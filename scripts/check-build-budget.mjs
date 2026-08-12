import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { stdout } from "node:process";
import { gzipSync } from "node:zlib";
import { collectInitialJavaScriptPaths } from "./build-budget-utils.mjs";

const kibibyte = 1_024;
const budgets = {
  mainJavaScriptRaw: 800 * kibibyte,
  mainJavaScriptGzip: 210 * kibibyte,
  moonstoneTextures: 32 * kibibyte,
};
const root = resolve(import.meta.dirname, "..");
const distDirectory = resolve(root, "dist");
const indexHtml = await readFile(resolve(distDirectory, "index.html"), "utf8");
const htmlDeclaredJavaScriptPaths = collectInitialJavaScriptPaths(indexHtml);
if (htmlDeclaredJavaScriptPaths.length === 0) {
  throw new Error(
    "Expected at least one initial JavaScript asset in dist/index.html.",
  );
}
const initialSources = await Promise.all(
  htmlDeclaredJavaScriptPaths.map((path) => readFile(resolve(distDirectory, path))),
);
const mainRawBytes = initialSources.reduce(
  (total, source) => total + source.byteLength,
  0,
);
const mainGzipBytes = initialSources.reduce(
  (total, source) => total + gzipSync(source, { level: 9 }).byteLength,
  0,
);
const textureNames = [
  "lumenmoon-moonstone-v1.webp",
  "lumenmoon-moonstone-normal-v1.webp",
];
const textureBytes = (
  await Promise.all(
    textureNames.map(async (name) => (await stat(resolve(root, "dist", "textures", name))).size),
  )
).reduce((total, size) => total + size, 0);

const measurements = {
  mainJavaScriptRaw: mainRawBytes,
  mainJavaScriptGzip: mainGzipBytes,
  moonstoneTextures: textureBytes,
};

for (const [name, value] of Object.entries(measurements)) {
  const limit = budgets[name];
  if (value > limit) {
    throw new Error(`${name} exceeds budget: ${value} bytes > ${limit} bytes.`);
  }
}

stdout.write(
  `[build-budget] PASS html-declared=${mainRawBytes} B raw/${mainGzipBytes} B gzip (${htmlDeclaredJavaScriptPaths.join(", ")}), textures=${textureBytes} B\n`,
);
