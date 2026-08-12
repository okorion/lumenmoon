import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("공개 메타데이터", () => {
  it("canonical, 대형 공유 카드와 구조화된 게임 정보를 제공한다", async () => {
    const html = await readFile(join(ROOT, "index.html"), "utf8");

    expect(html).toContain(
      '<link rel="canonical" href="https://lumenmoon.vercel.app/" />',
    );
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain(
      'content="https://lumenmoon.vercel.app/og/lumenmoon-og.jpg"',
    );

    const structuredData = html.match(
      /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/u,
    )?.[1];
    expect(structuredData).toBeDefined();
    expect(JSON.parse(structuredData ?? "{}")).toMatchObject({
      "@type": "VideoGame",
      name: "루멘문",
      alternateName: "Lumenmoon",
      isAccessibleForFree: true,
      inLanguage: "ko-KR",
    });
  });

  it("PWA manifest가 가로 우선 방향과 실제 설치 이미지를 선언한다", async () => {
    const manifest = JSON.parse(
      await readFile(join(ROOT, "public", "manifest.webmanifest"), "utf8"),
    ) as {
      orientation?: string;
      icons?: Array<{ src: string; sizes: string }>;
      screenshots?: Array<{ src: string; form_factor: string }>;
    };

    expect(manifest.orientation).toBe("landscape-primary");
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/icons/icon-192.png", sizes: "192x192" }),
        expect.objectContaining({ src: "/icons/icon-512.png", sizes: "512x512" }),
        expect.objectContaining({
          src: "/icons/icon-maskable-512.png",
          sizes: "512x512",
        }),
      ]),
    );
    expect(manifest.screenshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ form_factor: "wide" }),
        expect.objectContaining({ form_factor: "narrow" }),
      ]),
    );
  });

  it("README와 공유 메타데이터가 참조하는 이미지가 비어 있지 않다", async () => {
    const assets = [
      "docs/assets/lumenmoon-hero.jpg",
      "public/og/lumenmoon-og.jpg",
      "public/screenshots/lumenmoon-desktop.jpg",
      "public/screenshots/lumenmoon-mobile.jpg",
      "public/icons/icon-192.png",
      "public/icons/icon-512.png",
      "public/icons/icon-maskable-512.png",
    ];

    const sizes = await Promise.all(
      assets.map(async (asset) => (await stat(join(ROOT, asset))).size),
    );
    expect(sizes.every((size) => size > 1_024)).toBe(true);
  });

  it("Vercel이 Vite 산출물만 프로덕션에 배포한다", async () => {
    const config = JSON.parse(
      await readFile(join(ROOT, "vercel.json"), "utf8"),
    ) as {
      framework?: string;
      buildCommand?: string;
      outputDirectory?: string;
    };

    expect(config).toMatchObject({
      framework: "vite",
      buildCommand: "npm run build",
      outputDirectory: "dist",
    });
  });
});
