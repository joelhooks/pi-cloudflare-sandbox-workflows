<script lang="ts">
  const { data } = $props();
</script>

<div class="shell">
  <nav class="topbar">
    <a class="brand" href="/">
      <div class="logo">📦</div>
      <div>
        <div class="eyebrow">Pack Library</div>
        <strong>Live Cloudflare registry</strong>
      </div>
    </a>
    <a class="button secondary" href="/">Home</a>
  </nav>

  <section class="hero">
    <div class="eyebrow">Browse</div>
    <h1>Pick the right context, then pin the ref.</h1>
    <p>
      This list is fetched server-side from the deployed registry Worker. Tokens stay on the
      server. Office humans see names, status, versions, and receipts.
    </p>
  </section>

  <section class="table panel">
    {#each data.packages as pack}
      <a class="row" href={`/packs/${pack.name}`}>
        <div>
          <div class="tag-row">
            <span class:ok={pack.latest?.validationStatus === 'succeeded'} class:bad={pack.latest?.validationStatus === 'failed'} class="tag">
              {pack.latest?.validationStatus ?? 'unknown'}
            </span>
            <span class="tag">{pack.versionCount} version{pack.versionCount === 1 ? '' : 's'}</span>
            <span class="tag">{pack.jobCount} job{pack.jobCount === 1 ? '' : 's'}</span>
          </div>
          <h2>{pack.name}</h2>
          <p class="muted">{pack.description}</p>
          {#if pack.latest}
            <pre>{pack.latest.packageRef}</pre>
          {/if}
        </div>
        <div class="button secondary">Inspect</div>
      </a>
    {/each}
  </section>
</div>
