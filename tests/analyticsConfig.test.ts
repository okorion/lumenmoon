import { describe, expect, it } from "vitest";
import {
  canUseExternalAnalytics,
  readRuntimeAnalyticsConfig,
} from "../src/config/analyticsConfig";

describe("analytics runtime config", () => {
  it("설정이 없으면 게임을 막지 않는 비활성 설정을 반환한다", () => {
    expect(readRuntimeAnalyticsConfig({ MODE: "development" })).toEqual({
      enabled: false,
      projectKey: null,
      host: "https://eu.i.posthog.com",
      environment: "development",
      diagnosticLogging: true,
    });
  });

  it("명시적으로 켜고 project key가 있을 때만 활성화한다", () => {
    const config = readRuntimeAnalyticsConfig({
      MODE: "production",
      VITE_ANALYTICS_ENABLED: "true",
      VITE_POSTHOG_KEY: "phc_public_project_token",
      VITE_POSTHOG_HOST: "https://us.i.posthog.com/capture",
    });

    expect(config).toMatchObject({
      enabled: true,
      projectKey: "phc_public_project_token",
      host: "https://us.i.posthog.com",
      environment: "production",
      diagnosticLogging: false,
    });
  });

  it("localhost, test, 자동화 브라우저에서는 외부 전송을 차단한다", () => {
    const config = readRuntimeAnalyticsConfig({
      MODE: "production",
      VITE_ANALYTICS_ENABLED: "true",
      VITE_POSTHOG_KEY: "phc_public_project_token",
    });

    expect(canUseExternalAnalytics(config, { hostname: "localhost" })).toBe(false);
    expect(canUseExternalAnalytics(config, { hostname: "127.0.0.1" })).toBe(false);
    expect(
      canUseExternalAnalytics(config, {
        hostname: "game.example",
        webdriver: true,
      }),
    ).toBe(false);
    expect(canUseExternalAnalytics(config, { hostname: "game.example" })).toBe(
      true,
    );
  });

  it("잘못된 HTTP host는 안전한 기본 HTTPS host로 대체한다", () => {
    const config = readRuntimeAnalyticsConfig({
      MODE: "staging",
      VITE_ANALYTICS_ENABLED: "true",
      VITE_POSTHOG_KEY: "phc_public_project_token",
      VITE_POSTHOG_HOST: "http://collector.example",
    });

    expect(config.host).toBe("https://eu.i.posthog.com");
    expect(config.environment).toBe("staging");
  });
});
