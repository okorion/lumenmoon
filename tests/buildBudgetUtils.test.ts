import { describe, expect, it } from "vitest";
// 빌드 전에 Node가 직접 실행하는 순수 ESM 도우미라 TypeScript 산출물이 없다.
// @ts-expect-error JavaScript helper intentionally has no declaration file.
import { collectInitialJavaScriptPaths } from "../scripts/build-budget-utils.mjs";

describe("initial JavaScript budget discovery", () => {
  it("entry와 modulepreload를 중복 없이 모두 센다", () => {
    const html = [
      '<script crossorigin type="module" src="/assets/index-a.js"></script>',
      '<link href="/assets/three-b.js" rel="modulepreload" crossorigin>',
      '<link rel="modulepreload stylesheet" href="/assets/three-b.js">',
      '<link rel="stylesheet" href="/assets/index.css">',
    ].join("");

    expect(collectInitialJavaScriptPaths(html)).toEqual([
      "assets/index-a.js",
      "assets/three-b.js",
    ]);
  });

  it("외부 URL과 상위 경로를 초기 자산으로 허용하지 않는다", () => {
    expect(() =>
      collectInitialJavaScriptPaths(
        '<script type="module" src="https://example.com/app.js"></script>',
      ),
    ).toThrow(/local asset/);
    expect(() =>
      collectInitialJavaScriptPaths(
        '<link rel="modulepreload" href="../secret.js">',
      ),
    ).toThrow(/Invalid/);
  });
});
