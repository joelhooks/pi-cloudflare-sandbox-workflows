/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { WorkflowApp } from "../../src/app/application/workflow-app.ts";
import { hashJson, sha256Hex } from "../../src/app/domain/hash.ts";
import {
  CapabilityLeaseSchema,
  ReviewSurfaceDocumentSchema,
  WzrrdPublishPayloadSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  CapabilityLease,
  ReviewSurfaceArtifact,
  WorkflowRunRequest,
  WzrrdPublishPayload,
} from "../../src/app/domain/schemas.ts";
import { workflowTraceContextForCapability } from "../../src/app/domain/trace-context.ts";
import { createCloudflareArtifactsObservabilityRecorder } from "../../src/app/infrastructure/cloudflare-artifacts-observability-recorder.ts";
import { createCloudflareArtifactsReviewSurfacePublisher } from "../../src/app/infrastructure/cloudflare-artifacts-review-surface.ts";
import {
  createCloudflareWzrrdApiTokenResolver,
  createCloudflareWzrrdPublishAdapter,
} from "../../src/app/infrastructure/cloudflare-wzrrd-publish-adapter.ts";
import type {
  WzrrdApiTokenSecretResolver,
  WzrrdPrimaryDocumentRenderer,
} from "../../src/app/infrastructure/cloudflare-wzrrd-publish-adapter.ts";
import {
  createDryRunDiscordMessageAdapter,
  createDryRunWzrrdPublishAdapter,
  createIntegrationTestDynamicWorkflowPlanner,
  createMemoryArtifactStore,
  createMemoryContextCapsuleActor,
  createMemoryPackageRegistryActor,
  createMemoryReviewGateActor,
  createMemoryWorkflowStatusProjectionStore,
  createPolicyCapabilityLeaseBroker,
} from "../../src/app/infrastructure/memory-adapters.ts";
import {
  buildIntegrationTestRunRequest,
  integrationTestPackageMetadata,
} from "./workflow-app-fixtures.ts";

interface FetchCall {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly method: string;
  readonly url: string;
}

const WzrrdPublishRequestBodySchema = z.object({
  files: z
    .array(
      z.object({
        content: z.string().min(1),
        path: z.string().min(1),
      })
    )
    .min(1),
  indexing: z.literal("noindex"),
  slug: z.string().min(1),
  source: z.string().min(1),
});

const wzrrdToken = "wzrrd-api-token-never-in-receipts";
const tufteMdsvxTemplate = {
  defaultExpiresIn: "24h",
  format: "mdsvx",
  noindex: true,
  rendererId: "joel/static-tufte-mdsvx-preview@0.1.0",
  templateId: "joel/tufte-mdsvx",
  version: "0.1.0",
} as const;

const PrimaryDocumentRenderingReceiptSchema = z.object({
  primaryDocument: z.object({
    artifactRef: z.string().min(1),
    hash: z.string().min(1),
    mediaType: z.literal("text/mdsvx"),
    path: z.string().min(1),
    rendererId: z.string().min(1),
    template: z.object({
      defaultExpiresIn: z.literal("24h"),
      format: z.literal("mdsvx"),
      noindex: z.literal(true),
      rendererId: z.string().min(1),
      templateId: z.literal("joel/tufte-mdsvx"),
      version: z.literal("0.1.0"),
    }),
    title: z.string().min(1),
  }),
  redacted: z.literal(true),
  rendererId: z.string().min(1),
  runId: z.string().min(1),
  schemaVersion: z.literal("wzrrd.primary-document-rendering.v1"),
  workItemId: z.string().min(1),
});

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
      throw new TypeError("Expected Wzrrd request body to be JSON text.");
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
  const resolver: WzrrdApiTokenSecretResolver = {
    resolve() {
      count += 1;

      return Promise.resolve(wzrrdToken);
    },
  };

  return {
    get count() {
      return count;
    },
    resolver,
  };
};

