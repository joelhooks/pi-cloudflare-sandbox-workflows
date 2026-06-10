<script lang="ts">
  const { data } = $props();
</script>

<div class="shell">
  <nav class="topbar">
    <a class="brand" href="/skills">
      <div class="logo">📦</div>
      <div>
        <div class="eyebrow">Skill</div>
        <strong>{data.skill.id}</strong>
      </div>
    </a>
    <a class="button secondary" href="/skills">All skills</a>
  </nav>

  <section class="hero">
    <div class="eyebrow">Versioned skill</div>
    <h1>{data.skill.id}</h1>
    <p>
      A skill can appear in many packs. The useful pin is the exact version/ref that a workflow used.
    </p>
  </section>

  {#if data.skill.latest}
    <section class="panel card">
      <div class="eyebrow">Latest ref</div>
      <h2>{data.skill.latest.version}</h2>
      <pre>{data.skill.latest.packRef}</pre>
      <p class="muted">From pack: {data.skill.latest.packName}</p>
    </section>
  {/if}

  {#if data.renderedSkill}
    <section class="panel card skill-render">
      <div class="eyebrow">Rendered SKILL.md</div>
      <p class="muted"><code>{data.renderedSkill.path}</code></p>
      {#if Object.keys(data.renderedSkill.frontmatter).length > 0}
        <dl class="metadata">
          {#each Object.entries(data.renderedSkill.frontmatter) as [key, value]}
            <div>
              <dt>{key}</dt>
              <dd>{Array.isArray(value) ? value.join(', ') : String(value)}</dd>
            </div>
          {/each}
        </dl>
      {/if}
      {@html data.renderedSkill.html}
    </section>
  {/if}

  <section class="panel card">
    <div class="eyebrow">Versions</div>
    <div class="table">
      {#each data.skill.versions as version}
        <div class="row">
          <div>
            <div class="tag-row">
              <span class:ok={version.validationStatus === 'succeeded'} class:bad={version.validationStatus === 'failed'} class="tag">
                {version.validationStatus}
              </span>
              <span class="tag">{version.version}</span>
              <span class="tag">{version.sizeBytes} bytes</span>
            </div>
            <strong>{version.path}</strong>
            <p class="muted">pack: {version.packName}</p>
            <pre>{version.packRef}</pre>
          </div>
        </div>
      {/each}
    </div>
  </section>
</div>
