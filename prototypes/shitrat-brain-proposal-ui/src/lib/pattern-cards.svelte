<script lang="ts">
  interface PatternReceipt {
    href: string;
    label: string;
  }

  interface PatternItem {
    receipts: PatternReceipt[];
    title: string;
    why: string;
  }

  interface Props {
    items: PatternItem[];
    label?: string;
  }

  const { items, label = "Pattern cards" }: Props = $props();
</script>

<section class="pattern-cards" aria-label={label}>
  {#each items as item}
    <article class="pattern-card">
      <h3>{item.title}</h3>
      <div class="pattern-card-receipts" aria-label="Receipts">
        <span>Receipt</span>
        {#each item.receipts as receipt}
          <a href={receipt.href}><code>{receipt.label}</code></a>
        {/each}
      </div>
      <p>{item.why}</p>
    </article>
  {/each}
</section>
