import { indexedDB } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbWorldRepository } from "../src/data/IndexedDbWorldRepository";
import { MemoryWorldRepository } from "../src/data/WorldRepository";
import {
  applyMissionContribution,
  createInitialLocalMissionWorldState,
} from "../src/domain/mission";
import { createLocalPlayerProgress } from "../src/domain/progression";
import {
  LOCAL_PLAYER,
  type WorldSnapshot,
} from "../src/domain/types";

function snapshot(worldId: string): WorldSnapshot {
  return {
    schemaVersion: 1,
    worldId,
    updatedAt: 123,
    blocks: [
      {
        id: "saved-block",
        worldId,
        position: { x: 1, y: 2, z: 3 },
        kind: "stair",
        rotation: 1,
        colorIndex: 6,
        owner: LOCAL_PLAYER,
        zone: "personal",
        createdAt: 120,
      },
    ],
  };
}

describe.each([
  ["MemoryWorldRepository", () => new MemoryWorldRepository()],
  [
    "IndexedDbWorldRepository",
    () => new IndexedDbWorldRepository(indexedDB),
  ],
])("%s", (_name, createRepository) => {
  it("월드를 저장하고 다시 복원한다", async () => {
    const repository = createRepository();
    const worldId = "test-" + crypto.randomUUID();
    const original = snapshot(worldId);
    await repository.save(original);

    const restored = await repository.load(worldId);
    expect(restored).toEqual(original);
  });

  it("불러온 값을 수정해도 저장된 원본은 바뀌지 않는다", async () => {
    const repository = createRepository();
    const worldId = "clone-" + crypto.randomUUID();
    await repository.save(snapshot(worldId));
    const restored = await repository.load(worldId);
    restored!.blocks[0]!.position.x = 99;

    const secondRead = await repository.load(worldId);
    expect(secondRead!.blocks[0]!.position.x).toBe(1);
  });

  it("2단계 로컬 진행 상태와 수동 생산 기록을 함께 복원한다", async () => {
    const repository = createRepository();
    const worldId = "progress-" + crypto.randomUUID();
    const original: WorldSnapshot = {
      ...snapshot(worldId),
      schemaVersion: 2,
      localState: {
        playerId: LOCAL_PLAYER.id,
        baySlotIndex: 7,
        progress: {
          initialGrantClaimed: true,
          inventory: 11,
          baseCompleted: true,
          baseCompletedAt: 100,
          producerCompleted: true,
          producerCompletedAt: 200,
          trialRewardClaimed: true,
          productionLevel: 2,
          producerUpgradeCompletedAt: 300,
          lastSettledAt: 400,
          manualProductionAt: [250, 350],
        },
      },
    };
    await repository.save(original);

    const restored = await repository.load(worldId);
    expect(restored?.localState).toEqual(original.localState);
    restored!.localState!.progress.manualProductionAt.push(999);

    const secondRead = await repository.load(worldId);
    expect(secondRead?.localState?.progress.manualProductionAt).toEqual([
      250, 350,
    ]);
  });

  it("다른 탭의 오래된 일반 저장이 최신 완료·기여 기록을 되돌리지 않는다", async () => {
    const repository = createRepository();
    const worldId = "mission-preserve-" + crypto.randomUUID();
    const initialMissionState = createInitialLocalMissionWorldState(worldId, 0);
    const applied = applyMissionContribution({
      state: initialMissionState,
      worldId,
      missionInstanceId: initialMissionState.activeMissionId,
      slotIndex: 0,
      paletteIndex: 0,
      idempotencyKey: "00000000-0000-4000-8000-000000000701",
      actor: {
        publicId: LOCAL_PLAYER.publicId,
        nickname: LOCAL_PLAYER.nickname,
        emblem: LOCAL_PLAYER.emblem,
      },
      progress: {
        ...createLocalPlayerProgress(0),
        initialGrantClaimed: true,
        inventory: 2,
        baseCompleted: true,
        baseCompletedAt: 0,
        producerCompleted: true,
        producerCompletedAt: 0,
        trialRewardClaimed: true,
      },
      now: 1_000,
    });
    await repository.save({
      ...snapshot(worldId),
      localMissionState: applied.state,
    });
    await repository.save({
      ...snapshot(worldId),
      updatedAt: 2_000,
      localMissionState: initialMissionState,
    });

    const restored = await repository.load(worldId);
    expect(restored?.localMissionState?.instances[0]?.contributions).toHaveLength(
      1,
    );
    expect(restored?.localMissionState?.operations).toHaveLength(1);
  });
});
