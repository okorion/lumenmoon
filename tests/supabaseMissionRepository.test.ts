import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { SupabaseRepository } from "../src/data/SupabaseRepository";

const WORLD_ID = "00000000-0000-4000-8000-000000000001";
const MISSION_ID = "61000000-0000-4000-8000-000000000001";
const NEXT_MISSION_ID = "61000000-0000-4000-8000-000000000002";
const CONTRIBUTION_ID = "62000000-0000-4000-8000-000000000001";
const BLOCK_ID = "63000000-0000-4000-8000-000000000001";
const ACTION_ID = "64000000-0000-4000-8000-000000000001";
const SERVER_NOW = "2026-08-11T07:00:00.000Z";

function progress(inventory = 2) {
  return {
    initial_grant_claimed: true,
    inventory,
    base_completed: true,
    base_completed_at: "2026-08-11T06:00:00.000Z",
    producer_completed: true,
    producer_completed_at: "2026-08-11T06:00:00.000Z",
    trial_reward_claimed: true,
    production_level: 1,
    producer_upgrade_completed_at: null,
    last_settled_at: SERVER_NOW,
    manual_production_at: [],
  };
}

function contribution() {
  return {
    id: CONTRIBUTION_ID,
    block_id: BLOCK_ID,
    slot_index: 0,
    x: -3,
    y: 1,
    z: 5,
    kind: "cube",
    rotation: 0,
    palette_index: 2,
    color_index: 6,
    creator_public_tag: "#A2B3",
    nickname_snapshot: "고요한 여우",
    creator_emblem: "✦",
    created_at: SERVER_NOW,
    mission_id: MISSION_ID,
    mission_name: "별빛 관문",
    mission_layer: 1,
  };
}

function mission(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: MISSION_ID,
    template_key: "starlight-gate",
    name: "별빛 관문",
    layer: 1,
    origin_x: 0,
    origin_y: 1,
    origin_z: 0,
    rotation: 0,
    palette_seed: 0,
    palette: [1, 4, 6, 9, 11],
    status: "active",
    filled_slots: 1,
    total_slots: 24,
    stage_percent: 0,
    started_at: "2026-08-11T06:00:00.000Z",
    completed_at: null,
    canonical_blocks: [contribution()],
    contributors: [
      {
        creator_public_tag: "#A2B3",
        nickname_snapshot: "고요한 여우",
        creator_emblem: "✦",
        contribution_count: 1,
        first_contributed_at: SERVER_NOW,
        last_contributed_at: SERVER_NOW,
      },
    ],
    recent_contributions: [contribution()],
    my_contribution_count: 1,
    participant_count: 1,
    recommended_slot_indexes: [1, 2, 3],
    ...overrides,
  };
}

function fakeClient(handlers: Readonly<Record<string, unknown>>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: {
            user: { id: "internal-auth-uid", is_anonymous: true },
          },
        },
        error: null,
      })),
      signInAnonymously: vi.fn(),
    },
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: handlers[name] ?? null, error: null };
    }),
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("Supabase 공동 미션 저장소", () => {
  it("활성 미션을 공개 신원과 최대 3개 추천 슬롯으로 매핑한다", async () => {
    const { client } = fakeClient({
      get_mission_overview: {
        active_mission: mission(),
        eligibility: {
          base_built: 16,
          producer_built: 8,
          eligible: true,
        },
        server_now: SERVER_NOW,
      },
    });
    const repository = new SupabaseRepository(client, { worldId: WORLD_ID });

    const result = await repository.getMissionOverview(WORLD_ID);

    expect(result.activeMission.recommendedSlotIndexes).toEqual([1, 2, 3]);
    expect(result.eligibility).toEqual({
      baseBuilt: 16,
      producerBuilt: 8,
      eligible: true,
    });
    expect(result.activeMission.canonicalBlocks[0]).toMatchObject({
      id: CONTRIBUTION_ID,
      blockId: BLOCK_ID,
      paletteIndex: 2,
      colorIndex: 6,
      creator: { publicId: "#A2B3", nickname: "고요한 여우", emblem: "✦" },
    });
    expect(JSON.stringify(result)).not.toContain("internal-auth-uid");
  });

  it("paletteIndex만 RPC에 보내고 서버 확정 재고·다음 층을 적용한다", async () => {
    const completed = mission({
      status: "completed",
      filled_slots: 24,
      stage_percent: 100,
      completed_at: SERVER_NOW,
      canonical_blocks: Array.from({ length: 24 }, (_, index) => ({
        ...contribution(),
        id: `62000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        block_id: `63000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        slot_index: index,
      })),
      recommended_slot_indexes: [],
    });
    const next = mission({
      id: NEXT_MISSION_ID,
      layer: 2,
      origin_y: 8,
      rotation: 1,
      palette_seed: 1,
      filled_slots: 0,
      stage_percent: 0,
      canonical_blocks: [],
      contributors: [],
      recent_contributions: [],
      my_contribution_count: 0,
      participant_count: 0,
      recommended_slot_indexes: [0, 1, 2],
    });
    const { client, calls } = fakeClient({
      contribute_to_mission: {
        mission: completed,
        contribution: contribution(),
        progress: progress(1),
        next_mission: next,
        server_now: SERVER_NOW,
        replayed: false,
      },
    });
    const repository = new SupabaseRepository(client, { worldId: WORLD_ID });

    const result = await repository.contributeToMission({
      worldId: WORLD_ID,
      missionInstanceId: MISSION_ID,
      slotIndex: 0,
      paletteIndex: 2,
      idempotencyKey: ACTION_ID,
    });

    expect(calls).toContainEqual({
      name: "contribute_to_mission",
      args: {
        p_world_id: WORLD_ID,
        p_mission_instance_id: MISSION_ID,
        p_slot_index: 0,
        p_palette_index: 2,
        p_idempotency_key: ACTION_ID,
      },
    });
    expect(result.progress.inventory).toBe(1);
    expect(result.mission.status).toBe("completed");
    expect(result.nextMission?.id).toBe(NEXT_MISSION_ID);
  });

  it("기록관 완료 미션의 모든 기여자 스냅샷을 유지한다", async () => {
    const completed = mission({
      status: "completed",
      completed_at: SERVER_NOW,
      filled_slots: 24,
      stage_percent: 100,
      canonical_blocks: Array.from({ length: 24 }, (_, index) => ({
        ...contribution(),
        id: `62000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        block_id: `63000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        slot_index: index,
      })),
      recommended_slot_indexes: [],
    });
    const { client } = fakeClient({
      list_completed_missions: {
        missions: [completed],
        server_now: SERVER_NOW,
      },
    });
    const repository = new SupabaseRepository(client, { worldId: WORLD_ID });

    const result = await repository.listCompletedMissions(WORLD_ID);

    expect(result.missions).toHaveLength(1);
    expect(result.missions[0]?.contributors).toEqual([
      {
        publicId: "#A2B3",
        nickname: "고요한 여우",
        emblem: "✦",
        contributionCount: 1,
        firstContributedAt: Date.parse(SERVER_NOW),
        lastContributedAt: Date.parse(SERVER_NOW),
      },
    ]);
  });
});

