export type ProductionLevel = 1 | 2;

export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export interface GameRulesConfig {
  initialInventory: number;
  baseGuideSlots: number;
  producerGuideSlots: number;
  trialReward: number;
  maxInventory: number;
  automaticProductionIntervalMs: Readonly<Record<ProductionLevel, number>>;
  manualProductionWindowMs: number;
  manualProductionLimit: number;
  manualProductionReward: number;
  manualProductionDurationMs: number;
  manualProductionStepCount: number;
  producerUpgradeGuideSlots: number;
}

export const DEFAULT_GAME_RULES: Readonly<GameRulesConfig> = Object.freeze({
  initialInventory: 24,
  baseGuideSlots: 16,
  producerGuideSlots: 8,
  trialReward: 2,
  maxInventory: 36,
  automaticProductionIntervalMs: Object.freeze({
    1: 3 * 60 * 60 * 1_000,
    2: 2 * 60 * 60 * 1_000,
  }),
  manualProductionWindowMs: 24 * 60 * 60 * 1_000,
  manualProductionLimit: 3,
  manualProductionReward: 1,
  manualProductionDurationMs: 15_000,
  manualProductionStepCount: 3,
  producerUpgradeGuideSlots: 12,
});

export interface LocalPlayerProgress {
  initialGrantClaimed: boolean;
  inventory: number;
  baseCompleted: boolean;
  baseCompletedAt: number | null;
  producerCompleted: boolean;
  producerCompletedAt: number | null;
  trialRewardClaimed: boolean;
  productionLevel: ProductionLevel;
  producerUpgradeCompletedAt: number | null;
  lastSettledAt: number;
  manualProductionAt: number[];
}

export interface ProductionSettlement {
  progress: LocalPlayerProgress;
  elapsedSlots: number;
  produced: number;
}

export interface ManualProductionResult {
  progress: LocalPlayerProgress;
  produced: boolean;
  remainingAttempts: number;
  reason?: "daily-limit" | "inventory-full";
}

export interface ProductionUpgradeResult {
  progress: LocalPlayerProgress;
  upgraded: boolean;
  producedBeforeUpgrade: number;
}

export interface OnboardingResetResult {
  progress: LocalPlayerProgress;
  reset: boolean;
}

export function createLocalPlayerProgress(now: number): LocalPlayerProgress {
  return {
    initialGrantClaimed: false,
    inventory: 0,
    baseCompleted: false,
    baseCompletedAt: null,
    producerCompleted: false,
    producerCompletedAt: null,
    trialRewardClaimed: false,
    productionLevel: 1,
    producerUpgradeCompletedAt: null,
    lastSettledAt: now,
    manualProductionAt: [],
  };
}

/** 신규 플레이어의 최초 재고를 정확히 한 번만 설정한다. */
export function grantInitialInventory(
  progress: LocalPlayerProgress,
  config: Readonly<GameRulesConfig> = DEFAULT_GAME_RULES,
): LocalPlayerProgress {
  if (progress.initialGrantClaimed) {
    return progress;
  }

  return {
    ...progress,
    initialGrantClaimed: true,
    inventory: config.initialInventory,
  };
}

/** 가이드 개수에 따라 최초 완성 시각과 16+8 시운전 보상을 한 번만 기록한다. */
export function reconcileOnboardingCompletion(
  progress: LocalPlayerProgress,
  baseGuideCount: number,
  producerGuideCount: number,
  now: number,
  config: Readonly<GameRulesConfig> = DEFAULT_GAME_RULES,
): LocalPlayerProgress {
  const baseJustCompleted =
    !progress.baseCompleted && baseGuideCount >= config.baseGuideSlots;
  const producerJustCompleted =
    !progress.producerCompleted && producerGuideCount >= config.producerGuideSlots;
  const baseCompleted = progress.baseCompleted || baseJustCompleted;
  const producerCompleted = progress.producerCompleted || producerJustCompleted;
  const shouldReward =
    baseGuideCount >= config.baseGuideSlots &&
    producerGuideCount >= config.producerGuideSlots &&
    !progress.trialRewardClaimed;
  const rewardSettledAt = shouldReward
    ? Math.max(progress.lastSettledAt, now)
    : progress.lastSettledAt;

  if (!baseJustCompleted && !producerJustCompleted && !shouldReward) {
    return progress;
  }

  return {
    ...progress,
    baseCompleted,
    baseCompletedAt: baseJustCompleted ? now : progress.baseCompletedAt,
    producerCompleted,
    producerCompletedAt: producerJustCompleted
      ? now
      : progress.producerCompletedAt,
    lastSettledAt: rewardSettledAt,
    trialRewardClaimed: progress.trialRewardClaimed || shouldReward,
    inventory: shouldReward
      ? Math.min(config.maxInventory, progress.inventory + config.trialReward)
      : progress.inventory,
  };
}

export function resetOnboardingProgress(
  progress: LocalPlayerProgress,
  now: number,
  config: Readonly<GameRulesConfig> = DEFAULT_GAME_RULES,
): OnboardingResetResult {
  if (progress.trialRewardClaimed) {
    return { progress, reset: false };
  }

  return {
    progress: grantInitialInventory(createLocalPlayerProgress(now), config),
    reset: true,
  };
}

