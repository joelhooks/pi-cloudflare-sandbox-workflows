/// <reference types="@cloudflare/workers-types" />

import { z } from "zod";

import type { DiscordMessageCapabilityAdapter } from "../application/ports.ts";
import { sha256Hex } from "../domain/hash.ts";
import {
  CapabilityLeaseSchema,
  DiscordDeliveryResultSchema,
  DiscordMessagePayloadSchema,
} from "../domain/schemas.ts";
import type {
  CapabilityDenialCode,
  CapabilityLease,
  DiscordDeliveryResult,
  DiscordMessagePayload,
  DiscordResource,
} from "../domain/schemas.ts";

type DiscordMessageLease = CapabilityLease & {
  readonly capability: "discord.message.send";
  readonly resource: DiscordResource;
};

export interface DiscordBotTokenSecretResolver {
  resolve(input: {
    readonly leaseId: string;
    readonly runId: string;
    readonly secretRef: string;
  }): Promise<string | null>;
}

export interface CloudflareSecretStringBinding {
  get(): Promise<null | string>;
}

export type CloudflareDiscordBotTokenBinding =
  | CloudflareSecretStringBinding
  | string;

export interface CloudflareDiscordMessageAdapterConfig {
  readonly discordApiBaseUrl?: string;
  readonly discordBotSecretRef: string;
  readonly fetch?: typeof fetch;
  readonly resolveChannelId?: (resource: DiscordResource) => null | string;
  readonly secretResolver: DiscordBotTokenSecretResolver;
  readonly userAgent: string;
}

export interface CloudflareDiscordBotTokenResolverConfig {
  readonly secret: CloudflareDiscordBotTokenBinding;
  readonly secretRef: string;
}

const DiscordCreateMessageResponseSchema = z.looseObject({
  channel_id: z.string().min(1),
  id: z.string().min(1),
});

const blocked = (
  code: CapabilityDenialCode,
  message: string
): DiscordDeliveryResult =>
  DiscordDeliveryResultSchema.parse({
    blocker: {
      code,
      message,
      redacted: true,
    },
    status: "blocked",
  });

const defaultDiscordApiBaseUrl = "https://discord.com/api/v10";

const snowflakePattern = /^\d{17,20}$/u;

const defaultResolveChannelId = (resource: DiscordResource): null | string => {
  const prefix = "discord:channel:";
  const channelId = resource.channelRef.startsWith(prefix)
    ? resource.channelRef.slice(prefix.length)
    : resource.channelRef;

  return snowflakePattern.test(channelId) ? channelId : null;
};

const isDiscordMessageLease = (
  lease: CapabilityLease
): lease is DiscordMessageLease =>
  lease.capability === "discord.message.send" &&
  lease.resource.kind === "discord.channel";

const deliveryForDryRun = (input: {
  readonly lease: DiscordMessageLease;
  readonly payload: DiscordMessagePayload;
}): DiscordDeliveryResult =>
  DiscordDeliveryResultSchema.parse({
    channelRef: input.lease.resource.channelRef,
    dryRun: true,
    messageId: `dry-run:${input.lease.runId}`,
    payloadHash: input.payload.bodyHash,
    redacted: true,
    serverRef: input.lease.resource.serverRef,
    status: "dry-run",
  });

const validateLeasePayloadBinding = (input: {
  readonly lease: DiscordMessageLease;
  readonly payload: DiscordMessagePayload;
}): DiscordDeliveryResult | null => {
  if (input.payload.bodyHash !== input.lease.payloadHash) {
    return blocked(
      "payload_hash_mismatch",
      "Discord payload no longer matches the leased payload hash."
    );
  }

  if (
    input.payload.channelRef !== input.lease.resource.channelRef ||
    input.payload.serverRef !== input.lease.resource.serverRef
  ) {
    return blocked(
      "resource_scope_denied",
      "Discord payload resource does not match the leased resource."
    );
  }

  return null;
};

