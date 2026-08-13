import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { Clock } from "../src/domain/progression";
import { createStarterBayLayout } from "../src/domain/starterBay";
import {
  DEFAULT_FREE_MODE_RULES,
  FREE_MODE_MAX_BLOCKS_PER_CHUNK,
  FREE_MODE_FOREIGN_REMOVAL_AGE_MS,
  FREE_MODE_GRANT_INTERVAL_MS,
  FREE_MODE_IDEMPOTENCY_RETENTION_MS,
} from "../src/domain/freeMode";
import {
  LOCAL_PLAYER,
  SYSTEM_OWNER,
  WORLD_ID,
  type BlockOwner,
  type WorldSnapshot,
} from "../src/domain/types";
import { LocalCollaborativeWorldRepository } from "../src/data/LocalCollaborativeWorldRepository";
import { IndexedDbWorldRepository } from "../src/data/IndexedDbWorldRepository";
import {
  FreeModeRevisionConflictError,
  MemoryWorldRepository,
  freeModeRevision,
} from "../src/data/WorldRepository";

const PLAYER_B: BlockOwner = {
  id: "local-player-b",
  publicId: "#Q7R4",
  nickname: "푸른 제비",
  emblem: "◇",
};

class FakeClock implements Clock {
  constructor(public current = 0) {}
  now(): number {
    return this.current;
  }
}

