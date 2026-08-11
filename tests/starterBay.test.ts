import { describe, expect, it } from "vitest";
import {
  STARTER_BAY_RESERVED_SLOT_COUNT,
  classifyStarterBayPosition,
  createStarterBayLayout,
  getStarterBaySlot,
  localToWorld,
} from "../src/domain/starterBay";
import type { BlockRotation, GridPosition } from "../src/domain/types";
import { VoxelWorld } from "../src/domain/world";

function positionKey(position: GridPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function distanceFromTower(position: GridPosition): number {
  return Math.hypot(position.x, position.z);
}

describe("스타터 베이 슬롯", () => {
  it("같은 인덱스에 항상 같은 슬롯을 배정하고 첫 슬롯은 중앙탑 북쪽이다", () => {
    expect(getStarterBaySlot(37)).toEqual(getStarterBaySlot(37));
    expect(getStarterBaySlot(0)).toMatchObject({
      origin: { x: 0, y: 0, z: -26 },
      rotation: 0,
      towardTower: { x: 0, y: 0, z: 1 },
    });
    expect(() => getStarterBaySlot(-1)).toThrow(RangeError);
    expect(() => getStarterBaySlot(1.5)).toThrow(RangeError);
  });

  it("로컬 좌표를 네 방향으로 정확히 회전한다", () => {
    const origin = { x: 10, y: 2, z: -4 };
    const expected = [
      { x: 12, y: 5, z: 1 },
      { x: 5, y: 5, z: -2 },
      { x: 8, y: 5, z: -9 },
      { x: 15, y: 5, z: -6 },
    ];

    for (let rotation = 0; rotation < 4; rotation += 1) {
      expect(
        localToWorld(
          { x: 2, y: 3, z: 5 },
          origin,
          rotation as BlockRotation,
        ),
      ).toEqual(expected[rotation]);
    }
  });

  it("개인 16개, 생산시설 8개, 확장 12개의 중복 없는 가이드를 만든다", () => {
    const layout = createStarterBayLayout(0);
    expect(layout.baseGuides).toHaveLength(16);
    expect(layout.producerGuides).toHaveLength(8);
    expect(layout.upgradeGuides).toHaveLength(12);
    expect(layout.guides).toHaveLength(36);

    expect(layout.baseGuides.filter(({ role }) => role === "floor")).toHaveLength(9);
    expect(layout.baseGuides.filter(({ role }) => role === "core")).toHaveLength(1);
    expect(layout.baseGuides.filter(({ role }) => role === "wall")).toHaveLength(3);
    expect(layout.baseGuides.filter(({ role }) => role === "roof")).toHaveLength(2);
    expect(
      layout.baseGuides.filter(({ role }) => role === "decoration"),
    ).toHaveLength(1);

    const keys = new Set(layout.guides.map(({ position }) => positionKey(position)));
    expect(keys.size).toBe(layout.guides.length);
    expect(layout.baseGuides.map(({ order }) => order)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    expect(layout.producerGuides.map(({ order }) => order)).toEqual(
      Array.from({ length: 8 }, (_, index) => index + 1),
    );
  });

  it("첫 64개 슬롯의 실제 풋프린트가 서로 겹치지 않는다", () => {
    const occupied = new Map<string, number>();

    for (let slotIndex = 0; slotIndex < 64; slotIndex += 1) {
      const layout = createStarterBayLayout(slotIndex);
      for (const position of layout.footprint) {
        const key = positionKey(position);
        expect(occupied.get(key), `${slotIndex}번 슬롯이 ${key}에서 겹침`).toBeUndefined();
        occupied.set(key, slotIndex);
      }
    }
  });

  it("첫 64개 슬롯의 모든 시스템 칸과 가이드가 월드 배치 경계 안에 있다", () => {
    const world = new VoxelWorld("slot-bounds");

    for (let slotIndex = 0; slotIndex < 64; slotIndex += 1) {
      const layout = createStarterBayLayout(slotIndex);
      for (const position of [
        ...layout.systemPlatform,
        ...layout.guides.map((guide) => guide.position),
      ]) {
        expect(
          world.canPlace(position),
          `${slotIndex}번 슬롯의 ${positionKey(position)}가 월드 밖`,
        ).toBe(true);
      }
    }
  });

  it("다른 플레이어에게 예약된 빈 베이도 공용 구역으로 오인하지 않는다", () => {
    const layouts = Array.from(
      { length: STARTER_BAY_RESERVED_SLOT_COUNT },
      (_, index) => createStarterBayLayout(index),
    );
    const otherBay = layouts[1]!;
    const privateCell = otherBay.baseGuides[0]!.position;
    const producerCell = otherBay.producerGuides[0]!.position;

    expect(classifyStarterBayPosition(layouts, privateCell)).toEqual({
      zone: "personal",
      slotIndex: 1,
    });
    expect(classifyStarterBayPosition(layouts, producerCell)).toEqual({
      zone: "producer",
      slotIndex: 1,
    });
    expect(
      classifyStarterBayPosition(layouts, { x: 300, y: 1, z: 300 }),
    ).toEqual({ zone: "public", slotIndex: null });
  });

  it("통로의 각 칸은 슬롯에서 중앙탑 방향으로 진행한다", () => {
    for (let slotIndex = 0; slotIndex < 64; slotIndex += 1) {
      const layout = createStarterBayLayout(slotIndex);
      expect(layout.path).toHaveLength(14);

      for (let index = 1; index < layout.path.length; index += 1) {
        const previous = layout.path[index - 1]!;
        const current = layout.path[index]!;
        expect(current.x - previous.x).toBe(layout.slot.towardTower.x);
        expect(current.z - previous.z).toBe(layout.slot.towardTower.z);
        expect(distanceFromTower(current)).toBeLessThan(distanceFromTower(previous));
      }
    }
  });

  it("안전 스폰은 전용 불변 발판 바로 위에 있다", () => {
    for (const slotIndex of [0, 2, 4, 6, 31]) {
      const layout = createStarterBayLayout(slotIndex);
      const belowSpawn = {
        x: Math.floor(layout.safeSpawn.x),
        y: Math.floor(layout.safeSpawn.y) - 1,
        z: Math.floor(layout.safeSpawn.z),
      };
      expect(layout.spawnPlatform.map(positionKey)).toContain(positionKey(belowSpawn));
      expect(layout.systemPlatform.map(positionKey)).toContain(positionKey(belowSpawn));
    }
  });
});