/** 경과한 전체 생산 슬롯을 소비하고, 재고 여유분만 실제 생산한다. */
export function settleAutomaticProduction(
  progress: LocalPlayerProgress,
  now: number,
  config: Readonly<GameRulesConfig> = DEFAULT_GAME_RULES,
): ProductionSettlement {
  const interval = config.automaticProductionIntervalMs[progress.productionLevel];
  const elapsed = Math.max(0, now - progress.lastSettledAt);
  const elapsedSlots = Math.floor(elapsed / interval);

  if (elapsedSlots === 0) {
    return { progress, elapsedSlots: 0, produced: 0 };
  }

  const capacity = Math.max(0, config.maxInventory - progress.inventory);
  const produced = Math.min(elapsedSlots, capacity);

  return {
    progress: {
      ...progress,
      inventory: progress.inventory + produced,
      // 슬롯 단위로 전진해 남은 부분 시간을 보존한다. 가득 찬 동안의 슬롯은 소급하지 않는다.
      lastSettledAt: progress.lastSettledAt + elapsedSlots * interval,
    },
    elapsedSlots,
    produced,
  };
}

export function getRecentManualProductionAt(
  progress: LocalPlayerProgress,
  now: number,
  config: Readonly<GameRulesConfig> = DEFAULT_GAME_RULES,
): number[] {
  const windowStart = now - config.manualProductionWindowMs;
  return progress.manualProductionAt.filter(
    (producedAt) => Number.isFinite(producedAt) && producedAt > windowStart,
  );
}

/** 3단계 조작 성공 뒤 호출하며, 최근 24시간 제한과 재고 상한을 원자적으로 적용한다. */
export function tryManualProduction(
  progress: LocalPlayerProgress,
  now: number,
  config: Readonly<GameRulesConfig> = DEFAULT_GAME_RULES,
): ManualProductionResult {
  const recent = getRecentManualProductionAt(progress, now, config);
  const remainingBeforeAttempt = Math.max(
    0,
    config.manualProductionLimit - recent.length,
  );

  if (remainingBeforeAttempt === 0) {
    return {
      progress: { ...progress, manualProductionAt: recent },
      produced: false,
      remainingAttempts: 0,
      reason: "daily-limit",
    };
  }

  if (progress.inventory >= config.maxInventory) {
    return {
      progress: { ...progress, manualProductionAt: recent },
      produced: false,
      remainingAttempts: remainingBeforeAttempt,
      reason: "inventory-full",
    };
  }

  const nextInventory = Math.min(
    config.maxInventory,
    progress.inventory + config.manualProductionReward,
  );
  const producedAt = Math.max(now, ...recent);
  const nextManualProductionAt = [...recent, producedAt];

  return {
    progress: {
      ...progress,
      inventory: nextInventory,
      manualProductionAt: nextManualProductionAt,
    },
    produced: true,
    remainingAttempts: Math.max(
      0,
      config.manualProductionLimit - nextManualProductionAt.length,
    ),
  };
}

export function getManualProductionRemainingAttempts(
  progress: LocalPlayerProgress,
  now: number,
  config: Readonly<GameRulesConfig> = DEFAULT_GAME_RULES,
): number {
  return Math.max(
    0,
    config.manualProductionLimit -
      getRecentManualProductionAt(progress, now, config).length,
  );
}

/** 12칸을 최초 완성하면 기존 레벨로 먼저 정산한 뒤 레벨 2의 기준 시각을 현재로 리셋한다. */
export function reconcileProductionUpgrade(
  progress: LocalPlayerProgress,
  expansionGuideCount: number,
  producerGuideCount: number,
  now: number,
  config: Readonly<GameRulesConfig> = DEFAULT_GAME_RULES,
): ProductionUpgradeResult {
  if (
    progress.productionLevel === 2 ||
    !isProductionOperational(progress, producerGuideCount, config) ||
    expansionGuideCount < config.producerUpgradeGuideSlots
  ) {
    return { progress, upgraded: false, producedBeforeUpgrade: 0 };
  }

  const settlement = settleAutomaticProduction(progress, now, config);
  const upgradedAt = Math.max(now, settlement.progress.lastSettledAt);

  return {
    progress: {
      ...settlement.progress,
      productionLevel: 2,
      producerUpgradeCompletedAt: upgradedAt,
      lastSettledAt: upgradedAt,
    },
    upgraded: true,
    producedBeforeUpgrade: settlement.produced,
  };
}

/** 재고가 가득 찼으면 null, 정산할 슬롯이 이미 생겼으면 0을 반환한다. */
export function getNextAutomaticProductionInMs(
  progress: LocalPlayerProgress,
  now: number,
  config: Readonly<GameRulesConfig> = DEFAULT_GAME_RULES,
): number | null {
  if (progress.inventory >= config.maxInventory) {
    return null;
  }

  const interval = config.automaticProductionIntervalMs[progress.productionLevel];
  return Math.max(0, progress.lastSettledAt + interval - now);
}

export function isProductionOperational(
  progress: LocalPlayerProgress,
  producerGuideCount: number,
  config: Readonly<GameRulesConfig> = DEFAULT_GAME_RULES,
): boolean {
  return (
    progress.trialRewardClaimed &&
    producerGuideCount >= config.producerGuideSlots
  );
}
