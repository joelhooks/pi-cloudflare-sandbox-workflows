<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { page } from "$app/state";
  import { deriveEnvelopeProgression, deriveNodeSteps } from "$lib/envelope";
  import {
    clockTime,
    isTerminalState,
    relativeAge,
    relativeFromMs,
    statusTone,
  } from "$lib/format";
  import {
    RunDurabilityDumpSchema,
    WorkflowEventStreamDocumentSchema,
    WorkflowRunStatusDocumentSchema,
  } from "$lib/schemas";
  import type {
    RunDurabilityDump,
    WorkflowEventStreamDocument,
    WorkflowRunStatusDocument,
  } from "$lib/schemas";

  const POLL_INTERVAL_MS = 4000;
  const STALE_THRESHOLD_MS = 90_000;

  const runId = $derived(page.params.runId ?? "");

  let status = $state<null | WorkflowRunStatusDocument>(null);
  let stream = $state<null | WorkflowEventStreamDocument>(null);
  let durability = $state<null | RunDurabilityDump>(null);
  let diagramSvg = $state<null | string>(null);
  let dynamicDiagramSvg = $state<null | string>(null);

  let statusError = $state<null | string>(null);
  let streamError = $state<null | string>(null);
  let durabilityError = $state<null | string>(null);
  let diagramError = $state<null | string>(null);
  let dynamicDiagramError = $state<null | string>(null);

  let loading = $state(true);
  let paused = $state(false);
  /** Whether the secondary fixed safety-envelope shell chart is expanded. */
  let envelopeShellOpen = $state(false);
  let lastUpdatedMs = $state<null | number>(null);
  let nowMs = $state(Date.now());

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  const extractError = (body: unknown, statusCode: number): string => {
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
    ) {
      return body.error.message;
    }

    return `Request failed with ${statusCode}.`;
  };

  /**
   * Reads a settled SVG-fetch result into an `{ svg, error }` pair. Keeps the
   * two inline diagram fetches (dynamic + envelope shell) out of `refresh`'s
   * branch budget.
   *
   * @param settled The settled fetch promise for an SVG endpoint.
   * @param label Human label for the endpoint, used in the fallback message.
   */
  const readSvgResult = async (
    settled: PromiseSettledResult<Response>,
    label: string
  ): Promise<{ error: null | string; svg: null | string }> => {
    if (settled.status !== "fulfilled") {
      return { error: `Could not reach the ${label} endpoint.`, svg: null };
    }
    try {
      if (settled.value.ok) {
        return { error: null, svg: await settled.value.text() };
      }
      let message = `${label} failed with ${settled.value.status}.`;
      try {
        const body: unknown = await settled.value.json();
        message = extractError(body, settled.value.status);
      } catch {
        // Non-JSON error body; keep the generic message.
      }

      return { error: message, svg: null };
    } catch {
      return { error: `Could not read the ${label} response.`, svg: null };
    }
  };

  const refresh = async (): Promise<void> => {
    if (inFlight || runId === "") {
      return;
    }
    inFlight = true;
    const encoded = encodeURIComponent(runId);

    const [statusRes, eventsRes, durabilityRes, dynamicDiagramRes, diagramRes] =
      await Promise.allSettled([
        fetch(`/api/runs/${encoded}/status`, {
          headers: { accept: "application/json" },
        }),
        fetch(`/api/runs/${encoded}/events`, {
          headers: { accept: "application/json" },
        }),
        fetch(`/api/runs/${encoded}/durability`, {
          headers: { accept: "application/json" },
        }),
        fetch(`/api/runs/${encoded}/dynamic-diagram`, {
          headers: { accept: "image/svg+xml" },
        }),
        fetch(`/api/runs/${encoded}/state-diagram`, {
          headers: { accept: "image/svg+xml" },
        }),
      ]);

    if (statusRes.status === "fulfilled") {
      try {
        const body: unknown = await statusRes.value.json();
        if (statusRes.value.ok) {
          const parsed = WorkflowRunStatusDocumentSchema.safeParse(body);
          if (parsed.success) {
            status = parsed.data;
            statusError = null;
          } else {
            statusError = "Status response did not match the expected shape.";
          }
        } else {
          statusError = extractError(body, statusRes.value.status);
        }
      } catch {
        statusError = "Could not read the status response.";
      }
    } else {
      statusError = "Could not reach the status endpoint.";
    }

    if (eventsRes.status === "fulfilled") {
      try {
        const body: unknown = await eventsRes.value.json();
        if (eventsRes.value.ok) {
          const parsed = WorkflowEventStreamDocumentSchema.safeParse(body);
          if (parsed.success) {
            stream = parsed.data;
            streamError = null;
          } else {
            streamError = "Event stream did not match the expected shape.";
          }
        } else {
          streamError = extractError(body, eventsRes.value.status);
        }
      } catch {
        streamError = "Could not read the event stream response.";
      }
    } else {
      streamError = "Could not reach the events endpoint.";
    }

    if (durabilityRes.status === "fulfilled") {
      try {
        const body: unknown = await durabilityRes.value.json();
        if (durabilityRes.value.ok) {
          const parsed = RunDurabilityDumpSchema.safeParse(body);
          if (parsed.success) {
            durability = parsed.data;
            durabilityError = null;
          } else {
            durabilityError =
              "Durability dump did not match the expected shape.";
          }
        } else {
          durabilityError = extractError(body, durabilityRes.value.status);
        }
      } catch {
        durabilityError = "Could not read the durability response.";
      }
    } else {
      durabilityError = "Could not reach the durability endpoint.";
    }

    const dynamicResult = await readSvgResult(
      dynamicDiagramRes,
      "dynamic-diagram"
    );
    dynamicDiagramSvg = dynamicResult.svg ?? dynamicDiagramSvg;
    dynamicDiagramError = dynamicResult.error;

    const envelopeResult = await readSvgResult(diagramRes, "state-diagram");
    diagramSvg = envelopeResult.svg ?? diagramSvg;
    diagramError = envelopeResult.error;

    inFlight = false;
    loading = false;
    lastUpdatedMs = Date.now();
    nowMs = Date.now();
  };

  const togglePause = (): void => {
    paused = !paused;
    if (!paused) {
      void refresh();
    }
  };

  const toggleEnvelopeShell = (): void => {
    envelopeShellOpen = !envelopeShellOpen;
  };

  onMount(() => {
    void refresh();
    pollTimer = setInterval(() => {
      if (!paused) {
        void refresh();
      }
    }, POLL_INTERVAL_MS);
    clockTimer = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
  });

  onDestroy(() => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
    }
    if (clockTimer !== undefined) {
      clearInterval(clockTimer);
    }
  });

  // --- Derived views -------------------------------------------------------

  const events = $derived(stream?.events ?? []);
  const latestStatus = $derived(
    status?.status ?? stream?.latestStatus ?? null
  );
  const terminal = $derived(
    latestStatus !== null && isTerminalState(latestStatus)
  );
  const blocker = $derived(status?.blocker ?? null);

  const envelope = $derived(
    deriveEnvelopeProgression(events, latestStatus)
  );
  const nodeSteps = $derived(deriveNodeSteps(events, terminal));

  /** Events newest-first for the timeline. */
  const timeline = $derived([...events].toReversed());

  /** Last event timestamp in epoch ms (for the wedge heuristic). */
  const lastEvent = $derived(events.at(-1));
  const lastEventMs = $derived(
    lastEvent === undefined ? null : Date.parse(lastEvent.event.at)
  );

  /**
   * A wedged run: in-flight but the last event is older than the stale
   * threshold. This is the headline "is it stuck" signal on the detail view.
   */
  const wedged = $derived(
    latestStatus !== null &&
      !terminal &&
      lastEventMs !== null &&
      nowMs - lastEventMs > STALE_THRESHOLD_MS
  );

  /**
   * Durability health: a stale driving marker on a non-terminal run, or an
   * overdue reaper/alarm, is the watchdog-machinery warning the operator wants.
   */
  const drivingStale = $derived(durability?.drivingMarker?.stale ?? false);
  const reaperDueAtMs = $derived(durability?.reaperDueAtMs ?? null);
  const reaperOverdue = $derived(
    !terminal && reaperDueAtMs !== null && reaperDueAtMs < nowMs
  );
  const durabilityWarn = $derived(
    !terminal && (drivingStale || reaperOverdue)
  );
