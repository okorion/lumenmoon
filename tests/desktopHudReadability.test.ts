import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DESKTOP_MARKER = "/* Desktop HUD readability";

describe("desktop HUD readability", () => {
  it("limits the larger scale to fine-pointer desktop viewports", async () => {
    const css = await readFile(join(ROOT, "src/style.css"), "utf8");
    const desktopRules = css.slice(css.indexOf(DESKTOP_MARKER));

    expect(desktopRules).toContain(
      "@media (hover: hover) and (pointer: fine) and (min-width: 1024px)",
    );
    expect(desktopRules).not.toContain("pointer: coarse");
    expect(desktopRules).toContain("--control-height: 40px");
    expect(desktopRules).toContain("--desktop-hud-body: 12px");
    expect(css).toMatch(
      /@media \(pointer: fine\) and \(min-width: 761px\)[\s\S]*?\.game-shell:has\(\.world-panel\.is-expanded\) \.mission-panel/u,
    );
  });

  it("scales every core desktop HUD surface without removing size caps", async () => {
    const css = await readFile(join(ROOT, "src/style.css"), "utf8");
    const desktopRules = css.slice(css.indexOf(DESKTOP_MARKER));

    for (const selector of [
      ".profile-status-panel.world-panel",
      ".mission-panel",
      ".owner-tooltip",
      ".owner-card",
      ".build-tray",
      ".action-hint",
      ".analytics-settings-shell",
    ]) {
      expect(desktopRules, `${selector} desktop rule`).toContain(selector);
    }

    expect(desktopRules).toContain("max-height: calc(100dvh - 188px)");
    expect(desktopRules).toContain("width: min(420px, calc(100vw - 48px))");
    expect(desktopRules).toContain("max-width: min(680px, calc(100vw - 104px))");
  });
});
