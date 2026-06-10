/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { sha256Hex } from "../../src/app/domain/hash.ts";
import {
  CapabilityLeaseSchema,
  DiscordMessagePayloadSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  CapabilityLease,
  DiscordMessagePayload,
} from "../../src/app/domain/schemas.ts";
import { workflowTraceContextForCapability } from "../../src/app/domain/trace-context.ts";
import {
  createCloudflareDiscordBotTokenResolver,
  createCloudflareDiscordMessageAdapter,
} from "../../src/app/infrastructure/cloudflare-discord-message-adapter.ts";
import type { DiscordBotTokenSecretResolver } from "../../src/app/infrastructure/cloudflare-discord-message-adapter.ts";
import { buildIntegrationTestRunRequest } from "./workflow-app-fixtures.ts";

interface FetchCall {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly method: string;
  readonly url: string;
}

const DiscordRequestBodySchema = z.object({
  allowed_mentions: z.object({
    parse: z.array(z.string()),
  }),
  content: z.string().min(1),
  enforce_nonce: z.boolean(),
  nonce: z.string().min(1),
  tts: z.boolean(),
});

const discordBody = "Workflow captured with a real leased Discord send.";
const discordToken = "discord-bot-token-never-in-receipts";

const buildPayload = (): DiscordMessagePayload =>
  DiscordMessagePayloadSchema.parse({
    body: discordBody,
    bodyHash: sha256Hex(discordBody),
    channelRef: "discord:channel:123456789012345678",
    serverRef: "discord:server:987654321098765432",
  });

const buildLease = (input: {
  readonly dryRun?: boolean;
  readonly payload: DiscordMessagePayload;
  readonly reviewGate?: CapabilityLease["reviewGate"];
  readonly secretRef?: string;
}): CapabilityLease => {
  const request = buildIntegrationTestRunRequest();

  return CapabilityLeaseSchema.parse({
    actor: request.actor,
    capability: "discord.message.send",
    capabilityRef: `capability:discord.message.send:${request.runId}`,
    dryRun: input.dryRun ?? false,
    expiresAt: "2026-06-08T23:59:00.000Z",
    leaseId: `lease:discord.message.send:${request.runId}`,
    payloadHash: input.payload.bodyHash,
    payloadRef: `artifact://discord-adapter/runs/${request.runId}/payloads/discord-message.json`,
    policyId: "discord-message-policy",
    receiptSink: `artifact://discord-adapter/runs/${request.runId}/receipts/discord-capability.json`,
    redacted: true,
    resource: {
      channelRef: input.payload.channelRef,
      kind: "discord.channel",
      serverRef: input.payload.serverRef,
    },
    reviewGate:
      input.reviewGate ??
      ({
        approvalRef: "review:discord-send-approved",
        mode: "approved",
        reviewerActorId: "actor:joel",
      } satisfies CapabilityLease["reviewGate"]),
    runId: request.runId,
    secretRef: input.secretRef ?? "secretref:discord-bot",
    traceContext: workflowTraceContextForCapability({
      capability: "discord.message.send",
      runId: request.runId,
      stepId: "test:discord-message",
    }),
    workItemId: request.workItemId,
  });
};

const responseFrom = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
  });

const urlForFetchInput = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
};

const createFakeFetch = (response: Response) => {
  const calls: FetchCall[] = [];
  const fetcher: typeof fetch = (input, init) => {
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected Discord request body to be JSON text.");
    }

    calls.push({
      body: init.body,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      method: init.method ?? "GET",
      url: urlForFetchInput(input),
    });

    return Promise.resolve(response);
  };

  return { calls, fetcher };
};

const createCountingResolver = () => {
  let count = 0;
  const resolver: DiscordBotTokenSecretResolver = {
    resolve() {
      count += 1;

      return Promise.resolve(discordToken);
    },
  };

  return {
    get count() {
      return count;
    },
    resolver,
  };
};