describe("LocalCollaborativeWorldRepository 자유 모드", () => {
  it("관문 모드 진행과 분리해 첫 진입 시 사용자별 30개를 한 번만 지급한다", async () => {
    const storage = new MemoryWorldRepository();
    const clock = new FakeClock(1_000);
    const playerA = new LocalCollaborativeWorldRepository(storage, { clock });
    const playerB = new LocalCollaborativeWorldRepository(storage, {
      clock,
      player: PLAYER_B,
    });

    const missionBootstrap = await playerA.bootstrapPlayer(WORLD_ID);
    const firstA = await playerA.getFreeModeOverview(WORLD_ID);
    const secondA = await playerA.getFreeModeOverview(WORLD_ID);
    const firstB = await playerB.getFreeModeOverview(WORLD_ID);

    expect(missionBootstrap.progress.inventory).toBe(24);
    expect(firstA.progress.inventory).toBe(30);
    expect(secondA.progress.inventory).toBe(30);
    expect(firstB.progress.inventory).toBe(30);
    expect((await storage.load(WORLD_ID))?.localFreeModeStates).toHaveLength(2);
  });

  it("권위 Clock으로 시간당 5개를 정산하고 100개에서 멈춘다", async () => {
    const storage = new MemoryWorldRepository();
    const clock = new FakeClock(0);
    const repository = new LocalCollaborativeWorldRepository(storage, { clock });
    await repository.getFreeModeOverview(WORLD_ID);

    clock.current = FREE_MODE_GRANT_INTERVAL_MS - 1;
    expect((await repository.settleFreeModeInventory(WORLD_ID)).produced).toBe(0);
    clock.current = FREE_MODE_GRANT_INTERVAL_MS * 2;
    expect(await repository.settleFreeModeInventory(WORLD_ID)).toMatchObject({
      produced: 10,
      progress: { inventory: 40 },
    });
    clock.current = FREE_MODE_GRANT_INTERVAL_MS * 20;
    const capped = await repository.settleFreeModeInventory(WORLD_ID);
    expect(capped.progress.inventory).toBe(100);
    expect(capped.nextGrantInMs).toBeNull();
  });

  it("가득 찬 재고 조회는 no-op이고 100→99 배치 시각부터 다음 1시간을 재다", async () => {
    const storage = new CountingMemoryWorldRepository();
    const clock = new FakeClock(0);
    const repository = new LocalCollaborativeWorldRepository(storage, { clock });
    await repository.getFreeModeOverview(WORLD_ID);
    clock.current = FREE_MODE_GRANT_INTERVAL_MS * 14;
    expect((await repository.settleFreeModeInventory(WORLD_ID)).progress.inventory)
      .toBe(100);
    storage.freeModeStateSaveCount = 0;

    clock.current += FREE_MODE_GRANT_INTERVAL_MS / 2;
    const firstRead = await repository.getFreeModeOverview(WORLD_ID);
    const secondRead = await repository.getFreeModeOverview(WORLD_ID);
    expect(firstRead.progress).toEqual(secondRead.progress);
    expect(storage.freeModeStateSaveCount).toBe(0);

    const placedAt = clock.current;
    const placedBlockId = uuid(2_551);
    const placed = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_550),
      actions: [placeAction(placedBlockId, 69)],
    });
    expect(placed.progress).toMatchObject({
      inventory: 99,
      lastSettledAt: placedAt,
    });
    clock.current = placedAt + 50 * 60 * 1_000;
    const removedAt = clock.current;
    const removed = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_552),
      actions: [{ type: "remove", blockId: placedBlockId }],
    });
    expect(removed.progress).toMatchObject({
      inventory: 100,
      lastSettledAt: removedAt,
    });
    const placedAgain = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_553),
      actions: [placeAction(uuid(2_554), 69)],
    });
    expect(placedAgain.progress).toMatchObject({
      inventory: 99,
      lastSettledAt: removedAt,
    });
    clock.current = removedAt + FREE_MODE_GRANT_INTERVAL_MS - 1;
    expect((await repository.settleFreeModeInventory(WORLD_ID)).produced).toBe(0);
    clock.current += 1;
    expect(await repository.settleFreeModeInventory(WORLD_ID)).toMatchObject({
      produced: 1,
      progress: { inventory: 100, lastSettledAt: clock.current },
    });
  });

  it("배치와 자기 제거를 원자 처리하고 제거한 블록 1개를 돌려준다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(10_000),
    });
    const placed = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(1),
      actions: [placeAction(uuid(2), 40)],
    });
    const removed = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(3),
      actions: [{ type: "remove", blockId: uuid(2) }],
    });

    expect(placed.progress.inventory).toBe(29);
    expect(placed.upsertedBlocks[0]).toMatchObject({
      source: "free",
      zone: "public",
      createdAt: 10_000,
    });
    expect(removed.progress.inventory).toBe(30);
    expect(removed.removedBlockIds).toEqual([uuid(2)]);
  });

  it("관문 월드와 자유 모드 청크 조회를 source 경계로 분리한다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(4),
      actions: [placeAction(uuid(5), 47)],
    });
    const request = {
      worldId: WORLD_ID,
      chunkX: 0,
      chunkY: 0,
      chunkZ: 0,
      radius: 1,
      verticalRadius: 1,
    };

    const missionWorld = await repository.loadNearbyBlocks(request);
    const freeWorld = await repository.loadNearbyFreeModeBlocks(request);
    expect(missionWorld.blocks.some(({ id }) => id === uuid(5))).toBe(false);
    expect(freeWorld.blocks).toEqual([
      expect.objectContaining({ id: uuid(5), source: "free" }),
    ]);
    expect(freeWorld.blockCount).toBe(1);
    expect(freeWorld.blockLimit).toBe(8_192);
  });

  it("다른 모드의 사용자 블록과 같은 좌표를 자유 모드에서 독립적으로 쓴다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    await repository.bootstrapPlayer(WORLD_ID);
    const snapshot = (await storage.load(WORLD_ID))!;
    const sharedPosition = placeAction(uuid(8), 48).position;
    snapshot.blocks.push({
      id: uuid(6),
      worldId: WORLD_ID,
      position: sharedPosition,
      kind: "cube",
      rotation: 0,
      colorIndex: 1,
      owner: PLAYER_B,
      zone: "public",
      createdAt: 0,
      source: "inventory",
    });
    await saveFixtureSnapshot(storage, snapshot);

    const result = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(7),
      actions: [placeAction(uuid(8), 48)],
    });
    expect(result.upsertedBlocks).toHaveLength(1);
    expect(
      (await storage.load(WORLD_ID))?.blocks.filter(
        ({ position }) =>
          position.x === sharedPosition.x &&
          position.y === sharedPosition.y &&
          position.z === sharedPosition.z,
      ),
    ).toHaveLength(2);
  });

  it("결정적 바닥은 지지 행 없이 허용하고 다른 모드 블록은 공중 지지대로 쓰지 않는다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    await repository.bootstrapPlayer(WORLD_ID);
    const snapshot = (await storage.load(WORLD_ID))!;
    const groundedPosition = placeAction(uuid(17), 51).position;
    snapshot.blocks.push({
      id: uuid(9),
      worldId: WORLD_ID,
      position: groundedPosition,
      kind: "cube",
      rotation: 0,
      colorIndex: 1,
      owner: PLAYER_B,
      zone: "public",
      createdAt: 0,
      source: "inventory",
    });
    await saveFixtureSnapshot(storage, snapshot);

    await expect(
      repository.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(14),
        actions: [
          {
            ...placeAction(uuid(15), 50),
            position: { ...groundedPosition, y: 2 },
            supportId: uuid(9),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid-support" });
    await expect(
      repository.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(20),
        actions: [
          {
            ...placeAction(uuid(21), 53),
            position: { ...placeAction(uuid(21), 53).position, y: 2 },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid-support" });
    const grounded = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(16),
      actions: [
        {
          ...placeAction(uuid(17), 51),
          supportId: uuid(9),
        },
      ],
    });
    expect(grounded.upsertedBlocks[0]?.supportId).toBeUndefined();
    await expect(
      repository.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(18),
        actions: [
          {
            ...placeAction(uuid(19), 52),
            position: { x: 52, y: 0, z: 40 },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "protected-zone" });
  });

  it("스폰 본체·연속 통로·중앙 패드만 막고 근처 지면과 관문 건축은 허용한다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    await repository.bootstrapPlayer(WORLD_ID);
    const layout = createStarterBayLayout(0);
    const spawn = {
      x: Math.floor(layout.safeSpawn.x),
      y: Math.floor(layout.safeSpawn.y),
      z: Math.floor(layout.safeSpawn.z),
    };
    const protectedPositions = [
      spawn,
      { x: 1, y: spawn.y, z: -15 },
      { x: 7, y: spawn.y, z: 7 },
    ];
    for (const [index, position] of protectedPositions.entries()) {
      await expect(
        repository.commitFreeModeActions({
          worldId: WORLD_ID,
          idempotencyKey: uuid(27 + index * 2),
          actions: [
            {
              ...placeAction(uuid(28 + index * 2), position.x),
              position,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "protected-zone" });
    }

    const outsidePad = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(33),
      actions: [
        {
          ...placeAction(uuid(34), 8),
          position: { x: 8, y: 1, z: 0 },
        },
      ],
    });
    expect(outsidePad.upsertedBlocks).toEqual([
      expect.objectContaining({ id: uuid(34), source: "free" }),
    ]);

    const platformSide = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(37),
      actions: [
        {
          ...placeAction(uuid(38), -2),
          position: { x: -2, y: 1, z: -28 },
        },
      ],
    });
    expect(platformSide.upsertedBlocks).toEqual([
      expect.objectContaining({ id: uuid(38), source: "free" }),
    ]);

    await expect(
      repository.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(39),
        actions: [
          {
            ...placeAction(uuid(40), 40),
            position: { x: 40, y: 1, z: 40 },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid-support" });

    const guide = layout.baseGuides.find(({ position }) => position.y === 1)!;
    const mission = await repository.commitWorldActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(35),
      actions: [
        {
          type: "place",
          blockId: uuid(36),
          position: { ...guide.position },
          kind: guide.kind,
          rotation: guide.rotation,
          colorIndex: 3,
        },
      ],
    });
    expect(mission.upsertedBlocks).toEqual([
      expect.objectContaining({ id: uuid(36), source: "onboarding" }),
    ]);
  });

  it("정확한 시스템 셀만 막고 중심 상공 전체를 보호 구역으로 만들지 않는다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    await repository.bootstrapPlayer(WORLD_ID);
    await expect(
      repository.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(22),
        actions: [
          {
            ...placeAction(uuid(23), 0),
            position: { x: 0, y: 1, z: 0 },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "duplicate-coordinate" });
    const snapshot = (await storage.load(WORLD_ID))!;
    snapshot.blocks.push({
      id: uuid(26),
      worldId: WORLD_ID,
      position: { x: 1, y: 20, z: 0 },
      kind: "cube",
      rotation: 0,
      colorIndex: 3,
      owner: PLAYER_B,
      zone: "public",
      createdAt: 0,
      source: "free",
    });
    await saveFixtureSnapshot(storage, snapshot);
    const aboveTower = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(24),
      actions: [
        {
          ...placeAction(uuid(25), 0),
          position: { x: 0, y: 20, z: 0 },
          supportId: uuid(26),
        },
      ],
    });
    expect(aboveTower.upsertedBlocks).toHaveLength(1);
  });

  it("타인 블록은 72시간 전에는 그대로 두고 경계부터 재고 보상 없이 제거한다", async () => {
    const storage = new MemoryWorldRepository();
    const clock = new FakeClock(0);
    const freeModeConfig = {
      ...DEFAULT_FREE_MODE_RULES,
      grantIntervalMs: 100 * 24 * 60 * 60 * 1_000,
    };
    const playerA = new LocalCollaborativeWorldRepository(storage, {
      clock,
      freeModeConfig,
    });
    const playerB = new LocalCollaborativeWorldRepository(storage, {
      clock,
      player: PLAYER_B,
      freeModeConfig,
    });
    await playerA.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(10),
      actions: [placeAction(uuid(11), 41)],
    });
    await playerB.getFreeModeOverview(WORLD_ID);

    clock.current = FREE_MODE_FOREIGN_REMOVAL_AGE_MS - 1;
    await expect(
      playerB.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(12),
        actions: [{ type: "remove", blockId: uuid(11) }],
      }),
    ).rejects.toMatchObject({ code: "foreign-block-locked" });
    expect(
      (await storage.load(WORLD_ID))?.blocks.some(({ id }) => id === uuid(11)),
    ).toBe(true);

    clock.current = FREE_MODE_FOREIGN_REMOVAL_AGE_MS;
    const removed = await playerB.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(13),
      actions: [{ type: "remove", blockId: uuid(11) }],
    });
    expect(removed.removedBlockIds).toEqual([uuid(11)]);
    expect(removed.progress.inventory).toBe(30);
  });

  it("자기 지지 블록은 즉시 회수하고 타인 자식은 원자적으로 분리한다", async () => {
    const storage = new MemoryWorldRepository();
    const clock = new FakeClock(0);
    const freeModeConfig = {
      ...DEFAULT_FREE_MODE_RULES,
      grantIntervalMs: 100 * 24 * 60 * 60 * 1_000,
    };
    const playerA = new LocalCollaborativeWorldRepository(storage, {
      clock,
      freeModeConfig,
    });
    const playerB = new LocalCollaborativeWorldRepository(storage, {
      clock,
      player: PLAYER_B,
      freeModeConfig,
    });
    const parentId = uuid(2_700);
    const childId = uuid(2_701);

    await playerA.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_702),
      actions: [placeAction(parentId, 41)],
    });
    await playerB.getFreeModeOverview(WORLD_ID);
    const childPosition = { ...placeAction(childId, 41).position, y: 2 };
    await playerB.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_703),
      actions: [
        {
          ...placeAction(childId, 41),
          position: childPosition,
          supportId: parentId,
        },
      ],
    });

    clock.current = FREE_MODE_FOREIGN_REMOVAL_AGE_MS;
    await expect(
      playerB.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(2_704),
        actions: [{ type: "remove", blockId: parentId }],
      }),
    ).rejects.toMatchObject({ code: "support-in-use" });
    expect((await playerB.getFreeModeOverview(WORLD_ID)).progress.inventory).toBe(29);

    const ownerRequest = {
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_705),
      actions: [{ type: "remove" as const, blockId: parentId }],
    };
    const ownerRemoval = await playerA.commitFreeModeActions(ownerRequest);
    const replay = await playerA.commitFreeModeActions(ownerRequest);
    expect(ownerRemoval).toMatchObject({
      removedBlockIds: [parentId],
      progress: { inventory: 30 },
      replayed: false,
    });
    expect(ownerRemoval.upsertedBlocks).toEqual([
      expect.objectContaining({ id: childId }),
    ]);
    expect(ownerRemoval.upsertedBlocks[0]?.supportId).toBeUndefined();
    expect(replay).toMatchObject({
      removedBlockIds: [parentId],
      progress: { inventory: 30 },
      replayed: true,
    });

    const snapshot = (await storage.load(WORLD_ID))!;
    expect(snapshot.blocks.find(({ id }) => id === parentId)).toBeUndefined();
    expect(snapshot.blocks.find(({ id }) => id === childId)?.supportId).toBeUndefined();
    const childRemoval = await playerB.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_706),
      actions: [{ type: "remove", blockId: childId }],
    });
    expect(childRemoval).toMatchObject({
      removedBlockIds: [childId],
      progress: { inventory: 30 },
    });
  });

  it("멱등 결과를 스냅샷에 보존해 저장소 인스턴스를 다시 만들어도 중복 차감하지 않는다", async () => {
    const storage = new MemoryWorldRepository();
    const clock = new FakeClock(0);
    const request = {
      worldId: WORLD_ID,
      idempotencyKey: uuid(20),
      actions: [placeAction(uuid(21), 42)],
    };
    const firstRepository = new LocalCollaborativeWorldRepository(storage, {
      clock,
    });
    const first = await firstRepository.commitFreeModeActions(request);
    const reloadedRepository = new LocalCollaborativeWorldRepository(storage, {
      clock,
    });
    const replay = await reloadedRepository.commitFreeModeActions(request);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.progress.inventory).toBe(29);
    expect(
      (await storage.load(WORLD_ID))?.blocks.filter(
        ({ id }) => id === uuid(21),
      ),
    ).toHaveLength(1);
  });

  it("IndexedDB v1 inline 원장을 v2 upgrade에서 옮겨 첫 옛 요청부터 재생한다", async () => {
    const factory = new IDBFactory();
    const action = placeAction(uuid(2_500), 42);
    const request = {
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_501),
      actions: [action],
    };
    const originalBlock = {
      id: action.blockId,
      worldId: WORLD_ID,
      position: { ...action.position },
      kind: action.kind,
      rotation: action.rotation,
      colorIndex: action.colorIndex,
      owner: { ...LOCAL_PLAYER },
      zone: "public" as const,
      createdAt: 0,
      source: "free" as const,
    };
    const originalProgress = {
      initialGrantClaimed: true,
      inventory: 29,
      lastSettledAt: 0,
    };
    const fingerprint = JSON.stringify({
      worldId: WORLD_ID,
      actions: [{ ...action, supportId: null }],
    });
    const legacySnapshot: WorldSnapshot = {
      schemaVersion: 3,
      worldId: WORLD_ID,
      blocks: [],
      updatedAt: 0,
      localFreeModeStates: [
        {
          playerId: LOCAL_PLAYER.id,
          progress: {
            initialGrantClaimed: true,
            inventory: 30,
            lastSettledAt: 0,
          },
          operations: [
            {
              idempotencyKey: request.idempotencyKey,
              fingerprint,
              upsertedBlocks: [originalBlock],
              removedBlockIds: [],
              progress: originalProgress,
              serverNow: 0,
            },
          ],
          updatedAt: 0,
        },
      ],
    };
    await saveVersionOneSnapshot(factory, legacySnapshot);

    const storage = new IndexedDbWorldRepository(factory);
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    const replay = await repository.commitFreeModeActions(request);

    expect(replay).toMatchObject({
      replayed: true,
      upsertedBlocks: [originalBlock],
      progress: originalProgress,
    });
    const migrated = await storage.load(WORLD_ID);
    expect(migrated?.blocks).toEqual([]);
    expect(migrated?.localFreeModeStates?.[0]?.progress.inventory).toBe(30);
    expect(migrated?.localFreeModeStates?.[0]?.operations).toEqual([]);
    expect(
      await storage.loadFreeModeOperation(
        WORLD_ID,
        LOCAL_PLAYER.id,
        request.idempotencyKey,
        0,
      ),
    ).toMatchObject({ fingerprint, progress: originalProgress });
  });

  it("한 요청의 뒤쪽 작업이 실패하면 앞쪽 배치와 재고 차감도 저장하지 않는다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    await repository.getFreeModeOverview(WORLD_ID);
    const firstAction = placeAction(uuid(31), 43);

    await expect(
      repository.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(30),
        actions: [
          firstAction,
          {
            ...placeAction(uuid(32), 44),
            position: { ...firstAction.position },
          },
        ],
      }),
    ).rejects.toThrow(/좌표가 중복/);

    const saved = await storage.load(WORLD_ID);
    expect(saved?.blocks.some(({ id }) => id === uuid(31))).toBe(false);
    expect(saved?.localFreeModeStates?.[0]?.progress.inventory).toBe(30);
  });

  it("같은 좌표의 동시 요청은 하나만 확정하고 한 번만 차감한다", async () => {
    const storage = new MemoryWorldRepository();
    const clock = new FakeClock(0);
    const firstTab = new LocalCollaborativeWorldRepository(storage, { clock });
    const secondTab = new LocalCollaborativeWorldRepository(storage, { clock });
    const results = await Promise.allSettled([
      firstTab.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(35),
        actions: [placeAction(uuid(36), 46)],
      }),
      secondTab.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(37),
        actions: [placeAction(uuid(38), 46)],
      }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const saved = await storage.load(WORLD_ID);
    expect(saved?.localFreeModeStates?.[0]?.progress.inventory).toBe(29);
    const contestedPosition = placeAction(uuid(36), 46).position;
    expect(
      saved?.blocks.filter(
        ({ position }) =>
          position.x === contestedPosition.x &&
          position.y === contestedPosition.y &&
          position.z === contestedPosition.z,
      ),
    ).toHaveLength(1);
  });

  it("Web Locks 없이 서로 다른 IndexedDB adapter의 두 배치를 CAS retry로 모두 보존한다", async () => {
    const factory = new IDBFactory();
    const clock = new FakeClock(0);
    const initializer = new LocalCollaborativeWorldRepository(
      new IndexedDbWorldRepository(factory),
      { clock },
    );
    await initializer.getFreeModeOverview(WORLD_ID);

    const barrier = new FirstFreeModeWriteBarrier(2);
    const storageA = new BarrierIndexedDbWorldRepository(factory, barrier);
    const storageB = new BarrierIndexedDbWorldRepository(factory, barrier);
    const playerA = new LocalCollaborativeWorldRepository(storageA, { clock });
    const playerB = new LocalCollaborativeWorldRepository(storageB, { clock });
    const firstRequest = {
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_600),
      actions: [placeAction(uuid(2_601), 70)],
    };
    const secondRequest = {
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_602),
      actions: [placeAction(uuid(2_603), 71)],
    };

    vi.stubGlobal("navigator", {});
    try {
      const results = await Promise.all([
        playerA.commitFreeModeActions(firstRequest),
        playerB.commitFreeModeActions(secondRequest),
      ]);
      expect(results.map(({ progress }) => progress.inventory).sort()).toEqual([
        28, 29,
      ]);
    } finally {
      vi.unstubAllGlobals();
    }

    const saved = await storageA.load(WORLD_ID);
    expect(
      saved?.blocks
        .filter(({ source }) => source === "free")
        .map(({ id }) => id)
        .sort(),
    ).toEqual([uuid(2_601), uuid(2_603)].sort());
    expect(saved?.localFreeModeStates?.[0]).toMatchObject({
      progress: { inventory: 28 },
      revision: 3,
    });
    expect(
      await storageA.loadFreeModeOperation(
        WORLD_ID,
        LOCAL_PLAYER.id,
        firstRequest.idempotencyKey,
        0,
      ),
    ).not.toBeNull();
    expect(
      await storageB.loadFreeModeOperation(
        WORLD_ID,
        LOCAL_PLAYER.id,
        secondRequest.idempotencyKey,
        0,
      ),
    ).not.toBeNull();
  });

  it("Web Locks 없이 서로 다른 사용자가 동시 배치해도 전역 revision으로 모두 보존한다", async () => {
    const factory = new IDBFactory();
    const clock = new FakeClock(0);
    const initializerStorage = new IndexedDbWorldRepository(factory);
    await new LocalCollaborativeWorldRepository(initializerStorage, { clock })
      .getFreeModeOverview(WORLD_ID);
    await new LocalCollaborativeWorldRepository(initializerStorage, {
      clock,
      player: PLAYER_B,
    }).getFreeModeOverview(WORLD_ID);

    const barrier = new FirstFreeModeWriteBarrier(2);
    const storageA = new BarrierIndexedDbWorldRepository(factory, barrier);
    const storageB = new BarrierIndexedDbWorldRepository(factory, barrier);
    const playerA = new LocalCollaborativeWorldRepository(storageA, { clock });
    const playerB = new LocalCollaborativeWorldRepository(storageB, {
      clock,
      player: PLAYER_B,
    });
    const requestA = {
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_630),
      actions: [placeAction(uuid(2_631), 74)],
    };
    const requestB = {
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_632),
      actions: [placeAction(uuid(2_633), 75)],
    };

    vi.stubGlobal("navigator", {});
    try {
      await Promise.all([
        playerA.commitFreeModeActions(requestA),
        playerB.commitFreeModeActions(requestB),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }

    const saved = await storageA.load(WORLD_ID);
    expect(
      saved?.blocks
        .filter(({ source }) => source === "free")
        .map(({ id }) => id)
        .sort(),
    ).toEqual([uuid(2_631), uuid(2_633)].sort());
    expect(saved?.localFreeModeRevision).toBe(4);
    expect(
      saved?.localFreeModeStates
        ?.map(({ playerId, progress }) => [playerId, progress.inventory])
        .sort(),
    ).toEqual([
      [LOCAL_PLAYER.id, 29],
      [PLAYER_B.id, 29],
    ].sort());
    expect(
      await storageA.loadFreeModeOperation(
        WORLD_ID,
        LOCAL_PLAYER.id,
        requestA.idempotencyKey,
        0,
      ),
    ).not.toBeNull();
    expect(
      await storageB.loadFreeModeOperation(
        WORLD_ID,
        PLAYER_B.id,
        requestB.idempotencyKey,
        0,
      ),
    ).not.toBeNull();
  });

  it("Web Locks 없이 관문과 자유 배치가 겹쳐도 상대 모드 블록과 재고를 보존한다", async () => {
    const factory = new IDBFactory();
    const clock = new FakeClock(0);
    const initializer = new LocalCollaborativeWorldRepository(
      new IndexedDbWorldRepository(factory),
      { clock },
    );
    await initializer.bootstrapPlayer(WORLD_ID);
    await initializer.getFreeModeOverview(WORLD_ID);

    const barrier = new FirstFreeModeWriteBarrier(2);
    const missionStorage = new AllWritesBarrierIndexedDbWorldRepository(
      factory,
      barrier,
    );
    const freeStorage = new AllWritesBarrierIndexedDbWorldRepository(
      factory,
      barrier,
    );
    const missionRepository = new LocalCollaborativeWorldRepository(
      missionStorage,
      { clock },
    );
    const freeRepository = new LocalCollaborativeWorldRepository(freeStorage, {
      clock,
    });
    const guide = createStarterBayLayout(0).baseGuides.find(
      ({ position }) => position.y === 1,
    )!;
    const missionBlockId = uuid(2_640);
    const freeBlockId = uuid(2_641);
    const freeActionId = uuid(2_642);

    vi.stubGlobal("navigator", {});
    try {
      await Promise.all([
        missionRepository.commitWorldActions({
          worldId: WORLD_ID,
          idempotencyKey: uuid(2_643),
          actions: [
            {
              type: "place",
              blockId: missionBlockId,
              position: { ...guide.position },
              kind: guide.kind,
              rotation: guide.rotation,
              colorIndex: 3,
            },
          ],
        }),
        freeRepository.commitFreeModeActions({
          worldId: WORLD_ID,
          idempotencyKey: freeActionId,
          actions: [placeAction(freeBlockId, 76)],
        }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }

    const saved = await missionStorage.load(WORLD_ID);
    expect(saved?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: missionBlockId, source: "onboarding" }),
        expect.objectContaining({ id: freeBlockId, source: "free" }),
      ]),
    );
    expect(saved?.localState?.progress.inventory).toBe(23);
    expect(saved?.localFreeModeStates?.[0]?.progress.inventory).toBe(29);
    expect(
      await freeStorage.loadFreeModeOperation(
        WORLD_ID,
        LOCAL_PLAYER.id,
        freeActionId,
        0,
      ),
    ).not.toBeNull();
  });

  it("Web Locks 없이 배치와 시간 정산이 겹쳐도 지급과 차감을 한 번씩 반영한다", async () => {
    const factory = new IDBFactory();
    const clock = new FakeClock(0);
    const initializer = new LocalCollaborativeWorldRepository(
      new IndexedDbWorldRepository(factory),
      { clock },
    );
    await initializer.getFreeModeOverview(WORLD_ID);
    clock.current = FREE_MODE_GRANT_INTERVAL_MS;

    const barrier = new FirstFreeModeWriteBarrier(2);
    const storageA = new BarrierIndexedDbWorldRepository(factory, barrier);
    const storageB = new BarrierIndexedDbWorldRepository(factory, barrier);
    const playerA = new LocalCollaborativeWorldRepository(storageA, { clock });
    const playerB = new LocalCollaborativeWorldRepository(storageB, { clock });
    const placeRequest = {
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_610),
      actions: [placeAction(uuid(2_611), 72)],
    };

    vi.stubGlobal("navigator", {});
    try {
      await Promise.all([
        playerA.commitFreeModeActions(placeRequest),
        playerB.settleFreeModeInventory(WORLD_ID),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }

    const saved = await storageA.load(WORLD_ID);
    expect(saved?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: uuid(2_611), source: "free" }),
      ]),
    );
    expect(saved?.localFreeModeStates?.[0]?.progress).toMatchObject({
      inventory: 34,
      lastSettledAt: FREE_MODE_GRANT_INTERVAL_MS,
    });
    expect(
      await storageA.loadFreeModeOperation(
        WORLD_ID,
        LOCAL_PLAYER.id,
        placeRequest.idempotencyKey,
        FREE_MODE_GRANT_INTERVAL_MS,
      ),
    ).not.toBeNull();
  });

  it("revision 충돌이 계속되면 4회 뒤 retryable 오류로 중단한다", async () => {
    const storage = new ConflictCountingMemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    await repository.getFreeModeOverview(WORLD_ID);
    storage.rejectFreeModeCommits = true;

    await expect(
      repository.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(2_620),
        actions: [placeAction(uuid(2_621), 73)],
      }),
    ).rejects.toMatchObject({
      code: "free-mode-revision-conflict",
      retryable: true,
    });
    expect(storage.rejectedCommitCount).toBe(4);
    expect(
      (await storage.load(WORLD_ID))?.blocks.some(
        ({ id }) => id === uuid(2_621),
      ),
    ).toBe(false);
  });

  it("권위 Clock이 역행해도 다음 배치의 재고·멱등 기록·생성 시각을 되돌리지 않는다", async () => {
    const storage = new MemoryWorldRepository();
    const clock = new FakeClock(2_000);
    const repository = new LocalCollaborativeWorldRepository(storage, { clock });
    await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(50),
      actions: [placeAction(uuid(51), 54)],
    });

    clock.current = 1_500;
    const second = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(52),
      actions: [placeAction(uuid(53), 55)],
    });
    const saved = await storage.load(WORLD_ID);

    expect(second.serverNow).toBe(2_000);
    expect(second.progress.inventory).toBe(28);
    expect(second.upsertedBlocks[0]?.createdAt).toBe(2_000);
    expect(saved?.localFreeModeStates?.[0]).toMatchObject({
      updatedAt: 2_000,
      progress: { inventory: 28, lastSettledAt: 2_000 },
    });
    expect(saved?.localFreeModeStates?.[0]?.operations).toEqual([]);
    expect(
      await storage.loadFreeModeOperation(
        WORLD_ID,
        LOCAL_PLAYER.id,
        uuid(50),
        2_000,
      ),
    ).not.toBeNull();
    expect(
      await storage.loadFreeModeOperation(
        WORLD_ID,
        LOCAL_PLAYER.id,
        uuid(52),
        2_000,
      ),
    ).not.toBeNull();
    expect(saved?.blocks.filter(({ source }) => source === "free")).toHaveLength(2);
  });

  it("관문 모드 제거 경로가 자유 모드 블록을 우회 삭제하지 못하게 한다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(40),
      actions: [placeAction(uuid(41), 45)],
    });

    await expect(
      repository.commitWorldActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(42),
        actions: [{ type: "remove", blockId: uuid(41) }],
      }),
    ).rejects.toMatchObject({ code: "free-mode-only" });
  });

  it("자유 모드 가이드 좌표가 관문 완성·생산·참여 조건으로 집계되지 않는다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    await repository.bootstrapPlayer(WORLD_ID);
    const layout = createStarterBayLayout(0);
    const snapshot = (await storage.load(WORLD_ID))!;
    snapshot.blocks.push(
      ...[...layout.baseGuides, ...layout.producerGuides].map(
        (guide, index) => ({
          id: uuid(2_000 + index),
          worldId: WORLD_ID,
        position: { ...guide.position },
        kind: guide.kind,
        rotation: guide.rotation,
        colorIndex: 3,
          owner: { ...LOCAL_PLAYER },
          zone: guide.group === "base" ? ("personal" as const) : ("producer" as const),
          createdAt: 0,
          source: "free" as const,
        }),
      ),
    );
    await saveFixtureSnapshot(storage, snapshot);

    const overview = await repository.getMissionOverview(WORLD_ID);
    expect(overview.eligibility).toEqual({
      baseBuilt: 0,
      producerBuilt: 0,
      eligible: false,
    });
    expect((await repository.settleProduction(WORLD_ID)).produced).toBe(0);
    await expect(
      repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: overview.activeMission.id,
        slotIndex: 0,
        paletteIndex: 0,
        idempotencyKey: uuid(2_100),
      }),
    ).rejects.toMatchObject({ code: "onboarding-incomplete" });
  });

  it("같은 블록 ID를 양 모드가 독립적으로 쓰고 자유 블록을 관문 지지대로 쓰지 않는다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    const layout = createStarterBayLayout(0);
    const guide = layout.baseGuides[0]!;
    const freePosition = {
      x: 8,
      y: 1,
      z: 0,
    };
    const sharedId = uuid(2_200);
    await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_201),
      actions: [
        {
          type: "place",
          blockId: sharedId,
          position: freePosition,
          kind: guide.kind,
          rotation: guide.rotation,
          colorIndex: 3,
        },
      ],
    });
    const mission = await repository.commitWorldActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_202),
      actions: [
        {
          type: "place",
          blockId: sharedId,
          position: { ...guide.position },
          kind: guide.kind,
          rotation: guide.rotation,
          colorIndex: 3,
        },
      ],
    });
    expect(mission.progress.inventory).toBe(23);
    expect(
      (await storage.load(WORLD_ID))?.blocks.filter(({ id }) => id === sharedId),
    ).toHaveLength(2);

    const unsupportedGuide = createStarterBayLayout(0).baseGuides.find(
      ({ position }) => position.y > 1,
    )!;
    const freeSupportId = uuid(2_205);
    const snapshot = (await storage.load(WORLD_ID))!;
    snapshot.blocks.push({
      id: freeSupportId,
      worldId: WORLD_ID,
      position: {
        x: unsupportedGuide.position.x,
        y: unsupportedGuide.position.y - 1,
        z: unsupportedGuide.position.z,
      },
      kind: "cube",
      rotation: 0,
      colorIndex: 3,
      owner: { ...LOCAL_PLAYER },
      zone: "personal",
      createdAt: 0,
      source: "free",
    });
    await saveFixtureSnapshot(storage, snapshot);

    await expect(
      repository.commitWorldActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(2_203),
        actions: [
          {
            type: "place",
            blockId: uuid(2_204),
            position: { ...unsupportedGuide.position },
            kind: unsupportedGuide.kind,
            rotation: unsupportedGuide.rotation,
            colorIndex: 3,
            supportId: freeSupportId,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid-support" });

    await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_206),
      actions: [{ type: "remove", blockId: sharedId }],
    });
    expect(
      (await storage.load(WORLD_ID))?.blocks.filter(({ id }) => id === sharedId),
    ).toEqual([expect.objectContaining({ source: "onboarding" })]);
    await expect(
      repository.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(2_207),
        actions: [{ type: "remove", blockId: sharedId }],
      }),
    ).rejects.toMatchObject({ code: "not-free-mode-block" });

    await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_208),
      actions: [
        {
          type: "place",
          blockId: sharedId,
          position: freePosition,
          kind: guide.kind,
          rotation: guide.rotation,
          colorIndex: 3,
        },
      ],
    });
    await repository.commitWorldActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_209),
      actions: [{ type: "remove", blockId: sharedId }],
    });
    expect(
      (await storage.load(WORLD_ID))?.blocks.filter(({ id }) => id === sharedId),
    ).toEqual([expect.objectContaining({ source: "free" })]);
    await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_210),
      actions: [{ type: "remove", blockId: sharedId }],
    });
    expect(
      (await storage.load(WORLD_ID))?.blocks.some(({ id }) => id === sharedId),
    ).toBe(false);
  });

  it("관문 초기화와 타인 블록 철거도 같은 ID의 자유 블록을 보존한다", async () => {
    const storage = new MemoryWorldRepository();
    const clock = new FakeClock(0);
    const repository = new LocalCollaborativeWorldRepository(storage, { clock });
    await repository.bootstrapPlayer(WORLD_ID);
    const snapshot = (await storage.load(WORLD_ID))!;
    const resetSharedId = uuid(2_300);
    const dismantleSharedId = uuid(2_301);
    snapshot.blocks.push(
      {
        id: resetSharedId,
        worldId: WORLD_ID,
        position: { x: 60, y: 1, z: 40 },
        kind: "cube",
        rotation: 0,
        colorIndex: 3,
        owner: { ...LOCAL_PLAYER },
        zone: "personal",
        createdAt: 0,
        source: "onboarding",
      },
      {
        id: resetSharedId,
        worldId: WORLD_ID,
        position: { x: 60, y: 1, z: 40 },
        kind: "cube",
        rotation: 0,
        colorIndex: 3,
        owner: { ...LOCAL_PLAYER },
        zone: "public",
        createdAt: 0,
        source: "free",
      },
      {
        id: dismantleSharedId,
        worldId: WORLD_ID,
        position: { x: 61, y: 1, z: 40 },
        kind: "cube",
        rotation: 0,
        colorIndex: 3,
        owner: { ...PLAYER_B },
        zone: "public",
        createdAt: 0,
        source: "inventory",
      },
      {
        id: dismantleSharedId,
        worldId: WORLD_ID,
        position: { x: 61, y: 1, z: 40 },
        kind: "cube",
        rotation: 0,
        colorIndex: 3,
        owner: { ...PLAYER_B },
        zone: "public",
        createdAt: 0,
        source: "free",
      },
    );
    await saveFixtureSnapshot(storage, snapshot);

    const reset = await repository.commitWorldActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_302),
      actions: [{ type: "reset_onboarding" }],
    });
    expect(reset.removedBlockIds).toEqual([resetSharedId]);
    expect(
      (await storage.load(WORLD_ID))?.blocks.filter(
        ({ id }) => id === resetSharedId,
      ),
    ).toEqual([expect.objectContaining({ source: "free" })]);

    const ticket = await repository.startDismantle(
      WORLD_ID,
      dismantleSharedId,
      uuid(2_303),
    );
    clock.current = ticket.readyAt;
    const dismantled = await repository.finishDismantle(
      WORLD_ID,
      ticket.id,
      uuid(2_304),
    );
    expect(dismantled.removedBlockId).toBe(dismantleSharedId);
    expect(
      (await storage.load(WORLD_ID))?.blocks.filter(
        ({ id }) => id === dismantleSharedId,
      ),
    ).toEqual([expect.objectContaining({ source: "free" })]);
  });

  it("24시간이 지난 action key는 정리하고 새 요청으로 처리한다", async () => {
    const storage = new MemoryWorldRepository();
    const clock = new FakeClock(0);
    const repository = new LocalCollaborativeWorldRepository(storage, { clock });
    const actionId = uuid(2_900);
    const originalBlockId = uuid(2_901);
    await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: actionId,
      actions: [placeAction(originalBlockId, 90)],
    });
    await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(2_902),
      actions: [{ type: "remove", blockId: originalBlockId }],
    });

    clock.current = FREE_MODE_IDEMPOTENCY_RETENTION_MS;
    const replacementBlockId = uuid(2_903);
    const reused = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: actionId,
      actions: [placeAction(replacementBlockId, 91)],
    });

    expect(reused).toMatchObject({
      replayed: false,
      serverNow: FREE_MODE_IDEMPOTENCY_RETENTION_MS,
      upsertedBlocks: [expect.objectContaining({ id: replacementBlockId })],
    });
    expect(
      await storage.loadFreeModeOperation(
        WORLD_ID,
        LOCAL_PLAYER.id,
        actionId,
        FREE_MODE_IDEMPOTENCY_RETENTION_MS,
      ),
    ).toMatchObject({
      upsertedBlocks: [expect.objectContaining({ id: replacementBlockId })],
    });
  });

  it("놓고 제거한 뒤 128건이 지나도 24시간 안의 action key는 최초 응답만 재생한다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    const originalPlace = {
      worldId: WORLD_ID,
      idempotencyKey: uuid(3_000),
      actions: [placeAction(uuid(3_001), 100)],
    };
    const first = await repository.commitFreeModeActions(originalPlace);
    await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: uuid(3_002),
      actions: [{ type: "remove" as const, blockId: uuid(3_001) }],
    });
    for (let index = 0; index < 64; index += 1) {
      const blockId = uuid(3_100 + index * 3);
      await repository.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(3_101 + index * 3),
        actions: [placeAction(blockId, 110 + index)],
      });
      await repository.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(3_102 + index * 3),
        actions: [{ type: "remove", blockId }],
      });
    }

    const beforeReplay = await storage.load(WORLD_ID);
    expect(beforeReplay?.localFreeModeStates?.[0]?.operations).toEqual([]);
    expect(
      await storage.loadFreeModeOperation(
        WORLD_ID,
        LOCAL_PLAYER.id,
        originalPlace.idempotencyKey,
        0,
      ),
    ).not.toBeNull();
    expect(beforeReplay?.localFreeModeStates?.[0]?.progress.inventory).toBe(30);
    expect(beforeReplay?.blocks.some(({ id }) => id === uuid(3_001))).toBe(false);

    const replay = await repository.commitFreeModeActions(originalPlace);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await storage.load(WORLD_ID)).toEqual(beforeReplay);
  });

  it("청크당 자유 블록 100개를 넘는 배치는 재고와 블록을 되돌린다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(0),
    });
    await repository.bootstrapPlayer(WORLD_ID);
    const snapshot = (await storage.load(WORLD_ID))!;
    snapshot.blocks.push(
      ...Array.from({ length: FREE_MODE_MAX_BLOCKS_PER_CHUNK }, (_, index) => ({
        id: uuid(4_000 + index),
        worldId: WORLD_ID,
        position: {
          x: 160 + (index % 16),
          y: 1,
          z: 160 + Math.floor(index / 16),
        },
        kind: "cube" as const,
        rotation: 0 as const,
        colorIndex: 3,
        owner: { ...PLAYER_B },
        zone: "public" as const,
        createdAt: 0,
        source: "free" as const,
      })),
      ...[
        { x: 163, y: 0, z: 166 },
        { x: 164, y: 0, z: 166 },
      ].map((position, index) => ({
        id: `starter-chunk-cap-ground-${String(index)}`,
        worldId: WORLD_ID,
        position,
        kind: "cube" as const,
        rotation: 0 as const,
        colorIndex: 3,
        owner: { ...SYSTEM_OWNER },
        zone: "system" as const,
        createdAt: 0,
      })),
    );
    await saveFixtureSnapshot(storage, snapshot);

    await expect(
      repository.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(4_200),
        actions: [
          {
            ...placeAction(uuid(4_201), 163),
            position: { x: 163, y: 2, z: 166 },
            supportId: uuid(4_000 + 99),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "chunk-full" });

    const saved = await storage.load(WORLD_ID);
    expect(saved?.blocks.filter(({ source }) => source === "free")).toHaveLength(
      FREE_MODE_MAX_BLOCKS_PER_CHUNK,
    );
    expect(saved?.blocks.some(({ id }) => id === uuid(4_201))).toBe(false);
    expect((await repository.getFreeModeOverview(WORLD_ID)).progress.inventory).toBe(30);
  });
});

