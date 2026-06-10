<script lang="ts">
  let { data } = $props();
</script>

<div class="shell">
  <nav class="topbar">
    <a class="brand" href="/">
      <div class="logo">📦</div>
      <div>
        <div class="eyebrow">Internal Registry</div>
        <strong>Prompt + Skill Packs</strong>
      </div>
    </a>
    <div class="actions" style="margin-top: 0">
      <a class="button secondary" href="/skills">Browse skills</a>
      <a class="button secondary" href="/packs">Browse packs</a>
    </div>
  </nav>

  <section class="hero">
    <div class="eyebrow">Office-friendly context packs</div>
    <h1>GitHub-ish, but for prompts and skills.</h1>
    <p>
      This is the first office-facing skin over the real Cloudflare registry spike:
      deployed Worker, Durable Object state, Queue jobs, Artifacts repos, and real
      Sandbox validation. People browse packs. Machines pin immutable refs.
    </p>
    <div class="actions">
      <a class="button" href="/skills">Open the skill library</a>
      <a class="button secondary" href="/packs">Open pack collections</a>
      <a class="button secondary" href={data.registryUrl}>Worker API</a>
    </div>
  </section>

  <section class="grid panel">
    <div class="card">
      <div class="eyebrow">Packages</div>
      <div class="stat">{data.stats.packageCount}</div>
      <p class="muted">Live packages from the deployed registry.</p>
    </div>
    <div class="card">
      <div class="eyebrow">Validated</div>
      <div class="stat">{data.stats.succeededCount}</div>
      <p class="muted">Latest versions that passed cloud validation.</p>
    </div>
    <div class="card">
      <div class="eyebrow">Versions</div>
      <div class="stat">{data.stats.versionCount}</div>
      <p class="muted">Immutable refs backed by Cloudflare Artifacts commits.</p>
    </div>
  </section>

  <section class="panel">
    <div class="topbar">
      <div>
        <div class="eyebrow">Featured packs</div>
        <h2>Share these around the office</h2>
      </div>
      <a class="button secondary" href="/packs">View all</a>
    </div>
    <div class="grid">
      {#each data.cards.slice(0, 6) as pack}
        <a class="card" href={`/packs/${pack.name}`}>
          <div class="tag-row">
            <span class:ok={pack.latest?.validationStatus === 'succeeded'} class:bad={pack.latest?.validationStatus === 'failed'} class="tag">
              {pack.latest?.validationStatus ?? 'unknown'}
            </span>
            <span class="tag">{pack.latest?.version ?? 'no version'}</span>
          </div>
          <h3>{pack.name}</h3>
          <p class="muted">{pack.description}</p>
          {#if pack.latest}
            <pre>{pack.latest.packageRef}</pre>
          {/if}
        </a>
      {/each}
    </div>
  </section>

  <section class="panel card">
    <div class="eyebrow">How people use it</div>

## Browse → inspect → pin

1. Find the pack by job: launch ops, support, copy review, architecture, whatever.
2. Check validation and install-smoke receipts.
3. Copy the package ref into a sandbox workflow.
4. Every run records the exact pack ref it used.

No one in the office needs to know there is a Git repo wearing a trench coat under this. Good.

  </section>
</div>
