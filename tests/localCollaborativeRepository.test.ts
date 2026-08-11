import { describe, expect, it } from "vitest";
import type { Clock } from "../src/domain/progression";
import { createStarterBayLayout } from "../src/domain/starterBay";
import { LOCAL_PLAYER, WORLD_ID, type VoxelBlock } from "../src/domain/types";
import { LocalCollaborativeWorldRepository } from "../src/data/LocalCollaborativeWorldRepository";
import { MemoryWorldRepository } from "../src/data/WorldRepository";
import { prepareLocalSnapshot } from "../src/world/localWorld";
import { createSeedSnapshot } from "../src/world/seed";

const UUIDS = {
  commit: "00000000-0000-4000-8000-000000000011",
  block: "00000000-0000-4000-8000-000000000012",
  reset: "00000000-0000-4000-8000-000000000013",
  secondCommit: "00000000-0000-4000-8000-000000000014",
  secondBlock: "00000000-0000-4000-8000-000000000015",
  foreignBlock: "00000000-0000-4000-8000-000000000019",
  dismantleStart: "00000000-0000-4000-8000-000000000020",
  dismantleFinish: "00000000-0000-4000-8000-000000000021",
};

class FakeClock implements Clock {
  constructor(public current: number) {}
  now(): number {
    return this.current;
  }
}

