<script lang="ts">
  interface Props {
    alt: string;
    caption: string;
    src: string;
    title: string;
    version?: string;
  }

  const {
    alt,
    caption,
    src,
    title,
    version = "20260608-d2-tufte",
  }: Props = $props();
  const href = $derived(`${src}?v=${version}`);
</script>

<figure class="flow-chart">
  <img {alt} decoding="async" loading="lazy" src={href} />
  <figcaption><strong>{title}</strong> — {caption}</figcaption>
</figure>
