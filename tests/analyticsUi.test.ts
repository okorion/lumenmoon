import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsConsentChoice } from "../src/analytics/types";
import {
  analyticsConsentLabel,
  releasePointerLockForDialog,
} from "../src/ui/GameUI";

afterEach(() => vi.unstubAllGlobals());

describe("분석 동의 UI", () => {
  it.each<[AnalyticsConsentChoice, string]>([
    ["undecided", "선택 전 · 보내지 않아요"],
    ["allowed", "익명 이용 정보 보내는 중"],
    ["essential_only", "게임 개선 정보 보내지 않음"],
  ])("%s 선택 상태를 명확하게 표시한다", (choice, expected) => {
    expect(analyticsConsentLabel(choice)).toBe(expected);
  });
});

describe("복구 UI Pointer Lock", () => {
  it("대화형 복구 버튼을 표시하기 전에 포인터 잠금을 해제한다", () => {
    const exitPointerLock = vi.fn();
    vi.stubGlobal("document", {
      pointerLockElement: {},
      exitPointerLock,
    });

    releasePointerLockForDialog();

    expect(exitPointerLock).toHaveBeenCalledOnce();
  });

  it("치명 오류 화면을 다른 모달보다 우선해 재시도 버튼을 활성화한다", async () => {
    const ui = await readFile(join(process.cwd(), "src/ui/GameUI.ts"), "utf8");

    expect(ui).toMatch(
      /private get activeDialog\(\): HTMLElement \| null \{\s*if \(!this\.fatalOverlay\.hidden\) return this\.fatalOverlay;/u,
    );
    expect(ui).toMatch(
      /this\.fatalOverlay\.hidden = false;\s*this\.syncExclusiveSurface\(\);/u,
    );
  });
});
