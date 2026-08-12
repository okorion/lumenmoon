import { IDBFactory, indexedDB } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbWorldRepository } from "../src/data/IndexedDbWorldRepository";
import { MemoryWorldRepository } from "../src/data/WorldRepository";
import { LocalStorageFallback } from "../src/data/repositoryFactory";
import {
  applyMissionContribution,
  createInitialLocalMissionWorldState,
} from "../src/domain/mission";
import { createLocalPlayerProgress } from "../src/domain/progression";
import { FREE_MODE_IDEMPOTENCY_RETENTION_MS } from "../src/domain/freeMode";
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

  it("오래된 일반 저장이 최신 자유 모드 재고와 멱등 기록을 지우지 않는다", async () => {
    const repository = createRepository();
    const worldId = "free-preserve-" + crypto.randomUUID();
    const freeBlock = {
      ...snapshot(worldId).blocks[0]!,
      id: "free-block",
      owner: LOCAL_PLAYER,
      zone: "public" as const,
      source: "free" as const,
    };
    await repository.save({
      ...snapshot(worldId),
      schemaVersion: 3,
      localFreeModeStates: [
        {
          playerId: LOCAL_PLAYER.id,
          progress: {
            initialGrantClaimed: true,
            inventory: 29,
            lastSettledAt: 1_000,
          },
          operations: [
            {
              idempotencyKey: "00000000-0000-4000-8000-000000000801",
              fingerprint: "place-one",
              upsertedBlocks: [freeBlock],
              removedBlockIds: [],
              progress: {
                initialGrantClaimed: true,
                inventory: 29,
                lastSettledAt: 1_000,
              },
              serverNow: 1_000,
            },
          ],
          updatedAt: 1_000,
        },
      ],
    });
    await repository.save({
      ...snapshot(worldId),
      schemaVersion: 3,
      updatedAt: 2_000,
    });

    const restored = await repository.load(worldId);
    expect(restored?.localFreeModeStates?.[0]?.progress.inventory).toBe(29);
    expect(restored?.localFreeModeStates?.[0]?.operations).toEqual([]);
    expect(
      await repository.loadFreeModeOperation(
        worldId,
        LOCAL_PLAYER.id,
        "00000000-0000-4000-8000-000000000801",
        1_000,
      ),
    ).toMatchObject({ fingerprint: "place-one", serverNow: 1_000 });
  });

  it("자유 모드 snapshot과 action 원장을 함께 저장하고 다시 연 저장소에서도 재생한다", async () => {
    const worldId = "free-journal-" + crypto.randomUUID();
    const idempotencyKey = "00000000-0000-4000-8000-000000000901";
    const operation = {
      idempotencyKey,
      fingerprint: "journal-place",
      upsertedBlocks: [],
      removedBlockIds: [],
      progress: {
        initialGrantClaimed: true,
        inventory: 29,
        lastSettledAt: 900,
      },
      serverNow: 900,
    };
    const first = createRepository();
    await first.saveFreeModeCommit(
      {
        ...snapshot(worldId),
        schemaVersion: 3,
        localFreeModeStates: [
          {
            playerId: LOCAL_PLAYER.id,
            progress: operation.progress,
            operations: [],
            updatedAt: 900,
            revision: 1,
          },
        ],
      },
      LOCAL_PLAYER.id,
      operation,
      0,
    );

    const reopened =
      _name === "IndexedDbWorldRepository" ? createRepository() : first;
    expect(
      await reopened.loadFreeModeOperation(
        worldId,
        LOCAL_PLAYER.id,
        idempotencyKey,
        operation.serverNow,
      ),
    ).toEqual(operation);
    expect((await reopened.load(worldId))?.localFreeModeStates?.[0]?.operations)
      .toEqual([]);
  });

  it("같은 밀리초의 오래된 자유 모드 snapshot이 높은 revision을 덮지 않는다", async () => {
    const repository = createRepository();
    const worldId = "free-revision-" + crypto.randomUUID();
    const freeState = (inventory: number, revision: number) => ({
      playerId: LOCAL_PLAYER.id,
      progress: {
        initialGrantClaimed: true,
        inventory,
        lastSettledAt: 1_000,
      },
      operations: [],
      updatedAt: 1_000,
      revision,
    });
    await repository.save({
      ...snapshot(worldId),
      schemaVersion: 3,
      localFreeModeStates: [freeState(28, 2)],
    });
    await repository.save({
      ...snapshot(worldId),
      schemaVersion: 3,
      localFreeModeStates: [freeState(29, 1)],
    });

    expect((await repository.load(worldId))?.localFreeModeStates?.[0]).toMatchObject({
      progress: { inventory: 28 },
      revision: 2,
    });
  });
});

