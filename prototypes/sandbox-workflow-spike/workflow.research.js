// THROWAWAY PROTOTYPE FIXTURE
// This is a generated-harness-shaped script for the first dogfood workload.
// It is not production runtime code.

export const meta = {
  description:
    "Fan out source collection, verify claims, synthesize a report and reusable context pack.",
  name: "research-claude-workflows",
  phases: ["collect", "verify", "synthesize", "publish"],
};

export default async function workflow({ capsule, contextPack, supervisor }) {
  await supervisor.pinHarness(import.meta.url);
  await supervisor.requireContextPack(contextPack.id);

  const sources = await supervisor.parallel(
    [
      "anthropic-dynamic-workflows-blog",
      "thariq-skills-and-dags",
      "thariq-workshop-recap",
      "cloudflare-dynamic-workflows",
      "kody-secrets-pattern",
    ].map((sourceId) => () => supervisor.collectSource({ capsule, sourceId })),
    { concurrency: 2 }
  );

  const verifiedClaims = await supervisor.verifyClaims({ capsule, sources });
  const report = await supervisor.synthesizeReport({ capsule, verifiedClaims });
  const reusablePack = await supervisor.buildContextPack({ capsule, report });

  return supervisor.publishWzrrdReview({ capsule, report, reusablePack });
}
