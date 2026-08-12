import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const OUTPUT_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

interface ProbeBlock {
  id: string;
  worldId: string;
  position: { x: number; y: number; z: number };
  kind: "cube" | "stair" | "light";
  rotation: 0 | 1 | 2 | 3;
  colorIndex: number;
  owner: {
    id: string;
    publicId: string;
    nickname: string;
    emblem: string;
  };
  zone: "public";
  createdAt: number;
}

interface RuntimeSnapshot {
  framesPerSecond: number;
  drawCalls: number;
  triangles: number;
  visibleBlockCount: number;
  activeChunkCount: number;
  sceneObjectCount: number;
  geometries: number;
  textures: number;
  pixelRatio: number;
}

interface RendererRuntime {
  renderer: {
    getContext(): WebGLRenderingContext | WebGL2RenderingContext;
  };
  setPlayerPose(
    position: { x: number; y: number; z: number },
    yaw: number,
    pitch: number,
  ): void;
  render(): void;
  getPerformanceSnapshot(): RuntimeSnapshot;
  dispose(): void;
}

interface RendererModule {
  LUMEN_SURFACE_ASSET_URLS: Readonly<{
    albedo: string;
    normal: string;
  }>;
  VoxelRenderer: new (
    canvas: HTMLCanvasElement,
    world: unknown,
    touchPreferred: boolean,
  ) => RendererRuntime;
}

interface WorldModule {
  VoxelWorld: new (worldId: string, blocks: readonly ProbeBlock[]) => unknown;
}

interface ProbeSample {
  cycle: number;
  geometries: number;
  textures: number;
  sceneObjectCount: number;
  activeChunks: number;
  drawCalls: number;
  visibleBlocks: number;
}

interface WarmupSample {
  attempt: number;
  textures: number;
}

