import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("사운드 설정 UI와 게임 연결", () => {
  it("전체 켜기·끄기와 네 채널의 명시적 레이블을 제공한다", async () => {
    const [ui, panel] = await Promise.all([
      readFile(join(ROOT, "src/ui/GameUI.ts"), "utf8"),
      readFile(join(ROOT, "src/audio/SoundSettingsPanel.ts"), "utf8"),
    ]);

    expect(ui).toContain('id="sound-settings-mount"');
    expect(panel).toContain('id="sound-all-on"');
    expect(panel).toContain('id="sound-all-off"');
    expect(panel).toContain('soundRange("master", "전체 음량"');
    expect(panel).toContain('soundRange("music", "배경 음악"');
    expect(panel).toContain('soundRange("interface", "메뉴와 버튼"');
    expect(panel).toContain('soundRange("effects", "움직임과 블록"');
    expect(panel).toContain('<label for="${id}">${label}</label>');
    expect(panel).toContain('<input id="${id}"');
    expect(panel).toContain('<output id="${id}-output"');
    expect(panel).toContain('aria-live="polite"');
  });

  it("모든 슬라이더와 모바일 토글은 44px 터치 영역을 유지한다", async () => {
    const css = await readFile(join(ROOT, "src/style.css"), "utf8");

    expect(css).toMatch(
      /\.sound-toggle-actions \.ui-button \{[\s\S]*min-height: 44px;/u,
    );
    expect(css).toMatch(/\.sound-level \{[\s\S]*min-height: 44px;/u);
    expect(css).toMatch(
      /\.sound-level input\[type="range"\] \{[\s\S]*height: 44px;/u,
    );
  });

  it("블록과 움직임 효과음은 성공 또는 실제 입력 경로에서만 재생한다", async () => {
    const app = await readFile(join(ROOT, "src/app/GameApp.ts"), "utf8");

    expect(app).toMatch(
      /commitFreeModeActions\(request\)[\s\S]*applyFreeModeMutationOrRefresh\(attempt\.value\)[\s\S]*audio\.play\("place"\)/u,
    );
    expect(app).toMatch(
      /applyFreeModeMutationOrRefresh[\s\S]*reconcileFreeModeMutationResult[\s\S]*refreshFreeModeWorld\(true, true, true, true\)/u,
    );
    expect(app).toMatch(
      /commitWorldActions\(request\)[\s\S]*applyOnlineMutation\(result\)[\s\S]*audio\.play\("remove"\)/u,
    );
    expect(app).toContain('this.audio.play("jump")');
    expect(app).toContain('this.audio.play("footstep")');
    expect(app).toContain('this.audio.play("contribute")');
    expect(app).toContain('this.audio.setScene(this.gameMode)');
  });

  it("전체 또는 배경 음악이 0이면 음악 타이머와 노드를 멈춘다", async () => {
    const audio = await readFile(join(ROOT, "src/audio/GameAudio.ts"), "utf8");

    expect(audio).toMatch(
      /if \(!musicIsAudible\) \{[\s\S]*this\.stopMusic\(\)/u,
    );
    expect(audio).toMatch(
      /this\.preferencesValue\.master <= 0 \|\|[\s\S]*this\.preferencesValue\.music <= 0/u,
    );
  });
});
