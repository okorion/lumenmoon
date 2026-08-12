import { describe, expect, it, vi } from "vitest";
import { ANALYTICS_CONSENT_STORAGE_KEY } from "../src/analytics/storageKeys";
import { DeferredGameAnalytics } from "../src/app/DeferredGameAnalytics";
import type { GameAnalytics } from "../src/app/GameAnalytics";

function memoryStorage(initial: string | null): Storage {
  const values = new Map<string, string>();
  if (initial !== null) values.set(ANALYTICS_CONSENT_STORAGE_KEY, initial);
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function delegateMock(): GameAnalytics {
  return {
    consentChoice: "allowed",
    setConsent: vi.fn(async () => undefined),
    prepareForReplay: vi.fn(async () => undefined),
    worldControllable: vi.fn(),
    markInput: vi.fn(),
    tick: vi.fn(),
    increment: vi.fn(),
    otherCreatorSeen: vi.fn(),
    creatorDetailsOpened: vi.fn(),
    milestone: vi.fn(),
    failure: vi.fn(),
    checkpoint: vi.fn(),
  } as unknown as GameAnalytics;
}

const startContext = {
  progress_stage: "new_player" as const,
  acquisition: "direct" as const,
  input_mode: "keyboard_mouse" as const,
  orientation: "landscape" as const,
  renderer_tier_bucket: "medium" as const,
  world_ready_ms_bucket: "under_1s" as const,
};

describe("DeferredGameAnalytics", () => {
  it("동의 전에는 분석 청크를 예약하거나 불러오지 않는다", () => {
    const loader = vi.fn(async () => delegateMock());
    const schedule = vi.fn();
    const analytics = DeferredGameAnalytics.create({
      storage: memoryStorage(null),
      loader,
      schedule,
    });

    analytics.increment("public_blocks_placed");
    analytics.failure("world_sync_failed", "world_read", true);

    expect(analytics.consentChoice).toBe("undecided");
    expect(schedule).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  });

  it("저장된 동의를 적용하고 세션 준비가 끝난 뒤 누적값을 재생한다", async () => {
    const delegate = delegateMock();
    let finishPreparation: (() => void) | undefined;
    vi.mocked(delegate.prepareForReplay).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    let idleCallback: (() => void) | undefined;
    const analytics = DeferredGameAnalytics.create({
      storage: memoryStorage("allowed"),
      loader: async () => delegate,
      schedule: (callback) => {
        idleCallback = callback;
      },
    });

    analytics.worldControllable(startContext);
    analytics.increment("public_blocks_placed", 2);
    idleCallback?.();
    await vi.waitFor(() =>
      expect(delegate.prepareForReplay).toHaveBeenCalledWith(startContext),
    );
    expect(delegate.increment).not.toHaveBeenCalled();

    finishPreparation?.();
    await vi.waitFor(() =>
      expect(delegate.increment).toHaveBeenCalledWith(
        "public_blocks_placed",
        2,
      ),
    );
  });

  it("로딩 중 철회가 먼저 허용된 분석을 다시 켜지 못하게 한다", async () => {
    const storage = memoryStorage("allowed");
    const delegate = delegateMock();
    let finishLoad: ((delegate: GameAnalytics) => void) | undefined;
    const loader = vi.fn(
      () =>
        new Promise<GameAnalytics>((resolve) => {
          finishLoad = resolve;
        }),
    );
    let idleCallback: (() => void) | undefined;
    const analytics = DeferredGameAnalytics.create({
      storage,
      loader,
      schedule: (callback) => {
        idleCallback = callback;
      },
    });

    analytics.worldControllable(startContext);
    analytics.increment("public_blocks_placed");
    idleCallback?.();
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    const denied = analytics.setConsent("essential_only");
    finishLoad?.(delegate);
    await denied;

    expect(storage.getItem(ANALYTICS_CONSENT_STORAGE_KEY)).toBe(
      "essential_only",
    );
    expect(delegate.setConsent).toHaveBeenCalledTimes(1);
    expect(delegate.setConsent).toHaveBeenCalledWith("essential_only");
    expect(delegate.prepareForReplay).not.toHaveBeenCalled();
    expect(delegate.increment).not.toHaveBeenCalled();
  });

  it("세션 준비 중 철회는 queue를 기다리지 않고 provider를 즉시 끈다", async () => {
    const delegate = delegateMock();
    let finishPreparation: (() => void) | undefined;
    vi.mocked(delegate.prepareForReplay).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    let idleCallback: (() => void) | undefined;
    const analytics = DeferredGameAnalytics.create({
      storage: memoryStorage("allowed"),
      loader: async () => delegate,
      schedule: (callback) => {
        idleCallback = callback;
      },
    });

    analytics.worldControllable(startContext);
    analytics.increment("public_blocks_placed");
    idleCallback?.();
    await vi.waitFor(() =>
      expect(delegate.prepareForReplay).toHaveBeenCalledTimes(1),
    );
    vi.mocked(delegate.setConsent).mockClear();

    const denied = analytics.setConsent("essential_only");
    await vi.waitFor(() =>
      expect(delegate.setConsent).toHaveBeenCalledWith("essential_only"),
    );
    expect(delegate.increment).not.toHaveBeenCalled();

    finishPreparation?.();
    await denied;
    expect(delegate.prepareForReplay).toHaveBeenCalledTimes(1);
    expect(delegate.increment).not.toHaveBeenCalled();
  });

  it("사용자가 동의하면 즉시 불러오되 월드 준비 전 이벤트는 계속 보관한다", async () => {
    const delegate = delegateMock();
    const analytics = DeferredGameAnalytics.create({
      storage: memoryStorage(null),
      loader: async () => delegate,
      schedule: vi.fn(),
    });

    await analytics.setConsent("allowed");
    analytics.increment("public_blocks_placed");
    expect(delegate.prepareForReplay).not.toHaveBeenCalled();
    expect(delegate.increment).not.toHaveBeenCalled();

    analytics.worldControllable(startContext);
    await vi.waitFor(() =>
      expect(delegate.increment).toHaveBeenCalledWith(
        "public_blocks_placed",
        1,
      ),
    );
  });

  it("분석 청크 로드 실패를 게임과 동의 설정에 전파하지 않는다", async () => {
    const analytics = DeferredGameAnalytics.create({
      storage: memoryStorage(null),
      loader: async () => {
        throw new Error("offline");
      },
      schedule: vi.fn(),
    });

    await expect(analytics.setConsent("allowed")).resolves.toBeUndefined();
    expect(analytics.consentChoice).toBe("allowed");
  });
});
