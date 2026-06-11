<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import StatusBadge from "$lib/components/status-badge.svelte";
  import { isTerminalState, looksStale, relativeAge } from "$lib/format";
  import {
    SafetyEnvelopeStateSchema,
    WorkflowRunsListDocumentSchema,
  } from "$lib/schemas";
  import type {
    SafetyEnvelopeState,
    WorkflowRunsListDocument,
  } from "$lib/schemas";

  const POLL_INTERVAL_MS = 4000;
  const STALE_THRESHOLD_MS = 90_000;

  const statusFilters = ["all", ...SafetyEnvelopeStateSchema.options] as const;
  type StatusFilter = (typeof statusFilters)[number];

  let document = $state<null | WorkflowRunsListDocument>(null);
  let errorMessage = $state<null | string>(null);
  let loading = $state(true);
  let paused = $state(false);
  let statusFilter = $state<StatusFilter>("all");
  let limit = $state(50);
  const limitOptions = [25, 50, 100, 200] as const;
  let lastUpdatedMs = $state<null | number>(null);
  let nowMs = $state(Date.now());

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  const buildUrl = (): string => {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (statusFilter !== "all") {
      params.set("status", statusFilter);
    }

    return `/api/runs?${params.toString()}`;
  };

  const refresh = async (): Promise<void> => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const response = await fetch(buildUrl(), {
        headers: { accept: "application/json" },
      });
      const body: unknown = await response.json();
      if (response.ok) {
        const parsed = WorkflowRunsListDocumentSchema.safeParse(body);
        if (parsed.success) {
          document = parsed.data;
          errorMessage = null;
          lastUpdatedMs = Date.now();
        } else {
          errorMessage = "Run list response did not match the expected shape.";
        }
      } else {
        errorMessage =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "object" &&
          body.error !== null &&
          "message" in body.error &&
          typeof body.error.message === "string"
            ? body.error.message
            : `Request failed with ${response.status}.`;
      }
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : "Could not load runs.";
    } finally {
      inFlight = false;
      loading = false;
      nowMs = Date.now();
    }
  };

  const onStatusChange = (event: Event): void => {
    const target = event.currentTarget;
    if (target instanceof HTMLSelectElement) {
      statusFilter = target.value as StatusFilter;
      loading = true;
      void refresh();
    }
  };

  const onLimitChange = (event: Event): void => {
    const target = event.currentTarget;
    if (target instanceof HTMLSelectElement) {
      limit = Number.parseInt(target.value, 10);
      loading = true;
      void refresh();
    }
  };

  const togglePause = (): void => {
    paused = !paused;
    if (!paused) {
      void refresh();
    }
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

  const runs = $derived(document?.runs ?? []);
  const blockedCount = $derived(
    runs.filter((run) => run.status === "blocked").length
  );
  const inFlightCount = $derived(
    runs.filter((run) => !isTerminalState(run.status)).length
  );

  const phaseHint = (state: SafetyEnvelopeState): string => {
    if (state.startsWith("planning") || state.startsWith("pinningPlan")) {
      return "planning";
    }
    if (state.startsWith("executing") || state.startsWith("verifying")) {
      return "executing";
    }
    if (state.startsWith("requesting") || state === "checkingEntitlements") {
      return "gating";
    }

    return "";
  };
</script>

<div class="shell">
  <header class="board-head">
    <div>
      <h1 class="board-title">Workflow Run Monitor</h1>
      <p class="board-subtitle">
        Live view of deployed runs — is it progressing, where is it, why is it
        blocked.
      </p>
    </div>
    <div class="board-controls">
      <div class="control-group">
        <span class="control-label">Status</span>
        <select
          value={statusFilter}
          onchange={onStatusChange}
          aria-label="Filter by status"
        >
          {#each statusFilters as option (option)}
            <option value={option}>{option}</option>
          {/each}
        </select>
      </div>
      <div class="control-group">
        <span class="control-label">Limit</span>
        <select value={limit} onchange={onLimitChange} aria-label="Row limit">
          {#each limitOptions as option (option)}
            <option value={option}>{option}</option>
          {/each}
        </select>
      </div>
      <button onclick={togglePause}>
        <span class="live-dot" class:paused></span>
        {paused ? "Paused" : "Live"}
      </button>
      <button onclick={() => void refresh()}>Refresh</button>
    </div>
  </header>

  <div class="meta-line">
    <span>{runs.length} shown</span>
    <span>{inFlightCount} in-flight</span>
    <span>{blockedCount} blocked</span>
    {#if lastUpdatedMs !== null}
      <span
        >updated {relativeAge(new Date(lastUpdatedMs).toISOString(), nowMs)}</span
      >
    {/if}
    <span>polling every {POLL_INTERVAL_MS / 1000}s</span>
  </div>

  {#if errorMessage !== null}
    <div class="banner" role="alert">
      Worker request failed: {errorMessage}
    </div>
  {/if}

  {#if loading && document === null}
    <div class="empty">
      <strong>Loading runs…</strong>
      Talking to the Worker.
    </div>
  {:else if runs.length === 0}
    <div class="empty">
      <strong>No runs to show.</strong>
      {#if statusFilter === "all"}
        Nothing has run yet, or the runs table is empty.
      {:else}
        No runs with status <code>{statusFilter}</code>.
      {/if}
    </div>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Status</th>
          <th>Last event</th>
          <th>Blocker</th>
        </tr>
      </thead>
      <tbody>
        {#each runs as run (run.runId)}
          {@const stale = looksStale(
            run.updatedAt,
            run.status,
            nowMs,
            STALE_THRESHOLD_MS
          )}
          {@const phase = phaseHint(run.status)}
          <tr class:is-stale={stale}>
            <td>
              <a class="run-id" href="/runs/{encodeURIComponent(run.runId)}"
                >{run.runId}</a
              >
              <span class="work-item">{run.workItemId}</span>
            </td>
            <td>
              <StatusBadge state={run.status} />
              {#if phase !== ""}
                <span class="phase-tag">{phase}</span>
              {/if}
            </td>
            <td>
              <span class="age" class:stale>{relativeAge(run.updatedAt, nowMs)}</span
              >
              {#if stale}
                <span class="phase-tag">no progress &gt; {STALE_THRESHOLD_MS /
                    1000}s</span>
              {/if}
            </td>
            <td>
              {#if run.blocker !== undefined}
                <div class="blocker">
                  <span class="blocker-code">{run.blocker.code}</span>
                  <div class="blocker-message">{run.blocker.message}</div>
                  {#if run.blocker.stepId !== undefined || run.blocker.nodeType !== undefined}
                    <div class="blocker-where">
                      {#if run.blocker.nodeType !== undefined}{run.blocker
                          .nodeType}{/if}{#if run.blocker.stepId !== undefined}
                        @ {run.blocker.stepId}{/if}
                    </div>
                  {/if}
                </div>
              {:else}
                <span class="dash">—</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
