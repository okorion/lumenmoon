import { describe, expect, it } from "vitest";
import {
  deduplicateMissionVisualBlocks,
  missionEmissiveIntensity,
  selectMissionFocusVisual,
  type MissionVisualBlock,
} from "../src/rendering/VoxelRenderer";
import { missionStageLabel } from "../src/ui/GameUI";

function visual(
  visualId: string,
  x: number,
  z: number,
  isReplica: boolean,
): MissionVisualBlock {
  return {
    visualId,
    sourceId: "canonical-7",
    sourceBlock: {
      id: "canonical-7",
      worldId: "world-1",
      position: { x: 1, y: 4, z: 2 },
      kind: "cube",
      rotation: 0,
      colorIndex: 4,
      owner: {
        id: "internal-not-rendered",
        publicId: "#A1B2",
        nickname: "고요한 여우",
        emblem: "✦",
      },
      zone: "mission",
      createdAt: 1_786_402_800_000,
    },
    position: { x, y: 4, z },
    kind: "cube",
    rotation: 0,
    colorIndex: 4,
    stage: 0,
    isReplica,
    symmetryQuarter: isReplica ? 1 : 0,
    instanceId: "mission-1",
    missionName: "루멘문",
    layer: 1,
    canonicalContributionId: "canonical-7",
  };
}

describe("공동 미션 UI·렌더 표현", () => {
  it("대칭축 중복 좌표는 한 번만 남기고 정규 원본을 우선한다", () => {
    const replica = visual("replica", -0, 0, true);
    const canonical = visual("canonical", 0, 0, false);
    const other = visual("other", 2, 0, true);

    const result = deduplicateMissionVisualBlocks([
      replica,
      canonical,
      other,
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      visualId: "canonical",
      sourceId: "canonical-7",
      isReplica: false,
    });
    expect(result[0]?.sourceBlock.owner.publicId).toBe("#A1B2");
  });

  it("25·50·75·100 단계가 서로 다른 문구와 점증하는 발광을 가진다", () => {
    const stages = [0, 25, 50, 75, 100] as const;
    expect(stages.map(missionStageLabel)).toEqual([
      "별빛 모으는 중",
      "바닥 문양 점등",
      "좌우 기둥 활성화",
      "상단 고리 · 빛줄기",
      "불변 기념물 완성",
    ]);
    expect(stages.map(missionEmissiveIntensity)).toEqual(
      [...stages.map(missionEmissiveIntensity)].sort((left, right) => left - right),
    );
  });

  it("조준 카드의 찾아가기는 같은 제작자의 첫 블록 대신 해당 정규 기여를 고른다", () => {
    const first = visual("first", 1, 1, false);
    const targetReplica = {
      ...visual("target-replica", -4, 2, true),
      canonicalContributionId: "canonical-target",
      sourceId: "canonical-target",
    };
    const targetCanonical = {
      ...visual("target-canonical", 4, 2, false),
      canonicalContributionId: "canonical-target",
      sourceId: "canonical-target",
      layer: 2,
    };

    expect(
      selectMissionFocusVisual(
        [first, targetReplica, targetCanonical],
        "#A1B2",
        "canonical-target",
      ),
    ).toMatchObject({
      visualId: "target-canonical",
      canonicalContributionId: "canonical-target",
      isReplica: false,
      layer: 2,
    });
  });
});

