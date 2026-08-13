import { describe, expect, it, vi } from "vitest";
import { createLocalPlayerProgress } from "../src/domain/progression";
import {
  LOCAL_PLAYER,
  SYSTEM_OWNER,
  WORLD_ID,
  type VoxelBlock,
} from "../src/domain/types";
import type { FreeModeMutationResult } from "../src/data/CollaborativeWorldRepository";
import {
  ChunkRequestGate,
  ExplicitRetryGate,
  SynchronizedServerClock,
  OnlineProgressGate,
  applyAuthoritativeMutation,
  createOptimisticPlacementProgress,
  createNearbyOnlineSystemBlocks,
  mergeServerAndSystemBlocks,
  reconcileFreeModeMutationResult,
} from "../src/app/onlineWorld";

function freeMutation(replayed: boolean): FreeModeMutationResult {
  return {
    worldId: WORLD_ID,
    idempotencyKey: "operation",
    upsertedBlocks: [],
    removedBlockIds: [],
    progress: {
      initialGrantClaimed: true,
      inventory: 29,
      lastSettledAt: 1,
    },
    serverNow: 1,
    replayed,
  };
}

describe("자유 모드 멱등 replay 권위 복구", () => {
  it("새 응답만 적용하고 replay는 최신 overview와 청크를 다시 읽는다", async () => {
    const applied: boolean[] = [];
    let refreshes = 0;
    const handlers = {
      apply: (value: FreeModeMutationResult) => {
        applied.push(value.replayed);
      },
      refresh: async () => {
        refreshes += 1;
      },
    };

    await reconcileFreeModeMutationResult(freeMutation(false), handlers);
    await reconcileFreeModeMutationResult(freeMutation(true), handlers);

    expect(applied).toEqual([false]);
    expect(refreshes).toBe(1);
  });
});

describe("자유 모드 자동 요청 실패 래치", () => {
  it("명시 재시도 전까지 프레임 반복 요청을 막고 성공 뒤 다시 연다", () => {
    const gate = new ExplicitRetryGate();

    expect(gate.canAttempt()).toBe(true);
    gate.recordFailure();
    expect(Array.from({ length: 120 }, () => gate.canAttempt())).not.toContain(
      true,
    );
    expect(gate.canAttempt(true)).toBe(true);
    gate.recordSuccess();
    expect(gate.canAttempt()).toBe(true);
  });

  it("같은 청크 실패는 매 프레임 반복하지 않고 이동·명시 재시도만 허용한다", () => {
    const gate = new ChunkRequestGate();

    expect(gate.shouldRequest("free:0:0:-2")).toBe(true);
    expect(
      Array.from({ length: 120 }, () =>
        gate.shouldRequest("free:0:0:-2"),
      ),
    ).not.toContain(true);
    expect(gate.shouldRequest("free:1:0:-2")).toBe(true);
    gate.reset();
    expect(gate.shouldRequest("free:1:0:-2")).toBe(true);
  });
});

function block(id: string, x: number, owner = LOCAL_PLAYER): VoxelBlock {
  return {
    id,
    worldId: WORLD_ID,
    position: { x, y: 1, z: 0 },
    kind: "cube",
    rotation: 0,
    colorIndex: 0,
    owner,
    zone: owner === SYSTEM_OWNER ? "system" : "public",
    createdAt: 1,
  };
}

describe("온라인 미확정 상태", () => {
  it("응답 전 재고만 임시 차감하고 원본 진행 상태는 보존한다", () => {
    const progress = { ...createLocalPlayerProgress(0), inventory: 3 };
    const optimistic = createOptimisticPlacementProgress(progress);

    expect(optimistic.inventory).toBe(2);
    expect(progress.inventory).toBe(3);
    expect(() =>
      createOptimisticPlacementProgress({ ...progress, inventory: 0 }),
    ).toThrow("재고");
  });

  it("서버 확정 블록과 삭제 ID로 좌표 경쟁 결과를 권위 상태에 반영한다", () => {
    const localDraft = block("draft", 1);
    const serverWinner = block("server", 1);
    const retained = block("retained", 2);
    const next = applyAuthoritativeMutation([localDraft, retained], {
      upsertedBlocks: [serverWinner],
      removedBlockIds: ["draft"],
    });

    expect(next.map((item) => item.id)).toEqual(["retained", "server"]);
  });

  it("서버 블록과 겹치지 않는 안전 발판만 합성한다", () => {
    const authoritative = block("server", 0);
    const systemConflict = block("system-conflict", 0, SYSTEM_OWNER);
    const systemFree = block("system-free", 1, SYSTEM_OWNER);

    expect(
      mergeServerAndSystemBlocks(
        [authoritative],
        [systemConflict, systemFree],
      ).map((item) => item.id),
    ).toEqual(["server", "system-free"]);
  });
});

describe("서버 동기화 시계", () => {
  it("기기 Date.now가 바뀌어도 performance 경과만 반영한다", () => {
    const performanceSpy = vi.spyOn(performance, "now");
    performanceSpy.mockReturnValueOnce(100).mockReturnValueOnce(100).mockReturnValue(350);
    const clock = new SynchronizedServerClock(10_000);

    expect(clock.now()).toBe(10_250);
    vi.spyOn(Date, "now").mockReturnValue(999_999_999);
    expect(clock.now()).toBe(10_250);
  });

  it("늦게 도착한 이전 응답이 표시 시계를 뒤로 돌리지 않는다", () => {
    const performanceSpy = vi.spyOn(performance, "now");
    performanceSpy
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(350)
      .mockReturnValueOnce(350)
      .mockReturnValue(600);
    const clock = new SynchronizedServerClock(10_000);
    clock.synchronize(9_000);

    expect(clock.now()).toBe(10_500);
  });
});

describe("온라인 진행 상태 단일 요청 게이트", () => {
  it("배치·생산 등 서로 다른 RPC 경로의 동시 진입을 막는다", () => {
    const gate = new OnlineProgressGate();

    expect(gate.tryEnter()).toBe(true);
    expect(gate.busy).toBe(true);
    expect(gate.tryEnter()).toBe(false);

    gate.leave();
    expect(gate.busy).toBe(false);
    expect(gate.tryEnter()).toBe(true);
  });
});

describe("온라인 결정적 시스템 구조물", () => {
  it("현재 청크 주변의 중앙 코어와 여러 예약 베이를 중복 없이 합성한다", () => {
    const worldId = "00000000-0000-4000-8000-000000000001";
    const blocks = createNearbyOnlineSystemBlocks(worldId, 0, 0, -2, 2, 1);
    const positionKeys = blocks.map(
      ({ position }) => `${position.x},${position.y},${position.z}`,
    );

    expect(blocks.some(({ id }) => id.startsWith("online-tower-core"))).toBe(
      true,
    );
    expect(blocks.some(({ id }) => id.startsWith("starter-0-"))).toBe(true);
    expect(blocks.some(({ id }) => id.startsWith("starter-1-"))).toBe(true);
    expect(new Set(positionKeys).size).toBe(positionKeys.length);
    expect(blocks.every((block) => block.worldId === worldId)).toBe(true);
  });

  it("멀리 이동하면 중앙 구조물을 주변 청크 결과에 넣지 않는다", () => {
    const blocks = createNearbyOnlineSystemBlocks(
      "00000000-0000-4000-8000-000000000001",
      20,
      0,
      20,
      2,
      1,
    );
    expect(blocks.some(({ id }) => id.startsWith("online-"))).toBe(false);
  });
});