const createReviewSurfaceFixture = async () => {
  const artifacts = createMemoryArtifactStore("wzrrd-publish-adapter");
  const workflow = new WorkflowApp({
    artifacts,
    capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
      discordSecretRef: "secretref:discord-bot",
      policyId: "wzrrd-adapter-policy",
      wzrrdSecretRef: "secretref:wzrrd-api",
    }),
    contextCapsules: createMemoryContextCapsuleActor(),
    discordMessages: createDryRunDiscordMessageAdapter(),
    discordSecretRefs: {
      dryRun: "secretref:discord-dry-run",
      send: "secretref:discord-bot",
    },
    dynamicWorkflowPlanner: createIntegrationTestDynamicWorkflowPlanner(),
    executionMode: "integration-test",
    observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
      artifacts,
    }),
    packageRegistry: createMemoryPackageRegistryActor(
      integrationTestPackageMetadata
    ),
    reviewGate: createMemoryReviewGateActor(artifacts),
    reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
      artifacts,
    }),
    statusProjection: createMemoryWorkflowStatusProjectionStore(),
    wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
    wzrrdSecretRefs: {
      dryRun: "secretref:wzrrd-dry-run",
      publish: "secretref:wzrrd-api",
    },
    wzrrdSiteRef: "wzrrd:test",
  });
  const request = buildIntegrationTestRunRequest();
  const result = await workflow.run(request);
  if (result.status !== "captured") {
    throw new Error(result.blocker.message);
  }

  return {
    artifacts,
    request,
    reviewSurfaceArtifact: result.reviewSurfaceArtifact,
  };
};

const buildPayload = (input: {
  readonly request: WorkflowRunRequest;
  readonly reviewSurfaceArtifact: ReviewSurfaceArtifact;
  readonly slug?: string;
}): WzrrdPublishPayload =>
  WzrrdPublishPayloadSchema.parse({
    redacted: true,
    reviewSurface: {
      artifactRef: input.reviewSurfaceArtifact.artifactRef,
      hash: input.reviewSurfaceArtifact.hash,
      kind: input.reviewSurfaceArtifact.kind,
      surfaceId: input.reviewSurfaceArtifact.surfaceId,
    },
    runId: input.request.runId,
    schemaVersion: "wzrrd.publish-payload.v1",
    slug: input.slug ?? "piwf-wzrrd-adapter-test",
    title: `Review surface for ${input.request.runId}`,
    workItemId: input.request.workItemId,
  });

const buildLease = (input: {
  readonly dryRun?: boolean;
  readonly payload: WzrrdPublishPayload;
  readonly request: WorkflowRunRequest;
  readonly reviewGate?: CapabilityLease["reviewGate"];
  readonly secretRef?: string;
}): CapabilityLease =>
  CapabilityLeaseSchema.parse({
    actor: input.request.actor,
    capability: "wzrrd.site.publish",
    capabilityRef: `capability:wzrrd.site.publish:${input.request.runId}:test:wzrrd-publish`,
    dryRun: input.dryRun ?? false,
    expiresAt: "2026-06-08T23:59:00.000Z",
    leaseId: `lease:wzrrd.site.publish:${input.request.runId}:test:wzrrd-publish`,
    payloadHash: hashJson(input.payload),
    payloadRef: `artifact://wzrrd-adapter/runs/${input.request.runId}/payloads/wzrrd-publish.json`,
    policyId: "wzrrd-adapter-policy",
    receiptSink: `artifact://wzrrd-adapter/runs/${input.request.runId}/receipts/wzrrd-capability.json`,
    redacted: true,
    resource: {
      kind: "wzrrd.site",
      siteRef: "wzrrd:test",
      slug: input.payload.slug,
    },
    reviewGate:
      input.reviewGate ??
      ({
        approvalRef:
          "artifact://wzrrd-adapter/review/wzrrd-publish-approval.json",
        mode: "approved",
        reviewerActorId: input.request.actor.id,
      } satisfies CapabilityLease["reviewGate"]),
    runId: input.request.runId,
    secretRef: input.secretRef ?? "secretref:wzrrd-api",
    stepId: "test:wzrrd-publish",
    traceContext: workflowTraceContextForCapability({
      capability: "wzrrd.site.publish",
      runId: input.request.runId,
      stepId: "test:wzrrd-publish",
    }),
    workItemId: input.request.workItemId,
  });

