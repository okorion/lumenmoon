import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryRequestError } from "../src/data/CollaborativeWorldRepository";
import { SupabaseRepository } from "../src/data/SupabaseRepository";

const WORLD_ID = "00000000-0000-4000-8000-000000000001";
const BLOCK_ID = "00000000-0000-4000-8000-000000000002";
const COMMIT_ID = "00000000-0000-4000-8000-000000000003";
const SESSION_ID = "00000000-0000-4000-8000-000000000004";
const TICKET_ID = "00000000-0000-4000-8000-000000000005";
const SERVER_NOW = "2026-08-11T06:00:00.000Z";

function progress() {
  return {
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
}

function freeProgress(inventory = 30) {
  return {
    initial_grant_claimed: true,
    inventory,
    last_settled_at: SERVER_NOW,
  };
}

function block() {
  return {
    id: BLOCK_ID,
    world_id: WORLD_ID,
    x: 1,
    y: 2,
    z: 3,
    kind: "cube",
    rotation: 0,
    color_index: 4,
    creator_public_tag: "#A2B3",
    nickname_snapshot: "고요한 여우",
    creator_emblem: "✦",
    zone: "public",
    support_id: null,
    created_at: SERVER_NOW,
  };
}

interface FakeClientOptions {
  anonymous?: boolean;
  handlers?: Readonly<Record<string, unknown>>;
}

function fakeClient(options: FakeClientOptions = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const data = options.handlers?.[name];
    return { data: data ?? null, error: null };
  });
  const user = { id: "internal-auth-uid", is_anonymous: options.anonymous ?? true };
  const client = {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { user } },
        error: null,
      })),
      signInAnonymously: vi.fn(),
    },
    rpc,
  };
  return {
    calls,
    client: client as unknown as SupabaseClient,
  };
}

