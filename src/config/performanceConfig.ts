import type { EnvironmentSource } from "./runtimeConfig";

/** 운영 빌드에서는 환경 값이 잘못 들어가도 개발 HUD를 노출하지 않는다. */
export function isPerformanceHudEnabled(
  environment: EnvironmentSource,
  development: boolean,
): boolean {
  return development && environment.VITE_PERF_HUD === "true";
}
