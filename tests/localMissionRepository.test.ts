import { describe, expect, it } from "vitest";
import { LocalCollaborativeWorldRepository } from "../src/data/LocalCollaborativeWorldRepository";
import { MemoryWorldRepository } from "../src/data/WorldRepository";
import type { Clock } from "../src/domain/progression";
import { createStarterBayLayout } from "../src/domain/starterBay";
import {
  LOCAL_PLAYER,
  WORLD_ID,
  type BlockOwner,
  type VoxelBlock,
} from "../src/domain/types";
import { createSeedSnapshot } from "../src/world/seed";
import { prepareLocalSnapshot } from "../src/world/localWorld";

class FakeClock implements Clock {
  constructor(public current = 1_000) {}
  now(): number {
    return this.current;
  }
}

const OLD_PLAYER: BlockOwner = {
  ...LOCAL_PLAYER,
  nickname: "고요한 여우",
  emblem: "✦",
};

describe("Local 공동 미션 저장소", () => {
  it("활성 별빛 관문과 최대 3개 추천 슬롯을 읽는다", async () => {
    const { repository } = await eligibleRepository(2);
    const overview = await repository.getMissionOverview(WORLD_ID);

    expect(overview.activeMission.name).toBe("별빛 관문");
    expect(overview.activeMission.totalSlots).toBe(24);
    expect(overview.activeMission.recommendedSlotIndexes).toEqual([0, 1, 2]);
    expect(overview.activeMission.palette).toHaveLength(5);
    expect(overview.eligibility).toEqual({
      baseBuilt: 16,
      producerBuilt: 8,
      eligible: true,
    });
  });

  it("현재 16+8 가이드가 없으면 과거 완성 플래그만으로 기여할 수 없다", async () => {
    const storage = new MemoryWorldRepository();
    const snapshot = createSeedSnapshot(0);
    snapshot.localState!.progress = completedProgress(2);
    await storage.save(snapshot);
    const repository = new LocalCollaborativeWorldRepository(storage, {
      clock: new FakeClock(),
    });
    const overview = await repository.getMissionOverview(WORLD_ID);
    const mission = overview.activeMission;
    expect(overview.eligibility.eligible).toBe(false);

    await expect(
      repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: mission.id,
        slotIndex: 0,
        paletteIndex: 0,
        idempotencyKey: uuid(1),
      }),
    ).rejects.toMatchObject({ code: "onboarding-incomplete" });
  });

  it("가이드가 있어도 거점·생산시설 완성 상태가 아니면 참여를 거절한다", async () => {
    const fixture = await eligibleRepository(2);
    const snapshot = (await fixture.storage.load(WORLD_ID))!;
    snapshot.localState!.progress.baseCompleted = false;
    snapshot.localState!.progress.baseCompletedAt = null;
    await fixture.storage.save(snapshot);
    const mission = (await fixture.repository.getMissionOverview(WORLD_ID))
      .activeMission;

    await expect(
      fixture.repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: mission.id,
        slotIndex: 0,
        paletteIndex: 0,
        idempotencyKey: uuid(6),
      }),
    ).rejects.toMatchObject({ code: "onboarding-incomplete" });
  });

  it("재고 1개로 정규 슬롯 하나만 확정하고 새 저장소 인스턴스의 재전송도 중복 반영하지 않는다", async () => {
    const fixture = await eligibleRepository(2);
    const mission = (await fixture.repository.getMissionOverview(WORLD_ID))
      .activeMission;
    const request = {
      worldId: WORLD_ID,
      missionInstanceId: mission.id,
      slotIndex: 0,
      paletteIndex: 2,
      idempotencyKey: uuid(2),
    };

    const first = await fixture.repository.contributeToMission(request);
    const between = (await fixture.storage.load(WORLD_ID))!;
    const producerIndex = between.blocks.findIndex(
      ({ zone, owner }) => zone === "producer" && owner.id === OLD_PLAYER.id,
    );
    between.blocks.splice(producerIndex, 1);
    await fixture.storage.save(between);
    const reloaded = new LocalCollaborativeWorldRepository(fixture.storage, {
      clock: fixture.clock,
    });
    const replay = await reloaded.contributeToMission(request);
    const saved = await fixture.storage.load(WORLD_ID);

    expect(first.replayed).toBe(false);
    expect(first.mission.filledSlots).toBe(1);
    expect(first.progress.inventory).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.progress.inventory).toBe(1);
    expect(saved?.localMissionState?.instances[0]?.contributions).toHaveLength(1);
    expect(saved?.localState?.progress.inventory).toBe(1);
  });

  it("같은 추천 슬롯의 동시 요청은 하나만 성공하고 실패 재고는 차감하지 않는다", async () => {
    const { repository, storage } = await eligibleRepository(3);
    const mission = (await repository.getMissionOverview(WORLD_ID)).activeMission;
    const results = await Promise.allSettled([
      repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: mission.id,
        slotIndex: 0,
        paletteIndex: 0,
        idempotencyKey: uuid(3),
      }),
      repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: mission.id,
        slotIndex: 0,
        paletteIndex: 1,
        idempotencyKey: uuid(4),
      }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await storage.load(WORLD_ID))?.localState?.progress.inventory).toBe(2);
    expect(
      (await storage.load(WORLD_ID))?.localMissionState?.instances[0]
        ?.contributions,
    ).toHaveLength(1);
  });

  it("같은 저장소를 쓰는 별도 repository 인스턴스의 슬롯 경쟁도 하나만 성공한다", async () => {
    const fixture = await eligibleRepository(3);
    const secondRepository = new LocalCollaborativeWorldRepository(
      fixture.storage,
      { clock: fixture.clock },
    );
    const mission = (await fixture.repository.getMissionOverview(WORLD_ID))
      .activeMission;
    const results = await Promise.allSettled([
      fixture.repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: mission.id,
        slotIndex: 0,
        paletteIndex: 0,
        idempotencyKey: uuid(40),
      }),
      secondRepository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: mission.id,
        slotIndex: 0,
        paletteIndex: 1,
        idempotencyKey: uuid(41),
      }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const saved = await fixture.storage.load(WORLD_ID);
    expect(saved?.localState?.progress.inventory).toBe(2);
    expect(saved?.localMissionState?.instances[0]?.contributions).toHaveLength(1);
  });

  it("별도 탭의 일반 배치와 미션 기여를 같은 원자 큐에서 직렬화한다", async () => {
    const fixture = await eligibleRepository(2);
    const otherTab = new LocalCollaborativeWorldRepository(fixture.storage, {
      clock: fixture.clock,
    });
    const mission = (await fixture.repository.getMissionOverview(WORLD_ID))
      .activeMission;

    const [placement, contribution] = await Promise.all([
      otherTab.commitWorldActions({
        worldId: WORLD_ID,
        idempotencyKey: uuid(42),
        actions: [
          {
            type: "place",
            blockId: uuid(43),
            position: { x: 20, y: 1, z: 20 },
            kind: "cube",
            rotation: 0,
            colorIndex: 3,
          },
        ],
      }),
      fixture.repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: mission.id,
        slotIndex: 0,
        paletteIndex: 1,
        idempotencyKey: uuid(44),
      }),
    ]);

    const saved = await fixture.storage.load(WORLD_ID);
    expect(placement.progress.inventory + contribution.progress.inventory).toBe(
      1,
    );
    expect(saved?.localState?.progress.inventory).toBe(0);
    expect(saved?.blocks.some(({ id }) => id === uuid(43))).toBe(true);
    expect(saved?.localMissionState?.instances[0]?.contributions).toHaveLength(1);
  });

  it("주변 일반 블록 조회에서는 mission 원본을 제외한다", async () => {
    const fixture = await eligibleRepository(2);
    const snapshot = (await fixture.storage.load(WORLD_ID))!;
    snapshot.blocks.push({
      id: "mission-overview-only",
      worldId: WORLD_ID,
      position: { x: 2, y: 1, z: 2 },
      kind: "light",
      rotation: 0,
      colorIndex: 4,
      owner: { ...OLD_PLAYER },
      zone: "mission",
      createdAt: 0,
    });
    await fixture.storage.save(snapshot);

    const nearby = await fixture.repository.loadNearbyBlocks({
      worldId: WORLD_ID,
      chunkX: 0,
      chunkY: 0,
      chunkZ: 0,
      radius: 0,
      verticalRadius: 0,
    });
    expect(nearby.blocks.some(({ id }) => id === "mission-overview-only")).toBe(
      false,
    );
    expect(nearby.blocks.every(({ zone }) => zone !== "mission")).toBe(true);
  });

  it("신규 seed에는 임시 관문이 없고 기존 고정 샘플만 마이그레이션에서 제거한다", () => {
    const snapshot = createSeedSnapshot(0);
    expect(snapshot.blocks.some(({ zone }) => zone === "mission")).toBe(false);
    snapshot.blocks.push(
      {
        id: "gate-a--3-1--3",
        worldId: WORLD_ID,
        position: { x: -3, y: 1, z: -3 },
        kind: "cube",
        rotation: 0,
        colorIndex: 9,
        owner: {
          id: "sample-dawn",
          publicId: "#M2Q8",
          nickname: "새벽의 수달",
          emblem: "☼",
        },
        zone: "mission",
        createdAt: 0,
      },
      {
        id: "gate-a-user-kept",
        worldId: WORLD_ID,
        position: { x: -4, y: 1, z: -3 },
        kind: "cube",
        rotation: 0,
        colorIndex: 9,
        owner: { ...LOCAL_PLAYER },
        zone: "mission",
        createdAt: 0,
      },
    );

    const prepared = prepareLocalSnapshot(snapshot, 1_000);
    expect(prepared.changed).toBe(true);
    expect(
      prepared.snapshot.blocks.some(({ id }) => id === "gate-a--3-1--3"),
    ).toBe(false);
    expect(
      prepared.snapshot.blocks.some(({ id }) => id === "gate-a-user-kept"),
    ).toBe(true);
  });

  it("재고가 부족하면 슬롯과 재고를 모두 변경하지 않는다", async () => {
    const { repository, storage } = await eligibleRepository(0);
    const mission = (await repository.getMissionOverview(WORLD_ID)).activeMission;

    await expect(
      repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: mission.id,
        slotIndex: 0,
        paletteIndex: 0,
        idempotencyKey: uuid(5),
      }),
    ).rejects.toMatchObject({ code: "insufficient-inventory" });
    const saved = await storage.load(WORLD_ID);
    expect(saved?.localState?.progress.inventory).toBe(0);
    expect(saved?.localMissionState?.instances[0]?.contributions).toHaveLength(0);
  });

  it("6·12·18·24번째 기여에서 25·50·75·100%로 전환하고 다음 층을 하나만 연다", async () => {
    const fixture = await eligibleRepository(36);
    const firstMission = (await fixture.repository.getMissionOverview(WORLD_ID))
      .activeMission;
    const stages: number[] = [];
    let finalResult;
    for (let index = 0; index < 24; index += 1) {
      fixture.clock.current += 1;
      finalResult = await fixture.repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: firstMission.id,
        slotIndex: index,
        paletteIndex: index % 5,
        idempotencyKey: uuid(100 + index),
      });
      if ([5, 11, 17, 23].includes(index)) {
        stages.push(finalResult.mission.stagePercent);
      }
    }

    expect(stages).toEqual([25, 50, 75, 100]);
    expect(finalResult?.mission.status).toBe("completed");
    expect(finalResult?.nextMission?.layer).toBe(2);
    expect(finalResult?.nextMission?.origin.y).toBe(8);
    expect(finalResult?.nextMission?.rotation).toBe(1);
    expect(finalResult?.nextMission?.palette).toEqual([4, 6, 9, 11, 1]);
    const saved = await fixture.storage.load(WORLD_ID);
    expect(saved?.localMissionState?.instances.filter(({ status }) => status === "active"))
      .toHaveLength(1);
    expect(saved?.localMissionState?.instances).toHaveLength(2);
    expect((await fixture.repository.listCompletedMissions(WORLD_ID)).missions)
      .toHaveLength(1);
  });

  it("마지막 슬롯 경쟁에서도 완료와 다음 미션 생성은 정확히 한 번이다", async () => {
    const fixture = await eligibleRepository(36);
    const mission = (await fixture.repository.getMissionOverview(WORLD_ID))
      .activeMission;
    for (let index = 0; index < 23; index += 1) {
      await fixture.repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: mission.id,
        slotIndex: index,
        paletteIndex: 0,
        idempotencyKey: uuid(200 + index),
      });
    }
    const competing = await Promise.allSettled([
      fixture.repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: mission.id,
        slotIndex: 23,
        paletteIndex: 0,
        idempotencyKey: uuid(300),
      }),
      fixture.repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: mission.id,
        slotIndex: 23,
        paletteIndex: 1,
        idempotencyKey: uuid(301),
      }),
    ]);

    expect(competing.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const saved = await fixture.storage.load(WORLD_ID);
    expect(saved?.localMissionState?.instances).toHaveLength(2);
    expect(saved?.localMissionState?.instances.filter(({ status }) => status === "completed"))
      .toHaveLength(1);
    expect(saved?.localMissionState?.instances.filter(({ status }) => status === "active"))
      .toHaveLength(1);
    expect(saved?.localState?.progress.inventory).toBe(12);
  });

  it("완료 당시 닉네임·문양 스냅샷은 이후 공개 프로필이 바뀌어도 보존된다", async () => {
    const fixture = await eligibleRepository(36, OLD_PLAYER);
    const mission = (await fixture.repository.getMissionOverview(WORLD_ID))
      .activeMission;
    for (let index = 0; index < 24; index += 1) {
      await fixture.repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId: mission.id,
        slotIndex: index,
        paletteIndex: 0,
        idempotencyKey: uuid(400 + index),
      });
    }
    const renamedRepository = new LocalCollaborativeWorldRepository(
      fixture.storage,
      {
        clock: fixture.clock,
        player: { ...OLD_PLAYER, nickname: "빛나는 여우", emblem: "◈" },
      },
    );
    const archive = await renamedRepository.listCompletedMissions(WORLD_ID);

    expect(archive.missions[0]?.contributors).toEqual([
      expect.objectContaining({
        publicId: OLD_PLAYER.publicId,
        nickname: OLD_PLAYER.nickname,
        emblem: OLD_PLAYER.emblem,
        contributionCount: 24,
      }),
    ]);
    expect(
      archive.missions[0]?.canonicalBlocks.every(
        ({ creator }) => creator.nickname === OLD_PLAYER.nickname,
      ),
    ).toBe(true);
  });

  it("별도 사용자 B가 A의 공개 신원 스냅샷과 기여 결과를 읽는다", async () => {
    const fixture = await eligibleRepository(2, OLD_PLAYER);
    const mission = (await fixture.repository.getMissionOverview(WORLD_ID))
      .activeMission;
    await fixture.repository.contributeToMission({
      worldId: WORLD_ID,
      missionInstanceId: mission.id,
      slotIndex: 0,
      paletteIndex: 0,
      idempotencyKey: uuid(500),
    });
    const reader = new LocalCollaborativeWorldRepository(fixture.storage, {
      clock: fixture.clock,
      player: {
        id: "reader",
        publicId: "#Q7R4",
        nickname: "푸른 제비",
        emblem: "◇",
      },
    });
    const observed = await reader.getMissionOverview(WORLD_ID);

    expect(observed.activeMission.canonicalBlocks[0]?.creator).toEqual({
      publicId: OLD_PLAYER.publicId,
      nickname: OLD_PLAYER.nickname,
      emblem: OLD_PLAYER.emblem,
    });
    expect(observed.activeMission.myContributionCount).toBe(0);
    expect(observed.activeMission.participantCount).toBe(1);
  });
});

