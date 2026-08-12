import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? "4185");
const baseURL = `http://127.0.0.1:${port}`;
const supabaseUrl =
  process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:54321";
const supabaseAnonKey = process.env.SUPABASE_TEST_ANON_KEY ?? "";
const browserChannel =
  process.env.PLAYWRIGHT_CHANNEL ??
  (process.platform === "win32" ? "msedge" : undefined);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/playwright",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [["list"]],
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ...(browserChannel ? { channel: browserChannel } : {}),
    // 온라인 익명 세션의 Authorization 헤더가 trace archive에 들어갈 수 있다.
    // E2E 증거는 공개 UI screenshot과 비식별 성능 JSON만 보존한다.
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: process.env.CI !== "true",
    timeout: 60_000,
    env: {
      ...process.env,
      VITE_REPOSITORY_MODE: process.env.E2E_REPOSITORY_MODE ?? "online",
      VITE_SUPABASE_URL: supabaseUrl,
      VITE_SUPABASE_ANON_KEY: supabaseAnonKey,
      VITE_SUPABASE_WORLD_ID: "00000000-0000-4000-8000-000000000001",
      VITE_ANALYTICS_ENABLED: "false",
      VITE_ANALYTICS_ENV: "test",
      VITE_PERF_HUD: "true",
    },
  },
});
