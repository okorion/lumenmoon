import { describe, expect, it } from "vitest";
import {
  DEFAULT_GAME_RULES,
  createLocalPlayerProgress,
  getManualProductionRemainingAttempts,
  getNextAutomaticProductionInMs,
  grantInitialInventory,
  isProductionOperational,
  reconcileOnboardingCompletion,
  reconcileProductionUpgrade,
  resetOnboardingProgress,
  settleAutomaticProduction,
  tryManualProduction,
} from "../src/domain/progression";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

function createOperationalProgress(now = 0) {
  return reconcileOnboardingCompletion(
    createLocalPlayerProgress(now),
    DEFAULT_GAME_RULES.baseGuideSlots,
    DEFAULT_GAME_RULES.producerGuideSlots,
    now,
  );
}

describe("플레이어 진행 상태", () => {
  it("최초 24블록을 정확히 한 번만 지급한다", () => {
    const initial = createLocalPlayerProgress(1_000);
    const granted = grantInitialInventory(initial);
    const duplicated = grantInitialInventory(granted);

    expect(granted.inventory).toBe(24);
    expect(granted.initialGrantClaimed).toBe(true);
    expect(duplicated).toBe(granted);
    expect(duplicated.inventory).toBe(24);
  });

  it("16칸과 8칸을 따로 완성해도 최초 시각과 시운전 보상 2개를 한 번만 기록한다", () => {
    let progress = { ...grantInitialInventory(createLocalPlayerProgress(0)), inventory: 8 };
    progress = reconcileOnboardingCompletion(progress, 16, 7, 100);

    expect(progress.baseCompletedAt).toBe(100);
    expect(progress.producerCompletedAt).toBeNull();
    expect(progress.inventory).toBe(8);

    progress = reconcileOnboardingCompletion(progress, 16, 8, 200);
    expect(progress.producerCompletedAt).toBe(200);
    expect(progress.trialRewardClaimed).toBe(true);
    expect(progress.inventory).toBe(10);

    const duplicate = reconcileOnboardingCompletion(progress, 20, 20, 300);
    expect(duplicate).toBe(progress);
    expect(duplicate.inventory).toBe(10);
    expect(duplicate.baseCompletedAt).toBe(100);
    expect(duplicate.producerCompletedAt).toBe(200);
  });

  it("두 가이드를 동시에 완성해도 시운전 보상은 한 번만 준다", () => {
    const initial = { ...createLocalPlayerProgress(0), inventory: 0 };
    const completed = reconcileOnboardingCompletion(initial, 16, 8, 500);

    expect(completed.inventory).toBe(2);
    expect(completed.baseCompletedAt).toBe(500);
    expect(completed.producerCompletedAt).toBe(500);
  });

  it("둘 다 완성되기 전 초기화는 최초 24블록 상태를 복구한다", () => {
    const partial = {
      ...grantInitialInventory(createLocalPlayerProgress(0)),
      inventory: 5,
      baseCompleted: true,
      baseCompletedAt: 100,
    };
    const result = resetOnboardingProgress(partial, 500);

    expect(result.reset).toBe(true);
    expect(result.progress.inventory).toBe(24);
    expect(result.progress.baseCompleted).toBe(false);
    expect(result.progress.producerCompleted).toBe(false);
    expect(result.progress.lastSettledAt).toBe(500);
  });

  it("두 가이드를 모두 완성하면 초기화할 수 없다", () => {
    const completed = reconcileOnboardingCompletion(
      grantInitialInventory(createLocalPlayerProgress(0)),
      16,
      8,
      100,
    );
    const result = resetOnboardingProgress(completed, 500);

    expect(result.reset).toBe(false);
    expect(result.progress).toBe(completed);
  });

  it("한 가이드의 블록을 다시 뺀 상태에서는 시운전 보상을 주지 않고 초기화할 수 있다", () => {
    let progress = reconcileOnboardingCompletion(
      grantInitialInventory(createLocalPlayerProgress(0)),
      16,
      7,
      100,
    );
    progress = reconcileOnboardingCompletion(progress, 15, 8, 200);

    expect(progress.baseCompleted).toBe(true);
    expect(progress.producerCompleted).toBe(true);
    expect(progress.trialRewardClaimed).toBe(false);
    expect(resetOnboardingProgress(progress, 300).reset).toBe(true);
  });

  it("16+8이 모두 현재 존재할 때만 생산을 열고 완성 시각부터 정산한다", () => {
    let progress = grantInitialInventory(createLocalPlayerProgress(0));
    progress = reconcileOnboardingCompletion(progress, 0, 8, 3 * HOUR);

    expect(progress.producerCompleted).toBe(true);
    expect(progress.trialRewardClaimed).toBe(false);
    expect(isProductionOperational(progress, 8)).toBe(false);

    progress = reconcileOnboardingCompletion(progress, 16, 8, 9 * HOUR);
    expect(isProductionOperational(progress, 8)).toBe(true);
    expect(progress.lastSettledAt).toBe(9 * HOUR);
    expect(settleAutomaticProduction(progress, 9 * HOUR).produced).toBe(0);
    expect(isProductionOperational(progress, 7)).toBe(false);
  });
});

