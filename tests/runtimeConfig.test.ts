import { describe, expect, it } from "vitest";
import { readRuntimeRepositoryConfig } from "../src/config/runtimeConfig";
import { createRepositorySelection } from "../src/data/repositoryFactory";
import { WORLD_ID as LOCAL_WORLD_ID } from "../src/domain/types";

const WORLD_ID = "00000000-0000-4000-8000-000000000001";

describe("readRuntimeRepositoryConfig", () => {
  it("local 모드를 명시적으로 선택한다", () => {
    expect(
      readRuntimeRepositoryConfig({ VITE_REPOSITORY_MODE: "local" }),
    ).toEqual({ mode: "local" });
  });

  it("온라인 모드에 URL, anon 키, UUID 월드를 요구한다", () => {
    expect(
      readRuntimeRepositoryConfig({
        VITE_REPOSITORY_MODE: "online",
        VITE_SUPABASE_URL: "https://example.supabase.co",
        VITE_SUPABASE_ANON_KEY: "publishable-test-key",
        VITE_SUPABASE_WORLD_ID: WORLD_ID,
      }),
    ).toEqual({
      mode: "online",
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "publishable-test-key",
      worldId: WORLD_ID,
    });
  });

  it("모드 누락이나 불완전한 온라인 설정을 로컬로 바꾸지 않는다", () => {
    expect(() => readRuntimeRepositoryConfig({})).toThrow(
      /VITE_REPOSITORY_MODE/,
    );
    expect(() =>
      readRuntimeRepositoryConfig({ VITE_REPOSITORY_MODE: "online" }),
    ).toThrow(/VITE_SUPABASE_URL/);
  });

  it("브라우저 service-role 환경 변수를 거부한다", () => {
    expect(() =>
      readRuntimeRepositoryConfig({
        VITE_REPOSITORY_MODE: "local",
        VITE_SUPABASE_SERVICE_ROLE_KEY: "must-not-be-here",
      }),
    ).toThrow(/SERVICE_ROLE/iu);

    expect(() =>
      readRuntimeRepositoryConfig({
        VITE_REPOSITORY_MODE: "online",
        VITE_SUPABASE_URL: "https://example.supabase.co",
        VITE_SUPABASE_ANON_KEY: "sb_secret_browser-forbidden",
        VITE_SUPABASE_WORLD_ID: WORLD_ID,
      }),
    ).toThrow(/secret\/service-role/iu);

    expect(() =>
      readRuntimeRepositoryConfig({
        VITE_REPOSITORY_MODE: "local",
        VITE_DATABASE_SERVICE_ROLE: "renamed-but-still-forbidden",
      }),
    ).toThrow(/service-role/iu);

    expect(() =>
      readRuntimeRepositoryConfig({
        VITE_REPOSITORY_MODE: "local",
        VITE_SUPABASE_PROJECT_SECRET: "browser-secret",
      }),
    ).toThrow(/Supabase secret/iu);

    const serviceRoleJwt = `header.${Buffer.from(
      JSON.stringify({ role: "service_role" }),
    ).toString("base64url")}.signature`;
    expect(() =>
      readRuntimeRepositoryConfig({
        VITE_REPOSITORY_MODE: "online",
        VITE_SUPABASE_URL: "https://example.supabase.co",
        VITE_SUPABASE_ANON_KEY: serviceRoleJwt,
        VITE_SUPABASE_WORLD_ID: WORLD_ID,
      }),
    ).toThrow(/service-role JWT/iu);
  });

  it("원격 HTTP URL은 거부하고 로컬 Supabase HTTP만 허용한다", () => {
    expect(() =>
      readRuntimeRepositoryConfig({
        VITE_REPOSITORY_MODE: "online",
        VITE_SUPABASE_URL: "http://example.com",
        VITE_SUPABASE_ANON_KEY: "test",
        VITE_SUPABASE_WORLD_ID: WORLD_ID,
      }),
    ).toThrow(/HTTPS/);

    expect(
      readRuntimeRepositoryConfig({
        VITE_REPOSITORY_MODE: "online",
        VITE_SUPABASE_URL: "http://127.0.0.1:54321",
        VITE_SUPABASE_ANON_KEY: "test",
        VITE_SUPABASE_WORLD_ID: WORLD_ID,
      }).mode,
    ).toBe("online");
  });
});

describe("createRepositorySelection", () => {
  it("IndexedDB가 없는 명시적 local 모드만 메모리 저장소로 대체한다", async () => {
    const original = globalThis.indexedDB;
    Reflect.deleteProperty(globalThis, "indexedDB");
    try {
      const selection = createRepositorySelection({ mode: "local" });
      expect(selection.mode).toBe("local");
      expect(selection.warnings).toHaveLength(1);
      expect(
        (await selection.repository.bootstrapPlayer(LOCAL_WORLD_ID)).progress
          .inventory,
      ).toBe(24);
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "indexedDB", {
          configurable: true,
          value: original,
        });
      }
    }
  });

  it("online 선택에는 로컬 fallback과 경고를 만들지 않는다", () => {
    const selection = createRepositorySelection({
      mode: "online",
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "publishable-test-key",
      worldId: WORLD_ID,
    });
    expect(selection.mode).toBe("online");
    expect(selection.worldId).toBe(WORLD_ID);
    expect(selection.repository.mode).toBe("online");
    expect(selection.warnings).toEqual([]);
  });
});
