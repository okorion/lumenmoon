import { SYSTEM_OWNER, type VoxelBlock } from "./types";
import { PLAYER_HEIGHT } from "./collision";
import {
  STARTER_BAY_RESERVED_SLOT_COUNT,
  createStarterBayLayout,
  type StarterBayLayout,
} from "./starterBay";

export const FREE_MODE_INITIAL_INVENTORY = 30;
export const FREE_MODE_GRANT_INTERVAL_MS = 60 * 60 * 1_000;
export const FREE_MODE_GRANT_AMOUNT = 5;
export const FREE_MODE_MAX_INVENTORY = 100;
export const FREE_MODE_FOREIGN_REMOVAL_AGE_MS = 72 * 60 * 60 * 1_000;
export const FREE_MODE_MAX_BLOCKS_PER_CHUNK = 100;
export const FREE_MODE_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const FREE_MODE_IDEMPOTENCY_CLEANUP_LIMIT = 512;
export const FREE_MODE_PUBLIC_SPAWN_SLOT_INDEX = 0;
export const FREE_MODE_SPAWN_BODY_RADIUS = 1;
export const FREE_MODE_CENTRAL_SAFE_PAD_RADIUS = 7;
export const FREE_MODE_ESCAPE_CORRIDOR_HALF_WIDTH = 1;

const DETERMINISTIC_SYSTEM_GROUND_ID = /^(?:ground-|online-ground-|starter-)/u;

const FREE_MODE_PUBLIC_SPAWN_LAYOUT = createStarterBayLayout(
  FREE_MODE_PUBLIC_SPAWN_SLOT_INDEX,
);

export interface FreeModeRulesConfig {
  initialInventory: number;
  grantIntervalMs: number;
  grantAmount: number;
  maxInventory: number;
  foreignRemovalAgeMs: number;
}

export const DEFAULT_FREE_MODE_RULES: Readonly<FreeModeRulesConfig> =
  Object.freeze({
    initialInventory: FREE_MODE_INITIAL_INVENTORY,
    grantIntervalMs: FREE_MODE_GRANT_INTERVAL_MS,
    grantAmount: FREE_MODE_GRANT_AMOUNT,
    maxInventory: FREE_MODE_MAX_INVENTORY,
    foreignRemovalAgeMs: FREE_MODE_FOREIGN_REMOVAL_AGE_MS,
  });

export interface FreeModeProgress {
  initialGrantClaimed: boolean;
  inventory: number;
  lastSettledAt: number;
}

export interface FreeModeInventorySettlement {
  progress: FreeModeProgress;
  elapsedSlots: number;
  produced: number;
}

export type FreeModeRemovalReason =
  | "allowed"
  | "protected-zone"
  | "support-in-use"
  | "not-free-mode-block"
  | "foreign-block-locked";

export interface FreeModeRemovalDecision {
  allowed: boolean;
  reason: FreeModeRemovalReason;
  refundInventory: number;
  removableAt: number | null;
  remainingMs: number;
}

export interface LocalFreeModeOperation {
  idempotencyKey: string;
  fingerprint: string;
  upsertedBlocks: VoxelBlock[];
  removedBlockIds: string[];
  progress: FreeModeProgress;
  serverNow: number;
}

export interface LocalFreeModeWorldState {
  playerId: string;
  progress: FreeModeProgress;
  /** v3 초기 저장본의 inline 원장 이관용. 새 저장은 별도 operation store를 사용한다. */
  operations: LocalFreeModeOperation[];
  updatedAt: number;
  /** 같은 밀리초의 연속 변경도 오래된 스냅샷과 구분하는 단조 증가 버전. */
  revision?: number;
}

/**
 * 공용 스폰의 플레이어 높이 공간과 광장으로 나가는 통로는
 * 자유 블록으로 가둘 수 없다. 상공 전체를 막지 않고 실제 충돌 높이만 보호한다.
 */
export function isFreeModeSpawnClearancePosition(
  position: VoxelBlock["position"],
  layout: StarterBayLayout = FREE_MODE_PUBLIC_SPAWN_LAYOUT,
): boolean {
  const spawnFloorY = Math.floor(layout.safeSpawn.y);
  const spawnHeadY = Math.ceil(layout.safeSpawn.y + PLAYER_HEIGHT) - 1;
  if (position.y < spawnFloorY || position.y > spawnHeadY) {
    return false;
  }

  const spawnCellX = Math.floor(layout.safeSpawn.x);
  const spawnCellZ = Math.floor(layout.safeSpawn.z);
  const inSpawnBody =
    Math.max(
      Math.abs(position.x - spawnCellX),
      Math.abs(position.z - spawnCellZ),
    ) <= FREE_MODE_SPAWN_BODY_RADIUS;
  if (inSpawnBody) {
    return true;
  }

  const inCentralPad =
    Math.max(Math.abs(position.x), Math.abs(position.z)) <=
    FREE_MODE_CENTRAL_SAFE_PAD_RADIUS;
  if (inCentralPad) {
    return true;
  }

  // slot 0은 중앙 광장과 직선으로 맞닿는다. safeSpawn→(0, 0)의
  // 연속 3칸 통로만 비워 두고 스폰 발판 전체를 보호하지는 않는다.
  if (spawnCellX === 0) {
    return (
      Math.abs(position.x) <= FREE_MODE_ESCAPE_CORRIDOR_HALF_WIDTH &&
      position.z >= Math.min(spawnCellZ, 0) &&
      position.z <= Math.max(spawnCellZ, 0)
    );
  }
  if (spawnCellZ === 0) {
    return (
      Math.abs(position.z) <= FREE_MODE_ESCAPE_CORRIDOR_HALF_WIDTH &&
      position.x >= Math.min(spawnCellX, 0) &&
      position.x <= Math.max(spawnCellX, 0)
    );
  }
  return false;
}