describe("SupabaseRepository", () => {
  it("모드 선택 전 공개 프로필만 준비한다", async () => {
    const { client, calls } = fakeClient({
      handlers: {
        get_player_identity: {
          profile: {
            public_tag: "#A2B3",
            nickname: "고요한 여우",
            emblem: "✦",
          },
          server_now: SERVER_NOW,
        },
      },
    });
    const repository = new SupabaseRepository(client, { worldId: WORLD_ID });

    const result = await repository.getPlayerIdentity(WORLD_ID);

    expect(result).toEqual({
      player: {
        id: "#A2B3",
        publicId: "#A2B3",
        nickname: "고요한 여우",
        emblem: "✦",
      },
      serverNow: Date.parse(SERVER_NOW),
    });
    expect(JSON.stringify(result)).not.toContain("internal-auth-uid");
    expect(calls).toEqual([
      { name: "get_player_identity", args: { p_world_id: WORLD_ID } },
    ]);
  });

  it("bootstrap 응답에서 auth UID를 제거하고 공개 신원만 반환한다", async () => {
    const { client, calls } = fakeClient({
      handlers: {
        bootstrap_player: {
          profile: {
            public_tag: "#A2B3",
            nickname: "고요한 여우",
            emblem: "✦",
          },
          world: { id: WORLD_ID, slug: "main" },
          progress: { starter_slot: 7, ...progress() },
          server_now: SERVER_NOW,
        },
      },
    });
    const repository = new SupabaseRepository(client, { worldId: WORLD_ID });

    const result = await repository.bootstrapPlayer(WORLD_ID);

    expect(result.player).toEqual({
      id: "#A2B3",
      publicId: "#A2B3",
      nickname: "고요한 여우",
      emblem: "✦",
    });
    expect(JSON.stringify(result)).not.toContain("internal-auth-uid");
    expect(calls).toEqual([
      { name: "bootstrap_player", args: { p_world_id: WORLD_ID } },
    ]);
  });

  it("빈 주변 청크에서도 RPC server_now를 유지한다", async () => {
    const { client } = fakeClient({
      handlers: {
        get_nearby_blocks: {
          blocks: [],
          block_count: 0,
          block_limit: 8192,
          server_now: SERVER_NOW,
        },
      },
    });
    const repository = new SupabaseRepository(client, { worldId: WORLD_ID });

    const result = await repository.loadNearbyBlocks({
      worldId: WORLD_ID,
      chunkX: 2,
      chunkY: 0,
      chunkZ: -1,
      radius: 2,
      verticalRadius: 1,
    });
    expect(result.blocks).toEqual([]);
    expect(result.blockCount).toBe(0);
    expect(result.blockLimit).toBe(8_192);
    expect(result.serverNow).toBe(Date.parse(SERVER_NOW));
  });

  it("자유 모드 RPC를 별도 블록 원본과 엄격한 재고 규칙으로 매핑한다", async () => {
    const freeBlock = { ...block(), source: "free" };
    const overview = {
      world_id: WORLD_ID,
      profile: {
        public_tag: freeBlock.creator_public_tag,
        nickname: freeBlock.nickname_snapshot,
        emblem: freeBlock.creator_emblem,
      },
      progress: freeProgress(),
      max_inventory: 100,
      grant_amount: 5,
      grant_interval_ms: 3_600_000,
      foreign_removal_age_ms: 259_200_000,
      next_grant_in_ms: 1_800_000,
      produced: 0,
      server_now: SERVER_NOW,
    };
    const { client, calls } = fakeClient({
      handlers: {
        get_free_mode_overview: overview,
        settle_free_mode_inventory: overview,
        get_nearby_free_mode_blocks: {
          world_id: WORLD_ID,
          blocks: [freeBlock],
          block_count: 1,
          block_limit: 8_192,
          server_now: SERVER_NOW,
        },
        commit_free_mode_actions: {
          world_id: WORLD_ID,
          idempotency_key: COMMIT_ID,
          upserted_blocks: [freeBlock],
          removed_block_ids: [],
          progress: freeProgress(29),
          server_now: SERVER_NOW,
          replayed: false,
        },
      },
    });
    const repository = new SupabaseRepository(client, { worldId: WORLD_ID });

    const first = await repository.getFreeModeOverview(WORLD_ID);
    const settled = await repository.settleFreeModeInventory(WORLD_ID);
    const nearby = await repository.loadNearbyFreeModeBlocks({
      worldId: WORLD_ID,
      chunkX: 0,
      chunkY: 0,
      chunkZ: 0,
      radius: 1,
      verticalRadius: 1,
    });
    const mutation = await repository.commitFreeModeActions({
      worldId: WORLD_ID,
      idempotencyKey: COMMIT_ID,
      actions: [
        {
          type: "place",
          blockId: BLOCK_ID,
          position: { x: 1, y: 2, z: 3 },
          kind: "cube",
          rotation: 0,
          colorIndex: 4,
        },
      ],
    });

    expect(first).toMatchObject({
      maxInventory: 100,
      grantAmount: 5,
      grantIntervalMs: 3_600_000,
      foreignRemovalAgeMs: 259_200_000,
      nextGrantInMs: 1_800_000,
    });
    expect(settled.progress.inventory).toBe(30);
    expect(nearby.blocks[0]?.source).toBe("free");
    expect(mutation.progress.inventory).toBe(29);
    expect(mutation.upsertedBlocks[0]?.source).toBe("free");
    expect(JSON.stringify({ first, nearby, mutation })).not.toContain(
      "internal-auth-uid",
    );
    expect(calls.map(({ name }) => name)).toEqual([
      "get_free_mode_overview",
      "settle_free_mode_inventory",
      "get_nearby_free_mode_blocks",
      "commit_free_mode_actions",
    ]);
    const action = calls[3]?.args.p_actions as Array<Record<string, unknown>>;
    expect(action[0]).not.toHaveProperty("creator_id");
    expect(action[0]).not.toHaveProperty("created_at");
  });

  it("place 요청에 제작자·구역을 보내지 않고 서버 확정 결과를 매핑한다", async () => {
    const { client, calls } = fakeClient({
      handlers: {
        commit_world_actions: {
          world_id: WORLD_ID,
          idempotency_key: COMMIT_ID,
          upserted_blocks: [block()],
          removed_block_ids: [],
          progress: progress(),
          server_now: SERVER_NOW,
          replayed: false,
        },
      },
    });
    const repository = new SupabaseRepository(client, { worldId: WORLD_ID });
    const result = await repository.commitWorldActions({
      worldId: WORLD_ID,
      idempotencyKey: COMMIT_ID,
      actions: [
        {
          type: "place",
          blockId: BLOCK_ID,
          position: { x: 1, y: 2, z: 3 },
          kind: "cube",
          rotation: 0,
          colorIndex: 4,
        },
      ],
    });

    const action = (
      calls.find(({ name }) => name === "commit_world_actions")!.args
        .p_actions as Array<Record<string, unknown>>
    )[0]!;
    expect(action).not.toHaveProperty("creator_id");
    expect(action).not.toHaveProperty("zone");
    expect(result.upsertedBlocks[0]?.owner.publicId).toBe("#A2B3");
    expect(result.progress.inventory).toBe(24);
  });

  it("수동 생산과 철거 시작에 클라이언트 UUID를 전달한다", async () => {
    const { client, calls } = fakeClient({
      handlers: {
        start_manual_production: {
          session_id: SESSION_ID,
          world_id: WORLD_ID,
          ready_at: "2026-08-11T06:00:15.000Z",
          expires_at: "2026-08-11T06:05:15.000Z",
          progress: progress(),
          server_now: SERVER_NOW,
        },
        start_dismantle: {
          ticket_id: TICKET_ID,
          world_id: WORLD_ID,
          block_id: BLOCK_ID,
          ready_at: "2026-08-11T06:00:02.500Z",
          expires_at: "2026-08-11T06:01:02.500Z",
          server_now: SERVER_NOW,
        },
      },
    });
    const repository = new SupabaseRepository(client, { worldId: WORLD_ID });

    const manualSession = await repository.startManualProduction(
      WORLD_ID,
      SESSION_ID,
    );
    await repository.startDismantle(WORLD_ID, BLOCK_ID, COMMIT_ID);
    await repository.cancelDismantle(WORLD_ID, TICKET_ID);

    expect(manualSession.progress.inventory).toBe(24);

    expect(calls).toContainEqual({
      name: "start_manual_production",
      args: { p_world_id: WORLD_ID, p_session_id: SESSION_ID },
    });
    expect(calls).toContainEqual({
      name: "start_dismantle",
      args: {
        p_world_id: WORLD_ID,
        p_block_id: BLOCK_ID,
        p_idempotency_key: COMMIT_ID,
      },
    });
    expect(calls).toContainEqual({
      name: "cancel_dismantle",
      args: { p_world_id: WORLD_ID, p_ticket_id: TICKET_ID },
    });
  });

  it("비익명 기존 세션과 잘못된 주변 반경을 명시적으로 거부한다", async () => {
    const { client } = fakeClient({ anonymous: false });
    const repository = new SupabaseRepository(client, { worldId: WORLD_ID });

    await expect(repository.bootstrapPlayer(WORLD_ID)).rejects.toMatchObject({
      code: "anonymous-auth-required",
    } satisfies Partial<RepositoryRequestError>);
    await expect(
      repository.loadNearbyBlocks({
        worldId: WORLD_ID,
        chunkX: 0,
        chunkY: 0,
        chunkZ: 0,
        radius: 3,
        verticalRadius: 1,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      repository.loadNearbyBlocks({
        worldId: WORLD_ID,
        chunkX: 0,
        chunkY: 0,
        chunkZ: 0,
        radius: 2,
        verticalRadius: 2,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("주변 응답 상한 초과나 개수 불일치를 잘린 성공으로 허용하지 않는다", async () => {
    const overflow = fakeClient({
      handlers: {
        get_nearby_blocks: {
          blocks: Array.from({ length: 8_193 }, () => null),
          block_count: 8_193,
          block_limit: 8_192,
          server_now: SERVER_NOW,
        },
      },
    });
    const overflowRepository = new SupabaseRepository(overflow.client, {
      worldId: WORLD_ID,
    });
    await expect(
      overflowRepository.loadNearbyBlocks({
        worldId: WORLD_ID,
        chunkX: 0,
        chunkY: 0,
        chunkZ: 0,
        radius: 2,
        verticalRadius: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });

    const mismatch = fakeClient({
      handlers: {
        get_nearby_blocks: {
          blocks: [],
          block_count: 1,
          block_limit: 8_192,
          server_now: SERVER_NOW,
        },
      },
    });
    const mismatchRepository = new SupabaseRepository(mismatch.client, {
      worldId: WORLD_ID,
    });
    await expect(
      mismatchRepository.loadNearbyBlocks({
        worldId: WORLD_ID,
        chunkX: 0,
        chunkY: 0,
        chunkZ: 0,
        radius: 0,
        verticalRadius: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("공개 프로필 조회는 최대 64개 고정 공개 ID만 허용한다", async () => {
    const { client } = fakeClient();
    const repository = new SupabaseRepository(client, { worldId: WORLD_ID });

    await expect(
      repository.getPublicProfiles(Array.from({ length: 65 }, () => "#A2B3")),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      repository.getPublicProfiles(["internal-auth-uid"]),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("응답 유실을 호출부가 같은 키로 재시도할 수 있는 timeout으로 분류한다", async () => {
    const rpc = vi.fn(
      (name: string, args: Record<string, unknown>) => {
        void name;
        void args;
        return new Promise(() => undefined);
      },
    );
    const user = { id: "internal-auth-uid", is_anonymous: true };
    const client = {
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { user } },
          error: null,
        })),
        signInAnonymously: vi.fn(),
      },
      rpc,
    } as unknown as SupabaseClient;
    const repository = new SupabaseRepository(client, {
      worldId: WORLD_ID,
      requestTimeoutMs: 5,
    });
    const request = {
      worldId: WORLD_ID,
      idempotencyKey: COMMIT_ID,
      actions: [
        {
          type: "place" as const,
          blockId: BLOCK_ID,
          position: { x: 1, y: 2, z: 3 },
          kind: "cube" as const,
          rotation: 0 as const,
          colorIndex: 4,
        },
      ],
    };

    const error = await repository
      .commitWorldActions(request)
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "request-timeout",
      retryable: true,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_idempotency_key: COMMIT_ID,
    });
  });

  it("브라우저 네트워크 단절 응답은 원문을 노출하지 않는 retryable 오류로 분류한다", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: "", message: "internal token should stay hidden" },
      status: 0,
    }));
    const user = { id: "internal-auth-uid", is_anonymous: true };
    const client = {
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { user } },
          error: null,
        })),
        signInAnonymously: vi.fn(),
      },
      rpc,
    } as unknown as SupabaseClient;
    const repository = new SupabaseRepository(client, {
      worldId: WORLD_ID,
      requestTimeoutMs: 5,
    });

    const error = await repository
      .loadNearbyBlocks({
        worldId: WORLD_ID,
        chunkX: 0,
        chunkY: 0,
        chunkZ: 0,
        radius: 0,
        verticalRadius: 0,
      })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "remote-error",
      retryable: true,
    });
    expect((error as Error).message).not.toContain("internal-auth-uid");
    expect((error as Error).message).not.toContain("internal token");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
