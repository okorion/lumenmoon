export type AnalyticsEnvironment = "production" | "staging" | "development" | "test";

export interface RuntimeAnalyticsConfig {
  enabled: boolean;
  projectKey: string | null;
  host: string;
  environment: AnalyticsEnvironment;
  diagnosticLogging: boolean;
}

export type AnalyticsEnvironmentSource = Readonly<
  Record<string, string | boolean | undefined>
>;

const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

/**
 * 분석 설정은 저장소 설정과 독립적으로 읽는다. 잘못되거나 비어 있는 분석
 * 설정은 언제나 비활성 상태가 되며 게임 부팅을 막지 않는다.
 */
export function readRuntimeAnalyticsConfig(
  environment: AnalyticsEnvironmentSource = import.meta.env,
): RuntimeAnalyticsConfig {
  const mode = asTrimmedString(environment.MODE).toLowerCase();
  const analyticsEnvironment = normalizeEnvironment(
    asTrimmedString(environment.VITE_ANALYTICS_ENV) || mode,
  );
  const explicitlyEnabled =
    asTrimmedString(environment.VITE_ANALYTICS_ENABLED).toLowerCase() === "true";
  const projectKey = asTrimmedString(environment.VITE_POSTHOG_KEY) || null;
  const requestedHost =
    asTrimmedString(environment.VITE_POSTHOG_HOST) || DEFAULT_POSTHOG_HOST;
  const host = safePostHogHost(requestedHost) ?? DEFAULT_POSTHOG_HOST;

  return {
    enabled: explicitlyEnabled && projectKey !== null,
    projectKey,
    host,
    environment: analyticsEnvironment,
    diagnosticLogging:
      analyticsEnvironment === "development" || analyticsEnvironment === "test",
  };
}

export function canUseExternalAnalytics(
  config: RuntimeAnalyticsConfig,
  runtime: {
    hostname?: string;
    webdriver?: boolean;
  } = {},
): boolean {
  const hostname = (runtime.hostname ?? "").toLowerCase();
  const local =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost");
  return (
    config.enabled &&
    config.projectKey !== null &&
    config.environment !== "test" &&
    !runtime.webdriver &&
    !local
  );
}

function normalizeEnvironment(value: string): AnalyticsEnvironment {
  switch (value) {
    case "production":
      return "production";
    case "staging":
      return "staging";
    case "test":
      return "test";
    default:
      return "development";
  }
}

function safePostHogHost(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function asTrimmedString(value: string | boolean | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}