describe("자동 생산", () => {
  it("레벨 1은 3시간 경계마다 한 슬롯을 정산하고 부분 시간을 보존한다", () => {
    const initial = { ...createLocalPlayerProgress(1_000), inventory: 0 };

    const before = settleAutomaticProduction(initial, 1_000 + 3 * HOUR - 1);
    expect(before.produced).toBe(0);
    expect(before.progress.lastSettledAt).toBe(1_000);

    const atBoundary = settleAutomaticProduction(initial, 1_000 + 3 * HOUR);
    expect(atBoundary.produced).toBe(1);
    expect(atBoundary.elapsedSlots).toBe(1);

    const afterSevenHours = settleAutomaticProduction(
      initial,
      1_000 + 7 * HOUR,
    );
    expect(afterSevenHours.produced).toBe(2);
    expect(afterSevenHours.progress.lastSettledAt).toBe(1_000 + 6 * HOUR);
    expect(getNextAutomaticProductionInMs(afterSevenHours.progress, 1_000 + 7 * HOUR)).toBe(
      2 * HOUR,
    );
  });

  it("레벨 2는 2시간당 한 개를 생산한다", () => {
    const levelTwo = {
      ...createLocalPlayerProgress(0),
      inventory: 2,
      productionLevel: 2 as const,
    };
    const result = settleAutomaticProduction(levelTwo, 6 * HOUR);

    expect(result.elapsedSlots).toBe(3);
    expect(result.produced).toBe(3);
    expect(result.progress.inventory).toBe(5);
  });

  it("재고 36 상한에서 초과 생산하지 않고 가득 찬 동안의 슬롯을 소비한다", () => {
    const almostFull = { ...createLocalPlayerProgress(0), inventory: 35 };
    const result = settleAutomaticProduction(almostFull, 12 * HOUR);

    expect(result.elapsedSlots).toBe(4);
    expect(result.produced).toBe(1);
    expect(result.progress.inventory).toBe(36);
    expect(result.progress.lastSettledAt).toBe(12 * HOUR);
    expect(getNextAutomaticProductionInMs(result.progress, 12 * HOUR)).toBeNull();

    const spent = { ...result.progress, inventory: 35 };
    expect(settleAutomaticProduction(spent, 12 * HOUR).produced).toBe(0);
  });

  it("시계가 뒤로 이동해도 음수 슬롯이나 음수 남은 시간을 만들지 않는다", () => {
    const progress = createLocalPlayerProgress(10 * HOUR);
    const result = settleAutomaticProduction(progress, 9 * HOUR);

    expect(result.elapsedSlots).toBe(0);
    expect(result.progress).toBe(progress);
    expect(getNextAutomaticProductionInMs(progress, 9 * HOUR)).toBe(4 * HOUR);
  });
});

describe("수동 생산", () => {
  it("최근 24시간에 세 번만 생산하고 네 번째 시도는 재고와 기록을 바꾸지 않는다", () => {
    let progress = createLocalPlayerProgress(0);
    for (const now of [1_000, 2_000, 3_000]) {
      const result = tryManualProduction(progress, now);
      expect(result.produced).toBe(true);
      progress = result.progress;
    }

    const blocked = tryManualProduction(progress, 4_000);
    expect(progress.inventory).toBe(3);
    expect(blocked.produced).toBe(false);
    expect(blocked.reason).toBe("daily-limit");
    expect(blocked.remainingAttempts).toBe(0);
    expect(blocked.progress.inventory).toBe(3);
    expect(blocked.progress.manualProductionAt).toHaveLength(3);
  });

  it("정확히 24시간 지난 기록은 창에서 제외해 다시 한 번 생산할 수 있다", () => {
    const progress = {
      ...createLocalPlayerProgress(0),
      manualProductionAt: [1_000, 2_000, 3_000],
    };
    const now = 1_000 + DAY;

    expect(getManualProductionRemainingAttempts(progress, now)).toBe(1);
    const result = tryManualProduction(progress, now);
    expect(result.produced).toBe(true);
    expect(result.progress.manualProductionAt).toEqual([2_000, 3_000, now]);
    expect(result.remainingAttempts).toBe(0);
  });

  it("재고가 가득 차면 횟수를 소모하지 않는다", () => {
    const full = { ...createLocalPlayerProgress(0), inventory: 36 };
    const result = tryManualProduction(full, 1_000);

    expect(result.produced).toBe(false);
    expect(result.reason).toBe("inventory-full");
    expect(result.remainingAttempts).toBe(3);
    expect(result.progress.manualProductionAt).toEqual([]);
  });

  it("시계를 뒤로 돌려도 미래의 수동 생산 기록을 버리지 않는다", () => {
    const future = {
      ...createLocalPlayerProgress(10 * HOUR),
      inventory: 0,
      manualProductionAt: [10 * HOUR, 10 * HOUR + 1, 10 * HOUR + 2],
    };

    expect(getManualProductionRemainingAttempts(future, 9 * HOUR)).toBe(0);
    expect(tryManualProduction(future, 9 * HOUR).reason).toBe("daily-limit");
  });
});

