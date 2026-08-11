import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsConsentChoice } from "../src/analytics/types";
import {
  analyticsConsentLabel,
  releasePointerLockForDialog,
} from "../src/ui/GameUI";

afterEach(() => vi.unstubAllGlobals());

describe("분석 동의 UI", () => {
  it.each<[AnalyticsConsentChoice, string]>([
    ["undecided", "선택 전 · 통계를 보내지 않아요"],
    ["allowed", "익명 이용 통계 허용됨"],
    ["essential_only", "필수 데이터만 · 익명 통계 꺼짐"],
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
});
