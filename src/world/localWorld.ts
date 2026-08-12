import {
  DEFAULT_GAME_RULES,
  createLocalPlayerProgress,
  grantInitialInventory,
  type GameRulesConfig,
  type LocalPlayerProgress,
} from "../domain/progression";
import { STARTER_BAY_RESERVED_SLOT_COUNT } from "../domain/starterBay";
import {
  LOCAL_PLAYER,
  SYSTEM_OWNER,
  type LocalGameState,
  type VoxelBlock,
  type WorldSnapshot,
} from "../domain/types";
import {
  createCentralOnlineSystemBlocks,
  createStarterBaySystemBlocks,
} from "./seed";
import {
  cloneLocalMissionWorldState,
  createInitialLocalMissionWorldState,
} from "../domain/mission";

export interface PreparedLocalSnapshot {
  snapshot: WorldSnapshot;
  changed: boolean;
}

export function prepareLocalSnapshot(
  source: WorldSnapshot,
  now: number,
  config: Readonly<GameRulesConfig> = DEFAULT_GAME_RULES,
): PreparedLocalSnapshot {
  const existingSlot = source.localState?.baySlotIndex;
  const baySlotIndex =
    Number.isSafeInteger(existingSlot) &&
    (existingSlot ?? -1) >= 0 &&
    (existingSlot ?? STARTER_BAY_RESERVED_SLOT_COUNT) <
      STARTER_BAY_RESERVED_SLOT_COUNT
      ? existingSlot!
      : 0;
  const progressCandidate: unknown = source.localState?.progress;
  const existingProgress = isValidProgress(progressCandidate, config)
    ? progressCandidate
    : undefined;
  const progress = grantInitialInventory(
    existingProgress ?? createLocalPlayerProgress(now),
    config,
  );
  const localState: LocalGameState = {
    playerId: LOCAL_PLAYER.id,
    baySlotIndex,
    progress: {
      ...progress,
      manualProductionAt: [...progress.manualProductionAt],
    },
  };

  const withoutLegacyMissionSamples = source.blocks.filter(
    (block) => !isLegacyMissionSampleBlock(block),
  );
  const removedLegacyMissionSamples =
    withoutLegacyMissionSamples.length !== source.blocks.length;
  // 시스템 지형은 사용자 저장 데이터가 아니라 버전 관리되는 결정적 합성물이다.
  // 기존 사용자·미션 블록을 보존한 채 이 부분만 최신 루멘문 맵으로 다시 만든다.
  const retainedSourceBlocks = withoutLegacyMissionSamples.filter(
    (block) => !isDeterministicSystemBlock(block),
  );
  const blocks = retainedSourceBlocks.map((block) => ({
    ...block,
    position: { ...block.position },
    owner: { ...block.owner },
  }));
  const occupied = new Set(
    blocks.map(({ position }) => `${position.x},${position.y},${position.z}`),
  );
  const desiredSystemBlocks = [
    ...createCentralOnlineSystemBlocks(),
    ...createStarterBaySystemBlocks(baySlotIndex),
  ].map((block) => ({ ...block, worldId: source.worldId }));
  for (const block of desiredSystemBlocks) {
    const key = `${block.position.x},${block.position.y},${block.position.z}`;
    if (!occupied.has(key)) {
      blocks.push(block);
      occupied.add(key);
    }
  }
  const generatedSystemBlocksChanged = !sameBlockCollection(
    withoutLegacyMissionSamples.filter(isDeterministicSystemBlock),
    blocks.filter(isDeterministicSystemBlock),
  );

  const changed =
    source.schemaVersion !== 2 ||
    source.localState === undefined ||
    source.localState?.playerId !== LOCAL_PLAYER.id ||
    source.localState?.baySlotIndex !== baySlotIndex ||
    progress !== existingProgress ||
    generatedSystemBlocksChanged ||
    removedLegacyMissionSamples ||
    source.localMissionState === undefined;

  return {
    changed,
    snapshot: {
      schemaVersion: 2,
      worldId: source.worldId,
      blocks,
      updatedAt: changed ? now : source.updatedAt,
      localState,
      localMissionState: source.localMissionState
        ? cloneLocalMissionWorldState(source.localMissionState)
        : createInitialLocalMissionWorldState(source.worldId, now),
    },
  };
}

const LEGACY_MISSION_SAMPLE_ID =
  /^(?:gate-[abcd]|gate-top-(?:north|south)|light-(?:dawn|tide))-/u;

const DETERMINISTIC_SYSTEM_ID = /^(?:ground-|online-|starter-)/u;

function isLegacyMissionSampleBlock(block: VoxelBlock): boolean {
  return (
    block.zone === "mission" &&
    (block.owner.id === "sample-dawn" || block.owner.id === "sample-tide") &&
    LEGACY_MISSION_SAMPLE_ID.test(block.id)
  );
}

function isDeterministicSystemBlock(block: VoxelBlock): boolean {
  return (
    block.owner.id === SYSTEM_OWNER.id && DETERMINISTIC_SYSTEM_ID.test(block.id)
  );
}

function sameBlockCollection(
  left: readonly VoxelBlock[],
  right: readonly VoxelBlock[],
): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((block) => [block.id, blockSignature(block)]));
  return left.every(
    (block) => rightById.get(block.id) === blockSignature(block),
  );
}

function blockSignature(block: VoxelBlock): string {
  return [
    block.worldId,
    block.position.x,
    block.position.y,
    block.position.z,
    block.kind,
    block.rotation,
    block.colorIndex,
    block.owner.id,
    block.owner.publicId,
    block.owner.nickname,
    block.owner.emblem,
    block.zone,
    block.createdAt,
    block.supportId ?? "",
    block.source ?? "",
  ].join("|");
}

export function withoutOnboardingBlocks(
  blocks: readonly VoxelBlock[],
  ownerId: string,
): VoxelBlock[] {
  return blocks.filter(
    (block) =>
      block.owner.id !== ownerId || block.source !== "onboarding",
  );
}

function isValidProgress(
  value: unknown,
  config: Readonly<GameRulesConfig>,
): value is LocalPlayerProgress {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<LocalPlayerProgress>;
  const booleans = [
    candidate.initialGrantClaimed,
    candidate.baseCompleted,
    candidate.producerCompleted,
    candidate.trialRewardClaimed,
  ];
  return (
    booleans.every((item) => typeof item === "boolean") &&
    Number.isSafeInteger(candidate.inventory) &&
    (candidate.inventory ?? -1) >= 0 &&
    (candidate.inventory ?? config.maxInventory + 1) <= config.maxInventory &&
    isTimestampOrNull(candidate.baseCompletedAt) &&
    isTimestampOrNull(candidate.producerCompletedAt) &&
    (candidate.productionLevel === 1 || candidate.productionLevel === 2) &&
    isTimestampOrNull(candidate.producerUpgradeCompletedAt) &&
    isTimestamp(candidate.lastSettledAt) &&
    Array.isArray(candidate.manualProductionAt) &&
    candidate.manualProductionAt.every(isTimestamp)
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTimestampOrNull(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}