async function eligibleRepository(
  inventory: number,
  player: BlockOwner = LOCAL_PLAYER,
) {
  const storage = new MemoryWorldRepository();
  const snapshot = createSeedSnapshot(0);
  snapshot.localState!.progress = completedProgress(inventory);
  const layout = createStarterBayLayout(snapshot.localState!.baySlotIndex);
  snapshot.blocks.push(
    ...layout.baseGuides.map((guide, index) => guideBlock(guide, index, player)),
    ...layout.producerGuides.map((guide, index) =>
      guideBlock(guide, 100 + index, player),
    ),
  );
  await storage.save(snapshot);
  const clock = new FakeClock();
  const repository = new LocalCollaborativeWorldRepository(storage, {
    clock,
    player,
  });
  return { storage, clock, repository };
}

function completedProgress(inventory: number) {
  return {
    ...createSeedSnapshot(0).localState!.progress,
    initialGrantClaimed: true,
    inventory,
    baseCompleted: true,
    baseCompletedAt: 0,
    producerCompleted: true,
    producerCompletedAt: 0,
    trialRewardClaimed: true,
  };
}

function guideBlock(
  guide: ReturnType<typeof createStarterBayLayout>["guides"][number],
  index: number,
  owner: BlockOwner,
): VoxelBlock {
  return {
    id: `mission-guide-${index}`,
    worldId: WORLD_ID,
    position: { ...guide.position },
    kind: guide.kind,
    rotation: guide.rotation,
    colorIndex: 3,
    owner: { ...owner },
    zone: guide.group === "base" ? "personal" : "producer",
    createdAt: 0,
    source: "onboarding",
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