/** y=1 자유 블록은 snapshot에 실제로 존재하는 결정적 시스템 지면 위에만 시작할 수 있다. */
export function hasFreeModeDeterministicGround(
  blocks: readonly VoxelBlock[],
  position: VoxelBlock["position"],
): boolean {
  return (
    isFreeModeDeterministicGroundPosition(position) ||
    blocks.some(
    (block) =>
      block.position.x === position.x &&
      block.position.y === 0 &&
      block.position.z === position.z &&
      block.owner.id === SYSTEM_OWNER.id &&
      block.zone === "system" &&
      DETERMINISTIC_SYSTEM_GROUND_ID.test(block.id),
    )
  );
}

/** 서버의 결정적 중앙 지면·64개 스타터 발판/통로와 같은 좌표 계약. */
export function isFreeModeDeterministicGroundPosition(
  position: VoxelBlock["position"],
): boolean {
  if (position.y !== 1) return false;
  if (
    position.x >= -12 &&
    position.x <= 12 &&
    position.z >= -12 &&
    position.z <= 15
  ) {
    return true;
  }
  return FREE_MODE_DETERMINISTIC_GROUND_POSITIONS.has(
    `${position.x}:${position.z}`,
  );
}

const FREE_MODE_DETERMINISTIC_GROUND_POSITIONS = new Set(
  Array.from(
    { length: STARTER_BAY_RESERVED_SLOT_COUNT },
    (_, slotIndex) => createStarterBayLayout(slotIndex).systemPlatform,
  ).flatMap((platform) =>
    platform.map((ground) => `${ground.x}:${ground.z}`),
  ),
);

/** 자유 모드에 처음 들어오기 전의 상태다. 최초 지급 시각은 진입 시점에 확정한다. */
export function createUnclaimedFreeModeProgress(now: number): FreeModeProgress {
  assertTimestamp(now, "현재 시각");
  return {
    initialGrantClaimed: false,
    inventory: 0,
    lastSettledAt: now,
  };
}

/** 최초 30개 지급을 한 번만 적용하고, 시간 생산의 기준 시각도 진입 시점으로 맞춘다. */
export function grantFreeModeInitialInventory(
  progress: FreeModeProgress,
  now: number,
  config: Readonly<FreeModeRulesConfig> = DEFAULT_FREE_MODE_RULES,
): FreeModeProgress {
  if (progress.initialGrantClaimed) {
    return progress;
  }
  assertTimestamp(now, "현재 시각");
  validateFreeModeRules(config);
  return {
    initialGrantClaimed: true,
    inventory: config.initialInventory,
    lastSettledAt: now,
  };
}

/**
 * 권위 시각을 기준으로 지난 온전한 1시간마다 5개씩 정산한다.
 * 재고가 가득 차도 경과 슬롯은 소비해, 블록 사용 직후 과거 시간이 재지급되지 않는다.
 */
export function settleFreeModeInventory(
  source: FreeModeProgress,
  now: number,
  config: Readonly<FreeModeRulesConfig> = DEFAULT_FREE_MODE_RULES,
): FreeModeInventorySettlement {
  assertTimestamp(now, "현재 시각");
  validateFreeModeRules(config);
  const progress = grantFreeModeInitialInventory(source, now, config);
  const elapsed = Math.max(0, now - progress.lastSettledAt);
  const elapsedSlots = Math.floor(elapsed / config.grantIntervalMs);
  if (progress.inventory >= config.maxInventory) {
    // 가득 찬 상태의 반복 조회는 no-op이다. 배치로 100→99가 될 때 기준 시각을 재설정한다.
    return {
      progress: {
        ...progress,
        // 가득 찬 동안의 시간을 비축했다가 사용 직후 소급 지급하지 않는다.
        lastSettledAt: progress.lastSettledAt,
      },
      elapsedSlots,
      produced: 0,
    };
  }
  if (elapsedSlots === 0) {
    return { progress, elapsedSlots: 0, produced: 0 };
  }

  const capacity = Math.max(0, config.maxInventory - progress.inventory);
  const produced = Math.min(elapsedSlots * config.grantAmount, capacity);
  return {
    progress: {
      ...progress,
      inventory: progress.inventory + produced,
      lastSettledAt:
        progress.inventory + produced >= config.maxInventory
          ? now
          : progress.lastSettledAt + elapsedSlots * config.grantIntervalMs,
    },
    elapsedSlots,
    produced,
  };
}

