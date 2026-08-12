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

  it("기능 아이콘은 운영체제 글꼴 기호가 아닌 의미별 SVG를 사용한다", async () => {
    const [ui, icons] = await Promise.all([
      readFile(join(ROOT, "src/ui/GameUI.ts"), "utf8"),
      readFile(join(ROOT, "src/ui/icons.ts"), "utf8"),
    ]);
    expect(ui).toContain("creatorCrestSvg");
    expect(ui).toContain('uiIcon("cube")');
    expect(ui).toContain('uiIcon("stair")');
    expect(ui).toContain('uiIcon("lamp")');
    expect(ui).toContain('uiIcon("place")');
    expect(ui).toContain('uiIcon("remove")');
    expect(ui).not.toMatch(/[⚙⌄⌂◩↑↻−＋✓×→]/u);
    expect(icons).toContain('viewBox="0 0 24 24"');
    expect(icons).toContain('aria-hidden="true"');
    expect(icons).toContain('focusable="false"');
    expect(icons).toContain('"⬟": "emblem-pentagon"');
    expect(icons).toContain('"⬟": "오각"');
    expect(icons).not.toContain("emblem-hex");
  });

  it("루멘문 앱 아이콘은 달빛 관문 단일 실루엣을 사용한다", async () => {
    const icon = await readFile(join(ROOT, "public/icon.svg"), "utf8");
    expect(icon).toContain("달빛 관문을 형상화한 루멘문 아이콘");
    expect(icon.match(/<path\b/gu)).toHaveLength(4);
    expect(icon).not.toContain("<text");
  });

  it("접힌 미션 헤더는 제목과 액션의 방향을 분리해 내부 요소를 자르지 않는다", async () => {
    const [ui, css] = await Promise.all([
      readFile(join(ROOT, "src/ui/GameUI.ts"), "utf8"),
      readFile(join(ROOT, "src/style.css"), "utf8"),
    ]);
    expect(css).not.toContain(".mission-heading > div {");
    expect(css).toMatch(
      /\.mission-heading\s*>\s*\.mission-heading-actions\s*\{[^}]*flex-direction:\s*row;/su,
    );
    expect(ui).toContain('data-testid="profile-status-panel"');
    expect(ui).toContain('id="player-profile-nickname"');
    expect(ui).toContain('id="player-profile-public-id"');
    expect(ui).toMatch(
      /<\/aside>',\s*'<button id="analytics-settings-button"/u,
    );
    expect(css).toMatch(
      /\.profile-status-panel\.world-panel:not\(\.is-expanded\)\s*\{[^}]*height:\s*52px;/u,
    );
    expect(css).toMatch(
      /\.world-panel:not\(\.is-expanded\) \.progress-grid,[\s\S]*?\.world-panel:not\(\.is-expanded\) \.shortcut-guide\s*\{[^}]*display:\s*none;/u,
    );
    expect(css).toMatch(
      /Mobile HUD final cascade guard[\s\S]*\.mission-panel\.is-collapsed\s*\{[^}]*max-height:\s*52px;/u,
    );
  });

  it("회전과 외부 선택은 임시 패널 상태를 닫는다", async () => {
    const ui = await readFile(join(ROOT, "src/ui/GameUI.ts"), "utf8");
    expect(ui).toContain('window.addEventListener("orientationchange"');
    expect(ui).toContain('document.addEventListener(\n      "pointerdown"');
    expect(ui).toContain("currentLayoutOrientation()");
    expect(ui).toContain("this.closeTransientHudPanels();");
    expect(ui).toContain('aria-controls="palette-row"');
  });

  it("모든 버튼은 DOM 순서가 아닌 의미 계층으로 스타일을 선택한다", async () => {
    const [ui, bootFailure, css] = await Promise.all([
      readFile(join(ROOT, "src/ui/GameUI.ts"), "utf8"),
      readFile(join(ROOT, "src/app/bootFailure.ts"), "utf8"),
      readFile(join(ROOT, "src/style.css"), "utf8"),
    ]);
    expect(ui).toContain("ui-button--primary");
    expect(ui).toContain("ui-button--secondary");
    expect(ui).toContain("ui-button--danger");
    expect(ui).toContain("ui-button--quiet");
    expect(bootFailure).toContain(
      'button.className = "ui-button ui-button--primary"',
    );
    expect(css).not.toMatch(/\.hud-actions\s+button:first-child/u);
    expect(css).not.toMatch(/\.owner-actions\s+button:first-child/u);
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