function placeAction(blockId: string, x: number) {
  const coordinateSeed = Math.abs(x);
  return {
    type: "place" as const,
    blockId,
    position: {
      x: 8 + (coordinateSeed % 5),
      y: 1,
      z: 8 + (Math.floor(coordinateSeed / 5) % 8),
    },
    kind: "cube" as const,
    rotation: 0 as const,
    colorIndex: 3,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

async function saveFixtureSnapshot(
  storage: MemoryWorldRepository,
  snapshot: WorldSnapshot,
): Promise<void> {
  const freeBlocks = snapshot.blocks.filter(({ source }) => source === "free");
  await storage.save(snapshot);
  if (freeBlocks.length === 0) return;

  const latest = (await storage.load(snapshot.worldId))!;
  const expectedRevision = freeModeRevision(latest);
  latest.blocks = [
    ...latest.blocks.filter(({ source }) => source !== "free"),
    ...structuredClone(freeBlocks),
  ];
  latest.localFreeModeStates ??= [];
  let state = latest.localFreeModeStates.find(
    ({ playerId }) => playerId === LOCAL_PLAYER.id,
  );
  if (!state) {
    state = {
      playerId: LOCAL_PLAYER.id,
      progress: {
        initialGrantClaimed: true,
        inventory: 30,
        lastSettledAt: snapshot.updatedAt,
      },
      operations: [],
      updatedAt: snapshot.updatedAt,
      revision: 0,
    };
    latest.localFreeModeStates.push(state);
  }
  state.revision = (state.revision ?? 0) + 1;
  latest.localFreeModeRevision = expectedRevision + 1;
  latest.schemaVersion = 3;
  await storage.saveFreeModeState(
    latest,
    LOCAL_PLAYER.id,
    expectedRevision,
  );
}

async function saveVersionOneSnapshot(
  factory: IDBFactory,
  snapshot: WorldSnapshot,
): Promise<void> {
  const openRequest = factory.open("lumenmoon", 1);
  openRequest.onupgradeneeded = () => {
    openRequest.result.createObjectStore("worlds", { keyPath: "worldId" });
  };
  const database = await requestResult(openRequest);
  const transaction = database.transaction("worlds", "readwrite");
  transaction.objectStore("worlds").put(structuredClone(snapshot));
  await transactionComplete(transaction);
  database.close();
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

class FirstFreeModeWriteBarrier {
  private arrived = 0;
  private readonly released: Promise<void>;
  private release!: () => void;

  constructor(private readonly expected: number) {
    this.released = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  async wait(): Promise<void> {
    this.arrived += 1;
    if (this.arrived >= this.expected) this.release();
    await this.released;
  }
}

class BarrierIndexedDbWorldRepository extends IndexedDbWorldRepository {
  private firstFreeModeWrite = true;

  constructor(factory: IDBFactory, private readonly barrier: FirstFreeModeWriteBarrier) {
    super(factory);
  }

  private async waitForFirstFreeModeWrite(): Promise<void> {
    if (!this.firstFreeModeWrite) return;
    this.firstFreeModeWrite = false;
    await this.barrier.wait();
  }

  override async saveFreeModeCommit(
    ...args: Parameters<IndexedDbWorldRepository["saveFreeModeCommit"]>
  ): Promise<void> {
    await this.waitForFirstFreeModeWrite();
    await super.saveFreeModeCommit(...args);
  }

  override async saveFreeModeState(
    ...args: Parameters<IndexedDbWorldRepository["saveFreeModeState"]>
  ): Promise<void> {
    await this.waitForFirstFreeModeWrite();
    await super.saveFreeModeState(...args);
  }
}

class AllWritesBarrierIndexedDbWorldRepository extends IndexedDbWorldRepository {
  private firstWrite = true;

  constructor(factory: IDBFactory, private readonly barrier: FirstFreeModeWriteBarrier) {
    super(factory);
  }

  private async waitForFirstWrite(): Promise<void> {
    if (!this.firstWrite) return;
    this.firstWrite = false;
    await this.barrier.wait();
  }

  override async save(
    ...args: Parameters<IndexedDbWorldRepository["save"]>
  ): Promise<void> {
    await this.waitForFirstWrite();
    await super.save(...args);
  }

  override async saveFreeModeCommit(
    ...args: Parameters<IndexedDbWorldRepository["saveFreeModeCommit"]>
  ): Promise<void> {
    await this.waitForFirstWrite();
    await super.saveFreeModeCommit(...args);
  }
}

class CountingMemoryWorldRepository extends MemoryWorldRepository {
  freeModeStateSaveCount = 0;

  override async saveFreeModeState(
    ...args: Parameters<MemoryWorldRepository["saveFreeModeState"]>
  ): Promise<void> {
    this.freeModeStateSaveCount += 1;
    await super.saveFreeModeState(...args);
  }
}

class ConflictCountingMemoryWorldRepository extends MemoryWorldRepository {
  rejectFreeModeCommits = false;
  rejectedCommitCount = 0;

  override async saveFreeModeCommit(
    ...args: Parameters<MemoryWorldRepository["saveFreeModeCommit"]>
  ): Promise<void> {
    if (this.rejectFreeModeCommits) {
      this.rejectedCommitCount += 1;
      const expectedRevision = args[3];
      throw new FreeModeRevisionConflictError(
        expectedRevision,
        expectedRevision + 1,
      );
    }
    await super.saveFreeModeCommit(...args);
  }
}
