import { readdir, readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      ["node_modules", ".git", ".vercel", "tmp", "output"].includes(entry.name)
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(mjs|js)$/.test(path)) files.push(path);
  }
  return files;
}
for (const file of await sourceFiles(root)) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
}
const config = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));
assert.equal(config.outputDirectory, "public");
for (const name of [
  "index.html",
  "styles.css",
  "app.js",
  "csv.js",
  "favicon.svg",
])
  await access(join(root, "public", name));
const html = await readFile(join(root, "public/index.html"), "utf8");
const js = await readFile(join(root, "public/app.js"), "utf8");
const ids = new Set(
  [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
);
for (const match of js.matchAll(/\$\(["']([^"']+)["']\)/g)) {
  if (!match[1].endsWith("-"))
    assert(ids.has(match[1]), `Missing HTML element: ${match[1]}`);
}
for (const route of ["check", "health", "demo"]) {
  const module = await import(new URL(`../api/${route}.js`, import.meta.url));
  assert.equal(
    typeof module.default,
    "function",
    `Invalid API handler: ${route}`,
  );
}
console.log(
  "Checks passed: JavaScript syntax, UI bindings, static assets, Vercel configuration, and API imports.",
);