describe("Cloudflare Discord message adapter", () => {
  it("sends an approved leased Discord message through the API without receipt token leakage", async () => {
    const payload = buildPayload();
    const lease = buildLease({ payload });
    const fakeFetch = createFakeFetch(
      responseFrom({
        channel_id: "123456789012345678",
        id: "112233445566778899",
      })
    );
    const adapter = createCloudflareDiscordMessageAdapter({
      discordBotSecretRef: "secretref:discord-bot",
      fetch: fakeFetch.fetcher,
      secretResolver: createCloudflareDiscordBotTokenResolver({
        secret: discordToken,
        secretRef: "secretref:discord-bot",
      }),
      userAgent: "DiscordBot (https://joelclaw.local, 0.0.0)",
    });

    const delivery = await adapter.execute({ lease, payload });
    const requestBodyJson: unknown = JSON.parse(
      fakeFetch.calls[0]?.body ?? "{}"
    );
    const requestBody = DiscordRequestBodySchema.parse(requestBodyJson);

    expect({
      body: {
        allowed_mentions: requestBody.allowed_mentions,
        content: requestBody.content,
        enforce_nonce: requestBody.enforce_nonce,
        nonceLength: requestBody.nonce.length,
        tts: requestBody.tts,
      },
      delivery,
      method: fakeFetch.calls[0]?.method,
      tokenLeaked: JSON.stringify(delivery).includes(discordToken),
      url: fakeFetch.calls[0]?.url,
    }).toStrictEqual({
      body: {
        allowed_mentions: { parse: [] },
        content: payload.body,
        enforce_nonce: true,
        nonceLength: 25,
        tts: false,
      },
      delivery: {
        channelRef: payload.channelRef,
        dryRun: false,
        messageId: "112233445566778899",
        payloadHash: payload.bodyHash,
        redacted: true,
        serverRef: payload.serverRef,
        status: "sent",
      },
      method: "POST",
      tokenLeaked: false,
      url: "https://discord.com/api/v10/channels/123456789012345678/messages",
    });
    expect(fakeFetch.calls[0]?.headers).toMatchObject({
      authorization: `Bot ${discordToken}`,
      "content-type": "application/json",
      "user-agent": "DiscordBot (https://joelclaw.local, 0.0.0)",
    });
  });

  it("keeps dry-run on the leased path without materializing secrets or fetching", async () => {
    const payload = buildPayload();
    const lease = buildLease({
      dryRun: true,
      payload,
      reviewGate: {
        mode: "dry-run-exempt",
        reason: "Dry-run still leases, but does not send.",
      },
      secretRef: "secretref:discord-dry-run",
    });
    const fakeFetch = createFakeFetch(responseFrom({}));
    const secret = createCountingResolver();
    const adapter = createCloudflareDiscordMessageAdapter({
      discordBotSecretRef: "secretref:discord-bot",
      fetch: fakeFetch.fetcher,
      secretResolver: secret.resolver,
      userAgent: "DiscordBot (https://joelclaw.local, 0.0.0)",
    });

    const delivery = await adapter.execute({ lease, payload });

    expect({
      deliveryStatus: delivery.status,
      fetchCount: fakeFetch.calls.length,
      resolverCount: secret.count,
    }).toStrictEqual({
      deliveryStatus: "dry-run",
      fetchCount: 0,
      resolverCount: 0,
    });
  });

  it("blocks unapproved real sends before secrets or fetch", async () => {
    const payload = buildPayload();
    const lease = buildLease({
      payload,
      reviewGate: {
        mode: "required",
        reviewRef: "artifact://discord-adapter/review/discord-send.json",
      },
    });
    const fakeFetch = createFakeFetch(responseFrom({}));
    const secret = createCountingResolver();
    const adapter = createCloudflareDiscordMessageAdapter({
      discordBotSecretRef: "secretref:discord-bot",
      fetch: fakeFetch.fetcher,
      secretResolver: secret.resolver,
      userAgent: "DiscordBot (https://joelclaw.local, 0.0.0)",
    });

    const delivery = await adapter.execute({ lease, payload });

    expect({
      delivery,
      fetchCount: fakeFetch.calls.length,
      resolverCount: secret.count,
    }).toStrictEqual({
      delivery: {
        blocker: {
          code: "review_required",
          message: "Discord sends require approved review before execution.",
          redacted: true,
        },
        status: "blocked",
      },
      fetchCount: 0,
      resolverCount: 0,
    });
  });

  it("blocks payload hash mismatches before secrets or fetch", async () => {
    const payload = buildPayload();
    const lease = {
      ...buildLease({ payload }),
      payloadHash: "0".repeat(64),
    };
    const fakeFetch = createFakeFetch(responseFrom({}));
    const secret = createCountingResolver();
    const adapter = createCloudflareDiscordMessageAdapter({
      discordBotSecretRef: "secretref:discord-bot",
      fetch: fakeFetch.fetcher,
      secretResolver: secret.resolver,
      userAgent: "DiscordBot (https://joelclaw.local, 0.0.0)",
    });

    const delivery = await adapter.execute({ lease, payload });

    expect({
      blockerCode: delivery.status === "blocked" ? delivery.blocker.code : null,
      fetchCount: fakeFetch.calls.length,
      resolverCount: secret.count,
    }).toStrictEqual({
      blockerCode: "payload_hash_mismatch",
      fetchCount: 0,
      resolverCount: 0,
    });
  });

  it("redacts Discord API auth failures", async () => {
    const payload = buildPayload();
    const lease = buildLease({ payload });
    const fakeFetch = createFakeFetch(responseFrom({ message: "nope" }, 401));
    const adapter = createCloudflareDiscordMessageAdapter({
      discordBotSecretRef: "secretref:discord-bot",
      fetch: fakeFetch.fetcher,
      secretResolver: createCloudflareDiscordBotTokenResolver({
        secret: discordToken,
        secretRef: "secretref:discord-bot",
      }),
      userAgent: "DiscordBot (https://joelclaw.local, 0.0.0)",
    });

    const delivery = await adapter.execute({ lease, payload });

    expect({
      delivery,
      tokenLeaked: JSON.stringify(delivery).includes(discordToken),
    }).toStrictEqual({
      delivery: {
        blocker: {
          code: "secret_denied",
          message: "Discord rejected the configured bot token.",
          redacted: true,
        },
        status: "blocked",
      },
      tokenLeaked: false,
    });
  });
});
