import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const OUTPUT_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

interface RendererSnapshot {
  drawCalls: number;
  geometries: number;
  textures: number;
  triangles: number;
  visibleBlockCount: number;
  activeChunkCount: number;
  pixelRatio: number;
}

interface VisualSnapshot extends RendererSnapshot {
  pixelSmoke: PixelSmoke;
}

interface PixelSmoke {
  sampleCount: number;
  meanLuminance: number;
  luminanceDeviation: number;
  visiblePixelRatio: number;
  highlightedPixelRatio: number;
  chromaticPixelRatio: number;
  quantizedColorCount: number;
}

declare global {
  interface Window {
    __lumenVisualRenderer?: {
      render(): void;
      dispose(): void;
      getPerformanceSnapshot(): RendererSnapshot;
    };
  }
}

test("루멘문 중앙 광장의 데스크톱·모바일 시각 예산을 고정한다", async ({
  page,
}) => {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const assetBudgetBytes = (
    await Promise.all(
      [
        "../public/textures/lumenmoon-moonstone-v1.webp",
        "../public/textures/lumenmoon-moonstone-normal-v1.webp",
      ].map(async (relativePath) =>
        (await stat(resolve(dirname(fileURLToPath(import.meta.url)), relativePath))).size,
      ),
    )
  ).reduce((total, size) => total + size, 0);
  expect(assetBudgetBytes).toBeLessThanOrEqual(32 * 1_024);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text().slice(0, 160));
  });
  page.on("pageerror", (error) => errors.push(error.name));

  await page.setViewportSize({ width: 1440, height: 900 });
  await openVisualProbe(page, false);
  const desktop = await settleAndRead(page);
  await page.screenshot({
    path: resolve(OUTPUT_DIRECTORY, "lumenmoon-world-desktop-1440x900.png"),
  });

  expect(desktop.drawCalls).toBeLessThanOrEqual(24);
  expect(desktop.geometries).toBeLessThanOrEqual(12);
  expect(desktop.textures).toBeLessThanOrEqual(8);
  expect(desktop.triangles).toBeGreaterThan(3_500);
  expect(desktop.visibleBlockCount).toBeGreaterThan(700);
  expect(desktop.activeChunkCount).toBeLessThanOrEqual(20);
  expect(desktop.pixelRatio).toBeLessThanOrEqual(1.6);
  expectHealthyPixels(desktop.pixelSmoke);
  await disposeVisualProbe(page);

  await page.setViewportSize({ width: 844, height: 390 });
  await openVisualProbe(page, true);
  const mobile = await settleAndRead(page);
  await page.screenshot({
    path: resolve(OUTPUT_DIRECTORY, "lumenmoon-world-mobile-844x390.png"),
  });

  expect(mobile.drawCalls).toBeLessThanOrEqual(desktop.drawCalls);
  expect(mobile.geometries).toBeLessThanOrEqual(desktop.geometries);
  expect(mobile.textures).toBeLessThanOrEqual(desktop.textures);
  expect(mobile.triangles).toBeGreaterThan(3_500);
  expect(mobile.visibleBlockCount).toBeGreaterThan(700);
  expect(mobile.activeChunkCount).toBeLessThanOrEqual(
    desktop.activeChunkCount,
  );
  expect(mobile.pixelRatio).toBeLessThanOrEqual(1.25);
  expectHealthyPixels(mobile.pixelSmoke);
  await disposeVisualProbe(page);

  expect(errors).toEqual([]);
  await writeFile(
    resolve(OUTPUT_DIRECTORY, "lumenmoon-world-visual-budget.json"),
    JSON.stringify(
      {
        measurement:
          "Playwright headless Edge WebGL2 on the Vite development server; not a physical-device FPS benchmark",
        desktop,
        mobile,
        assetBudgetBytes,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
});

async function openVisualProbe(page: Page, touchPreferred: boolean): Promise<void> {
  await page.goto("/e2e/renderer-probe.html", {
    waitUntil: "domcontentloaded",
  });
  await page.evaluate(async ({ touchPreferred }) => {
    document.documentElement.style.background = "#0a1025";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    const canvas = document.querySelector<HTMLCanvasElement>("#renderer-probe");
    if (!canvas) throw new Error("visual probe canvas is missing");
    canvas.style.width = "100vw";
    canvas.style.height = "100vh";

    await Promise.all(
      [
        "/textures/lumenmoon-moonstone-v1.webp",
        "/textures/lumenmoon-moonstone-normal-v1.webp",
      ].map(
        (source) =>
          new Promise<void>((resolveImage, rejectImage) => {
            const image = new Image();
            image.onload = () => resolveImage();
            image.onerror = () => rejectImage(new Error("visual asset failed"));
            image.src = source;
          }),
      ),
    );

    const rendererPath = "/src/rendering/VoxelRenderer.ts";
    const worldPath = "/src/domain/world.ts";
    const seedPath = "/src/world/seed.ts";
    const [rendererModule, worldModule, seedModule] = await Promise.all([
      import(/* @vite-ignore */ rendererPath),
      import(/* @vite-ignore */ worldPath),
      import(/* @vite-ignore */ seedPath),
    ]);
    const snapshot = seedModule.createSeedSnapshot(0);
    const world = new worldModule.VoxelWorld(snapshot.worldId, snapshot.blocks);
    const renderer = new rendererModule.VoxelRenderer(
      canvas,
      world,
      touchPreferred,
    );
    renderer.setPlayerPose({ x: 8.5, y: 6.4, z: 14.5 }, 0.515, -0.08);
    window.__lumenVisualRenderer = renderer;
  }, { touchPreferred });
}

async function settleAndRead(page: Page): Promise<VisualSnapshot> {
  await page.waitForTimeout(350);
  return page.evaluate(async () => {
    const renderer = window.__lumenVisualRenderer;
    if (!renderer) throw new Error("visual renderer is missing");
    for (let frame = 0; frame < 4; frame += 1) {
      renderer.render();
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    }
    renderer.render();
    const canvas = document.querySelector<HTMLCanvasElement>("#renderer-probe");
    const context = canvas?.getContext("webgl2");
    if (!context) throw new Error("visual probe WebGL2 context is missing");
    const width = context.drawingBufferWidth;
    const height = context.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);

    const targetSamples = 24_000;
    const pixelStride = Math.max(1, Math.floor(Math.sqrt((width * height) / targetSamples)));
    let sampleCount = 0;
    let luminanceSum = 0;
    let luminanceSquaredSum = 0;
    let visiblePixels = 0;
    let highlightedPixels = 0;
    let chromaticPixels = 0;
    const quantizedColors = new Set<number>();

    for (let y = 0; y < height; y += pixelStride) {
      for (let x = 0; x < width; x += pixelStride) {
        const offset = (y * width + x) * 4;
        const red = (pixels[offset] ?? 0) / 255;
        const green = (pixels[offset + 1] ?? 0) / 255;
        const blue = (pixels[offset + 2] ?? 0) / 255;
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
        const colorRange = Math.max(red, green, blue) - Math.min(red, green, blue);
        sampleCount += 1;
        luminanceSum += luminance;
        luminanceSquaredSum += luminance * luminance;
        if (Math.max(red, green, blue) >= 12 / 255) visiblePixels += 1;
        if (luminance >= 0.16) highlightedPixels += 1;
        if (colorRange >= 14 / 255) chromaticPixels += 1;
        quantizedColors.add(
          ((Math.floor(red * 15) & 0x0f) << 8) |
          ((Math.floor(green * 15) & 0x0f) << 4) |
          (Math.floor(blue * 15) & 0x0f),
        );
      }
    }

    const meanLuminance = luminanceSum / sampleCount;
    const luminanceVariance = Math.max(
      0,
      luminanceSquaredSum / sampleCount - meanLuminance * meanLuminance,
    );
    return {
      ...renderer.getPerformanceSnapshot(),
      pixelSmoke: {
        sampleCount,
        meanLuminance,
        luminanceDeviation: Math.sqrt(luminanceVariance),
        visiblePixelRatio: visiblePixels / sampleCount,
        highlightedPixelRatio: highlightedPixels / sampleCount,
        chromaticPixelRatio: chromaticPixels / sampleCount,
        quantizedColorCount: quantizedColors.size,
      },
    };
  });
}

function expectHealthyPixels(smoke: PixelSmoke): void {
  expect(smoke.sampleCount).toBeGreaterThan(10_000);
  expect(smoke.meanLuminance).toBeGreaterThan(0.025);
  expect(smoke.luminanceDeviation).toBeGreaterThan(0.025);
  expect(smoke.visiblePixelRatio).toBeGreaterThan(0.7);
  expect(smoke.highlightedPixelRatio).toBeGreaterThan(0.015);
  expect(smoke.chromaticPixelRatio).toBeGreaterThan(0.08);
  expect(smoke.quantizedColorCount).toBeGreaterThan(24);
}

async function disposeVisualProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__lumenVisualRenderer?.dispose();
    delete window.__lumenVisualRenderer;
  });
}
