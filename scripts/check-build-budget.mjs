import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { stdout } from "node:process";
import { gzipSync } from "node:zlib";

const kibibyte = 1_024;
const budgets = {
  mainJavaScriptRaw: 800 * kibibyte,
  mainJavaScriptGzip: 210 * kibibyte,
  moonstoneTextures: 32 * kibibyte,
};
const root = resolve(import.meta.dirname, "..");
const assetsDirectory = resolve(root, "dist", "assets");
const assetNames = await readdir(assetsDirectory);
const mainCandidates = assetNames.filter(
  (name) => name.startsWith("index-") && name.endsWith(".js"),
);

if (mainCandidates.length !== 1) {
  throw new Error(
    `Expected exactly one main index JavaScript chunk, found ${mainCandidates.length}.`,
  );
}

const mainPath = resolve(assetsDirectory, mainCandidates[0]);
const mainSource = await readFile(mainPath);
const mainRawBytes = mainSource.byteLength;
const mainGzipBytes = gzipSync(mainSource, { level: 9 }).byteLength;
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
  `[build-budget] PASS main=${mainRawBytes} B raw/${mainGzipBytes} B gzip, textures=${textureBytes} B\n`,
);