describe("생산시설 레벨 2", () => {
  it("12칸 미만에서는 업그레이드하지 않는다", () => {
    const progress = createOperationalProgress(0);
    const result = reconcileProductionUpgrade(progress, 11, 8, 10 * HOUR);

    expect(result.upgraded).toBe(false);
    expect(result.progress).toBe(progress);
  });

  it("12칸 최초 완성 시 레벨 1 생산을 정산한 뒤 레벨 2 기준을 현재로 리셋한다", () => {
    const progress = { ...createOperationalProgress(0), inventory: 0 };
    const result = reconcileProductionUpgrade(progress, 12, 8, 7 * HOUR);

    expect(result.upgraded).toBe(true);
    expect(result.producedBeforeUpgrade).toBe(2);
    expect(result.progress.inventory).toBe(2);
    expect(result.progress.productionLevel).toBe(2);
    expect(result.progress.producerUpgradeCompletedAt).toBe(7 * HOUR);
    expect(result.progress.lastSettledAt).toBe(7 * HOUR);
    expect(getNextAutomaticProductionInMs(result.progress, 7 * HOUR)).toBe(2 * HOUR);
  });

  it("이미 레벨 2면 업그레이드 시각과 정산 기준을 다시 쓰지 않는다", () => {
    const upgraded = {
      ...createOperationalProgress(0),
      productionLevel: 2 as const,
      producerUpgradeCompletedAt: 100,
      lastSettledAt: 100,
    };
    const duplicate = reconcileProductionUpgrade(upgraded, 20, 8, 10 * HOUR);

    expect(duplicate.upgraded).toBe(false);
    expect(duplicate.progress).toBe(upgraded);
    expect(duplicate.progress.producerUpgradeCompletedAt).toBe(100);
    expect(duplicate.progress.lastSettledAt).toBe(100);
  });

  it("시계가 역행해도 업그레이드 정산 기준을 뒤로 옮기지 않는다", () => {
    const progress = {
      ...createOperationalProgress(10 * HOUR),
      inventory: 0,
      lastSettledAt: 10 * HOUR,
    };
    const result = reconcileProductionUpgrade(progress, 12, 8, 9 * HOUR);

    expect(result.progress.lastSettledAt).toBe(10 * HOUR);
    expect(result.progress.producerUpgradeCompletedAt).toBe(10 * HOUR);
  });

  it("생산시설이 8칸 미만이면 확장 12칸을 채워도 정산하거나 업그레이드하지 않는다", () => {
    const progress = {
      ...createOperationalProgress(0),
      inventory: 0,
    };
    const result = reconcileProductionUpgrade(progress, 12, 7, 9 * HOUR);

    expect(result.upgraded).toBe(false);
    expect(result.producedBeforeUpgrade).toBe(0);
    expect(result.progress).toBe(progress);
    expect(result.progress.inventory).toBe(0);
    expect(result.progress.productionLevel).toBe(1);
  });
});

describe("규칙 설정", () => {
  it("15초·3단계와 모든 생산 시간 규칙을 설정값으로 노출한다", () => {
    expect(DEFAULT_GAME_RULES.manualProductionDurationMs).toBe(15_000);
    expect(DEFAULT_GAME_RULES.manualProductionStepCount).toBe(3);
    expect(DEFAULT_GAME_RULES.automaticProductionIntervalMs[1]).toBe(3 * HOUR);
    expect(DEFAULT_GAME_RULES.automaticProductionIntervalMs[2]).toBe(2 * HOUR);
    expect(DEFAULT_GAME_RULES.manualProductionWindowMs).toBe(DAY);
  });
});
