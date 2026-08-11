import { describe, expect, it } from "vitest";
import {
  MISSION_CANONICAL_SLOT_COUNT,
  STARLIGHT_GATE_TEMPLATE,
  applyMissionContribution,
  createInitialLocalMissionWorldState,
  expandMissionBlocks,
  expandMissionContribution,
  missionBlocksByCreator,
  missionInstanceView,
  selectMissionRenderWindow,
  missionStageFromFilledSlots,
  transformMissionSlot,
  type MissionContribution,
} from "../src/domain/mission";
import {
  createLocalPlayerProgress,
  type LocalPlayerProgress,
} from "../src/domain/progression";

const WORLD_ID = "mission-test-world";
const PLAYER = {
  publicId: "#B7K2",
  nickname: "고요한 여우",
  emblem: "✦",
};

describe("루멘문 도메인", () => {
  it("오래된 기록이 늘어도 현재 관람 층 주변 최대 5개만 렌더한다", () => {
    const missions = Array.from({ length: 120 }, (_, index) => ({
      id: `mission-${index + 1}`,
      layer: index + 1,
    }));
    const focus = missions[59]!;
    const selected = selectMissionRenderWindow(missions, focus);

    expect(selected.map(({ layer }) => layer)).toEqual([58, 59, 60, 61, 62]);
  });

  it("서버 정규 설계 슬롯은 정확히 24개이고 번호가 연속이다", () => {
    expect(STARLIGHT_GATE_TEMPLATE.slots).toHaveLength(
      MISSION_CANONICAL_SLOT_COUNT,
    );
    expect(STARLIGHT_GATE_TEMPLATE.slots.map(({ slotIndex }) => slotIndex)).toEqual(
      Array.from({ length: 24 }, (_, index) => index),
    );
  });

  it.each([
    [0, 0],
    [5, 0],
    [6, 25],
    [11, 25],
    [12, 50],
    [17, 50],
    [18, 75],
    [23, 75],
    [24, 100],
  ] as const)("확정 슬롯 %i개를 %i%% 단계로 판정한다", (count, stage) => {
    expect(missionStageFromFilledSlots(count)).toBe(stage);
  });

  it("정규 슬롯 하나를 최대 4방향으로 펼치고 중심축 중복은 제거한다", () => {
    const state = createInitialLocalMissionWorldState(WORLD_ID, 0);
    const instance = state.instances[0]!;
    const slot = STARLIGHT_GATE_TEMPLATE.slots[0]!;
    const transformed = transformMissionSlot(instance, slot);
    const contribution = contributionAt({
      ...transformed,
      position: transformed.position,
    });
    expect(expandMissionContribution(instance, contribution)).toHaveLength(4);

    const centered = contributionAt({
      position: { ...instance.origin, y: instance.origin.y + 1 },
      kind: "light",
      rotation: 0,
    });
    expect(expandMissionContribution(instance, centered)).toHaveLength(1);
  });

  it("복제본은 표시 블록일 뿐 정규 기여도는 한 번만 증가한다", () => {
    const state = createInitialLocalMissionWorldState(WORLD_ID, 0);
    const instance = state.instances[0]!;
    const result = applyMissionContribution({
      state,
      worldId: WORLD_ID,
      missionInstanceId: instance.id,
      slotIndex: 0,
      paletteIndex: 0,
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      actor: PLAYER,
      progress: eligibleProgress(2),
      now: 1_000,
    });

    expect(result.mission.filledSlots).toBe(1);
    expect(result.mission.myContributionCount).toBe(1);
    expect(result.state.instances[0]?.contributions).toHaveLength(1);
    expect(expandMissionBlocks(result.mission)).toHaveLength(4);
    expect(result.contribution.paletteIndex).toBe(0);
    expect(result.contribution.colorIndex).toBe(1);
    expect(result.progress.inventory).toBe(1);
  });

  it("같은 공개 ID의 원본과 모든 대칭 복제본을 함께 찾는다", () => {
    const state = createInitialLocalMissionWorldState(WORLD_ID, 0);
    const instance = state.instances[0]!;
    const result = applyMissionContribution({
      state,
      worldId: WORLD_ID,
      missionInstanceId: instance.id,
      slotIndex: 0,
      paletteIndex: 0,
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
      actor: PLAYER,
      progress: eligibleProgress(2),
      now: 1_000,
    });
    const highlighted = missionBlocksByCreator(result.mission, PLAYER.publicId);

    expect(highlighted).toHaveLength(4);
    expect(highlighted.filter(({ mission }) => !mission.isReplica)).toHaveLength(1);
    expect(
      highlighted.every(
        ({ mission }) => mission.canonicalBlockId === result.contribution.blockId,
      ),
    ).toBe(true);
  });

  it("읽기 모델은 추천 가능한 미확정 슬롯을 최대 3개만 제공한다", () => {
    const state = createInitialLocalMissionWorldState(WORLD_ID, 0);
    const view = missionInstanceView(state.instances[0]!, PLAYER.publicId);
    expect(view.recommendedSlotIndexes).toEqual([0, 1, 2]);
    expect(view.palette).toHaveLength(5);
  });
});

function eligibleProgress(inventory: number): LocalPlayerProgress {
  return {
    ...createLocalPlayerProgress(0),
    initialGrantClaimed: true,
    inventory,
    baseCompleted: true,
    baseCompletedAt: 0,
    producerCompleted: true,
    producerCompletedAt: 0,
    trialRewardClaimed: true,
  };
}

function contributionAt(
  block: Pick<MissionContribution, "position" | "kind" | "rotation">,
): MissionContribution {
  return {
    id: "contribution",
    blockId: "block",
    missionId: "mission",
    missionName: "루멘문",
    missionLayer: 1,
    slotIndex: 0,
    ...block,
    paletteIndex: 0,
    colorIndex: 4,
    creator: PLAYER,
    createdAt: 0,
  };
}

