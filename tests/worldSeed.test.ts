import { describe, expect, it } from "vitest";
import { createNearbyOnlineSystemBlocks } from "../src/app/onlineWorld";
import { createStarterBayLayout } from "../src/domain/starterBay";
import {
  STARLIGHT_GATE_TEMPLATE,
  createStarlightGateInstance,
  expandMissionContribution,
  transformMissionSlot,
  type MissionContribution,
} from "../src/domain/mission";
import {
  SYSTEM_OWNER,
  WORLD_ID,
  type GridPosition,
  type VoxelBlock,
} from "../src/domain/types";
import {
  createCentralOnlineSystemBlocks,
  createSeedSnapshot,
  createStarterBaySystemBlocks,
} from "../src/world/seed";

describe("루멘문 결정적 시스템 맵", () => {
  it("중앙 광장은 한 층의 조밀한 지면과 제한된 수의 방향 표지로 구성된다", () => {
    const blocks = createCentralOnlineSystemBlocks();
    const ground = blocks.filter(({ position }) => position.y === 0);
    const raised = blocks.filter(({ position }) => position.y > 0);

    expect(ground).toHaveLength(25 * 28);
    expect(raised).toHaveLength(26);
    expect(new Set(blocks.map(positionKey)).size).toBe(blocks.length);
    expect(new Set(blocks.map(({ id }) => id)).size).toBe(blocks.length);
    expect(blocks.every(({ owner }) => owner.id === SYSTEM_OWNER.id)).toBe(true);
    expect(new Set(ground.map(({ colorIndex }) => colorIndex)).size).toBeGreaterThan(
      3,
    );
    expect(
      blocks.filter(({ id }) => id.startsWith("online-core-orbit-")),
    ).toHaveLength(4);
    expect(
      blocks.filter(({ id }) => id.startsWith("online-core-crown-")),
    ).toHaveLength(4);
    expect(
      blocks.filter(({ id }) => id.startsWith("online-core-fin-")),
    ).toHaveLength(6);
  });

  it("높이가 있는 중앙 장식은 별빛 관문의 반지름 5 설계면을 침범하지 않는다", () => {
    const raised = createCentralOnlineSystemBlocks().filter(
      ({ position }) => position.y > 0,
    );
    const mission = createStarlightGateInstance(WORLD_ID, 1, 0);
    const missionPositions = new Set<string>();
    for (const templateSlot of STARLIGHT_GATE_TEMPLATE.slots) {
      const transformed = transformMissionSlot(mission, templateSlot);
      const contribution: MissionContribution = {
        id: `contribution-${templateSlot.slotIndex}`,
        blockId: `block-${templateSlot.slotIndex}`,
        missionId: mission.id,
        missionName: mission.name,
        missionLayer: mission.layer,
        slotIndex: templateSlot.slotIndex,
        ...transformed,
        paletteIndex: 0,
        colorIndex: 4,
        creator: { publicId: "#TEST", nickname: "테스트", emblem: "✦" },
        createdAt: 0,
      };
      for (const block of expandMissionContribution(mission, contribution)) {
        missionPositions.add(positionKey(block));
      }
    }

    for (const { position } of raised) {
      expect(missionPositions.has(positionKey(position)), positionKey(position)).toBe(
        false,
      );
    }
  });

  it("베이는 기존 발판 좌표와 ID를 유지하면서 구역마다 다른 문양을 사용한다", () => {
    for (const slotIndex of [0, 1, 2, 7, 31, 63]) {
      const layout = createStarterBayLayout(slotIndex);
      const blocks = createStarterBaySystemBlocks(slotIndex);

      expect(blocks.map(({ position }) => positionKey(position)).sort()).toEqual(
        layout.systemPlatform.map(positionKey).sort(),
      );
      expect(
        blocks.every(({ id }, index) => id.startsWith(`starter-${slotIndex}-${index}-`)),
      ).toBe(true);
      expect(new Set(blocks.map(positionKey)).size).toBe(blocks.length);
      expect(
        new Set(blocks.map(({ colorIndex }) => colorIndex)).size,
      ).toBeGreaterThan(3);
      expect(createStarterBaySystemBlocks(slotIndex)).not.toBe(blocks);
      expect(createStarterBaySystemBlocks(slotIndex)).toEqual(blocks);
    }
  });

  it("로컬 초기 맵과 온라인 주변 청크가 같은 시스템 블록을 합성한다", () => {
    const localSystem = createSeedSnapshot(0).blocks.filter(
      ({ owner }) => owner.id === SYSTEM_OWNER.id,
    );
    const online = createNearbyOnlineSystemBlocks(WORLD_ID, 0, 0, 0, 3, 1);
    const onlineById = new Map(online.map((block) => [block.id, block]));

    for (const localBlock of localSystem) {
      expect(onlineById.get(localBlock.id), localBlock.id).toEqual(localBlock);
    }
  });

  it("겹치는 청크 범위를 다시 합성해도 같은 ID의 내용이 바뀌지 않는다", () => {
    const left = createNearbyOnlineSystemBlocks(WORLD_ID, 0, 0, 0, 2, 1);
    const right = createNearbyOnlineSystemBlocks(WORLD_ID, 1, 0, 0, 2, 1);
    const rightById = new Map(right.map((block) => [block.id, block]));
    const overlap = left.filter(({ id }) => rightById.has(id));

    expect(overlap.length).toBeGreaterThan(0);
    for (const block of overlap) {
      expect(rightById.get(block.id)).toEqual(block);
    }
  });
});

function positionKey(position: GridPosition | VoxelBlock): string {
  const value = "position" in position ? position.position : position;
  return `${value.x},${value.y},${value.z}`;
}
