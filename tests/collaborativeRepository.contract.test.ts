import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { CollaborativeWorldRepository } from "../src/data/CollaborativeWorldRepository";
import { LocalCollaborativeWorldRepository } from "../src/data/LocalCollaborativeWorldRepository";
import { SupabaseRepository } from "../src/data/SupabaseRepository";
import { MemoryWorldRepository } from "../src/data/WorldRepository";
import { WORLD_ID as LOCAL_WORLD_ID } from "../src/domain/types";
import { createStarterBayLayout } from "../src/domain/starterBay";

const ONLINE_WORLD_ID = "00000000-0000-4000-8000-000000000101";
const BLOCK_ID = "00000000-0000-4000-8000-000000000102";
const COMMIT_ID = "00000000-0000-4000-8000-000000000103";
const SERVER_NOW = "2026-08-11T06:00:00.000Z";

interface ContractFixture {
  worldId: string;
  create(): CollaborativeWorldRepository;
  placement: {
    position: { x: number; y: number; z: number };
    kind: "cube" | "stair" | "light";
    rotation: 0 | 1 | 2 | 3;
  };
}

const fixtures: Array<[string, ContractFixture]> = [
  [
    "LocalCollaborativeWorldRepository",
    {
      worldId: LOCAL_WORLD_ID,
      create: () =>
        new LocalCollaborativeWorldRepository(new MemoryWorldRepository()),
      placement: createStarterBayLayout(0).baseGuides[0]!,
    },
  ],
  [
    "SupabaseRepository",
    {
      worldId: ONLINE_WORLD_ID,
      create: () =>
        new SupabaseRepository(fakeOnlineClient(), {
          worldId: ONLINE_WORLD_ID,
        }),
      placement: {
        position: { x: 0, y: 1, z: 0 },
        kind: "cube",
        rotation: 0,
      },
    },
  ],
];

describe.each(fixtures)("공동 저장소 계약: %s", (_name, fixture) => {
  it("bootstrap에서 공개 신원·슬롯·진행 상태만 제공한다", async () => {
    const result = await fixture.create().bootstrapPlayer(fixture.worldId);
    expect(result.worldId).toBe(fixture.worldId);
    expect(result.player.publicId).toMatch(/^#[A-Z0-9]{4}$/u);
    expect(result.player.id).not.toBe("internal-auth-uid");
    expect(result.baySlotIndex).toBeGreaterThanOrEqual(0);
    expect(result.progress.inventory).toBe(24);
    expect(Number.isFinite(result.serverNow)).toBe(true);
  });

  it("주변 청크 읽기를 동일한 블록 결과 계약으로 제공한다", async () => {
    const repository = fixture.create();
    await repository.bootstrapPlayer(fixture.worldId);
    const result = await repository.loadNearbyBlocks({
      worldId: fixture.worldId,
      chunkX: 0,
      chunkY: 0,
      chunkZ: 0,
      radius: 1,
      verticalRadius: 1,
    });
    expect(result.worldId).toBe(fixture.worldId);
    expect(Array.isArray(result.blocks)).toBe(true);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blockCount).toBe(result.blocks.length);
    expect(result.blockLimit).toBe(8_192);
    expect(Number.isFinite(result.serverNow)).toBe(true);
  });

  it("배치 mutation을 동일한 권위 결과 계약으로 제공한다", async () => {
    const repository = fixture.create();
    await repository.bootstrapPlayer(fixture.worldId);
    const result = await repository.commitWorldActions({
      worldId: fixture.worldId,
      idempotencyKey: COMMIT_ID,
      actions: [
        {
          type: "place",
          blockId: BLOCK_ID,
          position: fixture.placement.position,
          kind: fixture.placement.kind,
          rotation: fixture.placement.rotation,
          colorIndex: 1,
        },
      ],
    });
    expect(result.worldId).toBe(fixture.worldId);
    expect(result.idempotencyKey).toBe(COMMIT_ID);
    expect(result.upsertedBlocks).toHaveLength(1);
    expect(result.removedBlockIds).toEqual([]);
    expect(result.progress.inventory).toBe(23);
  });
});

function fakeOnlineClient(): SupabaseClient {
  const progress = {
    initial_grant_claimed: true,
    inventory: 24,
    base_completed: false,
    base_completed_at: null,
    producer_completed: false,
    producer_completed_at: null,
    trial_reward_claimed: false,
    production_level: 1,
    producer_upgrade_completed_at: null,
    last_settled_at: SERVER_NOW,
    manual_production_at: [],
  };
  const handlers: Record<string, unknown> = {
    bootstrap_player: {
      profile: {
        public_tag: "#Q7R4",
        nickname: "고요한 수달",
        emblem: "◆",
      },
      progress: { starter_slot: 2, ...progress },
      server_now: SERVER_NOW,
    },
    get_nearby_blocks: {
      blocks: [
        {
          id: BLOCK_ID,
          world_id: ONLINE_WORLD_ID,
          x: 0,
          y: 1,
          z: 0,
          kind: "cube",
          rotation: 0,
          color_index: 1,
          creator_public_tag: "#Q7R4",
          nickname_snapshot: "고요한 수달",
          creator_emblem: "◆",
          zone: "public",
          created_at: SERVER_NOW,
        },
      ],
      block_count: 1,
      block_limit: 8192,
      server_now: SERVER_NOW,
    },
    commit_world_actions: {
      world_id: ONLINE_WORLD_ID,
      idempotency_key: COMMIT_ID,
      upserted_blocks: [
        {
          id: BLOCK_ID,
          world_id: ONLINE_WORLD_ID,
          x: 0,
          y: 1,
          z: 0,
          kind: "cube",
          rotation: 0,
          color_index: 1,
          creator_public_tag: "#Q7R4",
          nickname_snapshot: "고요한 수달",
          creator_emblem: "◆",
          zone: "personal",
          created_at: SERVER_NOW,
        },
      ],
      removed_block_ids: [],
      progress: { ...progress, inventory: 23 },
      server_now: SERVER_NOW,
      replayed: false,
    },
  };
  return {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            user: { id: "internal-auth-uid", is_anonymous: true },
          },
        },
        error: null,
      }),
      signInAnonymously: async () => ({ data: {}, error: null }),
    },
    rpc: async (name: string) => ({ data: handlers[name] ?? null, error: null }),
  } as unknown as SupabaseClient;
}