</script>

<div class="shell">
  <header class="board-head">
    <div>
      <p class="crumb"><a href="/">← Run board</a></p>
      <h1 class="board-title">Run {runId}</h1>
      <p class="board-subtitle">
        Forensic view — timeline, envelope walk, node progress, durability.
      </p>
    </div>
    <div class="board-controls">
      <button onclick={togglePause}>
        <span class="live-dot" class:paused></span>
        {paused ? "Paused" : "Live"}
      </button>
      <button onclick={() => void refresh()}>Refresh</button>
    </div>
  </header>

  <!-- PRIMARY: the GENERATED DYNAMIC WORKFLOW (different every run). -->
  <section class="diagram-card primary" class:is-terminal={terminal}>
    <div class="diagram-head">
      <h2 class="card-title">Generated dynamic workflow</h2>
      <p class="card-hint">
        The per-run node chain the planner synthesised, walking inside the fixed
        safety-envelope shell. Executed nodes fill green, the current node pulses,
        a blocked node lights red with its reason, and a dashed
        <code>pending…</code> tail marks the not-yet-walked nodes. Live D2 render
        from the event stream — the concrete pending node identities aren't shown
        until the machine reaches them.
      </p>
    </div>
    <div class="diagram-stage">
      {#if dynamicDiagramSvg !== null}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- server-rendered, redaction-safe D2 SVG -->
        <div class="diagram-svg">{@html dynamicDiagramSvg}</div>
      {:else if dynamicDiagramError !== null}
        <p class="card-empty">
          Dynamic workflow unavailable: {dynamicDiagramError}
        </p>
      {:else}
        <p class="card-empty">Rendering generated workflow…</p>
      {/if}
    </div>
  </section>

  <!-- SECONDARY: the fixed safety-envelope shell (collapsible). -->
  <section class="diagram-card envelope-shell" class:is-terminal={terminal}>
    <button
      type="button"
      class="shell-toggle"
      aria-expanded={envelopeShellOpen}
      onclick={toggleEnvelopeShell}
    >
      <span class="shell-caret" class:open={envelopeShellOpen}>▸</span>
      <span class="card-title shell-title">Safety-envelope shell</span>
      <span class="card-hint shell-hint">
        the fixed deterministic envelope every run walks inside
      </span>
    </button>
    {#if envelopeShellOpen}
      <div class="diagram-stage">
        {#if diagramSvg !== null}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- server-rendered, redaction-safe D2 SVG -->
          <div class="diagram-svg">{@html diagramSvg}</div>
        {:else if diagramError !== null}
          <p class="card-empty">Diagram unavailable: {diagramError}</p>
        {:else}
          <p class="card-empty">Rendering state machine…</p>
        {/if}
      </div>
    {/if}
  </section>

  <div class="meta-line">
    {#if latestStatus !== null}
      <span class="badge {statusTone(latestStatus)}">{latestStatus}</span>
      <span>{terminal ? "terminal" : "in-flight"}</span>
    {/if}
    {#if stream !== null}
      <span>{stream.eventCount} events</span>
      <span>work item {stream.workItemId}</span>
    {/if}
    {#if lastEvent !== undefined}
      <span class:warn-text={wedged}
        >last event {relativeAge(lastEvent.event.at, nowMs)}</span
      >
    {/if}
    {#if lastUpdatedMs !== null}
      <span>polled {relativeAge(new Date(lastUpdatedMs).toISOString(), nowMs)}</span
      >
    {/if}
    <span>every {POLL_INTERVAL_MS / 1000}s</span>
  </div>

  {#if wedged}
    <div class="banner warn" role="alert">
      <strong>Possibly wedged.</strong> Run is in-flight ({latestStatus}) but no
      event for &gt; {STALE_THRESHOLD_MS / 1000}s. Check the durability panel for
      a stale driver or overdue watchdog.
    </div>
  {/if}

  {#if loading && status === null && stream === null}
    <div class="empty">
      <strong>Loading run…</strong>
      Talking to the Worker.
    </div>
  {:else}
    <!-- BLOCKER PANEL (only when blocked) -->
    {#if blocker !== null}
      <section class="blocker-panel" role="alert">
        <div class="blocker-panel-head">
          <span class="blocker-panel-label">Blocked</span>
          <span class="blocker-panel-code">{blocker.code}</span>
        </div>
        <p class="blocker-panel-message">{blocker.message}</p>
        {#if blocker.nodeType !== undefined || blocker.stepId !== undefined}
          <div class="blocker-panel-where">
            {#if blocker.nodeType !== undefined}
              <span><span class="k">node</span> {blocker.nodeType}</span>
            {/if}
            {#if blocker.stepId !== undefined}
              <span><span class="k">step</span> {blocker.stepId}</span>
            {/if}
          </div>
        {/if}
      </section>
    {/if}

    <div class="detail-grid">
      <!-- ENVELOPE SPINE -->
      <section class="card">
        <h2 class="card-title">Safety-envelope progression</h2>
        <p class="card-hint">
          Canonical envelope walk. Walked stages are filled; the current stage
          pulses.
        </p>
        <ol class="envelope">
          {#each envelope.stages as stage (stage.state)}
            <li
              class="env-stage {stage.status}"
              class:current={stage.isCurrent}
            >
              <span class="env-dot"></span>
              <span class="env-label">{stage.label}</span>
            </li>
          {/each}
          <li
            class="env-stage terminal-cell"
            class:captured={envelope.terminal.kind === "captured"}
            class:blocked={envelope.terminal.kind === "blocked"}
            class:pending={envelope.terminal.kind === "pending"}
          >
            <span class="env-dot"></span>
            <span class="env-label">
              {#if envelope.terminal.kind === "captured"}
                Captured
              {:else if envelope.terminal.kind === "blocked"}
                Blocked
              {:else}
                Outcome
              {/if}
            </span>
          </li>
        </ol>
      </section>

      <!-- NODE PROGRESS -->
      <section class="card">
        <h2 class="card-title">Generated-machine nodes</h2>
        <p class="card-hint">
          Node steps executed so far (from event refs). Pending nodes are
          unknowable until the machine walks them.
        </p>
        {#if nodeSteps.length === 0}
          <p class="card-empty">No node steps emitted yet.</p>
        {:else}
          <ol class="node-list">
            {#each nodeSteps as node (node.stepId)}
              <li class="node-row {node.status}">
                <span class="node-marker"></span>
                <div class="node-body">
                  <div class="node-head">
                    <code class="node-step">{node.stepId}</code>
                    {#if node.nodeType !== ""}
                      <span class="node-type">{node.nodeType}</span>
                    {/if}
                    <span class="node-status">{node.status}</span>
                  </div>
                  {#if node.summary !== ""}
                    <p class="node-summary">{node.summary}</p>
                  {/if}
                </div>
              </li>
            {/each}
          </ol>
        {/if}
      </section>

      <!-- DURABILITY PANEL -->
      <section class="card" class:warn-card={durabilityWarn}>
        <h2 class="card-title">
          Durability
          {#if durabilityWarn}<span class="warn-pill">watchdog warning</span
            >{/if}
        </h2>
        <p class="card-hint">
          Is the resume/watchdog machinery healthy? Supervisor DO state.
        </p>
        {#if durabilityError !== null}
          <p class="card-empty">{durabilityError}</p>
        {:else if durability === null}
          <p class="card-empty">Loading durability…</p>
        {:else}
          <dl class="durability">
            <div class="dur-row">
              <dt>Run-start record</dt>
              <dd>{durability.hasRunStartRecord ? "present" : "absent"}</dd>
            </div>
            <div class="dur-row">
              <dt>Latest checkpoint</dt>
              <dd>
                {#if durability.checkpoint === null}
                  none yet
                {:else}
                  step #{durability.checkpoint.stepIndex} ·
                  {durability.checkpoint.completedStepIds.length} completed ·
                  {durability.checkpoint.outputArtifactRefCount} output refs
                {/if}
              </dd>
            </div>
            <div class="dur-row" class:warn-text={drivingStale}>
              <dt>Driving marker</dt>
              <dd>
                {#if durability.drivingMarker === null}
                  no driver parked
                {:else}
                  started {relativeFromMs(
                    durability.drivingMarker.startedAtMs,
                    nowMs
                  )}
                  {#if durability.drivingMarker.stale}
                    · <strong>STALE</strong> (driver evicted, re-drivable)
                  {:else}
                    · fresh
                  {/if}
                {/if}
              </dd>
            </div>
            <div class="dur-row" class:warn-text={reaperOverdue}>
              <dt>Reaper due</dt>
              <dd>
                {#if durability.reaperDueAtMs === null}
                  not scheduled
                {:else}
                  {relativeFromMs(durability.reaperDueAtMs, nowMs)} ({clockTime(
                    durability.reaperDueAtMs
                  )}){#if reaperOverdue} · <strong>OVERDUE</strong>{/if}
                {/if}
              </dd>
            </div>
            <div class="dur-row">
              <dt>Armed alarm</dt>
              <dd>
                {#if durability.alarmAtMs === null}
                  none
                {:else}
                  {relativeFromMs(durability.alarmAtMs, nowMs)} ({clockTime(
                    durability.alarmAtMs
                  )})
                {/if}
              </dd>
            </div>
            <div class="dur-row">
              <dt>Active lanes</dt>
              <dd>{durability.activeLaneCount}</dd>
            </div>
          </dl>
        {/if}
      </section>
    </div>

    <!-- EVENT TIMELINE -->
    <section class="card timeline-card">
      <h2 class="card-title">Event timeline</h2>
      {#if streamError !== null}
        <p class="card-empty">{streamError}</p>
      {:else if timeline.length === 0}
        <p class="card-empty">No events recorded yet.</p>
      {:else}
        <ol class="timeline">
          {#each timeline as entry (entry.eventIndex)}
            <li class="tl-row">
              <span class="tl-index">#{entry.eventIndex}</span>
              <span class="tl-dot {statusTone(entry.event.state)}"></span>
              <div class="tl-body">
                <div class="tl-head">
                  <span class="tl-state">{entry.event.state}</span>
                  <span class="tl-age">{relativeAge(entry.event.at, nowMs)}</span>
                </div>
                <p class="tl-summary">{entry.event.summary}</p>
                {#if Object.keys(entry.event.refs).length > 0}
                  <div class="tl-refs">
                    {#each Object.entries(entry.event.refs) as [key, value] (key)}
                      <span class="tl-ref"
                        ><span class="k">{key}</span> {value}</span
                      >
                    {/each}
                  </div>
                {/if}
              </div>
            </li>
          {/each}
        </ol>
      {/if}
    </section>

    {#if statusError !== null}
      <div class="banner" role="alert">Status: {statusError}</div>
    {/if}
  {/if}
</div>
