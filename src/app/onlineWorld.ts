import type { WorldMutationResult } from "../data/CollaborativeWorldRepository";
import { toChunkCoordinate } from "../domain/grid";
import type { Clock, LocalPlayerProgress } from "../domain/progression";
import { STARTER_BAY_RESERVED_SLOT_COUNT } from "../domain/starterBay";
import type { VoxelBlock } from "../domain/types";
import {
  createCentralOnlineSystemBlocks,
  createStarterBaySystemBlocks,
} from "../world/seed";

const reservedStarterBaySystemBlocks = Array.from(
  { length: STARTER_BAY_RESERVED_SLOT_COUNT },
  (_, slotIndex) => createStarterBaySystemBlocks(slotIndex),
).flat();
const centralOnlineSystemBlocks = createCentralOnlineSystemBlocks();
const allOnlineSystemBlocks = [
  // 중앙 광장을 먼저 합성해 로컬 초기 맵과 겹치는 접근로의 재질·ID가 같다.
  ...centralOnlineSystemBlocks,
  ...reservedStarterBaySystemBlocks,
];

/** 서로 다른 UI 경로의 progress RPC가 겹쳐 역순 응답으로 상태를 덮지 않게 한다. */
export class OnlineProgressGate {
  private active = false;

  get busy(): boolean {
    return this.active;
  }

  tryEnter(): boolean {
    if (this.active) {
      return false;
    }
    this.active = true;
    return true;
  }

  leave(): void {
    this.active = false;
  }
}

/** DB 시각과 performance.now()를 묶어 기기 벽시계 변경과 무관한 표시용 시계를 만든다. */
export class SynchronizedServerClock implements Clock {
  private serverNow = 0;
  private synchronizedAt = performance.now();

  constructor(serverNow: number) {
    this.synchronize(serverNow);
  }

  now(): number {
    return this.serverNow + Math.max(0, performance.now() - this.synchronizedAt);
  }

  synchronize(serverNow: number): void {
    if (!Number.isFinite(serverNow) || serverNow < 0) {
      throw new RangeError("서버 시각이 올바르지 않습니다.");
    }
    const monotonicServerNow =
      this.serverNow === 0 ? serverNow : Math.max(serverNow, this.now());
    this.serverNow = monotonicServerNow;
    this.synchronizedAt = performance.now();
  }
}

export function createOptimisticPlacementProgress(
  progress: LocalPlayerProgress,
): LocalPlayerProgress {
  if (progress.inventory <= 0) {
    throw new RangeError("재고가 없는 상태에서는 미확정 배치를 만들 수 없습니다.");
  }
  return {
    ...progress,
    inventory: progress.inventory - 1,
    manualProductionAt: [...progress.manualProductionAt],
  };
}

/** RPC가 반환한 변경분만 적용하되 좌표와 ID 중복을 남기지 않는다. */
export function applyAuthoritativeMutation(
  current: readonly VoxelBlock[],
  result: Pick<WorldMutationResult, "removedBlockIds" | "upsertedBlocks">,
): VoxelBlock[] {
  const removed = new Set(result.removedBlockIds);
  const upsertIds = new Set(result.upsertedBlocks.map((block) => block.id));
  const upsertPositions = new Set(
    result.upsertedBlocks.map((block) => positionKey(block)),
  );
  return [
    ...current.filter(
      (block) =>
        !removed.has(block.id) &&
        !upsertIds.has(block.id) &&
        !upsertPositions.has(positionKey(block)),
    ),
    ...result.upsertedBlocks,
  ];
}

/** 서버 청크가 우선이며, 클라이언트 결정적 안전 발판은 없는 좌표에만 합성한다. */
export function mergeServerAndSystemBlocks(
  serverBlocks: readonly VoxelBlock[],
  systemBlocks: readonly VoxelBlock[],
): VoxelBlock[] {
  const occupiedPositions = new Set(serverBlocks.map(positionKey));
  const occupiedIds = new Set(serverBlocks.map((block) => block.id));
  return [
    ...serverBlocks,
    ...systemBlocks.filter(
      (block) =>
        !occupiedPositions.has(positionKey(block)) && !occupiedIds.has(block.id),
    ),
  ];
}

/** 현재 5×5×3 청크 안의 중앙 코어와 결정적 예약 베이 기반 시설만 합성한다. */
export function createNearbyOnlineSystemBlocks(
  worldId: string,
  chunkX: number,
  chunkY: number,
  chunkZ: number,
  radius: number,
  verticalRadius: number,
): VoxelBlock[] {
  const seenPositions = new Set<string>();
  const seenIds = new Set<string>();

  return allOnlineSystemBlocks.flatMap((source) => {
    const chunk = toChunkCoordinate(source.position);
    if (
      Math.abs(chunk.x - chunkX) > radius ||
      Math.abs(chunk.y - chunkY) > verticalRadius ||
      Math.abs(chunk.z - chunkZ) > radius
    ) {
      return [];
    }
    const block = { ...source, worldId };
    const position = positionKey(block);
    if (seenPositions.has(position) || seenIds.has(block.id)) {
      return [];
    }
    seenPositions.add(position);
    seenIds.add(block.id);
    return [block];
  });
}

function positionKey(block: VoxelBlock): string {
  return `${block.position.x},${block.position.y},${block.position.z}`;
}
