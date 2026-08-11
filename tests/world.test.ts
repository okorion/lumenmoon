import { describe, expect, it } from "vitest";
import {
  LOCAL_PLAYER,
  SYSTEM_OWNER,
  WORLD_ID,
  type VoxelBlock,
} from "../src/domain/types";
import { VoxelWorld, zoneAt } from "../src/domain/world";

function block(
  id: string,
  x: number,
  zone: VoxelBlock["zone"] = "public",
  owner = LOCAL_PLAYER,
): VoxelBlock {
  return {
    id,
    worldId: WORLD_ID,
    position: { x, y: 1, z: 0 },
    kind: "cube",
    rotation: 0,
    colorIndex: 0,
    owner,
    zone,
    createdAt: 1,
  };
}

describe("VoxelWorld", () => {
  it("빈 좌표만 배치 가능하고 중복 좌표를 거부한다", () => {
    const world = new VoxelWorld(WORLD_ID);
    world.addBlock(block("first", 0));
    expect(world.canPlace({ x: 0, y: 1, z: 0 })).toBe(false);
    expect(world.canPlace({ x: 1, y: 1, z: 0 })).toBe(true);
    expect(() => world.addBlock(block("second", 0))).toThrow();
  });

  it("자기 일반 블록만 제거한다", () => {
    const own = block("own", 0);
    const system = block("system", 1, "system", SYSTEM_OWNER);
    const world = new VoxelWorld(WORLD_ID, [own, system]);

    expect(world.removeOwnedBlock(system.id, LOCAL_PLAYER)).toBeNull();
    expect(world.removeOwnedBlock(own.id, LOCAL_PLAYER)).toEqual(own);
    expect(world.size).toBe(1);
  });

  it("스냅샷은 원본과 분리된 값으로 생성된다", () => {
    const original = block("own", 0);
    const world = new VoxelWorld(WORLD_ID, [original]);
    const snapshot = world.createSnapshot(42);
    snapshot.blocks[0]!.position.x = 99;
    expect(world.getBlockById(original.id)?.position.x).toBe(0);
    expect(snapshot.updatedAt).toBe(42);
  });

  it("서버에서 다시 읽은 블록 집합으로 월드를 원자 교체한다", () => {
    const world = new VoxelWorld(WORLD_ID, [block("old", 0)]);
    world.replaceBlocks([block("new", 2)]);

    expect(world.getBlockById("old")).toBeUndefined();
    expect(world.getBlockById("new")?.position.x).toBe(2);
    expect(world.size).toBe(1);
    expect(() =>
      world.replaceBlocks([block("first", 3), block("second", 3)]),
    ).toThrow("중복");
    expect(world.getBlockById("new")?.position.x).toBe(2);
  });

  it("좌표를 개인·미션·공용 구역으로 분류한다", () => {
    expect(zoneAt({ x: 0, y: 1, z: 8 })).toBe("personal");
    expect(zoneAt({ x: 0, y: 1, z: 0 })).toBe("mission");
    expect(zoneAt({ x: 20, y: 1, z: 20 })).toBe("public");
  });
});
