<script lang="ts">
  const { data } = $props();
</script>

<div class="shell">
  <nav class="topbar">
    <a class="brand" href="/packs">
      <div class="logo">📦</div>
      <div>
        <div class="eyebrow">Package</div>
        <strong>{data.pack.name}</strong>
      </div>
    </a>
    <a class="button secondary" href="/packs">All packs</a>
  </nav>

  <section class="hero">
    <div class="eyebrow">Context pack</div>
    <h1>{data.pack.name}</h1>
    <p>{data.pack.description}</p>
    <div class="tag-row">
      <span class="tag">{data.versions.length} version{data.versions.length === 1 ? '' : 's'}</span>
      <span class="tag">{data.jobs.length} job{data.jobs.length === 1 ? '' : 's'}</span>
      <span class="tag">Updated {new Date(data.pack.updatedAt).toLocaleString()}</span>
    </div>
  </section>

  <section class="panel card">
    <div class="eyebrow">Install ref</div>
    {#if data.versions[0]}
      <h2>{data.versions[0].version}</h2>
      <pre>{data.versions[0].packageRef}</pre>
      <div class="tag-row">
        <span class:ok={data.versions[0].validationStatus === 'succeeded'} class:bad={data.versions[0].validationStatus === 'failed'} class="tag">
          validation: {data.versions[0].validationStatus}
        </span>
        <span class="tag">repo: {data.versions[0].artifactRepoName}</span>
      </div>
    {/if}
  </section>

  <section class="grid panel">
    <div class="card">
      <div class="eyebrow">Included skills</div>
      {#if data.contents.skills.length > 0}
        <div class="tag-row">
          {#each data.contents.skills as skill}
            <span class="tag">{skill}</span>
          {/each}
        </div>
        <p class="muted">
          Source: {data.contents.source}. This comes from the registry file API for the selected package version.
        </p>
      {:else}
        <p class="muted">
          Skill list unavailable for this version. Older packages may predate the registry file API.
        </p>
      {/if}
    </div>

    <div class="card">
      <div class="eyebrow">Prompts + docs</div>
      {#if data.contents.prompts.length > 0}
        <h3>Prompts</h3>
        <ul>
          {#each data.contents.prompts as prompt}
            <li><code>{prompt}</code></li>
          {/each}
        </ul>
      {/if}
      {#if data.contents.docs.length > 0}
        <h3>Docs</h3>
        <ul>
          {#each data.contents.docs as doc}
            <li><code>{doc}</code></li>
          {/each}
        </ul>
      {/if}
      {#if data.contents.prompts.length === 0 && data.contents.docs.length === 0}
        <p class="muted">No prompt/doc summary available yet.</p>
      {/if}
    </div>
  </section>

  <section class="grid panel">
    <div class="card">
      <div class="eyebrow">Versions</div>
      <div class="table">
        {#each data.versions as version}
          <div>
            <div class="tag-row">
              <span class:ok={version.validationStatus === 'succeeded'} class:bad={version.validationStatus === 'failed'} class="tag">{version.validationStatus}</span>
              <span class="tag">{version.version}</span>
            </div>
            <pre>{version.packageRef}</pre>
          </div>
        {/each}
      </div>
    </div>

    <div class="card">
      <div class="eyebrow">Jobs</div>
      <div class="table">
        {#each data.jobs as job}
          <div class="row">
            <div>
              <div class="tag-row">
                <span class:ok={job.status === 'succeeded'} class:bad={job.status === 'failed'} class="tag">{job.status}</span>
                <span class="tag">{job.type}</span>
              </div>
              <strong>{job.id}</strong>
              {#if job.sandboxId}
                <p class="muted">sandbox: {job.sandboxId}</p>
              {/if}
              {#if job.sandboxDestroyReceipt}
                <p class="muted">{job.sandboxDestroyReceipt}</p>
              {/if}
              {#if job.error}
                <pre>{job.error}</pre>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </section>

  <section class="panel card">
    <div class="eyebrow">Event log</div>
    <div class="table">
      {#each data.events as event}
        <div class="row"><code>{event}</code></div>
      {/each}
    </div>
  </section>
</div>