it("IndexedDB v2 멱등 원장에 24시간 만료 index를 추가하고 점진 정리한다", async () => {
  const factory = new IDBFactory();
  const worldId = "free-v2-expiration";
  const idempotencyKey = "00000000-0000-4000-8000-000000000951";
  const operation = {
    idempotencyKey,
    fingerprint: "legacy-v2-operation",
    upsertedBlocks: [],
    removedBlockIds: [],
    progress: {
      initialGrantClaimed: true,
      inventory: 29,
      lastSettledAt: 1_000,
    },
    serverNow: 1_000,
  };
  await saveVersionTwoOperation(factory, worldId, operation);

  const repository = new IndexedDbWorldRepository(factory);
  expect(
    await repository.loadFreeModeOperation(
      worldId,
      LOCAL_PLAYER.id,
      idempotencyKey,
      operation.serverNow + FREE_MODE_IDEMPOTENCY_RETENTION_MS - 1,
    ),
  ).toEqual(operation);
  expect(
    await repository.loadFreeModeOperation(
      worldId,
      LOCAL_PLAYER.id,
      idempotencyKey,
      operation.serverNow + FREE_MODE_IDEMPOTENCY_RETENTION_MS,
    ),
  ).toBeNull();
});

it("이미 읽은 영구 저장소가 실패하면 빈 메모리 월드로 조용히 분기하지 않는다", async () => {
  const primary = new SaveFailingMemoryWorldRepository();
  const fallback = new MemoryWorldRepository();
  const warnings: string[] = [];
  const worldId = "fallback-stop";
  const initial: WorldSnapshot = {
    ...snapshot(worldId),
    schemaVersion: 3,
    localFreeModeRevision: 1,
    localFreeModeStates: [
      {
        playerId: LOCAL_PLAYER.id,
        progress: {
          initialGrantClaimed: true,
          inventory: 29,
          lastSettledAt: 0,
        },
        operations: [],
        updatedAt: 0,
        revision: 1,
      },
    ],
  };
  await primary.save(initial);
  const repository = new LocalStorageFallback(primary, fallback, warnings);
  expect(await repository.load(worldId)).toMatchObject({
    localFreeModeRevision: 1,
  });
  primary.failWrites = true;

  const next = structuredClone(initial);
  next.localFreeModeRevision = 2;
  next.localFreeModeStates![0]!.revision = 2;
  next.localFreeModeStates![0]!.progress.inventory = 28;
  await expect(
    repository.saveFreeModeCommit(
      next,
      LOCAL_PLAYER.id,
      {
        idempotencyKey: "00000000-0000-4000-8000-000000000952",
        fingerprint: "blocked-fallback",
        upsertedBlocks: [],
        removedBlockIds: [],
        progress: next.localFreeModeStates![0]!.progress,
        serverNow: 1,
      },
      1,
    ),
  ).rejects.toThrow("primary-write-failed");
  expect(await fallback.load(worldId)).toBeNull();
  expect(await repository.load(worldId)).toMatchObject({
    localFreeModeRevision: 1,
  });
  expect(warnings).toEqual([]);
});

class SaveFailingMemoryWorldRepository extends MemoryWorldRepository {
  failWrites = false;

  override async saveFreeModeCommit(
    ...args: Parameters<MemoryWorldRepository["saveFreeModeCommit"]>
  ): Promise<void> {
    if (this.failWrites) throw new Error("primary-write-failed");
    await super.saveFreeModeCommit(...args);
  }
}

async function saveVersionTwoOperation(
  factory: IDBFactory,
  worldId: string,
  operation: {
    idempotencyKey: string;
    fingerprint: string;
    upsertedBlocks: never[];
    removedBlockIds: never[];
    progress: {
      initialGrantClaimed: boolean;
      inventory: number;
      lastSettledAt: number;
    };
    serverNow: number;
  },
): Promise<void> {
  const request = factory.open("lumenmoon", 2);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("worlds", { keyPath: "worldId" });
    request.result.createObjectStore("free-mode-operations", {
      keyPath: ["worldId", "playerId", "idempotencyKey"],
    });
  };
  const database = await idbRequestResult(request);
  const transaction = database.transaction(
    ["worlds", "free-mode-operations"],
    "readwrite",
  );
  transaction.objectStore("worlds").put(snapshot(worldId));
  transaction.objectStore("free-mode-operations").put({
    ...operation,
    worldId,
    playerId: LOCAL_PLAYER.id,
  });
  await idbTransactionDone(transaction);
  database.close();
}

function idbRequestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTransactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
