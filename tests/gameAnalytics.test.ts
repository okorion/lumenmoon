import { describe, expect, it, vi } from "vitest";
import { GameAnalytics } from "../src/app/GameAnalytics";
import type { PostHogClient } from "../src/analytics";
import type { RuntimeAnalyticsConfig } from "../src/config/analyticsConfig";

function analyticsConfig(): RuntimeAnalyticsConfig {
  return {
    enabled: true,
    projectKey: "phc_public_project_token",
    host: "https://eu.i.posthog.com",
    environment: "production",
    diagnosticLogging: false,
  };
}

function storageWith(choice: "allowed" | "undecided"): Storage {
  let value: string | null = choice === "allowed" ? choice : null;
  return {
    get length() {
      return value === null ? 0 : 1;
    },
    clear: () => {
      value = null;
    },
    getItem: () => value,
    key: () => (value === null ? null : "analytics-consent"),
    removeItem: () => {
      value = null;
    },
    setItem: (_key, next) => {
      value = next;
    },
  };
}

function postHogClient(
  capture: (eventName: string, properties: Record<string, unknown>) => void,
): PostHogClient {
  return {
    init: vi.fn(),
    capture,
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    reset: vi.fn(),
  };
}

describe("GameAnalytics consent boundary", () => {
  it("기존 동의자의 즉시 부팅 실패는 provider 준비 뒤 안전 enum으로 전송한다", async () => {
    const capture = vi.fn(
      (eventName: string, properties: Record<string, unknown>) => {
        void eventName;
        void properties;
      },
    );
    const loader = vi.fn(async () => postHogClient(capture));
    const analytics = GameAnalytics.create({
      config: analyticsConfig(),
      hostname: "game.example",
      webdriver: false,
      localStorage: storageWith("allowed"),
      device: {
        viewportWidth: 1280,
        viewportHeight: 720,
        touchPoints: 0,
      },
      loader,
    });

    analytics.failure("webgl_unsupported", "renderer", false, false);

    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(capture).toHaveBeenCalledWith("game_failure", {
      code: "webgl_unsupported",
      stage: "renderer",
      recoverable: false,
      retry_succeeded: false,
      device_class: "desktop",
      environment: "production",
    });
  });

  it("동의 전에 발생한 실패를 나중의 동의 뒤 소급 전송하지 않는다", async () => {
    const capture = vi.fn(
      (eventName: string, properties: Record<string, unknown>) => {
        void eventName;
        void properties;
      },
    );
    const loader = vi.fn(async () => postHogClient(capture));
    const analytics = GameAnalytics.create({
      config: analyticsConfig(),
      hostname: "game.example",
      webdriver: false,
      localStorage: storageWith("undecided"),
      device: {
        viewportWidth: 390,
        viewportHeight: 844,
        touchPoints: 5,
      },
      loader,
    });

    analytics.failure("repository_bootstrap_failed", "boot", false, false);
    await analytics.setConsent("allowed");

    expect(loader).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
  });

  it("철회 클릭 뒤에는 마지막 요약을 포함한 새 이벤트를 보내지 않는다", async () => {
    const capture = vi.fn(
      (eventName: string, properties: Record<string, unknown>) => {
        void eventName;
        void properties;
      },
    );
    const client = postHogClient(capture);
    const loader = vi.fn(async () => client);
    const analytics = GameAnalytics.create({
      config: analyticsConfig(),
      hostname: "game.example",
      webdriver: false,
      localStorage: storageWith("allowed"),
      device: {
        viewportWidth: 1280,
        viewportHeight: 720,
        touchPoints: 0,
      },
      loader,
    });

    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    analytics.worldControllable({
      progress_stage: "new_player",
      input_mode: "keyboard_mouse",
      orientation: "landscape",
      acquisition: "direct",
      world_ready_ms_bucket: "under_1s",
      renderer_tier_bucket: "medium",
    });
    await vi.waitFor(() =>
      expect(capture).toHaveBeenCalledWith(
        "game_session_started",
        expect.any(Object),
      ),
    );
    capture.mockClear();

    await analytics.setConsent("essential_only");
    analytics.increment("public_blocks_placed");
    analytics.checkpoint(true);

    expect(capture).not.toHaveBeenCalled();
    expect(client.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(client.reset).toHaveBeenCalledWith(true);
  });

  it("같은 페이지에서 재동의해도 세션 시작은 한 번이고 summary 순서는 이어진다", async () => {
    const capture = vi.fn(
      (eventName: string, properties: Record<string, unknown>) => {
        void eventName;
        void properties;
      },
    );
    const client = postHogClient(capture);
    const analytics = GameAnalytics.create({
      config: analyticsConfig(),
      hostname: "game.example",
      webdriver: false,
      localStorage: storageWith("allowed"),
      device: {
        viewportWidth: 1280,
        viewportHeight: 720,
        touchPoints: 0,
      },
      loader: vi.fn(async () => client),
    });
    await vi.waitFor(() => expect(client.init).toHaveBeenCalledTimes(1));
    analytics.worldControllable({
      progress_stage: "base_in_progress",
      input_mode: "keyboard_mouse",
      orientation: "landscape",
      acquisition: "direct",
      world_ready_ms_bucket: "under_1s",
      renderer_tier_bucket: "medium",
    });
    await vi.waitFor(() =>
      expect(capture).toHaveBeenCalledWith(
        "game_session_started",
        expect.any(Object),
      ),
    );
    analytics.increment("public_blocks_placed");
    analytics.checkpoint(false);

    await analytics.setConsent("essential_only");
    analytics.otherCreatorSeen("#OFF1");
    await analytics.setConsent("allowed");
    analytics.increment("personal_blocks_placed");
    analytics.checkpoint(false);

    const starts = capture.mock.calls.filter(
      ([eventName]) => eventName === "game_session_started",
    );
    const summaries = capture.mock.calls.filter(
      ([eventName]) => eventName === "game_session_summary",
    );
    expect(starts).toHaveLength(1);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.[1]).toMatchObject({ summary_sequence: 1 });
    expect(summaries[1]?.[1]).toMatchObject({
      summary_sequence: 2,
      public_blocks_placed: 0,
      personal_blocks_placed: 1,
      distinct_other_creators_seen_bucket: "0",
    });
  });

  it("허용 SDK 로드 중 철회하면 오래된 완료가 세션을 재개하지 않는다", async () => {
    const capture = vi.fn(
      (eventName: string, properties: Record<string, unknown>) => {
        void eventName;
        void properties;
      },
    );
    const client = postHogClient(capture);
    let resolveSecondLoad: ((client: PostHogClient) => void) | null = null;
    let loadCount = 0;
    const loader = vi.fn(() => {
      loadCount += 1;
      if (loadCount === 1) return Promise.resolve(client);
      return new Promise<PostHogClient>((resolve) => {
        resolveSecondLoad = resolve;
      });
    });
    const analytics = GameAnalytics.create({
      config: analyticsConfig(),
      hostname: "game.example",
      webdriver: false,
      localStorage: storageWith("allowed"),
      device: {
        viewportWidth: 390,
        viewportHeight: 844,
        touchPoints: 5,
      },
      loader,
    });
    await vi.waitFor(() => expect(client.init).toHaveBeenCalledTimes(1));
    analytics.worldControllable({
      progress_stage: "new_player",
      input_mode: "touch",
      orientation: "portrait",
      acquisition: "direct",
      world_ready_ms_bucket: "under_1s",
      renderer_tier_bucket: "low",
    });
    await vi.waitFor(() =>
      expect(capture).toHaveBeenCalledWith(
        "game_session_started",
        expect.any(Object),
      ),
    );
    await analytics.setConsent("essential_only");
    capture.mockClear();

    const allowing = analytics.setConsent("allowed");
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    const withdrawing = analytics.setConsent("essential_only");
    if (!resolveSecondLoad) throw new Error("test_second_loader_not_started");
    (resolveSecondLoad as (client: PostHogClient) => void)(client);
    await Promise.all([allowing, withdrawing]);

    analytics.otherCreatorSeen("#OFF2");
    analytics.increment("public_blocks_placed");
    analytics.checkpoint(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it("조준은 제작자 발견만 기록하고 명시적인 상세 열기만 카드 조회로 센다", async () => {
    const capture = vi.fn(
      (eventName: string, properties: Record<string, unknown>) => {
        void eventName;
        void properties;
      },
    );
    const client = postHogClient(capture);
    const analytics = GameAnalytics.create({
      config: analyticsConfig(),
      hostname: "game.example",
      webdriver: false,
      localStorage: storageWith("allowed"),
      device: {
        viewportWidth: 390,
        viewportHeight: 844,
        touchPoints: 5,
      },
      loader: vi.fn(async () => client),
    });
    await vi.waitFor(() => expect(client.init).toHaveBeenCalledTimes(1));
    analytics.worldControllable({
      progress_stage: "mission_contributor",
      input_mode: "touch",
      orientation: "portrait",
      acquisition: "direct",
      world_ready_ms_bucket: "under_1s",
      renderer_tier_bucket: "low",
    });
    await vi.waitFor(() =>
      expect(capture).toHaveBeenCalledWith(
        "game_session_started",
        expect.any(Object),
      ),
    );
    capture.mockClear();

    analytics.otherCreatorSeen("#VIEW");
    analytics.checkpoint(false);
    analytics.creatorDetailsOpened();
    analytics.checkpoint(false);

    const summaries = capture.mock.calls.filter(
      ([eventName]) => eventName === "game_session_summary",
    );
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.[1]).toMatchObject({
      creator_card_view_count: 0,
      distinct_other_creators_seen_bucket: "1",
    });
    expect(summaries[1]?.[1]).toMatchObject({
      creator_card_view_count: 1,
      distinct_other_creators_seen_bucket: "0",
    });
  });
});
