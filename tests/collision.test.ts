import { describe, expect, it } from "vitest";
import {
  blockIntersectsPlayer,
  collidesAt,
  isGrounded,
  resolvePlayerMotion,
  type CollisionSource,
} from "../src/domain/collision";
import {
  SYSTEM_OWNER,
  WORLD_ID,
  type GridPosition,
  type VoxelBlock,
} from "../src/domain/types";
import { PlayerController } from "../src/player/PlayerController";

function makeBlock(position: GridPosition, id: string): VoxelBlock {
  return {
    id,
    worldId: WORLD_ID,
    position,
    kind: "cube",
    rotation: 0,
    colorIndex: 0,
    owner: SYSTEM_OWNER,
    zone: "system",
    createdAt: 1,
  };
}

function source(blocks: readonly VoxelBlock[]): CollisionSource {
  return {
    queryBounds: () => blocks,
  };
}

describe("플레이어 충돌", () => {
  const floor = makeBlock({ x: 0, y: 0, z: 0 }, "floor");

  it("바닥 위는 충돌하지 않지만 접지 상태로 판정한다", () => {
    const world = source([floor]);
    const position = { x: 0.5, y: 1.001, z: 0.5 };
    expect(collidesAt(world, position)).toBe(false);
    expect(isGrounded(world, position)).toBe(true);
  });

  it("배치 블록이 플레이어 몸과 겹치는지 판정한다", () => {
    expect(
      blockIntersectsPlayer(
        { x: 0.5, y: 1, z: 0.5 },
        { x: 0, y: 1, z: 0 },
      ),
    ).toBe(true);
    expect(
      blockIntersectsPlayer(
        { x: 0.5, y: 1, z: 0.5 },
        { x: 3, y: 1, z: 3 },
      ),
    ).toBe(false);
  });

  it("한 칸 장애물을 자동으로 올라간다", () => {
    const step = makeBlock({ x: 1, y: 1, z: 0 }, "step");
    const result = resolvePlayerMotion(
      source([floor, step]),
      { x: 0.5, y: 1.001, z: 0.5 },
      { x: 0.7, y: 0, z: 0 },
      true,
    );
    expect(result.stepped).toBe(true);
    expect(result.position.y).toBeGreaterThan(2);
  });

  it("두 칸 높이 벽은 통과하지 않는다", () => {
    const wallLow = makeBlock({ x: 1, y: 1, z: 0 }, "wall-low");
    const wallHigh = makeBlock({ x: 1, y: 2, z: 0 }, "wall-high");
    const result = resolvePlayerMotion(
      source([floor, wallLow, wallHigh]),
      { x: 0.5, y: 1.001, z: 0.5 },
      { x: 0.7, y: 0, z: 0 },
      true,
    );
    expect(result.stepped).toBe(false);
    expect(result.position.x).toBe(0.5);
  });

  it("스폰 칸이 막혀도 근처의 빈 바닥으로 복귀한다", () => {
    const blocks: VoxelBlock[] = [];
    for (let x = -1; x <= 1; x += 1) {
      for (let z = -1; z <= 1; z += 1) {
        blocks.push(makeBlock({ x, y: 0, z }, `floor-${x}-${z}`));
      }
    }
    blocks.push(makeBlock({ x: 0, y: 1, z: 0 }, "blocked-spawn"));
    const world = source(blocks);
    const player = new PlayerController(world, {
      x: 0.5,
      y: 1.001,
      z: 0.5,
    });

    expect(collidesAt(world, player.position)).toBe(false);
    expect(isGrounded(world, player.position)).toBe(true);
    expect(player.position).not.toEqual({ x: 0.5, y: 1.001, z: 0.5 });
  });
});