test("실제 WebGL 청크 왕복 뒤 GPU 자원 수가 plateau를 유지한다", async ({
  page,
}) => {
  const browserErrors = {
    console: [] as string[],
    page: 0,
    failedRequests: 0,
    http: 0,
  };
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/^Failed to load resource: the server responded with a status of \d+/u.test(
        message.text(),
      )
    ) {
      browserErrors.console.push(message.text().slice(0, 160));
    }
  });
  page.on("pageerror", () => {
    browserErrors.page += 1;
  });
  page.on("requestfailed", () => {
    browserErrors.failedRequests += 1;
  });
  page.on("response", (response) => {
    if (response.status() >= 400) browserErrors.http += 1;
  });

  await page.goto("/e2e/renderer-probe.html", {
    waitUntil: "domcontentloaded",
  });

  const probe = await page.evaluate(async () => {
    const rendererPath = "/src/rendering/VoxelRenderer.ts";
    const worldPath = "/src/domain/world.ts";
    const [rendererModule, worldModule] = (await Promise.all([
      import(/* @vite-ignore */ rendererPath),
      import(/* @vite-ignore */ worldPath),
    ])) as [RendererModule, WorldModule];

    const canvas = document.querySelector<HTMLCanvasElement>("#renderer-probe");
    if (!canvas) throw new Error("renderer probe canvas is missing");

    const worldId = "renderer-memory-probe";
    const owner = {
      id: "probe-owner",
      publicId: "#PR0B",
      nickname: "렌더러 점검자",
      emblem: "◆",
    };
    const kinds = ["cube", "stair", "light"] as const;
    const blocks: ProbeBlock[] = [];
    for (const chunkX of [-1, 0, 1, 7, 8, 9]) {
      kinds.forEach((kind, kindIndex) => {
        blocks.push({
          id: `probe-${chunkX}-${kind}`,
          worldId,
          position: {
            x: chunkX * 16 + 2 + kindIndex,
            y: kindIndex,
            z: 2,
          },
          kind,
          rotation: kindIndex as 0 | 1 | 2,
          colorIndex: kindIndex + 1,
          owner,
          zone: "public",
          createdAt: 0,
        });
      });
    }

    const world = new worldModule.VoxelWorld(worldId, blocks);
    const surfaceAssetUrls = Object.values(
      rendererModule.LUMEN_SURFACE_ASSET_URLS,
    );
    await Promise.all(
      surfaceAssetUrls.map(
        (source) =>
          new Promise<void>((resolveImage, rejectImage) => {
            const image = new Image();
            image.onload = () => resolveImage();
            image.onerror = () =>
              rejectImage(new Error(`renderer asset failed to load: ${source}`));
            image.src = source;
          }),
      ),
    );
    const renderer = new rendererModule.VoxelRenderer(canvas, world, false);
    const context = renderer.renderer.getContext();
    const contextType =
      typeof WebGL2RenderingContext !== "undefined" &&
      context instanceof WebGL2RenderingContext
        ? "webgl2"
        : "webgl";
    // yaw 0은 -Z를 본다. 블록 열을 시야 중앙에 두어 실제 draw/upload 뒤의
    // WebGLRenderer.info 자원 수를 비교한다.
    const near = { x: 3.5, y: 2, z: 8 };
    const far = { x: 131.5, y: 2, z: 8 };
    const samples: ProbeSample[] = [];

    const renderSettled = async (): Promise<void> => {
      renderer.render();
      await new Promise<void>((resolveFrame) => {
        requestAnimationFrame(() => {
          renderer.render();
          context.finish();
          resolveFrame();
        });
      });
    };

    try {
      renderer.setPlayerPose(near, 0, 0);
      renderer.render();
      context.finish();
      const fallbackTextureCount =
        renderer.getPerformanceSnapshot().textures;
      const expectedTextureCount =
        fallbackTextureCount + surfaceAssetUrls.length;
      const warmupSamples: WarmupSample[] = [];
      const warmupDeadline = performance.now() + 5_000;
      let stableTextureSamples = 0;

      while (stableTextureSamples < 2) {
        await renderSettled();
        const textureCount = renderer.getPerformanceSnapshot().textures;
        warmupSamples.push({
          attempt: warmupSamples.length + 1,
          textures: textureCount,
        });
        if (textureCount > expectedTextureCount) {
          throw new Error(
            `unexpected texture allocation during warm-up: ${textureCount} > ${expectedTextureCount}`,
          );
        }
        stableTextureSamples =
          textureCount === expectedTextureCount
            ? stableTextureSamples + 1
            : 0;
        if (performance.now() >= warmupDeadline) {
          throw new Error(
            `surface textures did not reach the expected GPU count: ${textureCount} !== ${expectedTextureCount}`,
          );
        }
      }

      for (let cycle = 1; cycle <= 8; cycle += 1) {
        renderer.setPlayerPose(far, 0, 0);
        await renderSettled();
        renderer.setPlayerPose(near, 0, 0);
        await renderSettled();
        const snapshot = renderer.getPerformanceSnapshot();
        samples.push({
          cycle,
          geometries: snapshot.geometries,
          textures: snapshot.textures,
          sceneObjectCount: snapshot.sceneObjectCount,
          activeChunks: snapshot.activeChunkCount,
          drawCalls: snapshot.drawCalls,
          visibleBlocks: snapshot.visibleBlockCount,
        });
      }
      return {
        contextType,
        samples,
        warmupSamples,
        fallbackTextureCount,
        expectedTextureCount,
        surfaceAssetCount: surfaceAssetUrls.length,
        disposed: true,
      };
    } finally {
      renderer.dispose();
    }
  });

  expect(probe.contextType).toBe("webgl2");
  expect(probe.disposed).toBe(true);
  expect(probe.samples).toHaveLength(8);
  expect(probe.surfaceAssetCount).toBe(2);
  expect(probe.expectedTextureCount).toBe(
    probe.fallbackTextureCount + probe.surfaceAssetCount,
  );
  expect(probe.warmupSamples.length).toBeGreaterThanOrEqual(2);
  expect(probe.warmupSamples.at(-1)?.textures).toBe(
    probe.expectedTextureCount,
  );
  const first = probe.samples[0];
  expect(first).toBeDefined();
  expect(first!.geometries).toBeGreaterThan(0);
  expect(first!.sceneObjectCount).toBeGreaterThan(0);
  expect(first!.activeChunks).toBeGreaterThan(0);
  expect(first!.visibleBlocks).toBeGreaterThan(0);
  expect(first!.drawCalls).toBeGreaterThan(0);

  for (const metric of [
    "geometries",
    "textures",
    "sceneObjectCount",
    "activeChunks",
  ] as const) {
    expect(
      probe.samples.map((sample) => sample[metric]),
      `${metric} must plateau after the warm-up cycle`,
    ).toEqual(Array.from({ length: probe.samples.length }, () => first![metric]));
  }
  expect(browserErrors).toEqual({
    console: [],
    page: 0,
    failedRequests: 0,
    http: 0,
  });

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await writeFile(
    resolve(OUTPUT_DIRECTORY, "renderer-memory-probe.json"),
    JSON.stringify(
      {
        measurement:
          "Playwright headless Edge WebGL2 on the Vite development server; Three.js GPU resource counters only, not JavaScript heap or a physical-device benchmark",
        cycles: probe.samples.length,
        fixture: "six X chunks with cube, stair, and light blocks",
        warmup:
          "the two moonstone surface images must load and add exactly two GPU textures before the eight measured chunk cycles",
        fallbackTextureCount: probe.fallbackTextureCount,
        expectedTextureCount: probe.expectedTextureCount,
        warmupSamples: probe.warmupSamples,
        browserErrors,
        samples: probe.samples,
        disposed: probe.disposed,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
});
