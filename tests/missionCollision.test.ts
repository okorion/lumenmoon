import { describe, expect, it } from "vitest";
import { collidesAt } from "../src/domain/collision";
import { queryMissionAwareBounds } from "../src/domain/missionCollision";
import { LOCAL_PLAYER, type VoxelBlock } from "../src/domain/types";
import { VoxelWorld } from "../src/domain/world";

describe("공동 미션 충돌", () => {
  it("VoxelWorld 밖의 정규·복제 미션 블록도 플레이어 AABB를 막는다", () => {
    const world = new VoxelWorld("mission-collision", []);
    const missionBlocks: VoxelBlock[] = [
      missionBlock("canonical", { x: 0, y: 1, z: 0 }),
      missionBlock("replica", { x: 5, y: 1, z: 0 }),
    ];
    const source = {
      queryBounds: (min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }) =>
        queryMissionAwareBounds(world, missionBlocks, min, max),
    };

    expect(collidesAt(source, { x: 0.5, y: 1, z: 0.5 })).toBe(true);
    expect(collidesAt(source, { x: 5.5, y: 1, z: 0.5 })).toBe(true);
    expect(collidesAt(source, { x: 9.5, y: 1, z: 0.5 })).toBe(false);
  });
});

function missionBlock(
  id: string,
  position: { x: number; y: number; z: number },
): VoxelBlock {
  return {
    id,
    worldId: "mission-collision",
    position,
    kind: "cube",
    rotation: 0,
    colorIndex: 4,
    owner: LOCAL_PLAYER,
    zone: "mission",
    createdAt: 1,
  };
}
