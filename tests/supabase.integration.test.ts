import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type {
  CommitWorldActionsRequest,
  WorldAction,
} from "../src/data/CollaborativeWorldRepository";
import { SupabaseRepository } from "../src/data/SupabaseRepository";
import { createStarterBayLayout } from "../src/domain/starterBay";

const WORLD_ID = "00000000-0000-4000-8000-000000000001";
const SUPABASE_URL = process.env.SUPABASE_TEST_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
const integrationEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("로컬 Supabase 실제 RPC 계약", () => {
  it(
    "익명 가입·동시 슬롯·좌표 경쟁·멱등성·권한·서버 시각을 보장한다",
    async () => {
      const url = requiredEnvironment(SUPABASE_URL, "SUPABASE_TEST_URL");
      const anonKey = requiredEnvironment(
        SUPABASE_ANON_KEY,
        "SUPABASE_TEST_ANON_KEY",
      );
      const first = createActor(url, anonKey);
      const second = createActor(url, anonKey);

      const [firstBootstrap, secondBootstrap] = await Promise.all([
        first.bootstrapPlayer(WORLD_ID),
        second.bootstrapPlayer(WORLD_ID),
      ]);

      expect(firstBootstrap.player.id).toBe(firstBootstrap.player.publicId);
      expect(firstBootstrap.player.publicId).toMatch(/^#[A-HJ-NP-Z2-9]{4}$/u);
      expect(secondBootstrap.player.publicId).not.toBe(
        firstBootstrap.player.publicId,
      );
      expect(secondBootstrap.baySlotIndex).not.toBe(
        firstBootstrap.baySlotIndex,
      );
      expect(firstBootstrap.progress.inventory).toBe(24);
      expect(secondBootstrap.progress.inventory).toBe(24);

      const [firstOnboarding, secondOnboarding] = await Promise.all([
        completeOnboarding(first, firstBootstrap.baySlotIndex),
        completeOnboarding(second, secondBootstrap.baySlotIndex),
      ]);
      expect(firstOnboarding.progress.inventory).toBe(2);
      expect(firstOnboarding.progress.trialRewardClaimed).toBe(true);
      expect(secondOnboarding.progress.inventory).toBe(2);
      expect(secondOnboarding.progress.trialRewardClaimed).toBe(true);

      const coordinateBase =
        300 +
        Math.max(
          firstBootstrap.baySlotIndex,
          secondBootstrap.baySlotIndex,
        ) *
          3;
      const sharedPosition = { x: coordinateBase, y: 1, z: 300 };
      const firstCompetition = placementRequest(sharedPosition);
      const secondCompetition = placementRequest(sharedPosition);
      const competition = await Promise.allSettled([
        first.commitWorldActions(firstCompetition),
        second.commitWorldActions(secondCompetition),
      ]);
      expect(competition.filter(({ status }) => status === "fulfilled")).toHaveLength(
        1,
      );
      expect(competition.filter(({ status }) => status === "rejected")).toHaveLength(
        1,
      );

      const winnerIndex = competition.findIndex(
        ({ status }) => status === "fulfilled",
      );
      const winner = winnerIndex === 0 ? first : second;
      const loser = winnerIndex === 0 ? second : first;
      const winningRequest =
        winnerIndex === 0 ? firstCompetition : secondCompetition;
      const replay = await winner.commitWorldActions(winningRequest);
      expect(replay.replayed).toBe(true);
      expect(replay.progress.inventory).toBe(1);
      expect((await loser.bootstrapPlayer(WORLD_ID)).progress.inventory).toBe(2);

      await expect(
        winner.commitWorldActions({
          ...winningRequest,
          actions: [
            {
              ...winningRequest.actions[0]!,
              blockId: crypto.randomUUID(),
              position: { x: coordinateBase + 1, y: 1, z: 300 },
            } as WorldAction,
          ],
        }),
      ).rejects.toMatchObject({ code: "22023" });

      const winnerBootstrap = await winner.bootstrapPlayer(WORLD_ID);
      const winnerBay = createStarterBayLayout(winnerBootstrap.baySlotIndex);
      await expect(
        loser.commitWorldActions(
          placementRequest({
            x: winnerBay.slot.origin.x,
            y: 4,
            z: winnerBay.slot.origin.z,
          }),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect((await loser.bootstrapPlayer(WORLD_ID)).progress.inventory).toBe(2);

      const finalBlock = placementRequest({
        x: coordinateBase + 1,
        y: 1,
        z: 300,
      });
      const depleted = await winner.commitWorldActions(finalBlock);
      expect(depleted.progress.inventory).toBe(0);
      await expect(
        winner.commitWorldActions(
          placementRequest({ x: coordinateBase + 2, y: 1, z: 300 }),
        ),
      ).rejects.toMatchObject({ code: "22023" });
      expect((await winner.bootstrapPlayer(WORLD_ID)).progress.inventory).toBe(0);

      const serverNowBefore = Date.now();
      const settlement = await loser.settleProduction(WORLD_ID);
      expect(settlement.produced).toBe(0);
      expect(settlement.serverNow).toBeGreaterThanOrEqual(serverNowBefore - 5_000);
      expect(settlement.serverNow).toBeLessThanOrEqual(Date.now() + 5_000);

      const session = await loser.startManualProduction(
        WORLD_ID,
        crypto.randomUUID(),
      );
      await expect(
        loser.completeManualProduction(
          WORLD_ID,
          session.id,
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({ code: "22023" });

      const rawClient = createClient(url, anonKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
      const rawSignIn = await rawClient.auth.signInAnonymously();
      expect(rawSignIn.error).toBeNull();
      const directWrite = await rawClient.from("blocks").insert({
        id: crypto.randomUUID(),
        world_id: WORLD_ID,
        x: 0,
        y: 1,
        z: 0,
        kind: "cube",
        rotation: 0,
        color_index: 0,
      });
      expect(directWrite.error).not.toBeNull();

      const manipulatedTimeRpc = await rawClient.rpc(
        "settle_production",
        {
          p_world_id: WORLD_ID,
          p_now: "2099-01-01T00:00:00.000Z",
        } as never,
      );
      expect(manipulatedTimeRpc.error).not.toBeNull();

      const nearby = await loser.loadNearbyBlocks({
        worldId: WORLD_ID,
        chunkX: Math.floor(sharedPosition.x / 16),
        chunkY: Math.floor(sharedPosition.y / 16),
        chunkZ: Math.floor(sharedPosition.z / 16),
        radius: 0,
        verticalRadius: 0,
      });
      const sharedBlock = nearby.blocks.find(
        ({ position }) =>
          position.x === sharedPosition.x &&
          position.y === sharedPosition.y &&
          position.z === sharedPosition.z,
      );
      expect(sharedBlock?.owner.publicId).toMatch(/^#[A-HJ-NP-Z2-9]{4}$/u);
      expect(sharedBlock?.owner.id).toBe(sharedBlock?.owner.publicId);
      const publicProfiles = await loser.getPublicProfiles([
        sharedBlock!.owner.publicId,
      ]);
      expect(publicProfiles).toEqual([sharedBlock!.owner]);
    },
    60_000,
  );

  it(
    "두 익명 사용자의 같은 미션 슬롯 경쟁과 공개 기여 조회를 보장한다",
    async () => {
      const url = requiredEnvironment(SUPABASE_URL, "SUPABASE_TEST_URL");
      const anonKey = requiredEnvironment(
        SUPABASE_ANON_KEY,
        "SUPABASE_TEST_ANON_KEY",
      );
      const first = createActor(url, anonKey);
      const second = createActor(url, anonKey);
      const [firstBootstrap, secondBootstrap] = await Promise.all([
        first.bootstrapPlayer(WORLD_ID),
        second.bootstrapPlayer(WORLD_ID),
      ]);
      await Promise.all([
        completeOnboarding(first, firstBootstrap.baySlotIndex),
        completeOnboarding(second, secondBootstrap.baySlotIndex),
      ]);

      const firstOverview = await first.getMissionOverview(WORLD_ID);
      expect(firstOverview.eligibility).toMatchObject({
        baseBuilt: 16,
        producerBuilt: 8,
        eligible: true,
      });
      const active = firstOverview.activeMission;
      const slotIndex = active.recommendedSlotIndexes[0];
      expect(slotIndex).toBeTypeOf("number");
      const firstRequest = {
        worldId: WORLD_ID,
        missionInstanceId: active.id,
        slotIndex: slotIndex!,
        paletteIndex: 0,
        idempotencyKey: crypto.randomUUID(),
      };
      const secondRequest = {
        ...firstRequest,
        idempotencyKey: crypto.randomUUID(),
      };

      const race = await Promise.allSettled([
        first.contributeToMission(firstRequest),
        second.contributeToMission(secondRequest),
      ]);
      expect(race.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(race.filter(({ status }) => status === "rejected")).toHaveLength(1);

      const winnerIndex = race.findIndex(({ status }) => status === "fulfilled");
      const winner = winnerIndex === 0 ? first : second;
      const loser = winnerIndex === 0 ? second : first;
      const winnerRequest = winnerIndex === 0 ? firstRequest : secondRequest;
      const winnerResult = race[winnerIndex];
      expect(winnerResult?.status).toBe("fulfilled");
      if (!winnerResult || winnerResult.status !== "fulfilled") {
        throw new Error("미션 슬롯 경쟁 승자를 찾지 못했습니다.");
      }

      expect((await winner.bootstrapPlayer(WORLD_ID)).progress.inventory).toBe(1);
      expect((await loser.bootstrapPlayer(WORLD_ID)).progress.inventory).toBe(2);
      const replay = await winner.contributeToMission(winnerRequest);
      expect(replay.replayed).toBe(true);
      expect(replay.progress.inventory).toBe(1);

      const [viewerActive, viewerArchive] = await Promise.all([
        loser.getMissionOverview(WORLD_ID),
        loser.listCompletedMissions(WORLD_ID),
      ]);
      const visibleMissions = [
        viewerActive.activeMission,
        ...viewerArchive.missions,
      ];
      const visibleContribution = visibleMissions
        .flatMap(({ canonicalBlocks }) => canonicalBlocks)
        .find(({ blockId }) => blockId === winnerResult.value.contribution.blockId);
      expect(visibleContribution?.creator).toEqual(
        winnerResult.value.contribution.creator,
      );
      expect(JSON.stringify(visibleMissions)).not.toContain("internal-auth-uid");
    },
    60_000,
  );

  it(
    "자유 모드의 30개 지급·좌표 경쟁·소유자 철거·공개 조회를 보장한다",
    async () => {
      const url = requiredEnvironment(SUPABASE_URL, "SUPABASE_TEST_URL");
      const anonKey = requiredEnvironment(
        SUPABASE_ANON_KEY,
        "SUPABASE_TEST_ANON_KEY",
      );
      const first = createActor(url, anonKey);
      const second = createActor(url, anonKey);
      const [firstOverview, secondOverview] = await Promise.all([
        first.getFreeModeOverview(WORLD_ID),
        second.getFreeModeOverview(WORLD_ID),
      ]);
      expect(firstOverview.progress.inventory).toBe(30);
      expect(secondOverview.progress.inventory).toBe(30);
      expect(firstOverview).toMatchObject({
        maxInventory: 100,
        grantAmount: 5,
        grantIntervalMs: 3_600_000,
        foreignRemovalAgeMs: 259_200_000,
      });

      // Slot 0의 실제 시스템 바닥 중 공용 스폰·통로 보호 영역 밖 좌표.
      const position = { x: 2, y: 1, z: -27 };
      const firstRequest = freePlacementRequest(position);
      const secondRequest = freePlacementRequest(position);
      const race = await Promise.allSettled([
        first.commitFreeModeActions(firstRequest),
        second.commitFreeModeActions(secondRequest),
      ]);
      expect(race.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(race.filter(({ status }) => status === "rejected")).toHaveLength(1);

      const winnerIndex = race.findIndex(({ status }) => status === "fulfilled");
      const winner = winnerIndex === 0 ? first : second;
      const loser = winnerIndex === 0 ? second : first;
      const winnerRequest = winnerIndex === 0 ? firstRequest : secondRequest;
      const winnerResult = race[winnerIndex];
      if (!winnerResult || winnerResult.status !== "fulfilled") {
        throw new Error("자유 모드 좌표 경쟁 승자를 찾지 못했습니다.");
      }
      const blockId = winnerResult.value.upsertedBlocks[0]!.id;
      expect(winnerResult.value.progress.inventory).toBe(29);
      expect(winnerResult.value.upsertedBlocks[0]?.source).toBe("free");
      expect((await loser.getFreeModeOverview(WORLD_ID)).progress.inventory).toBe(
        30,
      );

      const replay = await winner.commitFreeModeActions(winnerRequest);
      expect(replay.replayed).toBe(true);
      expect(replay.progress.inventory).toBe(29);
      await expect(
        loser.commitFreeModeActions({
          worldId: WORLD_ID,
          idempotencyKey: crypto.randomUUID(),
          actions: [{ type: "remove", blockId }],
        }),
      ).rejects.toMatchObject({ code: "P0004" });
      expect((await loser.getFreeModeOverview(WORLD_ID)).progress.inventory).toBe(
        30,
      );

      const visible = await loser.loadNearbyFreeModeBlocks({
        worldId: WORLD_ID,
        chunkX: Math.floor(position.x / 16),
        chunkY: 0,
        chunkZ: Math.floor(position.z / 16),
        radius: 0,
        verticalRadius: 0,
      });
      expect(visible.blocks[0]).toMatchObject({ id: blockId, source: "free" });
      expect(visible.blocks[0]?.owner.id).toBe(
        visible.blocks[0]?.owner.publicId,
      );
      expect(JSON.stringify(visible)).not.toContain("internal-auth-uid");

      const removed = await winner.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: crypto.randomUUID(),
        actions: [{ type: "remove", blockId }],
      });
      expect(removed.removedBlockIds).toEqual([blockId]);
      expect(removed.progress.inventory).toBe(30);
    },
    60_000,
  );
});

function createActor(url: string, anonKey: string): SupabaseRepository {
  const client = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return new SupabaseRepository(client, { worldId: WORLD_ID });
}

async function completeOnboarding(
  repository: SupabaseRepository,
  slotIndex: number,
) {
  const layout = createStarterBayLayout(slotIndex);
  const actions: WorldAction[] = [
    ...layout.baseGuides,
    ...layout.producerGuides,
  ].map((guide) => ({
    type: "place",
    blockId: crypto.randomUUID(),
    position: { ...guide.position },
    kind: guide.kind,
    rotation: guide.rotation,
    colorIndex: 1,
  }));
  expect(actions).toHaveLength(24);
  return repository.commitWorldActions({
    worldId: WORLD_ID,
    idempotencyKey: crypto.randomUUID(),
    actions,
  });
}

function placementRequest(
  position: { x: number; y: number; z: number },
): CommitWorldActionsRequest {
  return {
    worldId: WORLD_ID,
    idempotencyKey: crypto.randomUUID(),
    actions: [
      {
        type: "place",
        blockId: crypto.randomUUID(),
        position,
        kind: "cube",
        rotation: 0,
        colorIndex: 2,
      },
    ],
  };
}

function freePlacementRequest(
  position: { x: number; y: number; z: number },
) {
  return {
    worldId: WORLD_ID,
    idempotencyKey: crypto.randomUUID(),
    actions: [
      {
        type: "place" as const,
        blockId: crypto.randomUUID(),
        position,
        kind: "cube" as const,
        rotation: 0 as const,
        colorIndex: 2,
      },
    ],
  };
}

function requiredEnvironment(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name}이 필요합니다.`);
  }
  return value;
}