const blockerForDiscordStatus = (status: number): DiscordDeliveryResult => {
  if (status === 401) {
    return blocked(
      "secret_denied",
      "Discord rejected the configured bot token."
    );
  }

  if (status === 403) {
    return blocked(
      "resource_scope_denied",
      "Discord rejected the bot for the leased channel resource."
    );
  }

  if (status === 429) {
    return blocked(
      "adapter_unavailable",
      "Discord API rate limited the leased message send."
    );
  }

  return blocked(
    "adapter_unavailable",
    `Discord API rejected the leased message send with HTTP ${status}.`
  );
};

const discordNonceFor = (lease: CapabilityLease): string =>
  sha256Hex(`${lease.leaseId}:${lease.payloadHash}`).slice(0, 25);

const jsonBodyFor = (input: {
  readonly lease: CapabilityLease;
  readonly payload: DiscordMessagePayload;
}): string =>
  JSON.stringify({
    allowed_mentions: {
      parse: [],
    },
    content: input.payload.body,
    enforce_nonce: true,
    nonce: discordNonceFor(input.lease),
    tts: false,
  });

export const createCloudflareDiscordBotTokenResolver = (
  config: CloudflareDiscordBotTokenResolverConfig
): DiscordBotTokenSecretResolver => ({
  async resolve(input) {
    if (input.secretRef !== config.secretRef) {
      return null;
    }

    if (typeof config.secret === "string") {
      return config.secret.length === 0 ? null : config.secret;
    }

    const secret = await config.secret.get();

    return secret === null || secret.length === 0 ? null : secret;
  },
});

export const createCloudflareDiscordMessageAdapter = (
  config: CloudflareDiscordMessageAdapterConfig
): DiscordMessageCapabilityAdapter => ({
  async execute(input) {
    const lease = CapabilityLeaseSchema.parse(input.lease);
    const payload = DiscordMessagePayloadSchema.parse(input.payload);
    if (!isDiscordMessageLease(lease)) {
      return blocked(
        "capability_denied",
        "Discord message adapter requires a Discord message lease."
      );
    }

    const bindingBlocker = validateLeasePayloadBinding({ lease, payload });
    if (bindingBlocker !== null) {
      return bindingBlocker;
    }

    if (lease.dryRun) {
      return deliveryForDryRun({ lease, payload });
    }

    if (lease.reviewGate.mode !== "approved") {
      return blocked(
        lease.reviewGate.mode === "rejected"
          ? "review_rejected"
          : "review_required",
        "Discord sends require approved review before execution."
      );
    }

    if (lease.secretRef !== config.discordBotSecretRef) {
      return blocked(
        "secret_denied",
        "Discord send requires the configured bot secret reference."
      );
    }

    const channelId = (config.resolveChannelId ?? defaultResolveChannelId)(
      lease.resource
    );
    if (channelId === null) {
      return blocked(
        "resource_scope_denied",
        "Discord channel reference could not be resolved to a channel id."
      );
    }

    const token = await config.secretResolver.resolve({
      leaseId: lease.leaseId,
      runId: lease.runId,
      secretRef: lease.secretRef,
    });
    if (token === null) {
      return blocked(
        "secret_denied",
        "Discord bot token could not be materialized for the leased send."
      );
    }

    const response = await (config.fetch ?? fetch)(
      `${config.discordApiBaseUrl ?? defaultDiscordApiBaseUrl}/channels/${encodeURIComponent(channelId)}/messages`,
      {
        body: jsonBodyFor({ lease, payload }),
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
          "User-Agent": config.userAgent,
        },
        method: "POST",
      }
    );
    if (!response.ok) {
      return blockerForDiscordStatus(response.status);
    }

    const body = DiscordCreateMessageResponseSchema.parse(
      await response.json()
    );
    if (body.channel_id !== channelId) {
      return blocked(
        "resource_scope_denied",
        "Discord returned a message from a different channel than the leased resource."
      );
    }

    return DiscordDeliveryResultSchema.parse({
      channelRef: lease.resource.channelRef,
      dryRun: false,
      messageId: body.id,
      payloadHash: payload.bodyHash,
      redacted: true,
      serverRef: lease.resource.serverRef,
      status: "sent",
    });
  },
});
