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
  type LocalGameState,
  type VoxelBlock,
  type WorldSnapshot,
} from "../domain/types";
import { createStarterBaySystemBlocks } from "./seed";
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

  const retainedSourceBlocks = source.blocks.filter(
    (block) => !isLegacyMissionSampleBlock(block),
  );
  const removedLegacyMissionSamples =
    retainedSourceBlocks.length !== source.blocks.length;
  const blocks = retainedSourceBlocks.map((block) => ({
    ...block,
    position: { ...block.position },
    owner: { ...block.owner },
  }));
  const occupied = new Set(
    blocks.map(({ position }) => `${position.x},${position.y},${position.z}`),
  );
  let addedSystemBlocks = false;
  for (const block of createStarterBaySystemBlocks(baySlotIndex)) {
    const key = `${block.position.x},${block.position.y},${block.position.z}`;
    if (!occupied.has(key)) {
      blocks.push(block);
      occupied.add(key);
      addedSystemBlocks = true;
    }
  }

  const changed =
    source.schemaVersion !== 2 ||
    source.localState === undefined ||
    source.localState?.playerId !== LOCAL_PLAYER.id ||
    source.localState?.baySlotIndex !== baySlotIndex ||
    progress !== existingProgress ||
    addedSystemBlocks ||
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

function isLegacyMissionSampleBlock(block: VoxelBlock): boolean {
  return (
    block.zone === "mission" &&
    (block.owner.id === "sample-dawn" || block.owner.id === "sample-tide") &&
    LEGACY_MISSION_SAMPLE_ID.test(block.id)
  );
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
