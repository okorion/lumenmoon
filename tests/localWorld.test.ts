import { describe, expect, it } from "vitest";
import { LOCAL_PLAYER, SYSTEM_OWNER, WORLD_ID, type VoxelBlock } from "../src/domain/types";
import {
  prepareLocalSnapshot,
  withoutOnboardingBlocks,
} from "../src/world/localWorld";
import { createSeedSnapshot } from "../src/world/seed";

function ownedBlock(
  id: string,
  source: VoxelBlock["source"],
  owner = LOCAL_PLAYER,
): VoxelBlock {
  return {
    id,
    worldId: WORLD_ID,
    position: { x: id.length, y: 1, z: 30 + id.length },
    kind: "cube",
    rotation: 0,
    colorIndex: 6,
    owner,
    zone: "public",
    createdAt: 1,
    ...(source ? { source } : {}),
  };
}

describe("로컬 월드 준비", () => {
  it("1단계 저장본을 2단계로 한 번만 이관하고 최초 24블록과 베이 발판을 중복하지 않는다", () => {
    const first = prepareLocalSnapshot(
      {
        schemaVersion: 1,
        worldId: WORLD_ID,
        blocks: [],
        updatedAt: 10,
      },
      1_000,
    );

    expect(first.changed).toBe(true);
    expect(first.snapshot.schemaVersion).toBe(2);
    expect(first.snapshot.localState?.progress.inventory).toBe(24);
    expect(first.snapshot.localState?.progress.initialGrantClaimed).toBe(true);
    expect(first.snapshot.blocks.length).toBeGreaterThan(0);

    const second = prepareLocalSnapshot(first.snapshot, 2_000);
    expect(second.changed).toBe(false);
    expect(second.snapshot.localState?.progress.inventory).toBe(24);
    expect(second.snapshot.blocks).toHaveLength(first.snapshot.blocks.length);
    expect(new Set(second.snapshot.blocks.map((block) => block.id)).size).toBe(
      second.snapshot.blocks.length,
    );
  });

  it("베이 초기화는 해당 사용자의 온보딩 블록만 골라 제거한다", () => {
    const blocks = [
      ownedBlock("mine-onboarding", "onboarding"),
      ownedBlock("mine-inventory", "inventory"),
      ownedBlock("system-onboarding", "onboarding", SYSTEM_OWNER),
    ];

    expect(
      withoutOnboardingBlocks(blocks, LOCAL_PLAYER.id).map((block) => block.id),
    ).toEqual(["mine-inventory", "system-onboarding"]);
  });

  it("손상된 진행 상태와 범위 밖 슬롯은 안전한 최초 상태로 복구한다", () => {
    const malformed = {
      schemaVersion: 2,
      worldId: WORLD_ID,
      blocks: [],
      updatedAt: 10,
      localState: {
        playerId: "wrong-player",
        baySlotIndex: 999,
        progress: {
          initialGrantClaimed: true,
          inventory: Number.NaN,
        },
      },
    } as unknown as Parameters<typeof prepareLocalSnapshot>[0];

    const prepared = prepareLocalSnapshot(malformed, 5_000);
    expect(prepared.changed).toBe(true);
    expect(prepared.snapshot.localState?.playerId).toBe(LOCAL_PLAYER.id);
    expect(prepared.snapshot.localState?.baySlotIndex).toBe(0);
    expect(prepared.snapshot.localState?.progress.inventory).toBe(24);
    expect(prepared.snapshot.localState?.progress.lastSettledAt).toBe(5_000);
  });

  it("결정적 시스템 맵만 갱신하고 같은 좌표의 사용자 블록은 보존한다", () => {
    const initial = createSeedSnapshot(1_000);
    const replaceable = initial.blocks.find(
      ({ id }) => id === "online-ground-0-0-0",
    )!;
    const occupiedSystemPosition = initial.blocks.find(
      ({ id }) => id === "online-core-orbit-0--1-3-0",
    )!;
    const userWinner: VoxelBlock = {
      ...occupiedSystemPosition,
      id: "existing-user-winner",
      owner: LOCAL_PLAYER,
      zone: "public",
      colorIndex: 2,
    };
    const legacySnapshot = {
      ...initial,
      blocks: initial.blocks.map((block) => {
        if (block.id === replaceable.id) return { ...block, colorIndex: 2 };
        if (block.id === occupiedSystemPosition.id) return userWinner;
        return block;
      }),
    };

    const upgraded = prepareLocalSnapshot(legacySnapshot, 2_000);
    expect(upgraded.changed).toBe(true);
    expect(
      upgraded.snapshot.blocks.find(({ id }) => id === replaceable.id)?.colorIndex,
    ).not.toBe(2);
    expect(upgraded.snapshot.blocks.find(({ id }) => id === userWinner.id)).toEqual(
      userWinner,
    );
    expect(
      upgraded.snapshot.blocks.some(({ id }) => id === occupiedSystemPosition.id),
    ).toBe(false);

    const stable = prepareLocalSnapshot(upgraded.snapshot, 3_000);
    expect(stable.changed).toBe(false);
  });

  it("이전 ground 시스템 ID를 제거하고 같은 좌표를 중복 없이 최신 광장으로 이관한다", () => {
    const initial = createSeedSnapshot(1_000);
    const currentGround = initial.blocks.find(
      ({ id }) => id === "online-ground-11-0-11",
    )!;
    const legacyGround: VoxelBlock = {
      ...currentGround,
      id: "ground-11-0-11",
      colorIndex: 2,
    };
    const legacy = {
      ...initial,
      blocks: initial.blocks.map((block) =>
        block.id === currentGround.id ? legacyGround : block,
      ),
    };

    const upgraded = prepareLocalSnapshot(legacy, 2_000);
    expect(upgraded.changed).toBe(true);
    expect(upgraded.snapshot.blocks.some(({ id }) => id === legacyGround.id)).toBe(
      false,
    );
    expect(
      upgraded.snapshot.blocks.some(({ id }) => id === currentGround.id),
    ).toBe(true);
    expect(
      new Set(
        upgraded.snapshot.blocks.map(
          ({ position }) => `${position.x},${position.y},${position.z}`,
        ),
      ).size,
    ).toBe(upgraded.snapshot.blocks.length);
  });
});
