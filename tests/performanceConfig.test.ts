import { describe, expect, it } from "vitest";
import { isPerformanceHudEnabled } from "../src/config/performanceConfig";

describe("개발 성능 HUD 설정", () => {
  it("개발 환경의 명시적 true에서만 켠다", () => {
    expect(isPerformanceHudEnabled({ VITE_PERF_HUD: "true" }, true)).toBe(true);
    expect(isPerformanceHudEnabled({ VITE_PERF_HUD: "false" }, true)).toBe(false);
    expect(isPerformanceHudEnabled({}, true)).toBe(false);
    expect(isPerformanceHudEnabled({ VITE_PERF_HUD: "true" }, false)).toBe(false);
  });
});