export function getNextFreeModeGrantInMs(
  progress: FreeModeProgress,
  now: number,
  config: Readonly<FreeModeRulesConfig> = DEFAULT_FREE_MODE_RULES,
): number | null {
  assertTimestamp(now, "현재 시각");
  validateFreeModeRules(config);
  if (!progress.initialGrantClaimed) return 0;
  if (progress.inventory >= config.maxInventory) return null;
  return Math.max(0, progress.lastSettledAt + config.grantIntervalMs - now);
}

/** 자기 블록은 즉시, 타인 블록은 생성 후 72시간이 지난 뒤에만 제거한다. */
export function decideFreeModeRemoval(input: {
  actorId: string;
  block: VoxelBlock;
  allBlocks: readonly VoxelBlock[];
  now: number;
  config?: Readonly<FreeModeRulesConfig>;
}): FreeModeRemovalDecision {
  const config = input.config ?? DEFAULT_FREE_MODE_RULES;
  assertTimestamp(input.now, "현재 시각");
  validateFreeModeRules(config);
  if (input.block.zone === "system" || input.block.zone === "mission") {
    return deniedRemoval("protected-zone");
  }
  if (input.block.source !== "free") {
    return deniedRemoval("not-free-mode-block");
  }
  if (input.block.owner.id === input.actorId) {
    return {
      allowed: true,
      reason: "allowed",
      refundInventory: 1,
      removableAt: input.block.createdAt,
      remainingMs: 0,
    };
  }
  if (
    input.allBlocks.some(
      (candidate) =>
        candidate.source === "free" &&
        candidate.supportId === input.block.id,
    )
  ) {
    return deniedRemoval("support-in-use");
  }

  const removableAt = input.block.createdAt + config.foreignRemovalAgeMs;
  const remainingMs = Math.max(0, removableAt - input.now);
  if (remainingMs > 0) {
    return {
      allowed: false,
      reason: "foreign-block-locked",
      refundInventory: 0,
      removableAt,
      remainingMs,
    };
  }
  return {
    allowed: true,
    reason: "allowed",
    refundInventory: 0,
    removableAt,
    remainingMs: 0,
  };
}

export function cloneLocalFreeModeWorldState(
  state: LocalFreeModeWorldState,
): LocalFreeModeWorldState {
  return structuredClone(state);
}

/** 오래된 GameApp 스냅샷 저장이 최신 자유 모드 재고·작업 내역을 덮지 않게 한다. */
export function preserveLocalFreeModeState<
  T extends { localFreeModeStates?: LocalFreeModeWorldState[] },
>(
  snapshot: T,
  latest: { localFreeModeStates?: LocalFreeModeWorldState[] } | null,
): T {
  const latestStates = latest?.localFreeModeStates;
  if (!latestStates || latestStates.length === 0) {
    return snapshot;
  }
  const merged = new Map(
    (snapshot.localFreeModeStates ?? []).map((state) => [
      state.playerId,
      cloneLocalFreeModeWorldState(state),
    ]),
  );
  for (const latestState of latestStates) {
    const incomingState = merged.get(latestState.playerId);
    if (!isAtLeastAsFresh(incomingState, latestState)) {
      merged.set(
        latestState.playerId,
        cloneLocalFreeModeWorldState(latestState),
      );
    }
  }
  return {
    ...snapshot,
    localFreeModeStates: [...merged.values()],
  };
}

function deniedRemoval(
  reason: Exclude<FreeModeRemovalReason, "allowed" | "foreign-block-locked">,
): FreeModeRemovalDecision {
  return {
    allowed: false,
    reason,
    refundInventory: 0,
    removableAt: null,
    remainingMs: 0,
  };
}

function isAtLeastAsFresh(
  incoming: LocalFreeModeWorldState | undefined,
  latest: LocalFreeModeWorldState,
): boolean {
  if (!incoming) return false;
  const incomingRevision = incoming.revision ?? 0;
  const latestRevision = latest.revision ?? 0;
  if (incomingRevision !== latestRevision) {
    return incomingRevision > latestRevision;
  }
  if (incoming.updatedAt !== latest.updatedAt) {
    return incoming.updatedAt > latest.updatedAt;
  }
  return incoming.operations.length >= latest.operations.length;
}

function validateFreeModeRules(config: Readonly<FreeModeRulesConfig>): void {
  const integerFields = [
    config.initialInventory,
    config.grantIntervalMs,
    config.grantAmount,
    config.maxInventory,
    config.foreignRemovalAgeMs,
  ];
  if (integerFields.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError("자유 모드 규칙 값은 0보다 큰 안전한 정수여야 합니다.");
  }
  if (config.initialInventory > config.maxInventory) {
    throw new RangeError("자유 모드 최초 지급량은 최대 재고보다 클 수 없습니다.");
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label}은(는) 0 이상의 유한한 값이어야 합니다.`);
  }
}
