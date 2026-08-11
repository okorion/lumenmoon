import { indexedDB } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsConsentController,
  createBrowserAnalyticsRuntime,
  GuardedAnalytics,
  IndexedDbAnalyticsMilestoneStore,
  MAX_ANALYTICS_EVENTS_PER_SESSION,
  MemoryAnalytics,
  MemoryAnalyticsConsentStore,
  MemoryAnalyticsMilestoneStore,
  NoopAnalytics,
  PostHogAnalytics,
  SessionAnalytics,
  sanitizePostHogEvent,
  type AnalyticsEvent,
  type ConsentControlledAnalytics,
  type GameFailureProperties,
  type GameSessionStartedProperties,
  type GameSessionSummaryProperties,
  type PostHogClient,
  type PostHogInitOptions,
} from "../src/analytics";

function startedProperties(): GameSessionStartedProperties {
  return {
    first_visit: true,
    progress_stage: "new_player",
    device_class: "desktop",
    input_mode: "keyboard_mouse",
    orientation: "landscape",
    app_version: "0.1.0",
    acquisition: "direct",
    world_ready_ms_bucket: "under_1s",
    renderer_tier_bucket: "medium",
  };
}

function summaryProperties(sequence: number): GameSessionSummaryProperties {
  return {
    active_seconds: 1,
    wall_seconds: 1,
    personal_zone_seconds: 1,
    producer_zone_seconds: 0,
    mission_zone_seconds: 0,
    public_zone_seconds: 0,
    archive_seconds: 0,
    personal_blocks_placed: 0,
    public_blocks_placed: 0,
    mission_blocks_placed: 0,
    own_blocks_removed: 0,
    foreign_blocks_removed: 0,
    manual_production_count: 0,
    creator_card_view_count: 0,
    distinct_other_creators_seen_bucket: "0",
    creator_highlight_count: 0,
    archive_open_count: 0,
    mission_contribution_count: 0,
    insufficient_inventory_count: 0,
    commit_failure_count: 0,
    context_loss_count: 0,
    average_fps_bucket: "55_plus",
    summary_sequence: sequence,
    final_summary: false,
  };
}

function postHogHarness(runtime = { hostname: "game.example", test: false, e2e: false }) {
  let options: PostHogInitOptions | null = null;
  const capture = vi.fn();
  const reset = vi.fn();
  const optOut = vi.fn();
  const optIn = vi.fn();
  const client: PostHogClient = {
    init: (_key, value) => {
      options = value;
    },
    capture,
    reset,
    opt_in_capturing: optIn,
    opt_out_capturing: optOut,
  };
  const loader = vi.fn(async () => client);
  const analytics = new PostHogAnalytics({
    projectKey: "phc_public_project_key",
    host: "https://eu.i.posthog.com",
    environment: "production",
    loader,
    runtime,
  });
  return {
    analytics,
    loader,
    capture,
    reset,
    optOut,
    optIn,
    getOptions: () => options,
  };
}

