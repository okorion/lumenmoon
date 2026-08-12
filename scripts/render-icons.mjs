import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const source = await readFile(resolve(root, "public/icon.svg"), "utf8");
const browser = await chromium.launch({
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});

try {
  const page = await browser.newPage();
  for (const [name, size] of [
    ["icon-180.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-512.png", 512],
  ]) {
    const renderedSource = name.includes("maskable")
      ? source
          .replace(
            '<rect width="192" height="192" rx="42" fill="#091224"/>',
            '<rect width="192" height="192" fill="#091224"/>',
          )
          .replace(
            '<rect x="10" y="10" width="172" height="172" rx="34" fill="url(#sky)"/>',
            '<rect width="192" height="192" fill="url(#sky)"/>',
          )
      : source;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>${renderedSource}`,
    );
    await page.locator("svg").screenshot({
      path: resolve(root, "public/icons", name),
      omitBackground: true,
    });
  }
} finally {
  await browser.close();
}
