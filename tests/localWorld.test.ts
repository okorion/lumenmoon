import { describe, expect, it } from "vitest";
import { LOCAL_PLAYER, SYSTEM_OWNER, WORLD_ID, type VoxelBlock } from "../src/domain/types";
import {
  prepareLocalSnapshot,
  withoutOnboardingBlocks,
} from "../src/world/localWorld";

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
});