describe("Cloudflare Wzrrd publish adapter", () => {
  it("publishes an approved leased review surface through the Wzrrd API without token leakage", async () => {
    const fixture = await createReviewSurfaceFixture();
    const payload = buildPayload(fixture);
    const lease = buildLease({
      payload,
      request: fixture.request,
    });
    const fakeFetch = createFakeFetch(
      responseFrom({
        ok: true,
        site: {
          createdAt: "2026-06-08T23:59:05.000Z",
          slug: payload.slug,
          updatedAt: "2026-06-08T23:59:05.000Z",
          url: `https://${payload.slug}.wzrrd.sh/`,
        },
      })
    );
    const adapter = createCloudflareWzrrdPublishAdapter({
      artifacts: fixture.artifacts,
      fetch: fakeFetch.fetcher,
      now: () => "2026-06-08T23:59:10.000Z",
      secretResolver: createCloudflareWzrrdApiTokenResolver({
        secret: wzrrdToken,
        secretRef: "secretref:wzrrd-api",
      }),
      userAgent: "pi-cloudflare-sandbox-workflows/0.0.0",
      wzrrdApiBaseUrl: "https://wzrrd.example.invalid",
      wzrrdPublishSecretRef: "secretref:wzrrd-api",
    });

    const delivery = await adapter.execute({ lease, payload });
    const requestBody = WzrrdPublishRequestBodySchema.parse(
      JSON.parse(fakeFetch.calls[0]?.body ?? "{}")
    );
    const reviewSurfaceJsonFile = requestBody.files.find(
      (file) => file.path === "review-surface.json"
    );
    const reviewSurfaceJson =
      reviewSurfaceJsonFile === undefined
        ? null
        : ReviewSurfaceDocumentSchema.parse(
            JSON.parse(reviewSurfaceJsonFile.content)
          );

    expect({
      delivery,
      filePaths: requestBody.files.map((file) => file.path),
      htmlContainsRunId:
        requestBody.files
          .find((file) => file.path === "index.html")
          ?.content.includes(fixture.request.runId) ?? false,
      method: fakeFetch.calls[0]?.method,
      reviewSurfaceSchema: reviewSurfaceJson?.schemaVersion,
      source: requestBody.source,
      tokenLeaked: JSON.stringify(delivery).includes(wzrrdToken),
      url: fakeFetch.calls[0]?.url,
    }).toStrictEqual({
      delivery: {
        dryRun: false,
        payloadHash: hashJson(payload),
        publishedAt: "2026-06-08T23:59:05.000Z",
        redacted: true,
        reviewSurfaceRef: payload.reviewSurface.artifactRef,
        slug: payload.slug,
        status: "published",
        url: `https://${payload.slug}.wzrrd.sh/`,
      },
      filePaths: ["index.html", "review-surface.json"],
      htmlContainsRunId: true,
      method: "POST",
      reviewSurfaceSchema: "workflow.review-surface.v1",
      source: `pi-cloudflare-sandbox-workflows:${fixture.request.runId}`,
      tokenLeaked: false,
      url: "https://wzrrd.example.invalid/api/sites",
    });
    expect(fakeFetch.calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${wzrrdToken}`,
      "content-type": "application/json",
      "user-agent": "pi-cloudflare-sandbox-workflows/0.0.0",
    });
  });

  it("publishes a verified primary MDSvX document beside the review surface", async () => {
    const fixture = await createReviewSurfaceFixture();
    const mdsvx = [
      "---",
      'title: "This dream found work to do."',
      'template: "joel/tufte-mdsvx@0.1.0"',
      "---",
      "",
      "# This dream found work to do.",
      "",
      "## The actual findings",
      "",
      "Concise, actionable, and source-backed.",
      "",
      '<D2Fig aspectRatio="16:9" machineId="dream-test-machine" sourceKind="generated-xstate-machine" stateCount={4} title="Generated workflow state machine" transitionCount={3}>',
      "",
      "```d2",
      "generate -> execute -> verify -> publish",
      "```",
      "",
      "</D2Fig>",
      "",
    ].join("\n");
    const mdsvxWrite = await fixture.artifacts.writeText({
      mediaType: "text/mdsvx",
      path: "report/hitl-report.mdsvx",
      redacted: true,
      runId: fixture.request.runId,
      value: mdsvx,
    });
    const payload = WzrrdPublishPayloadSchema.parse({
      ...buildPayload(fixture),
      primaryDocument: {
        artifactRef: mdsvxWrite.artifactRef,
        hash: sha256Hex(mdsvx),
        mediaType: "text/mdsvx",
        path: "report.mdsvx",
        template: tufteMdsvxTemplate,
        title: "This dream found work to do.",
      },
    });
    const lease = buildLease({
      payload,
      request: fixture.request,
    });
    const fakeFetch = createFakeFetch(
      responseFrom({
        ok: true,
        site: {
          createdAt: "2026-06-08T23:59:05.000Z",
          slug: payload.slug,
          url: `https://${payload.slug}.wzrrd.sh/`,
        },
      })
    );
    const adapter = createCloudflareWzrrdPublishAdapter({
      artifacts: fixture.artifacts,
      fetch: fakeFetch.fetcher,
      secretResolver: createCloudflareWzrrdApiTokenResolver({
        secret: wzrrdToken,
        secretRef: "secretref:wzrrd-api",
      }),
      userAgent: "pi-cloudflare-sandbox-workflows/0.0.0",
      wzrrdApiBaseUrl: "https://wzrrd.example.invalid",
      wzrrdPublishSecretRef: "secretref:wzrrd-api",
    });

    const delivery = await adapter.execute({ lease, payload });
    const requestBody = WzrrdPublishRequestBodySchema.parse(
      JSON.parse(fakeFetch.calls[0]?.body ?? "{}")
    );
    const filesByPath = new Map(
      requestBody.files.map((file) => [file.path, file.content])
    );
    const indexHtml = filesByPath.get("index.html") ?? "";
    const renderingReceipt = PrimaryDocumentRenderingReceiptSchema.parse(
      JSON.parse(filesByPath.get("report-rendering.json") ?? "{}")
    );

    expect({
      delivery:
        delivery.status === "published"
          ? {
              primaryDocument: delivery.primaryDocument,
              status: delivery.status,
            }
          : delivery,
      filePaths: requestBody.files.map((file) => file.path),
      frontmatterStripped: !indexHtml.includes("---"),
      indexContainsAspectRatio: indexHtml.includes(
        'style="--flow-chart-aspect-ratio:16 / 9"'
      ),
      indexContainsD2FigMetadata: indexHtml.includes('data-component="D2Fig"'),
      indexContainsD2Figure: indexHtml.includes('class="flow-chart"'),
      indexContainsFindings: indexHtml.includes(
        '<h2 id="the-actual-findings">The actual findings</h2>'
      ),
      indexContainsTemplate: indexHtml.includes("joel/tufte-mdsvx@0.1.0"),
      indexOmitsD2FigTag: !indexHtml.includes("&lt;D2Fig"),
      indexUsesStaticRenderer: indexHtml.includes(
        "joel/static-tufte-mdsvx-preview@0.1.0"
      ),
      renderingReceipt: {
        primaryDocument: renderingReceipt.primaryDocument,
        rendererId: renderingReceipt.rendererId,
      },
      reportSourceMatches: filesByPath.get("report.mdsvx") === mdsvx,
      reviewSurfaceIncluded: filesByPath.has("review-surface.json"),
    }).toStrictEqual({
      delivery: {
        primaryDocument: {
          artifactRef: mdsvxWrite.artifactRef,
          hash: sha256Hex(mdsvx),
          mediaType: "text/mdsvx",
          path: "report.mdsvx",
          rendererId: "joel/static-tufte-mdsvx-preview@0.1.0",
          template: tufteMdsvxTemplate,
          title: "This dream found work to do.",
        },
        status: "published",
      },
      filePaths: [
        "index.html",
        "report.mdsvx",
        "report-rendering.json",
        "review-surface.json",
      ],
      frontmatterStripped: true,
      indexContainsAspectRatio: true,
      indexContainsD2FigMetadata: true,
      indexContainsD2Figure: true,
      indexContainsFindings: true,
      indexContainsTemplate: true,
      indexOmitsD2FigTag: true,
      indexUsesStaticRenderer: true,
      renderingReceipt: {
        primaryDocument: {
          artifactRef: mdsvxWrite.artifactRef,
          hash: sha256Hex(mdsvx),
          mediaType: "text/mdsvx",
          path: "report.mdsvx",
          rendererId: "joel/static-tufte-mdsvx-preview@0.1.0",
          template: tufteMdsvxTemplate,
          title: "This dream found work to do.",
        },
        rendererId: "joel/static-tufte-mdsvx-preview@0.1.0",
      },
      reportSourceMatches: true,
      reviewSurfaceIncluded: true,
    });
  });

  it("rejects a primary MDSvX document that does not match its declared template", async () => {
    const fixture = await createReviewSurfaceFixture();
    const mdsvx = [
      "---",
      'title: "This dream found work to do."',
      "---",
      "",
      "# This dream found work to do.",
      "",
    ].join("\n");
    const mdsvxWrite = await fixture.artifacts.writeText({
      mediaType: "text/mdsvx",
      path: "report/hitl-report.mdsvx",
      redacted: true,
      runId: fixture.request.runId,
      value: mdsvx,
    });
    const payload = WzrrdPublishPayloadSchema.parse({
      ...buildPayload(fixture),
      primaryDocument: {
        artifactRef: mdsvxWrite.artifactRef,
        hash: sha256Hex(mdsvx),
        mediaType: "text/mdsvx",
        path: "report.mdsvx",
        template: tufteMdsvxTemplate,
        title: "This dream found work to do.",
      },
    });
    const lease = buildLease({
      payload,
      request: fixture.request,
    });
    const fakeFetch = createFakeFetch(
      responseFrom({
        ok: true,
        site: {
          createdAt: "2026-06-08T23:59:05.000Z",
          slug: payload.slug,
          url: `https://${payload.slug}.wzrrd.sh/`,
        },
      })
    );
    const adapter = createCloudflareWzrrdPublishAdapter({
      artifacts: fixture.artifacts,
      fetch: fakeFetch.fetcher,
      secretResolver: createCloudflareWzrrdApiTokenResolver({
        secret: wzrrdToken,
        secretRef: "secretref:wzrrd-api",
      }),
      userAgent: "pi-cloudflare-sandbox-workflows/0.0.0",
      wzrrdApiBaseUrl: "https://wzrrd.example.invalid",
      wzrrdPublishSecretRef: "secretref:wzrrd-api",
    });

    const delivery = await adapter.execute({ lease, payload });

    expect({
      blockerCode: delivery.status === "blocked" ? delivery.blocker.code : null,
      fetchCount: fakeFetch.calls.length,
      status: delivery.status,
    }).toStrictEqual({
      blockerCode: "capability_denied",
      fetchCount: 0,
      status: "blocked",
    });
  });

  it("lets a package-style primary document renderer own index.html without owning publish side effects", async () => {
    const fixture = await createReviewSurfaceFixture();
    const mdsvx = [
      "---",
      'title: "Plugin-rendered dream report"',
      "---",
      "",
      "# Plugin-rendered dream report",
      "",
    ].join("\n");
    const mdsvxWrite = await fixture.artifacts.writeText({
      mediaType: "text/mdsvx",
      path: "report/hitl-report.mdsvx",
      redacted: true,
      runId: fixture.request.runId,
      value: mdsvx,
    });
    const payload = WzrrdPublishPayloadSchema.parse({
      ...buildPayload(fixture),
      primaryDocument: {
        artifactRef: mdsvxWrite.artifactRef,
        hash: sha256Hex(mdsvx),
        mediaType: "text/mdsvx",
        path: "report.mdsvx",
        title: "Plugin-rendered dream report",
      },
    });
    const lease = buildLease({
      payload,
      request: fixture.request,
    });
    const fakeFetch = createFakeFetch(
      responseFrom({
        ok: true,
        site: {
          createdAt: "2026-06-08T23:59:05.000Z",
          slug: payload.slug,
          url: `https://${payload.slug}.wzrrd.sh/`,
        },
      })
    );
    const rendererInputs: string[] = [];
    const renderer: WzrrdPrimaryDocumentRenderer = {
      render(input) {
        rendererInputs.push(input.reviewSurface.runId);

        return {
          files: [
            {
              content: `<html><body><main data-renderer="package-node">${input.document.title}</main></body></html>`,
              path: "index.html",
            },
            {
              content: "asset from renderer\n",
              path: "assets/report-renderer.txt",
            },
          ],
          rendererId: "@joelhooks/wzrrd-hitl-report/static@0.1.0",
        };
      },
    };
    const adapter = createCloudflareWzrrdPublishAdapter({
      artifacts: fixture.artifacts,
      fetch: fakeFetch.fetcher,
      primaryDocumentRenderer: renderer,
      secretResolver: createCloudflareWzrrdApiTokenResolver({
        secret: wzrrdToken,
        secretRef: "secretref:wzrrd-api",
      }),
      userAgent: "pi-cloudflare-sandbox-workflows/0.0.0",
      wzrrdApiBaseUrl: "https://wzrrd.example.invalid",
      wzrrdPublishSecretRef: "secretref:wzrrd-api",
    });

    const delivery = await adapter.execute({ lease, payload });
    const requestBody = WzrrdPublishRequestBodySchema.parse(
      JSON.parse(fakeFetch.calls[0]?.body ?? "{}")
    );
    const filesByPath = new Map(
      requestBody.files.map((file) => [file.path, file.content])
    );

    expect({
      deliveryRenderer:
        delivery.status === "published"
          ? delivery.primaryDocument?.rendererId
          : null,
      deliveryStatus: delivery.status,
      filePaths: requestBody.files.map((file) => file.path),
      indexOwnedByRenderer: filesByPath
        .get("index.html")
        ?.includes('data-renderer="package-node"'),
      rendererInputs,
      sourceStillPublished: filesByPath.get("report.mdsvx") === mdsvx,
    }).toStrictEqual({
      deliveryRenderer: "@joelhooks/wzrrd-hitl-report/static@0.1.0",
      deliveryStatus: "published",
      filePaths: [
        "index.html",
        "assets/report-renderer.txt",
        "report.mdsvx",
        "report-rendering.json",
        "review-surface.json",
      ],
      indexOwnedByRenderer: true,
      rendererInputs: [fixture.request.runId],
      sourceStillPublished: true,
    });
  });

  it("keeps dry-run on the leased path without materializing secrets or fetching", async () => {
    const fixture = await createReviewSurfaceFixture();
    const payload = buildPayload({
      request: fixture.request,
      reviewSurfaceArtifact: fixture.reviewSurfaceArtifact,
      slug: "piwf-wzrrd-adapter-dry-run",
    });
    const lease = buildLease({
      dryRun: true,
      payload,
      request: fixture.request,
      reviewGate: {
        mode: "dry-run-exempt",
        reason: "Dry-run still leases, but does not publish.",
      },
      secretRef: "secretref:wzrrd-dry-run",
    });
    const fakeFetch = createFakeFetch(responseFrom({}));
    const secret = createCountingResolver();
    const adapter = createCloudflareWzrrdPublishAdapter({
      artifacts: fixture.artifacts,
      fetch: fakeFetch.fetcher,
      secretResolver: secret.resolver,
      userAgent: "pi-cloudflare-sandbox-workflows/0.0.0",
      wzrrdPublishSecretRef: "secretref:wzrrd-api",
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

  it("blocks with a clean reason when the Wzrrd API does not respond within the timeout", async () => {
    const fixture = await createReviewSurfaceFixture();
    const payload = buildPayload(fixture);
    const lease = buildLease({
      payload,
      request: fixture.request,
    });
    // A hung wzrrd.sh surfaces as an AbortSignal.timeout TimeoutError; without
    // the bound the fetch would hang until workerd kills the whole drive
    // invocation (a wedged run the reaper later sweeps with no reason).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal fetch stub that always times out.
    const timeoutFetch = (() => {
      const error = new Error("The operation timed out.");
      error.name = "TimeoutError";

      return Promise.reject(error);
    }) as unknown as typeof fetch;
    const adapter = createCloudflareWzrrdPublishAdapter({
      artifacts: fixture.artifacts,
      fetch: timeoutFetch,
      secretResolver: createCloudflareWzrrdApiTokenResolver({
        secret: wzrrdToken,
        secretRef: "secretref:wzrrd-api",
      }),
      timeoutMs: 5000,
      userAgent: "pi-cloudflare-sandbox-workflows/0.0.0",
      wzrrdApiBaseUrl: "https://wzrrd.example.invalid",
      wzrrdPublishSecretRef: "secretref:wzrrd-api",
    });

    const delivery = await adapter.execute({ lease, payload });

    expect({
      blocker: delivery.status === "blocked" ? delivery.blocker : undefined,
      status: delivery.status,
    }).toStrictEqual({
      blocker: {
        code: "adapter_unavailable",
        message: "Wzrrd API did not respond within 5000ms.",
        redacted: true,
      },
      status: "blocked",
    });
  });
});
