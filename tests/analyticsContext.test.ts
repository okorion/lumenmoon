import { describe, expect, it } from "vitest";
import {
  bucketRendererTier,
  bucketWorldReadyMs,
  classifyAcquisition,
  classifyAnalyticsDevice,
  classifyInputMode,
  classifyOrientation,
  coarseAnalyticsZone,
} from "../src/app/analyticsContext";

describe("analytics context", () => {
  it("원시 referrer를 보존하지 않고 유입 범주만 만든다", () => {
    expect(classifyAcquisition("")).toBe("direct");
    expect(classifyAcquisition("https://www.google.com/search?q=secret")).toBe(
      "search",
    );
    expect(classifyAcquisition("https://www.instagram.com/private/path")).toBe(
      "social",
    );
    expect(classifyAcquisition("https://example.com/private?token=x")).toBe(
      "referral",
    );
    expect(classifyAcquisition("not a url")).toBe("unknown");
  });

  it("뷰포트와 터치 여부만으로 장치·입력·방향을 분류한다", () => {
    expect(
      classifyAnalyticsDevice({
        viewportWidth: 390,
        viewportHeight: 844,
        touchPoints: 5,
      }),
    ).toBe("mobile");
    expect(
      classifyAnalyticsDevice({
        viewportWidth: 1024,
        viewportHeight: 768,
        touchPoints: 5,
      }),
    ).toBe("tablet");
    expect(
      classifyAnalyticsDevice({
        viewportWidth: 390,
        viewportHeight: 844,
        touchPoints: 0,
      }),
    ).toBe("desktop");
    expect(classifyInputMode(1)).toBe("touch");
    expect(classifyOrientation(390, 844)).toBe("portrait");
  });

  it("성능 원시값을 고정 구간으로만 바꾼다", () => {
    expect(bucketWorldReadyMs(999)).toBe("under_1s");
    expect(bucketWorldReadyMs(3_200)).toBe("3s_to_10s");
    expect(bucketWorldReadyMs(15_000)).toBe("over_10s");
    expect(bucketRendererTier(undefined)).toBe("unknown");
    expect(bucketRendererTier(4)).toBe("low");
    expect(bucketRendererTier(16)).toBe("high");
  });

  it("정확 좌표 대신 다섯 개 체류 구역만 반환한다", () => {
    expect(coarseAnalyticsZone("personal", false)).toBe("personal");
    expect(coarseAnalyticsZone("system", false)).toBe("public");
    expect(coarseAnalyticsZone("mission", true)).toBe("archive");
  });
});
