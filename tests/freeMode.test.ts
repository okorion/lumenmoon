import { describe, expect, it } from "vitest";
import {
  DEFAULT_FREE_MODE_RULES,
  FREE_MODE_FOREIGN_REMOVAL_AGE_MS,
  FREE_MODE_GRANT_INTERVAL_MS,
  FREE_MODE_CENTRAL_SAFE_PAD_RADIUS,
  createUnclaimedFreeModeProgress,
  decideFreeModeRemoval,
  getNextFreeModeGrantInMs,
  grantFreeModeInitialInventory,
  hasFreeModeDeterministicGround,
  isFreeModeDeterministicGroundPosition,
  isFreeModeSpawnClearancePosition,
  settleFreeModeInventory,
} from "../src/domain/freeMode";
import { LOCAL_PLAYER, WORLD_ID, type VoxelBlock } from "../src/domain/types";
import { createStarterBayLayout } from "../src/domain/starterBay";

const OTHER_PLAYER = {
  id: "other-player",
  publicId: "#Q7R4",
  nickname: "푸른 제비",
  emblem: "◇",
};

describe("자유 모드 재고 규칙", () => {
  it("첫 진입에 30개를 정확히 한 번 지급한다", () => {
    const unclaimed = createUnclaimedFreeModeProgress(100);
    const first = grantFreeModeInitialInventory(unclaimed, 200);
    const second = grantFreeModeInitialInventory(first, 300);

    expect(first).toEqual({
      initialGrantClaimed: true,
      inventory: 30,
      lastSettledAt: 200,
    });
    expect(second).toBe(first);
  });

  it("온전한 1시간마다 5개만 만들고 남은 시간을 보존한다", () => {
    const initial = grantFreeModeInitialInventory(
      createUnclaimedFreeModeProgress(0),
      0,
    );
    const before = settleFreeModeInventory(
      initial,
      FREE_MODE_GRANT_INTERVAL_MS - 1,
    );
    const after = settleFreeModeInventory(
      initial,
      FREE_MODE_GRANT_INTERVAL_MS * 2 + 1_234,
    );

    expect(before).toMatchObject({ elapsedSlots: 0, produced: 0 });
    expect(after).toMatchObject({ elapsedSlots: 2, produced: 10 });
    expect(after.progress).toMatchObject({
      inventory: 40,
      lastSettledAt: FREE_MODE_GRANT_INTERVAL_MS * 2,
    });
    expect(getNextFreeModeGrantInMs(after.progress, after.progress.lastSettledAt))
      .toBe(FREE_MODE_GRANT_INTERVAL_MS);
  });

  it("재고를 100개로 제한하고 가득 찬 동안의 경과 슬롯을 다시 지급하지 않는다", () => {
    const progress = {
      initialGrantClaimed: true,
      inventory: 98,
      lastSettledAt: 0,
    };
    const full = settleFreeModeInventory(
      progress,
      FREE_MODE_GRANT_INTERVAL_MS * 3,
    );
    const spent = { ...full.progress, inventory: 99 };
    const immediatelySettled = settleFreeModeInventory(
      spent,
      FREE_MODE_GRANT_INTERVAL_MS * 3,
    );

    expect(full).toMatchObject({ elapsedSlots: 3, produced: 2 });
    expect(full.progress).toEqual({
      initialGrantClaimed: true,
      inventory: 100,
      lastSettledAt: FREE_MODE_GRANT_INTERVAL_MS * 3,
    });
    expect(getNextFreeModeGrantInMs(full.progress, full.progress.lastSettledAt))
      .toBeNull();
    expect(immediatelySettled).toMatchObject({ produced: 0 });
    expect(immediatelySettled.progress.inventory).toBe(99);
  });

  it("재고가 가득 찬 동안의 부분 시간도 비축하지 않는다", () => {
    const full = {
      initialGrantClaimed: true,
      inventory: 100,
      lastSettledAt: 0,
    };
    const halfHour = FREE_MODE_GRANT_INTERVAL_MS / 2;
    const settled = settleFreeModeInventory(full, halfHour);
    expect(settled.progress).toEqual(full);
    expect(
      getNextFreeModeGrantInMs(
        { ...settled.progress, inventory: 99, lastSettledAt: halfHour },
        halfHour,
      ),
    ).toBe(FREE_MODE_GRANT_INTERVAL_MS);
  });

  it("권위 시각이 뒤로 가도 재고나 정산 기준을 되돌리지 않는다", () => {
    const progress = {
      initialGrantClaimed: true,
      inventory: 35,
      lastSettledAt: FREE_MODE_GRANT_INTERVAL_MS,
    };
    expect(settleFreeModeInventory(progress, 0)).toEqual({
      progress,
      elapsedSlots: 0,
      produced: 0,
    });
  });
});