describe("analytics privacy and delivery guard", () => {
  it("설정이 비어 있으면 동의해도 비활성 분석으로 정상 동작한다", async () => {
    const runtime = createBrowserAnalyticsRuntime({
      enabled: true,
      environment: "development",
    });
    expect(await runtime.analytics.setConsent("allowed")).toBe(false);
    expect(runtime.analytics.isEnabled()).toBe(false);
    expect(
      runtime.analytics.capture("game_session_started", startedProperties()),
    ).toBe(false);
  });

  it("동의 전에는 SDK를 로드하지 않고 철회 시 식별자를 초기화한다", async () => {
    const harness = postHogHarness();
    const controller = new AnalyticsConsentController(
      new MemoryAnalyticsConsentStore(),
      () => harness.analytics,
    );

    expect(controller.capture("game_session_started", startedProperties())).toBe(false);
    expect(harness.loader).not.toHaveBeenCalled();
    await controller.setConsent("essential_only");
    expect(harness.loader).not.toHaveBeenCalled();

    expect(await controller.setConsent("allowed")).toBe(true);
    expect(harness.loader).toHaveBeenCalledTimes(1);
    expect(harness.optIn).toHaveBeenCalledWith({ captureEventName: false });
    expect(controller.capture("game_session_started", startedProperties())).toBe(true);
    await controller.withdraw();
    expect(harness.optOut).toHaveBeenCalledWith();
    expect(harness.reset).toHaveBeenCalledWith(true);
    expect(harness.reset.mock.invocationCallOrder[0]).toBeLessThan(
      harness.optOut.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(controller.capture("game_session_started", startedProperties())).toBe(false);

    expect(await controller.setConsent("allowed")).toBe(true);
    expect(harness.loader).toHaveBeenCalledTimes(2);
    expect(harness.optIn).toHaveBeenCalledTimes(2);
    expect(
      controller.capture("game_failure", {
        code: "storage_failed",
        stage: "world_read",
        recoverable: true,
        retry_succeeded: true,
        device_class: "desktop",
      }),
    ).toBe(true);
  });

  it("PostHog의 자동 수집과 세션 리플레이 설정을 전부 끈다", async () => {
    const harness = postHogHarness();
    await harness.analytics.enable();
    expect(harness.getOptions()).toMatchObject({
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_performance: false,
      disable_session_recording: true,
      person_profiles: "identified_only",
      respect_dnt: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      save_campaign_params: false,
      save_referrer: false,
      disable_capture_url_hashes: true,
      ip: false,
      advanced_disable_flags: true,
      advanced_disable_toolbar_metrics: true,
    });
  });

  it("SDK 로드 도중 철회해도 초기화하거나 전송 가능 상태가 되지 않는다", async () => {
    let resolveClient: ((client: PostHogClient) => void) | null = null;
    const init = vi.fn();
    const client: PostHogClient = { init, capture: vi.fn() };
    const analytics = new PostHogAnalytics({
      projectKey: "phc_public_project_key",
      host: "https://eu.i.posthog.com",
      environment: "production",
      loader: () =>
        new Promise((resolve) => {
          resolveClient = resolve;
        }),
      runtime: { hostname: "game.example", test: false, e2e: false },
    });

    const enabling = analytics.enable();
    analytics.disable();
    if (!resolveClient) throw new Error("test_loader_not_started");
    (resolveClient as (client: PostHogClient) => void)(client);
    expect(await enabling).toBe(false);
    expect(init).not.toHaveBeenCalled();
    expect(analytics.isEnabled()).toBe(false);
  });

  it("오래된 허용 완료가 더 최신 철회를 덮지 못한다", async () => {
    let resolveEnable: ((enabled: boolean) => void) | null = null;
    const provider: ConsentControlledAnalytics = {
      enable: () =>
        new Promise((resolve) => {
          resolveEnable = resolve;
        }),
      disable: vi.fn(),
      isEnabled: () => true,
      capture: () => true,
    };
    const controller = new AnalyticsConsentController(
      new MemoryAnalyticsConsentStore(),
      () => provider,
    );

    const allowing = controller.setConsent("allowed");
    await controller.setConsent("essential_only");
    if (!resolveEnable) throw new Error("test_enable_not_started");
    (resolveEnable as (enabled: boolean) => void)(true);

    expect(await allowing).toBe(false);
    expect(controller.choice).toBe("essential_only");
    expect(controller.isEnabled()).toBe(false);
    expect(provider.disable).toHaveBeenCalled();
  });

  it("localhost, 테스트, E2E에서는 loader 자체를 호출하지 않는다", async () => {
    for (const runtime of [
      { hostname: "localhost", test: false, e2e: false },
      { hostname: "game.example", test: true, e2e: false },
      { hostname: "game.example", test: false, e2e: true },
    ]) {
      const harness = postHogHarness(runtime);
      expect(await harness.analytics.enable()).toBe(false);
      expect(harness.loader).not.toHaveBeenCalled();
    }
  });

  it("이벤트·속성 allowlist 밖의 값과 4KB 초과 후보를 거절한다", () => {
    const analytics = new MemoryAnalytics();
    expect(
      analytics.capture("game_session_started", {
        ...startedProperties(),
        nickname: "금지된 닉네임",
      } as GameSessionStartedProperties),
    ).toBe(false);
    expect(
      analytics.capture("game_session_started", {
        ...startedProperties(),
        app_version: "x".repeat(5_000),
      }),
    ).toBe(false);
    expect(
      analytics.capture(
        "arbitrary_click" as "game_session_started",
        startedProperties(),
      ),
    ).toBe(false);
    expect(analytics.events).toHaveLength(0);
  });

  it("최종 필터가 UID·닉네임·공개 ID·좌표·URL·stack을 제거한다", () => {
    const output = sanitizePostHogEvent({
      event: "game_session_started",
      properties: {
        ...startedProperties(),
        environment: "production",
        auth_uid: "uid-secret",
        nickname: "nickname-secret",
        public_id: "#A123",
        x: 123,
        url: "https://example.test/?token=secret",
        token: "auth-secret",
        stack: "secret stack",
        "$current_url": "https://example.test/private",
        distinct_id: "anonymous-device",
        "$distinct_id": "anonymous-device",
      },
    });
    expect(output?.properties).toEqual({
      ...startedProperties(),
      environment: "production",
      distinct_id: "anonymous-device",
      "$distinct_id": "anonymous-device",
    });

    const protocolOutput = sanitizePostHogEvent(
      {
        event: "game_session_started",
        properties: {
          ...startedProperties(),
          environment: "production",
          token: "phc_public_project_key",
          distinct_id: "anonymous-device",
          $process_person_profile: false,
        },
      },
      "phc_public_project_key",
    );
    expect(protocolOutput?.properties).toMatchObject({
      token: "phc_public_project_key",
      distinct_id: "anonymous-device",
      $process_person_profile: false,
    });
  });

  it("세션당 20건과 summary sequence 중복을 막는다", () => {
    const analytics = new MemoryAnalytics();
    expect(analytics.capture("game_session_summary", summaryProperties(1))).toBe(true);
    expect(analytics.capture("game_session_summary", summaryProperties(1))).toBe(false);
    for (let index = 2; index <= MAX_ANALYTICS_EVENTS_PER_SESSION; index += 1) {
      expect(analytics.capture("game_session_summary", summaryProperties(index))).toBe(true);
    }
    expect(
      analytics.capture(
        "game_session_summary",
        summaryProperties(MAX_ANALYTICS_EVENTS_PER_SESSION + 1),
      ),
    ).toBe(false);
    expect(analytics.events).toHaveLength(MAX_ANALYTICS_EVENTS_PER_SESSION);
  });

  it("전송 예외를 호출자에게 전파하지 않는다", () => {
    class ThrowingAnalytics extends GuardedAnalytics {
      constructor() {
        super("test");
      }
      isEnabled(): boolean {
        return true;
      }
      protected deliver(event: AnalyticsEvent): boolean {
        void event;
        throw new Error("raw secret error");
      }
    }
    expect(new ThrowingAnalytics().capture("game_session_started", startedProperties())).toBe(
      false,
    );
    expect(new NoopAnalytics().capture("game_session_started", startedProperties())).toBe(
      false,
    );
  });
});

describe("session delta analytics", () => {
  it("60초 무입력 이후와 숨겨진 탭 시간을 active_seconds에서 제외한다", async () => {
    const analytics = new MemoryAnalytics();
    const tracker = new SessionAnalytics({
      analytics,
      milestoneStore: new MemoryAnalyticsMilestoneStore(),
      deviceClass: "desktop",
      clock: { now: () => 0 },
    });
    await tracker.start(
      {
        progress_stage: "new_player",
        input_mode: "keyboard_mouse",
        orientation: "landscape",
        app_version: "0.1.0",
        acquisition: "direct",
        world_ready_ms_bucket: "under_1s",
        renderer_tier_bucket: "medium",
      },
      0,
    );
    tracker.setZone("personal", 0);
    tracker.tick(70_000);
    tracker.setVisibility(false, 70_000);
    tracker.markInput(80_000);
    tracker.setVisibility(true, 100_000);
    tracker.markInput(100_000);
    tracker.tick(110_000, 60);
    tracker.checkpoint(false, 110_000);

    const summary = analytics.events.at(-1);
    expect(summary?.name).toBe("game_session_summary");
    expect(summary?.properties).toMatchObject({
      active_seconds: 70,
      wall_seconds: 110,
      personal_zone_seconds: 70,
    });
  });

  it("5분 체크포인트는 직전 전송 뒤의 시간·카운터 델타만 보낸다", async () => {
    const analytics = new MemoryAnalytics();
    const tracker = new SessionAnalytics({
      analytics,
      milestoneStore: new MemoryAnalyticsMilestoneStore(),
      deviceClass: "mobile",
    });
    await tracker.start(
      {
        progress_stage: "producer_completed",
        input_mode: "touch",
        orientation: "portrait",
        app_version: "0.1.0",
        acquisition: "direct",
        world_ready_ms_bucket: "1s_to_3s",
        renderer_tier_bucket: "low",
      },
      0,
    );
    tracker.increment("personal_blocks_placed", 2);
    tracker.setDistinctOtherCreatorsSeen(3);
    tracker.tick(10_000, 30);
    expect(tracker.checkpoint(false, 10_000)).toBe(true);

    tracker.markInput(10_000);
    tracker.increment("public_blocks_placed");
    tracker.setDistinctOtherCreatorsSeen(1);
    tracker.tick(15_000, 60);
    expect(tracker.checkpoint(false, 15_000)).toBe(true);

    const summaries = analytics.events.filter(
      (event) => event.name === "game_session_summary",
    );
    expect(summaries[0]?.properties).toMatchObject({
      wall_seconds: 10,
      personal_blocks_placed: 2,
      public_blocks_placed: 0,
      distinct_other_creators_seen_bucket: "2_to_4",
      summary_sequence: 1,
    });
    expect(summaries[1]?.properties).toMatchObject({
      wall_seconds: 5,
      personal_blocks_placed: 0,
      public_blocks_placed: 1,
      distinct_other_creators_seen_bucket: "1",
      summary_sequence: 2,
    });
  });

  it("IndexedDB에서 생애 마일스톤을 원자적으로 한 번만 기록한다", async () => {
    const store = new IndexedDbAnalyticsMilestoneStore(indexedDB);
    const [first, second] = await Promise.all([
      store.markMilestone("first_block", 1_000),
      store.markMilestone("first_block", 2_000),
    ]);
    expect([first.firstReached, second.firstReached].filter(Boolean)).toHaveLength(1);
    expect((await store.read()).milestones.first_block).toBeDefined();
  });

  it("같은 생애 마일스톤 이벤트를 두 번 전송하지 않는다", async () => {
    const analytics = new MemoryAnalytics();
    const tracker = new SessionAnalytics({
      analytics,
      milestoneStore: new MemoryAnalyticsMilestoneStore(),
      deviceClass: "desktop",
    });
    await tracker.start(
      {
        progress_stage: "new_player",
        input_mode: "keyboard_mouse",
        orientation: "landscape",
        app_version: "0.1.0",
        acquisition: "direct",
        world_ready_ms_bucket: "under_1s",
        renderer_tier_bucket: "medium",
      },
      1_000,
    );
    expect(await tracker.reachMilestone("first_move", 2_000)).toBe(true);
    expect(await tracker.reachMilestone("first_move", 3_000)).toBe(false);
    expect(
      analytics.events.filter(
        (event) => event.name === "player_milestone_reached",
      ),
    ).toHaveLength(1);
  });

  it("같은 마일스톤을 여러 프레임에서 요청해도 IndexedDB 작업은 한 번만 시작한다", async () => {
    const analytics = new MemoryAnalytics();
    const milestoneStore = new MemoryAnalyticsMilestoneStore();
    const markMilestone = vi.spyOn(milestoneStore, "markMilestone");
    const tracker = new SessionAnalytics({
      analytics,
      milestoneStore,
      deviceClass: "mobile",
    });
    await tracker.start(
      {
        progress_stage: "new_player",
        input_mode: "touch",
        orientation: "portrait",
        app_version: "0.1.0",
        acquisition: "direct",
        world_ready_ms_bucket: "under_1s",
        renderer_tier_bucket: "low",
      },
      1_000,
    );

    await Promise.all([
      tracker.reachMilestone("first_move", 2_000),
      tracker.reachMilestone("first_move", 2_001),
      tracker.reachMilestone("first_move", 2_002),
    ]);

    expect(markMilestone).toHaveBeenCalledTimes(1);
  });

  it("철회 구간의 델타를 버리고 재동의 뒤 summary 순서를 이어 간다", async () => {
    const analytics = new MemoryAnalytics();
    const tracker = new SessionAnalytics({
      analytics,
      milestoneStore: new MemoryAnalyticsMilestoneStore(),
      deviceClass: "desktop",
    });
    await tracker.start(
      {
        progress_stage: "base_in_progress",
        input_mode: "keyboard_mouse",
        orientation: "landscape",
        app_version: "0.1.0",
        acquisition: "direct",
        world_ready_ms_bucket: "under_1s",
        renderer_tier_bucket: "medium",
      },
      0,
    );
    tracker.increment("public_blocks_placed");
    tracker.tick(1_000);
    expect(tracker.checkpoint(false, 1_000)).toBe(true);

    tracker.pause(2_000);
    tracker.increment("public_blocks_placed", 10);
    tracker.tick(20_000);
    expect(tracker.checkpoint(false, 20_000)).toBe(false);

    tracker.resume(30_000);
    tracker.increment("personal_blocks_placed");
    tracker.tick(31_000);
    expect(tracker.checkpoint(false, 31_000)).toBe(true);

    const starts = analytics.events.filter(
      (event) => event.name === "game_session_started",
    );
    const summaries = analytics.events.filter(
      (event) => event.name === "game_session_summary",
    );
    expect(starts).toHaveLength(1);
    expect(summaries).toHaveLength(2);
    expect(summaries[1]?.properties).toMatchObject({
      summary_sequence: 2,
      wall_seconds: 1,
      public_blocks_placed: 0,
      personal_blocks_placed: 1,
    });
  });

  it("failure는 enum 속성만 저장한다", () => {
    const analytics = new MemoryAnalytics();
    const properties: GameFailureProperties = {
      code: "commit_network_failed",
      stage: "world_write",
      recoverable: true,
      retry_succeeded: false,
      device_class: "desktop",
    };
    expect(analytics.capture("game_failure", properties)).toBe(true);
    expect(analytics.events[0]?.properties).toEqual({
      ...properties,
      environment: "test",
    });
  });
});