describe("LocalCollaborativeWorldRepository", () => {
  it("기존 로컬 저장소 위에서 bootstrap과 주변 청크 읽기를 제공한다", async () => {
    const repository = new LocalCollaborativeWorldRepository(
      new MemoryWorldRepository(),
      { clock: new FakeClock(1_000) },
    );
    const bootstrap = await repository.bootstrapPlayer(WORLD_ID);

    expect(bootstrap.worldId).toBe(WORLD_ID);
    expect(bootstrap.player.publicId).toMatch(/^#[A-Z0-9]{4}$/u);
    expect(bootstrap.progress.inventory).toBe(24);
    expect(bootstrap.baySlotIndex).toBe(0);

    const nearby = await repository.loadNearbyBlocks({
      worldId: WORLD_ID,
      chunkX: 0,
      chunkY: 0,
      chunkZ: 0,
      radius: 1,
      verticalRadius: 1,
    });
    expect(nearby.blocks.length).toBeGreaterThan(0);
    expect(nearby.serverNow).toBe(1_000);
    expect(nearby.blockCount).toBe(nearby.blocks.length);
    expect(nearby.blockLimit).toBe(8_192);
  });

  it("16블록 수직 청크 반경 밖의 블록을 주변 조회에서 제외한다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(1_000),
    });
    await repository.bootstrapPlayer(WORLD_ID);
    const snapshot = (await storage.load(WORLD_ID))!;
    snapshot.blocks.push({
      id: "vertical-chunk-2",
      worldId: WORLD_ID,
      position: { x: 4, y: 32, z: 4 },
      kind: "cube",
      rotation: 0,
      colorIndex: 0,
      owner: LOCAL_PLAYER,
      zone: "public",
      createdAt: 1_000,
    });
    await storage.save(snapshot);

    const lower = await repository.loadNearbyBlocks({
      worldId: WORLD_ID,
      chunkX: 0,
      chunkY: 0,
      chunkZ: 0,
      radius: 0,
      verticalRadius: 1,
    });
    const upper = await repository.loadNearbyBlocks({
      worldId: WORLD_ID,
      chunkX: 0,
      chunkY: 2,
      chunkZ: 0,
      radius: 0,
      verticalRadius: 0,
    });

    expect(lower.blocks.some(({ id }) => id === "vertical-chunk-2")).toBe(false);
    expect(upper.blocks.some(({ id }) => id === "vertical-chunk-2")).toBe(true);
  });

  it("과밀한 주변 청크를 일부만 반환하지 않고 명시적으로 거부한다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(1_000),
    });
    await repository.bootstrapPlayer(WORLD_ID);
    const snapshot = (await storage.load(WORLD_ID))!;
    snapshot.blocks = Array.from({ length: 8_193 }, (_, index) => ({
      id: `dense-${String(index)}`,
      worldId: WORLD_ID,
      position: {
        x: -32 + (index % 80),
        y: Math.floor(index / 6_400),
        z: -32 + (Math.floor(index / 80) % 80),
      },
      kind: "cube" as const,
      rotation: 0 as const,
      colorIndex: 0,
      owner: LOCAL_PLAYER,
      zone: "public" as const,
      createdAt: index,
    }));
    await storage.save(snapshot);

    await expect(
      repository.loadNearbyBlocks({
        worldId: WORLD_ID,
        chunkX: 0,
        chunkY: 0,
        chunkZ: 0,
        radius: 2,
        verticalRadius: 1,
      }),
    ).rejects.toMatchObject({ code: "nearby-block-limit" });
  });

  it("다른 탭의 늦은 bootstrap이 먼저 확정된 블록과 재고를 되돌리지 않는다", async () => {
    const storage = new MemoryWorldRepository();
    const firstTab = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(2_000),
    });
    const lateTab = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(3_000),
    });
    await firstTab.bootstrapPlayer(WORLD_ID);
    const guide = createStarterBayLayout(0).baseGuides[0]!;
    await firstTab.commitWorldActions({
      worldId: WORLD_ID,
      idempotencyKey: UUIDS.commit,
      actions: [
        {
          type: "place",
          blockId: UUIDS.block,
          position: guide.position,
          kind: guide.kind,
          rotation: guide.rotation,
          colorIndex: 3,
        },
      ],
    });

    const lateBootstrap = await lateTab.bootstrapPlayer(WORLD_ID);
    const saved = await storage.load(WORLD_ID);
    expect(lateBootstrap.progress.inventory).toBe(23);
    expect(saved?.localState?.progress.inventory).toBe(23);
    expect(saved?.blocks.some(({ id }) => id === UUIDS.block)).toBe(true);
  });

  it("같은 멱등 키 재시도에서 배치와 재고 차감을 중복하지 않는다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(2_000),
    });
    await repository.bootstrapPlayer(WORLD_ID);
    const guide = createStarterBayLayout(0).baseGuides[0]!;
    const request = {
      worldId: WORLD_ID,
      idempotencyKey: UUIDS.commit,
      actions: [
        {
          type: "place" as const,
          blockId: UUIDS.block,
          position: guide.position,
          kind: guide.kind,
          rotation: guide.rotation,
          colorIndex: 3,
        },
      ],
    };

    const first = await repository.commitWorldActions(request);
    const retry = await repository.commitWorldActions(request);
    const saved = await storage.load(WORLD_ID);

    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.progress.inventory).toBe(23);
    expect(saved?.blocks.filter(({ id }) => id === UUIDS.block)).toHaveLength(1);
  });

  it("같은 멱등 키를 다른 payload에 재사용하면 거부한다", async () => {
    const repository = new LocalCollaborativeWorldRepository(
      new MemoryWorldRepository(),
      { clock: new FakeClock(2_000) },
    );
    await repository.bootstrapPlayer(WORLD_ID);
    const [firstGuide, secondGuide] = createStarterBayLayout(0).baseGuides;
    await repository.commitWorldActions({
      worldId: WORLD_ID,
      idempotencyKey: UUIDS.commit,
      actions: [
        {
          type: "place",
          blockId: UUIDS.block,
          position: firstGuide!.position,
          kind: firstGuide!.kind,
          rotation: firstGuide!.rotation,
          colorIndex: 3,
        },
      ],
    });

    await expect(
      repository.commitWorldActions({
        worldId: WORLD_ID,
        idempotencyKey: UUIDS.commit,
        actions: [
          {
            type: "place",
            blockId: UUIDS.secondBlock,
            position: secondGuide!.position,
            kind: secondGuide!.kind,
            rotation: secondGuide!.rotation,
            colorIndex: 3,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "idempotency-conflict" });
  });

  it("동시 동일 좌표 경쟁을 직렬화해 하나만 확정한다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(2_000),
    });
    await repository.bootstrapPlayer(WORLD_ID);
    const guide = createStarterBayLayout(0).baseGuides[0]!;
    const results = await Promise.allSettled([
      repository.commitWorldActions({
        worldId: WORLD_ID,
        idempotencyKey: UUIDS.commit,
        actions: [
          {
            type: "place",
            blockId: UUIDS.block,
            position: guide.position,
            kind: guide.kind,
            rotation: guide.rotation,
            colorIndex: 3,
          },
        ],
      }),
      repository.commitWorldActions({
        worldId: WORLD_ID,
        idempotencyKey: UUIDS.secondCommit,
        actions: [
          {
            type: "place",
            blockId: UUIDS.secondBlock,
            position: guide.position,
            kind: guide.kind,
            rotation: guide.rotation,
            colorIndex: 3,
          },
        ],
      }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const saved = await storage.load(WORLD_ID);
    expect(saved?.localState?.progress.inventory).toBe(23);
    expect(
      saved?.blocks.filter(
        ({ position }) =>
          position.x === guide.position.x &&
          position.y === guide.position.y &&
          position.z === guide.position.z,
      ),
    ).toHaveLength(1);
  });

  it("온보딩 중에는 업그레이드 가이드 배치를 허용하지 않는다", async () => {
    const repository = new LocalCollaborativeWorldRepository(
      new MemoryWorldRepository(),
      { clock: new FakeClock(2_000) },
    );
    await repository.bootstrapPlayer(WORLD_ID);
    const guide = createStarterBayLayout(0).upgradeGuides[0]!;

    await expect(
      repository.commitWorldActions({
        worldId: WORLD_ID,
        idempotencyKey: UUIDS.commit,
        actions: [
          {
            type: "place",
            blockId: UUIDS.block,
            position: guide.position,
            kind: guide.kind,
            rotation: guide.rotation,
            colorIndex: 3,
          },
        ],
      }),
    ).rejects.toThrow(/가이드/);
  });

  it("중단된 생산시설을 복구할 때 중단 기간을 소급 생산하지 않는다", async () => {
    const clock = new FakeClock(0);
    const storage = new MemoryWorldRepository();
    const snapshot = prepareLocalSnapshot(createSeedSnapshot(0), 0).snapshot;
    const state = snapshot.localState!;
    state.progress = {
      ...state.progress,
      initialGrantClaimed: true,
      inventory: 20,
      baseCompleted: true,
      baseCompletedAt: 0,
      producerCompleted: true,
      producerCompletedAt: 0,
      trialRewardClaimed: true,
      lastSettledAt: 0,
    };
    const layout = createStarterBayLayout(0);
    const guideBlocks: VoxelBlock[] = [
      ...layout.baseGuides.map((guide, index) =>
        guideBlock(guide, index + 100),
      ),
      ...layout.producerGuides.map((guide, index) =>
        guideBlock(guide, index + 200),
      ),
    ];
    snapshot.blocks.push(...guideBlocks);
    await storage.save(snapshot);
    const repository = new LocalCollaborativeWorldRepository(storage, { clock });
    await repository.bootstrapPlayer(WORLD_ID);
    const removed = guideBlocks.at(-1)!;

    clock.current = 60 * 60 * 1_000;
    await repository.commitWorldActions({
      worldId: WORLD_ID,
      idempotencyKey: "00000000-0000-4000-8000-000000000016",
      actions: [{ type: "remove", blockId: removed.id }],
    });
    clock.current = 10 * 60 * 60 * 1_000;
    const repaired = await repository.commitWorldActions({
      worldId: WORLD_ID,
      idempotencyKey: "00000000-0000-4000-8000-000000000017",
      actions: [
        {
          type: "place",
          blockId: "00000000-0000-4000-8000-000000000018",
          position: removed.position,
          kind: removed.kind,
          rotation: removed.rotation,
          colorIndex: removed.colorIndex,
        },
      ],
    });

    expect(repaired.progress.inventory).toBe(20);
    expect(repaired.progress.lastSettledAt).toBe(clock.current);
  });

  it("중단한 타인 블록 철거 티켓을 취소해 진행률을 남기지 않는다", async () => {
    const clock = new FakeClock(0);
    const storage = new MemoryWorldRepository();
    const snapshot = prepareLocalSnapshot(createSeedSnapshot(0), 0).snapshot;
    snapshot.blocks.push({
      id: UUIDS.foreignBlock,
      worldId: WORLD_ID,
      position: { x: 20, y: 1, z: 20 },
      kind: "cube",
      rotation: 0,
      colorIndex: 3,
      owner: {
        id: "other-player",
        publicId: "#Z9Y8",
        nickname: "푸른 제비",
        emblem: "◈",
      },
      zone: "public",
      createdAt: 0,
    });
    await storage.save(snapshot);
    const repository = new LocalCollaborativeWorldRepository(storage, { clock });
    await repository.bootstrapPlayer(WORLD_ID);

    const ticket = await repository.startDismantle(
      WORLD_ID,
      UUIDS.foreignBlock,
      UUIDS.dismantleStart,
    );
    await repository.cancelDismantle(WORLD_ID, ticket.id);
    await expect(
      repository.startDismantle(
        WORLD_ID,
        UUIDS.foreignBlock,
        UUIDS.dismantleStart,
      ),
    ).rejects.toMatchObject({ code: "ticket-cancelled" });
    clock.current = 3_000;

    await expect(
      repository.finishDismantle(
        WORLD_ID,
        ticket.id,
        UUIDS.dismantleFinish,
      ),
    ).rejects.toMatchObject({ code: "ticket-not-found" });
    expect(
      (await storage.load(WORLD_ID))?.blocks.some(
        ({ id }) => id === UUIDS.foreignBlock,
      ),
    ).toBe(true);
  });

  it("미완성 온보딩 초기화를 RPC 동등 작업으로 원자 처리한다", async () => {
    const storage = new MemoryWorldRepository();
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(3_000),
    });
    await repository.bootstrapPlayer(WORLD_ID);
    const guide = createStarterBayLayout(0).baseGuides[0]!;
    await repository.commitWorldActions({
      worldId: WORLD_ID,
      idempotencyKey: UUIDS.commit,
      actions: [
        {
          type: "place",
          blockId: UUIDS.block,
          position: guide.position,
          kind: guide.kind,
          rotation: guide.rotation,
          colorIndex: 3,
        },
      ],
    });

    const reset = await repository.commitWorldActions({
      worldId: WORLD_ID,
      idempotencyKey: UUIDS.reset,
      actions: [{ type: "reset_onboarding" }],
    });
    expect(reset.progress.inventory).toBe(24);
    expect(reset.removedBlockIds).toContain(UUIDS.block);
    expect((await storage.load(WORLD_ID))?.blocks.some(({ id }) => id === UUIDS.block)).toBe(
      false,
    );
  });
});

function guideBlock(
  guide: ReturnType<typeof createStarterBayLayout>["guides"][number],
  suffix: number,
): VoxelBlock {
  return {
    id: `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`,
    worldId: WORLD_ID,
    position: { ...guide.position },
    kind: guide.kind,
    rotation: guide.rotation,
    colorIndex: 3,
    owner: { ...LOCAL_PLAYER },
    zone: guide.group === "base" ? "personal" : "producer",
    createdAt: 0,
    source: "inventory",
  };
}
