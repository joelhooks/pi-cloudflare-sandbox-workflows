import matter from "gray-matter";
import type { Schema } from "hast-util-sanitize";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

export interface RenderedMarkdown {
  data: Record<string, unknown>;
  html: string;
}

const schema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      ["className"],
      ["target"],
      ["rel"],
    ],
    code: [...(defaultSchema.attributes?.code ?? []), ["className"]],
    h1: [...(defaultSchema.attributes?.h1 ?? []), ["id"]],
    h2: [...(defaultSchema.attributes?.h2 ?? []), ["id"]],
    h3: [...(defaultSchema.attributes?.h3 ?? []), ["id"]],
    h4: [...(defaultSchema.attributes?.h4 ?? []), ["id"]],
    h5: [...(defaultSchema.attributes?.h5 ?? []), ["id"]],
    h6: [...(defaultSchema.attributes?.h6 ?? []), ["id"]],
  },
};

export const renderMarkdown = async (
  markdown: string
): Promise<RenderedMarkdown> => {
  const parsed = matter(markdown);
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: "wrap" })
    .use(rehypeSanitize, schema)
    .use(rehypeStringify)
    .process(parsed.content);

  return {
    data: parsed.data,
    html: String(file),
  };
};
