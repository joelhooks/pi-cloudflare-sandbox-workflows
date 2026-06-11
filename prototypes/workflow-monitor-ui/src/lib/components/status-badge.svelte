<script lang="ts">
  import { isTerminalState, statusTone } from "$lib/format";
  import type { SafetyEnvelopeState } from "$lib/schemas";

  interface Props {
    state: SafetyEnvelopeState;
  }

  const { state }: Props = $props();
  const tone = $derived(statusTone(state));
  const lifecycle = $derived(isTerminalState(state) ? "terminal" : "in-flight");
</script>

<span class="badge {tone}">{state}</span>
<span class="lifecycle" class:inflight={lifecycle === "in-flight"}
  >{lifecycle}</span
>
