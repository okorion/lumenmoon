import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".example",
  ".html",
  ".json",
  ".md",
  ".sql",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".webmanifest",
  ".xml",
  ".yml",
  ".yaml",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".vercel",
  "dist",
  "node_modules",
  "test-results",
]);

describe("루멘문 브랜드와 최소 HUD", () => {
  it("이전 프로젝트 이름을 사용자 문구와 내부 저장 키에서 모두 제거한다", async () => {
    const files = await textFiles(ROOT);
    const violations: string[] = [];
    const koreanLegacy = new RegExp(
      ["한", "칸(?:을)?", "더"].join("\\s*"),
      "u",
    );
    const englishLegacy = new RegExp(
      ["one", "more", "block"].join("[-_ :]*"),
      "iu",
    );
    const compactLegacy = new RegExp(["one", "more", "block"].join(""), "iu");
    const oldEnglishName = new RegExp(["lumen", "morn"].join(""), "iu");
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (
        koreanLegacy.test(content) ||
        englishLegacy.test(content) ||
        compactLegacy.test(content) ||
        oldEnglishName.test(content)
      ) {
        violations.push(relative(ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("세로 화면은 페이지 스크롤 없이 접힌 HUD와 44px 조작을 사용한다", async () => {
    const [ui, css] = await Promise.all([
      readFile(join(ROOT, "src/ui/GameUI.ts"), "utf8"),
      readFile(join(ROOT, "src/style.css"), "utf8"),
    ]);
    expect(ui).toContain('id="world-panel-toggle"');
    expect(ui).toContain('id="mission-panel-toggle"');
    expect(ui).toContain('id="build-inventory-count"');
    expect(ui).toContain('id="palette-toggle"');
    expect(css).toContain("@media (max-width: 760px) and (orientation: portrait)");
    expect(css).toMatch(/#app\s*\{[^}]*height:\s*100dvh;[^}]*max-height:\s*100dvh;/su);
    expect(css).toMatch(/\.build-tray\s*\{[^}]*min-width:\s*0;/su);
    expect(css).toMatch(/\.mission-panel\.is-collapsed/su);
    expect(css).toMatch(/\.world-panel-toggle,[\s\S]*min-height:\s*44px;/u);
  });
});

async function textFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await textFiles(path)));
    } else if (TEXT_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}
