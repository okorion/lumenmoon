import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatFreeModeGrantCountdown } from "../src/ui/GameUI";

const ROOT = process.cwd();

describe("자유 건축 UI", () => {
  it("블록 충전까지 남은 시간을 시:분:초 또는 분:초로 표시한다", () => {
    expect(formatFreeModeGrantCountdown(3_600_000)).toBe("1:00:00");
    expect(formatFreeModeGrantCountdown(2_518_000)).toBe("41:58");
    expect(formatFreeModeGrantCountdown(-1)).toBe("00:00");
  });

  it("자유 건축을 기본값으로 두고 두 게임 방식을 명확히 설명한다", async () => {
    const ui = await readFile(join(ROOT, "src/ui/GameUI.ts"), "utf8");
    expect(ui).toContain('id="game-mode-picker"');
    expect(ui).toContain('type="radio" name="game-mode" value="free" checked');
    expect(ui).toContain('type="radio" name="game-mode" value="mission"');
    expect(ui).toContain("블록 30개 · 매시간 +5 · 최대 100개");
    expect(ui).toContain("시작 지점에서 조금 이동해 놓기");
    expect(ui).toContain("내 블록 바로 회수 · 타인 블록 3일 보호");
    expect(ui).toContain("자유 건축 시작");
    expect(ui).toContain("별빛 관문 시작");
  });

  it("자유 건축에서는 미션 UI와 미션 단축키를 열지 않는다", async () => {
    const [ui, css] = await Promise.all([
      readFile(join(ROOT, "src/ui/GameUI.ts"), "utf8"),
      readFile(join(ROOT, "src/style.css"), "utf8"),
    ]);
    expect(ui).toContain('this.gameShell.dataset["gameMode"] = mode');
    expect(ui).toMatch(
      /event\.code === "KeyM"[\s\S]*this\.gameMode === "mission"/u,
    );
    expect(ui).toMatch(
      /setMissionPanel\(state:[\s\S]*this\.gameMode === "free" \|\| state === null/u,
    );
    expect(css).toMatch(
      /\.game-shell\[data-game-mode="free"\] \.mission-panel,[\s\S]*\.shortcut-guide \{[\s\S]*display: none !important;/u,
    );
  });

  it("모바일 선택지는 44px 이상이며 시작 화면은 스크롤을 만들지 않는다", async () => {
    const css = await readFile(join(ROOT, "src/style.css"), "utf8");
    expect(css).toMatch(/\.game-mode-choice \{[\s\S]*min-height: 82px;/u);
    expect(css).toMatch(
      /@media \(pointer: coarse\), \(max-width: 760px\)[\s\S]*\.start-overlay \{[\s\S]*overflow: hidden;[\s\S]*touch-action: none;/u,
    );
    expect(css).toMatch(
      /\.game-shell\[data-game-mode="free"\] \.world-panel\.is-expanded \{[\s\S]*overflow: hidden;/u,
    );
    expect(css).toContain(
      ".game-shell:not(.is-world-entered) .profile-status-panel",
    );
    expect(css).toMatch(
      /\.game-shell:not\(\.is-world-entered\) \.performance-hud \{[\s\S]*visibility: hidden !important;[\s\S]*pointer-events: none !important;/u,
    );
    expect(css).toMatch(/\.recovery-notice \{[\s\S]*z-index: 82;/u);
  });
  it("공용 시작 지점은 미리보기부터 막고 이동 안내를 보여 준다", async () => {
    const app = await readFile(join(ROOT, "src/app/GameApp.ts"), "utf8");
    expect(app).toMatch(
      /if \(this\.gameMode === "free"\) \{[\s\S]*isFreeModeSpawnClearancePosition\(position\)[\s\S]*return false;/u,
    );
    expect(app).toMatch(
      /position\.y === 1[\s\S]*hasFreeModeDeterministicGround\(this\.world\.blocks, position\)/u,
    );
    expect(app).toContain("바닥이 있는 곳에 놓아 주세요");
    expect(app).toContain(
      "시작 지점과 광장으로 가는 길은 비워 두고 조금 떨어진 곳에 놓아 주세요",
    );
  });
});
