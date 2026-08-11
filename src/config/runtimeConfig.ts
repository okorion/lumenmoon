export type RepositoryMode = "local" | "online";

export type RuntimeRepositoryConfig =
  | {
      mode: "local";
    }
  | {
      mode: "online";
      supabaseUrl: string;
      supabaseAnonKey: string;
      worldId: string;
    };

export type EnvironmentSource = Readonly<
  Record<string, string | boolean | undefined>
>;

const SERVICE_ROLE_ENV_NAME = "VITE_SUPABASE_SERVICE_ROLE_KEY";
const FORBIDDEN_BROWSER_SECRET_NAME =
  /^VITE_.*(?:SERVICE[_-]?ROLE|SUPABASE.*SECRET)/iu;

/**
 * 저장소 모드는 반드시 명시한다. 온라인 설정 오류를 별도 로컬 월드로
 * 조용히 바꾸면 사용자가 공동 월드에 저장했다고 오인할 수 있기 때문이다.
 */
export function readRuntimeRepositoryConfig(
  environment: EnvironmentSource = import.meta.env,
): RuntimeRepositoryConfig {
  const mode = asTrimmedString(environment.VITE_REPOSITORY_MODE);

  const exposedSecretName = Object.entries(environment).find(
    ([name, value]) =>
      FORBIDDEN_BROWSER_SECRET_NAME.test(name) && Boolean(asTrimmedString(value)),
  )?.[0];
  if (exposedSecretName) {
    throw new Error(
      "service-role(SERVICE_ROLE) 또는 Supabase secret은 브라우저 환경 변수로 사용할 수 없습니다.",
    );
  }

  if (asTrimmedString(environment[SERVICE_ROLE_ENV_NAME])) {
    throw new Error(
      `${SERVICE_ROLE_ENV_NAME}는 브라우저 환경 변수로 사용할 수 없습니다.`,
    );
  }

  if (mode === "local") {
    return { mode };
  }

  if (mode !== "online") {
    throw new Error(
      "VITE_REPOSITORY_MODE를 local 또는 online으로 명시해야 합니다.",
    );
  }

  const supabaseUrl = asTrimmedString(environment.VITE_SUPABASE_URL);
  const supabaseAnonKey = asTrimmedString(environment.VITE_SUPABASE_ANON_KEY);
  const worldId = asTrimmedString(environment.VITE_SUPABASE_WORLD_ID);
  if (!supabaseUrl || !supabaseAnonKey || !worldId) {
    throw new Error(
      "온라인 모드에는 VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_SUPABASE_WORLD_ID가 필요합니다.",
    );
  }
  assertBrowserSafeSupabaseKey(supabaseAnonKey);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    throw new Error("VITE_SUPABASE_URL이 올바른 URL이 아닙니다.");
  }
  if (parsedUrl.protocol !== "https:" && !isLocalSupabaseUrl(parsedUrl)) {
    throw new Error(
      "VITE_SUPABASE_URL은 HTTPS 또는 로컬 Supabase 주소여야 합니다.",
    );
  }

  if (!isUuid(worldId)) {
    throw new Error("VITE_SUPABASE_WORLD_ID는 UUID여야 합니다.");
  }

  return { mode, supabaseUrl, supabaseAnonKey, worldId };
}

function asTrimmedString(value: string | boolean | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function isLocalSupabaseUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost")
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function assertBrowserSafeSupabaseKey(key: string): void {
  if (key.startsWith("sb_secret_")) {
    throw new Error(
      "Supabase secret/service-role 키는 브라우저에서 사용할 수 없습니다.",
    );
  }

  const segments = key.split(".");
  const encodedPayload = segments[1];
  if (segments.length !== 3 || !encodedPayload) {
    return;
  }
  try {
    const normalized = encodedPayload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as { role?: unknown };
    if (payload.role === "service_role") {
      throw new Error(
        "Supabase service-role JWT는 브라우저에서 사용할 수 없습니다.",
      );
    }
  } catch (error) {
    if (error instanceof Error && /service-role/u.test(error.message)) {
      throw error;
    }
    // JWT가 아닌 publishable/anon 키의 형식은 Supabase 클라이언트가 검증한다.
  }
}
