import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { D2 } from "@terrastruct/d2";

const root = path.resolve(import.meta.dirname, "..");
const sourceDir = path.join(root, "figures");
const outputDir = path.join(root, "static", "figures");

const d2 = new D2();
await mkdir(outputDir, { recursive: true });

const sourceFiles = await readdir(sourceDir);
const files = sourceFiles.filter((file) => file.endsWith(".d2"));
const rendered = [];

for (const file of files) {
  const sourcePath = path.join(sourceDir, file);
  const source = await readFile(sourcePath, "utf-8");
  const name = file.replace(/\.d2$/u, "");
  const result = await d2.compile(source, {
    layout: "elk",
    pad: 48,
    scale: 1,
    themeID: 0,
  });
  const svg = await d2.render(result.diagram, {
    ...result.renderOptions,
    noXMLTag: true,
    salt: name,
  });
  const outputPath = path.join(outputDir, `${name}.svg`);
  await writeFile(outputPath, svg, "utf-8");

  const width = Number(svg.match(/\bwidth="([0-9.]+)"/u)?.[1] ?? 0);
  const height = Number(svg.match(/\bheight="([0-9.]+)"/u)?.[1] ?? 0);
  if (!width || !height) {
    throw new Error(`Could not read SVG dimensions for ${file}`);
  }
  if (height <= width) {
    throw new Error(
      `${file} rendered too wide (${width}×${height}). Use direction: down, shorter labels, or split the chart.`
    );
  }
  rendered.push(`${name}.svg ${width}×${height}`);
}

console.log(`Rendered ${rendered.length} D2 figure(s):`);
for (const line of rendered) {
  console.log(`- ${line}`);
}

process.exit(0);