describe("자유 모드 제거 규칙", () => {
  it("자기 자유 모드 블록은 즉시 제거하고 1개를 돌려준다", () => {
    const target = freeBlock("own", LOCAL_PLAYER, 1_000);
    expect(
      decideFreeModeRemoval({
        actorId: LOCAL_PLAYER.id,
        block: target,
        allBlocks: [target],
        now: 1_000,
      }),
    ).toEqual({
      allowed: true,
      reason: "allowed",
      refundInventory: 1,
      removableAt: 1_000,
      remainingMs: 0,
    });
  });

  it("타인 블록은 72시간 직전까지 잠기고 경계 시각부터 보상 없이 제거한다", () => {
    const target = freeBlock("foreign", OTHER_PLAYER, 1_000);
    const before = decideFreeModeRemoval({
      actorId: LOCAL_PLAYER.id,
      block: target,
      allBlocks: [target],
      now: 1_000 + FREE_MODE_FOREIGN_REMOVAL_AGE_MS - 1,
    });
    const atBoundary = decideFreeModeRemoval({
      actorId: LOCAL_PLAYER.id,
      block: target,
      allBlocks: [target],
      now: 1_000 + FREE_MODE_FOREIGN_REMOVAL_AGE_MS,
    });

    expect(before).toMatchObject({
      allowed: false,
      reason: "foreign-block-locked",
      remainingMs: 1,
    });
    expect(atBoundary).toEqual({
      allowed: true,
      reason: "allowed",
      refundInventory: 0,
      removableAt: 1_000 + FREE_MODE_FOREIGN_REMOVAL_AGE_MS,
      remainingMs: 0,
    });
  });

  it("받치는 블록·보호 블록·기존 관문 모드 블록은 제거하지 않는다", () => {
    const support = freeBlock("support", LOCAL_PLAYER, 0);
    const dependent = { ...freeBlock("dependent", LOCAL_PLAYER, 0), supportId: support.id };
    const system = { ...freeBlock("system", LOCAL_PLAYER, 0), zone: "system" as const };
    const legacy = { ...freeBlock("legacy", LOCAL_PLAYER, 0), source: "inventory" as const };

    expect(
      decideFreeModeRemoval({
        actorId: LOCAL_PLAYER.id,
        block: support,
        allBlocks: [support, dependent],
        now: 0,
      }),
    ).toMatchObject({ allowed: true, reason: "allowed", refundInventory: 1 });
    expect(
      decideFreeModeRemoval({
        actorId: OTHER_PLAYER.id,
        block: support,
        allBlocks: [support, dependent],
        now: FREE_MODE_FOREIGN_REMOVAL_AGE_MS,
      }).reason,
    ).toBe("support-in-use");
    expect(
      decideFreeModeRemoval({
        actorId: LOCAL_PLAYER.id,
        block: system,
        allBlocks: [system],
        now: 0,
      }).reason,
    ).toBe("protected-zone");
    expect(
      decideFreeModeRemoval({
        actorId: LOCAL_PLAYER.id,
        block: legacy,
        allBlocks: [legacy],
        now: 0,
      }).reason,
    ).toBe("not-free-mode-block");
  });

  it("기본 규칙은 최초30·시간당5·최대100·타인72시간이다", () => {
    expect(DEFAULT_FREE_MODE_RULES).toEqual({
      initialInventory: 30,
      grantIntervalMs: 3_600_000,
      grantAmount: 5,
      maxInventory: 100,
      foreignRemovalAgeMs: 259_200_000,
    });
  });
});

describe("자유 모드 공용 스폰 보호", () => {
  it("스폰 본체·연속 통로·중앙 패드의 플레이어 높이만 보호한다", () => {
    const layout = createStarterBayLayout(0);
    const spawn = {
      x: Math.floor(layout.safeSpawn.x),
      y: Math.floor(layout.safeSpawn.y),
      z: Math.floor(layout.safeSpawn.z),
    };
    const corridor = { x: 1, y: spawn.y, z: -15 };
    const centralPadEdge = {
      x: FREE_MODE_CENTRAL_SAFE_PAD_RADIUS,
      y: spawn.y,
      z: FREE_MODE_CENTRAL_SAFE_PAD_RADIUS,
    };
    const centralPadOutside = { ...centralPadEdge, x: centralPadEdge.x + 1 };
    const platformSide = { x: -2, y: spawn.y, z: -28 };

    expect(isFreeModeSpawnClearancePosition(spawn)).toBe(true);
    expect(isFreeModeSpawnClearancePosition({ ...spawn, x: spawn.x + 1 }))
      .toBe(true);
    expect(isFreeModeSpawnClearancePosition(corridor)).toBe(true);
    expect(isFreeModeSpawnClearancePosition(centralPadEdge)).toBe(true);
    expect(isFreeModeSpawnClearancePosition(centralPadOutside)).toBe(false);
    expect(isFreeModeSpawnClearancePosition(platformSide)).toBe(false);
    expect(
      isFreeModeSpawnClearancePosition({ ...spawn, y: spawn.y + 2 }),
    ).toBe(false);
  });

  it("결정적 시스템 지면만 y=1 자유 블록의 바닥으로 인정한다", () => {
    const grounded = freeBlock("starter-0-1", LOCAL_PLAYER, 0);
    grounded.position = { x: 400, y: 0, z: 400 };
    grounded.owner = { ...grounded.owner, id: "system" };
    grounded.zone = "system";
    const fake = { ...grounded, id: "user-forged-ground" };

    expect(
      hasFreeModeDeterministicGround([grounded], { x: 400, y: 1, z: 400 }),
    ).toBe(true);
    expect(
      hasFreeModeDeterministicGround([fake], { x: 400, y: 1, z: 400 }),
    ).toBe(false);
    expect(
      hasFreeModeDeterministicGround([grounded], { x: 401, y: 1, z: 400 }),
    ).toBe(false);
    expect(
      isFreeModeDeterministicGroundPosition({ x: 24, y: 1, z: -28 }),
    ).toBe(true);
  });
});

function freeBlock(
  id: string,
  owner: VoxelBlock["owner"],
  createdAt: number,
): VoxelBlock {
  return {
    id,
    worldId: WORLD_ID,
    position: { x: id.length + 20, y: 1, z: 20 },
    kind: "cube",
    rotation: 0,
    colorIndex: 0,
    owner,
    zone: "public",
    createdAt,
    source: "free",
  };
}
