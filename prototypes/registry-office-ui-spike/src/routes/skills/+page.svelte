<script lang="ts">
  const { data } = $props();
</script>

<div class="shell">
  <nav class="topbar">
    <a class="brand" href="/">
      <div class="logo">📦</div>
      <div>
        <div class="eyebrow">Skills</div>
        <strong>Versioned units</strong>
      </div>
    </a>
    <a class="button secondary" href="/packs">Packs</a>
  </nav>

  <section class="hero">
    <div class="eyebrow">Skills first</div>
    <h1>Skills are tracks. Packs are playlists.</h1>
    <p>
      This view derives individual skill versions from registry file indexes. The next backend hardening is to publish skills directly, but the product model is already visible here: one skill, many pinned refs, packs as collections.
    </p>
  </section>

  <section class="table panel">
    {#each data.skills as skill}
      <a class="row" href={`/skills/${skill.id}`}>
        <div>
          <div class="tag-row">
            <span class="tag">{skill.versions.length} version{skill.versions.length === 1 ? '' : 's'}</span>
            {#if skill.latest}
              <span class:ok={skill.latest.validationStatus === 'succeeded'} class:bad={skill.latest.validationStatus === 'failed'} class="tag">
                {skill.latest.validationStatus}
              </span>
            {/if}
          </div>
          <h2>{skill.id}</h2>
          {#if skill.latest}
            <p class="muted">latest from {skill.latest.packName}@{skill.latest.version}</p>
            <pre>{skill.latest.packRef}</pre>
          {/if}
        </div>
        <div class="button secondary">Inspect</div>
      </a>
    {/each}
  </section>
</div>
