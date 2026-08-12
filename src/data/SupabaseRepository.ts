import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import type { LocalPlayerProgress } from "../domain/progression";
import {
  FREE_MODE_FOREIGN_REMOVAL_AGE_MS,
  FREE_MODE_GRANT_AMOUNT,
  FREE_MODE_GRANT_INTERVAL_MS,
  FREE_MODE_MAX_INVENTORY,
  type FreeModeProgress,
} from "../domain/freeMode";
import type {
  MissionContribution,
  MissionContributorSummary,
  MissionInstance,
  MissionStagePercent,
  MissionStatus,
} from "../domain/mission";
import type {
  BlockKind,
  BlockOwner,
  BlockRotation,
  GridPosition,
  VoxelBlock,
  ZoneKind,
} from "../domain/types";
import {
  MAX_NEARBY_CHUNK_RADIUS,
  MAX_NEARBY_BLOCKS_PER_RESPONSE,
  MAX_NEARBY_VERTICAL_CHUNK_RADIUS,
  MAX_COMPLETED_MISSIONS_PER_ARCHIVE,
  RepositoryRequestError,
  type CollaborativeWorldRepository,
  type CompletedMissionsResult,
  type CommitFreeModeActionsRequest,
  type CommitWorldActionsRequest,
  type ContributeToMissionRequest,
  type DismantleResult,
  type DismantleTicket,
  type FreeModeMutationResult,
  type FreeModeOverviewResult,
  type ManualProductionSession,
  type MissionContributionResult,
  type MissionOverviewResult,
  type NearbyBlocksRequest,
  type NearbyBlocksResult,
  type PlayerBootstrap,
  type PlayerIdentityResult,
  type ProductionResult,
  type WorldAction,
  type WorldMutationResult,
} from "./CollaborativeWorldRepository";
import {
  validateCommitFreeModeActions,
  validateCommitWorldActions,
} from "./worldActionValidation";

type JsonRecord = Record<string, unknown>;

const ALLOWED_NICKNAMES = new Set(
  ["고요한", "빛나는", "푸른", "따뜻한", "용감한", "느긋한"].flatMap(
    (adjective) =>
      ["여우", "수달", "참새", "고래", "토끼", "사슴"].map(
        (animal) => `${adjective} ${animal}`,
      ),
  ),
);
const ALLOWED_EMBLEMS = new Set(["◆", "●", "▲", "■", "✦", "⬟"]);

export interface SupabaseRepositoryOptions {
  worldId: string;
  /** 테스트에서만 짧게 조정한다. 운영 기본값은 12초다. */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const MAX_CONFIGURED_REQUEST_TIMEOUT_MS = 60_000;

/** 브라우저에는 publishable/anon 키만 전달한다. */
export function createSupabaseRepository(
  url: string,
  anonKey: string,
  options: SupabaseRepositoryOptions,
): SupabaseRepository {
  const client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return new SupabaseRepository(client, options);
}

/**
 * 공개 클라이언트에서 허용되는 변경은 RPC뿐이다. 이 클래스는 table insert,
 * update, delete를 호출하지 않으며 auth UID를 반환값이나 오류에 포함하지 않는다.
 */
export class SupabaseRepository implements CollaborativeWorldRepository {
  readonly mode = "online" as const;

  private readonly client: SupabaseClient;
  private readonly worldId: string;
  private readonly requestTimeoutMs: number;
  private authenticationPromise: Promise<User> | null = null;

  constructor(client: SupabaseClient, options: SupabaseRepositoryOptions) {
    assertUuid(options.worldId, "월드 ID");
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > MAX_CONFIGURED_REQUEST_TIMEOUT_MS
    ) {
      throw new RangeError(
        `Supabase 요청 제한 시간은 1~${MAX_CONFIGURED_REQUEST_TIMEOUT_MS}ms 정수여야 합니다.`,
      );
    }
    this.client = client;
    this.worldId = options.worldId;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async getPlayerIdentity(worldId: string): Promise<PlayerIdentityResult> {
    this.assertWorld(worldId);
    await this.ensureAnonymousUser();
    const root = objectResult(
      await this.rpc("get_player_identity", { p_world_id: worldId }),
      "플레이어 공개 정보",
    );
    return {
      player: parsePublicOwner(nestedRecord(root, ["profile", "player"], root)),
      serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
    };
  }

  async bootstrapPlayer(worldId: string): Promise<PlayerBootstrap> {
    this.assertWorld(worldId);
    await this.ensureAnonymousUser();
    const data = await this.rpc("bootstrap_player", {
      p_world_id: worldId,
    });
    return parseBootstrap(data, worldId);
  }

  async loadNearbyBlocks(
    request: NearbyBlocksRequest,
  ): Promise<NearbyBlocksResult> {
    this.assertWorld(request.worldId);
    assertSafeInteger(request.chunkX, "청크 X");
    assertSafeInteger(request.chunkY, "청크 Y");
    assertSafeInteger(request.chunkZ, "청크 Z");
    if (
      !Number.isSafeInteger(request.radius) ||
      request.radius < 0 ||
      request.radius > MAX_NEARBY_CHUNK_RADIUS
    ) {
      throw new RangeError(
        `주변 청크 반경은 0~${MAX_NEARBY_CHUNK_RADIUS} 정수여야 합니다.`,
      );
    }
    if (
      !Number.isSafeInteger(request.verticalRadius) ||
      request.verticalRadius < 0 ||
      request.verticalRadius > MAX_NEARBY_VERTICAL_CHUNK_RADIUS
    ) {
      throw new RangeError(
        `수직 청크 반경은 0~${MAX_NEARBY_VERTICAL_CHUNK_RADIUS} 정수여야 합니다.`,
      );
    }

    await this.ensureAnonymousUser();
    const data = await this.rpc("get_nearby_blocks", {
      p_world_id: request.worldId,
      p_chunk_x: request.chunkX,
      p_chunk_y: request.chunkY,
      p_chunk_z: request.chunkZ,
      p_radius: request.radius,
      p_vertical_radius: request.verticalRadius,
    });
    return parseNearbyBlocks(data, request.worldId);
  }

  async loadNearbyFreeModeBlocks(
    request: NearbyBlocksRequest,
  ): Promise<NearbyBlocksResult> {
    this.assertWorld(request.worldId);
    validateNearbyRequest(request);
    await this.ensureAnonymousUser();
    const data = await this.rpc("get_nearby_free_mode_blocks", {
      p_world_id: request.worldId,
      p_chunk_x: request.chunkX,
      p_chunk_y: request.chunkY,
      p_chunk_z: request.chunkZ,
      p_radius: request.radius,
      p_vertical_radius: request.verticalRadius,
    });
    return parseNearbyBlocks(data, request.worldId, "free");
  }

  async getPublicProfiles(publicIds: readonly string[]): Promise<BlockOwner[]> {
    if (publicIds.length > 64) {
      throw new RangeError("공개 프로필은 한 번에 최대 64개까지 조회할 수 있습니다.");
    }
    const uniqueIds = [...new Set(publicIds)];
    for (const publicId of uniqueIds) {
      if (!/^#[A-HJ-NP-Z2-9]{4}$/u.test(publicId)) {
        throw new RangeError("공개 ID 형식이 올바르지 않습니다.");
      }
    }
    if (uniqueIds.length === 0) {
      return [];
    }

    await this.ensureAnonymousUser();
    const data = await this.rpc("get_public_profiles", {
      p_public_tags: uniqueIds,
    });
    const root = objectResult(data, "공개 프로필 조회");
    return requiredArray(root, ["profiles"], "공개 프로필").map((item) =>
      parsePublicOwner(requiredRecord(item, "공개 프로필")),
    );
  }

  async commitWorldActions(
    request: CommitWorldActionsRequest,
  ): Promise<WorldMutationResult> {
    this.assertWorld(request.worldId);
    validateCommitWorldActions(request);

    await this.ensureAnonymousUser();
    const data = await this.rpc("commit_world_actions", {
      p_world_id: request.worldId,
      p_idempotency_key: request.idempotencyKey,
      p_actions: request.actions.map(serializeAction),
    });
    return parseMutation(data, request.worldId, request.idempotencyKey);
  }

  async getFreeModeOverview(
    worldId: string,
  ): Promise<FreeModeOverviewResult> {
    this.assertWorld(worldId);
    await this.ensureAnonymousUser();
    const data = await this.rpc("get_free_mode_overview", {
      p_world_id: worldId,
    });
    return parseFreeModeOverview(data, worldId);
  }

  async settleFreeModeInventory(
    worldId: string,
  ): Promise<FreeModeOverviewResult> {
    this.assertWorld(worldId);
    await this.ensureAnonymousUser();
    const data = await this.rpc("settle_free_mode_inventory", {
      p_world_id: worldId,
    });
    return parseFreeModeOverview(data, worldId);
  }

  async commitFreeModeActions(
    request: CommitFreeModeActionsRequest,
  ): Promise<FreeModeMutationResult> {
    this.assertWorld(request.worldId);
    validateCommitFreeModeActions(request);
    await this.ensureAnonymousUser();
    const data = await this.rpc("commit_free_mode_actions", {
      p_world_id: request.worldId,
      p_idempotency_key: request.idempotencyKey,
      p_actions: request.actions.map(serializeAction),
    });
    return parseFreeModeMutation(
      data,
      request.worldId,
      request.idempotencyKey,
    );
  }

  async settleProduction(worldId: string): Promise<ProductionResult> {
    this.assertWorld(worldId);
    await this.ensureAnonymousUser();
    const data = await this.rpc("settle_production", {
      p_world_id: worldId,
    });
    return parseProduction(data, worldId);
  }

  async startManualProduction(
    worldId: string,
    sessionId: string,
  ): Promise<ManualProductionSession> {
    this.assertWorld(worldId);
    assertUuid(sessionId, "수동 생산 세션 ID");
    await this.ensureAnonymousUser();
    const data = await this.rpc("start_manual_production", {
      p_world_id: worldId,
      p_session_id: sessionId,
    });
    const root = objectResult(data, "수동 생산 시작");
    return {
      id: requiredUuid(root, ["session_id", "id"], "수동 생산 세션 ID"),
      worldId: readWorldId(root, worldId),
      readyAt: requiredTimestamp(root, ["ready_at"], "수동 생산 준비 시각"),
      expiresAt: requiredTimestamp(root, ["expires_at"], "수동 생산 만료 시각"),
      serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
      progress: parseProgress(progressRecord(root)),
    };
  }

  async completeManualProduction(
    worldId: string,
    sessionId: string,
    idempotencyKey: string,
  ): Promise<ProductionResult> {
    this.assertWorld(worldId);
    assertUuid(sessionId, "수동 생산 세션 ID");
    assertIdempotencyKey(idempotencyKey);
    await this.ensureAnonymousUser();
    const data = await this.rpc("complete_manual_production", {
      p_world_id: worldId,
      p_session_id: sessionId,
      p_idempotency_key: idempotencyKey,
    });
    return parseProduction(data, worldId, idempotencyKey);
  }

  async startDismantle(
    worldId: string,
    blockId: string,
    idempotencyKey: string,
  ): Promise<DismantleTicket> {
    this.assertWorld(worldId);
    assertUuid(blockId, "블록 ID");
    assertIdempotencyKey(idempotencyKey);
    await this.ensureAnonymousUser();
    const data = await this.rpc("start_dismantle", {
      p_world_id: worldId,
      p_block_id: blockId,
      p_idempotency_key: idempotencyKey,
    });
    const root = objectResult(data, "철거 시작");
    return {
      id: requiredUuid(root, ["ticket_id", "id"], "철거 티켓 ID"),
      worldId: readWorldId(root, worldId),
      blockId: requiredUuid(root, ["block_id"], "블록 ID"),
      readyAt: requiredTimestamp(root, ["ready_at"], "철거 가능 시각"),
      expiresAt: requiredTimestamp(root, ["expires_at"], "철거 만료 시각"),
      serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
    };
  }

  async finishDismantle(
    worldId: string,
    ticketId: string,
    idempotencyKey: string,
  ): Promise<DismantleResult> {
    this.assertWorld(worldId);
    assertUuid(ticketId, "철거 티켓 ID");
    assertIdempotencyKey(idempotencyKey);
    await this.ensureAnonymousUser();
    const data = await this.rpc("finish_dismantle", {
      p_world_id: worldId,
      p_ticket_id: ticketId,
      p_idempotency_key: idempotencyKey,
    });
    const root = objectResult(data, "철거 완료");
    return {
      worldId: readWorldId(root, worldId),
      idempotencyKey: readIdempotencyKey(root, idempotencyKey),
      removedBlockId: requiredUuid(
        root,
        ["removed_block_id", "block_id"],
        "철거한 블록 ID",
      ),
      progress: parseProgress(progressRecord(root)),
      serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
      replayed: optionalBoolean(root, ["replayed"], false),
    };
  }

  async cancelDismantle(worldId: string, ticketId: string): Promise<void> {
    this.assertWorld(worldId);
    assertUuid(ticketId, "철거 티켓 ID");
    await this.ensureAnonymousUser();
    await this.rpc("cancel_dismantle", {
      p_world_id: worldId,
      p_ticket_id: ticketId,
    });
  }

  async getMissionOverview(worldId: string): Promise<MissionOverviewResult> {
    this.assertWorld(worldId);
    await this.ensureAnonymousUser();
    const data = await this.rpc("get_mission_overview", {
      p_world_id: worldId,
    });
    const root = objectResult(data, "공동 미션 조회");
    const eligibility = requiredRecord(
      valueFrom(root, ["eligibility"]),
      "공동 미션 참여 조건",
    );
    return {
      worldId: readWorldId(root, worldId),
      activeMission: parseMissionInstance(
        requiredRecord(
          valueFrom(root, ["active_mission"]),
          "활성 공동 미션",
        ),
        worldId,
      ),
      eligibility: {
        baseBuilt: requiredNonNegativeSafeInteger(
          eligibility,
          ["base_built"],
          "거점 완성 수",
        ),
        producerBuilt: requiredNonNegativeSafeInteger(
          eligibility,
          ["producer_built"],
          "생산시설 완성 수",
        ),
        eligible: requiredBoolean(
          eligibility,
          ["eligible"],
          "공동 미션 참여 가능 여부",
        ),
      },
      serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
    };
  }

  async contributeToMission(
    request: ContributeToMissionRequest,
  ): Promise<MissionContributionResult> {
    this.assertWorld(request.worldId);
    assertUuid(request.missionInstanceId, "공동 미션 ID");
    assertIdempotencyKey(request.idempotencyKey);
    if (
      !Number.isSafeInteger(request.slotIndex) ||
      request.slotIndex < 0 ||
      request.slotIndex > 23
    ) {
      throw new RangeError("공동 미션 슬롯은 0~23 정수여야 합니다.");
    }
    if (
      !Number.isSafeInteger(request.paletteIndex) ||
      request.paletteIndex < 0 ||
      request.paletteIndex > 4
    ) {
      throw new RangeError("공동 미션 팔레트 선택은 0~4 정수여야 합니다.");
    }

    await this.ensureAnonymousUser();
    const data = await this.rpc("contribute_to_mission", {
      p_world_id: request.worldId,
      p_mission_instance_id: request.missionInstanceId,
      p_slot_index: request.slotIndex,
      p_palette_index: request.paletteIndex,
      p_idempotency_key: request.idempotencyKey,
    });
    const root = objectResult(data, "공동 미션 기여");
    const nextValue = valueFrom(root, ["next_mission"]);
    const result: MissionContributionResult = {
      worldId: readWorldId(root, request.worldId),
      idempotencyKey: request.idempotencyKey,
      mission: parseMissionInstance(
        requiredRecord(valueFrom(root, ["mission"]), "기여 미션"),
        request.worldId,
      ),
      contribution: parseMissionContribution(
        requiredRecord(valueFrom(root, ["contribution"]), "확정 기여"),
      ),
      progress: parseProgress(progressRecord(root)),
      serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
      replayed: optionalBoolean(root, ["replayed"], false),
    };
    if (nextValue !== undefined && nextValue !== null) {
      result.nextMission = parseMissionInstance(
        requiredRecord(nextValue, "다음 공동 미션"),
        request.worldId,
      );
    }
    return result;
  }

  async listCompletedMissions(
    worldId: string,
  ): Promise<CompletedMissionsResult> {
    this.assertWorld(worldId);
    await this.ensureAnonymousUser();
    const data = await this.rpc("list_completed_missions", {
      p_world_id: worldId,
    });
    const root = objectResult(data, "공동 미션 기록관");
    const missions = requiredArray(root, ["missions"], "완료 미션 목록");
    if (missions.length > MAX_COMPLETED_MISSIONS_PER_ARCHIVE) {
      throw invalidResponse("완료 미션 목록이 허용된 기록관 상한을 넘었습니다.");
    }
    return {
      worldId: readWorldId(root, worldId),
      missions: missions.map((value) =>
        parseMissionInstance(requiredRecord(value, "완료 미션"), worldId),
      ),
      serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
    };
  }

  private async ensureAnonymousUser(): Promise<User> {
    if (!this.authenticationPromise) {
      this.authenticationPromise = this.authenticate().catch((error: unknown) => {
        this.authenticationPromise = null;
        throw error;
      });
    }
    return this.authenticationPromise;
  }

  private async authenticate(): Promise<User> {
    try {
      return await this.authenticateOnce();
    } catch (error) {
      throw normalizeRequestError(error);
    }
  }

  private async authenticateOnce(): Promise<User> {
    const current = await withRequestTimeout(
      this.client.auth.getSession(),
      this.requestTimeoutMs,
    );
    if (current.error) {
      throw repositoryError("익명 세션을 확인하지 못했습니다.", current.error);
    }
    if (current.data.session?.user) {
      return assertAnonymousUser(current.data.session.user);
    }

    // 익명 가입 자체에는 클라이언트 멱등 키가 없으므로 자동 재시도하지 않는다.
    // 응답 유실 뒤에는 Supabase가 저장한 세션을 다음 bootstrap에서 재사용한다.
    const signedIn = await withRequestTimeout(
      this.client.auth.signInAnonymously(),
      this.requestTimeoutMs,
    );
    if (signedIn.error || !signedIn.data.user) {
      throw repositoryError(
        "익명 계정을 만들지 못했습니다.",
        signedIn.error ?? undefined,
      );
    }
    return assertAnonymousUser(signedIn.data.user);
  }

  private async rpc(
    functionName: string,
    arguments_: JsonRecord,
  ): Promise<unknown> {
    try {
      const controller = new AbortController();
      const rpcRequest = this.client.rpc(functionName, arguments_);
      const result = await withRequestTimeout(
        attachAbortSignal(rpcRequest, controller.signal),
        this.requestTimeoutMs,
        controller,
      );
      if (result.error) {
        throw repositoryError(
          "공동 월드 요청을 처리하지 못했습니다.",
          {
            code: result.error.code,
            status: result.status,
          },
        );
      }
      return result.data;
    } catch (error) {
      // 멱등 mutation 재시도는 호출부가 원래 action/key를 보존해 한 번만 수행한다.
      throw normalizeRequestError(error);
    }
  }

  private assertWorld(worldId: string): void {
    if (worldId !== this.worldId) {
      throw new RepositoryRequestError("설정된 공동 월드와 다른 월드입니다.", {
        code: "world-mismatch",
      });
    }
  }
}

function parseBootstrap(data: unknown, worldId: string): PlayerBootstrap {
  const root = objectResult(data, "플레이어 초기화");
  const worldValue = valueFrom(root, ["world"]);
  if (worldValue !== undefined) {
    const responseWorld = requiredRecord(worldValue, "월드");
    const responseWorldId = requiredUuid(responseWorld, ["id"], "응답 월드 ID");
    if (responseWorldId !== worldId) {
      throw invalidResponse("응답 월드가 요청 월드와 다릅니다.");
    }
  }
  const profile = nestedRecord(root, ["profile", "player"], root);
  const state = nestedRecord(
    root,
    ["player_world_state", "world_state", "state", "progress"],
    root,
  );
  return {
    worldId: readWorldId(root, worldId),
    player: parsePublicOwner(profile),
    baySlotIndex: requiredSafeInteger(
      state,
      ["bay_slot_index", "starter_slot", "starter_slot_index"],
      "스타터 슬롯",
    ),
    progress: parseProgress(progressRecord(state)),
    serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
  };
}

function parseNearbyBlocks(
  data: unknown,
  worldId: string,
  expectedSource?: "free",
): NearbyBlocksResult {
  const root = objectResult(data, "주변 블록 조회");
  const rawBlocks = requiredArray(root, ["blocks"], "블록 목록");
  const blockCount = requiredNonNegativeSafeInteger(
    root,
    ["block_count"],
    "주변 블록 수",
  );
  const blockLimit = requiredPositiveSafeInteger(
    root,
    ["block_limit"],
    "주변 블록 상한",
  );
  if (
    blockLimit !== MAX_NEARBY_BLOCKS_PER_RESPONSE ||
    blockCount !== rawBlocks.length ||
    blockCount > blockLimit
  ) {
    throw invalidResponse("주변 블록 응답의 개수 또는 상한이 올바르지 않습니다.");
  }
  const blocks = rawBlocks.map((item) =>
    parseBlock(requiredRecord(item, "블록"), worldId, expectedSource),
  );
  return {
    worldId: readWorldId(root, worldId),
    blocks,
    blockCount,
    blockLimit,
    serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
  };
}

function parseFreeModeOverview(
  data: unknown,
  worldId: string,
): FreeModeOverviewResult {
  const root = objectResult(data, "자유 모드 조회");
  const progress = parseFreeModeProgress(progressRecord(root));
  const maxInventory = requiredPositiveSafeInteger(
    root,
    ["max_inventory", "maxInventory"],
    "자유 모드 최대 재고",
  );
  const grantAmount = requiredPositiveSafeInteger(
    root,
    ["grant_amount", "grantAmount"],
    "자유 모드 지급량",
  );
  const grantIntervalMs = requiredPositiveSafeInteger(
    root,
    ["grant_interval_ms", "grantIntervalMs"],
    "자유 모드 지급 간격",
  );
  const foreignRemovalAgeMs = requiredPositiveSafeInteger(
    root,
    ["foreign_removal_age_ms", "foreignRemovalAgeMs"],
    "타인 블록 보호 시간",
  );
  if (
    maxInventory !== FREE_MODE_MAX_INVENTORY ||
    grantAmount !== FREE_MODE_GRANT_AMOUNT ||
    grantIntervalMs !== FREE_MODE_GRANT_INTERVAL_MS ||
    foreignRemovalAgeMs !== FREE_MODE_FOREIGN_REMOVAL_AGE_MS
  ) {
    throw invalidResponse("자유 모드 규칙이 클라이언트 계약과 다릅니다.");
  }
  const nextGrantValue = valueFrom(root, [
    "next_grant_in_ms",
    "nextGrantInMs",
  ]);
  let nextGrantInMs: number | null;
  if (nextGrantValue === null) {
    nextGrantInMs = null;
  } else if (
    typeof nextGrantValue === "number" &&
    Number.isSafeInteger(nextGrantValue) &&
    nextGrantValue >= 0 &&
    nextGrantValue <= FREE_MODE_GRANT_INTERVAL_MS
  ) {
    nextGrantInMs = nextGrantValue;
  } else {
    throw invalidResponse("다음 자유 모드 지급 시간 형식이 올바르지 않습니다.");
  }
  return {
    worldId: readWorldId(root, worldId),
    player: parsePublicOwner(nestedRecord(root, ["profile", "player"], root)),
    progress,
    maxInventory,
    grantAmount,
    grantIntervalMs,
    foreignRemovalAgeMs,
    nextGrantInMs,
    produced: requiredNonNegativeSafeInteger(
      root,
      ["produced"],
      "자유 모드 지급 수",
    ),
    serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
  };
}

function parseFreeModeMutation(
  data: unknown,
  worldId: string,
  idempotencyKey: string,
): FreeModeMutationResult {
  const root = objectResult(data, "자유 모드 변경");
  return {
    worldId: readWorldId(root, worldId),
    idempotencyKey: readIdempotencyKey(root, idempotencyKey),
    upsertedBlocks: requiredArray(
      root,
      ["upserted_blocks"],
      "확정된 자유 모드 블록",
    ).map((item) =>
      parseBlock(requiredRecord(item, "자유 모드 블록"), worldId, "free"),
    ),
    removedBlockIds: optionalArray(root, ["removed_block_ids"]).map(
      (item) => {
        if (typeof item !== "string") {
          throw invalidResponse("제거된 자유 모드 블록 ID가 올바르지 않습니다.");
        }
        assertUuid(item, "제거된 자유 모드 블록 ID");
        return item;
      },
    ),
    progress: parseFreeModeProgress(progressRecord(root)),
    serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
    replayed: optionalBoolean(root, ["replayed"], false),
  };
}

function parseMutation(
  data: unknown,
  worldId: string,
  idempotencyKey: string,
): WorldMutationResult {
  const root = objectResult(data, "월드 변경");
  return {
    worldId: readWorldId(root, worldId),
    idempotencyKey: readIdempotencyKey(root, idempotencyKey),
    upsertedBlocks: requiredArray(
      root,
      ["upserted_blocks", "blocks", "changed_blocks"],
      "확정 블록",
    ).map((item) => parseBlock(requiredRecord(item, "블록"), worldId)),
    removedBlockIds: optionalArray(root, ["removed_block_ids"]).map((item) => {
      if (typeof item !== "string") {
        throw invalidResponse("제거 블록 ID 응답 형식이 올바르지 않습니다.");
      }
      assertUuid(item, "제거 블록 ID");
      return item;
    }),
    progress: parseProgress(progressRecord(root)),
    serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
    replayed: optionalBoolean(root, ["replayed"], false),
  };
}

function parseProduction(
  data: unknown,
  worldId: string,
  idempotencyKey?: string,
): ProductionResult {
  const root = objectResult(data, "생산 정산");
  const response: ProductionResult = {
    worldId: readWorldId(root, worldId),
    progress: parseProgress(progressRecord(root)),
    produced: requiredSafeInteger(root, ["produced"], "생산량"),
    serverNow: requiredTimestamp(root, ["server_now"], "서버 시각"),
  };
  if (idempotencyKey) {
    response.idempotencyKey = readIdempotencyKey(root, idempotencyKey);
    response.replayed = optionalBoolean(root, ["replayed"], false);
  }
  return response;
}

function parseMissionInstance(
  record: JsonRecord,
  worldId: string,
): MissionInstance {
  const id = requiredUuid(record, ["id"], "공동 미션 ID");
  const status = parseMissionStatus(
    requiredString(record, ["status"], "공동 미션 상태"),
  );
  const filledSlots = requiredSafeInteger(
    record,
    ["filled_slots"],
    "확정 슬롯 수",
  );
  const totalSlots = requiredSafeInteger(
    record,
    ["total_slots"],
    "전체 슬롯 수",
  );
  const stagePercent = parseMissionStage(
    requiredSafeInteger(record, ["stage_percent"], "공동 미션 단계"),
  );
  const palette = requiredArray(record, ["palette"], "미션 팔레트").map(
    (value) => parsePaletteColorIndex(value),
  );
  const canonicalBlocks = requiredArray(
    record,
    ["canonical_blocks"],
    "정규 미션 블록",
  ).map((value) =>
    parseMissionContribution(requiredRecord(value, "정규 미션 블록")),
  );
  const contributors = requiredArray(
    record,
    ["contributors"],
    "미션 기여자",
  ).map((value) =>
    parseMissionContributor(requiredRecord(value, "미션 기여자")),
  );
  const recentContributions = requiredArray(
    record,
    ["recent_contributions"],
    "최근 미션 기여",
  ).map((value) =>
    parseMissionContribution(requiredRecord(value, "최근 미션 기여")),
  );
  const recommendedSlotIndexes = requiredArray(
    record,
    ["recommended_slot_indexes"],
    "추천 미션 슬롯",
  ).map((value) => parseMissionSlotIndex(value));

  if (
    totalSlots !== 24 ||
    filledSlots < 0 ||
    filledSlots > totalSlots ||
    canonicalBlocks.length !== filledSlots
  ) {
    throw invalidResponse("공동 미션 슬롯 집계가 올바르지 않습니다.");
  }
  if (palette.length !== 5 || new Set(palette).size !== palette.length) {
    throw invalidResponse("공동 미션 팔레트는 서로 다른 5색이어야 합니다.");
  }
  if (
    recommendedSlotIndexes.length > 3 ||
    new Set(recommendedSlotIndexes).size !== recommendedSlotIndexes.length
  ) {
    throw invalidResponse("추천 미션 슬롯 응답이 올바르지 않습니다.");
  }
  if (
    canonicalBlocks.some(
      (contribution) =>
        contribution.missionId !== id ||
        contribution.missionLayer !==
          requiredSafeInteger(record, ["layer"], "미션 층"),
    )
  ) {
    throw invalidResponse("정규 블록의 미션 연결이 올바르지 않습니다.");
  }

  const completedAt = nullableTimestamp(
    record,
    ["completed_at"],
    "미션 완료 시각",
  );
  if (
    (status === "active" && completedAt !== null) ||
    (status === "completed" && completedAt === null)
  ) {
    throw invalidResponse("공동 미션 완료 상태가 올바르지 않습니다.");
  }

  return {
    id,
    worldId,
    templateKey: requiredString(
      record,
      ["template_key"],
      "미션 템플릿 키",
    ),
    name: requiredString(record, ["name"], "미션 이름"),
    layer: requiredPositiveSafeInteger(record, ["layer"], "미션 층"),
    origin: {
      x: requiredSafeInteger(record, ["origin_x"], "미션 원점 X"),
      y: requiredSafeInteger(record, ["origin_y"], "미션 원점 Y"),
      z: requiredSafeInteger(record, ["origin_z"], "미션 원점 Z"),
    },
    rotation: parseRotation(
      requiredSafeInteger(record, ["rotation"], "미션 회전"),
    ),
    paletteSeed: requiredSafeInteger(
      record,
      ["palette_seed"],
      "미션 팔레트 시드",
    ),
    palette,
    status,
    startedAt: requiredTimestamp(record, ["started_at"], "미션 시작 시각"),
    completedAt,
    filledSlots,
    totalSlots,
    stagePercent,
    canonicalBlocks,
    contributors,
    recentContributions,
    myContributionCount: requiredNonNegativeSafeInteger(
      record,
      ["my_contribution_count"],
      "내 기여 수",
    ),
    participantCount: requiredNonNegativeSafeInteger(
      record,
      ["participant_count"],
      "전체 참여자 수",
    ),
    recommendedSlotIndexes,
  };
}

function parseMissionContribution(record: JsonRecord): MissionContribution {
  const creator = parsePublicOwner({
    public_id: valueFrom(record, ["creator_public_tag"]),
    nickname: valueFrom(record, ["nickname_snapshot"]),
    emblem: valueFrom(record, ["creator_emblem"]),
  });
  const slotIndex = parseMissionSlotIndex(valueFrom(record, ["slot_index"]));
  const colorIndex = parsePaletteColorIndex(
    valueFrom(record, ["color_index"]),
  );
  const paletteIndex = parseMissionPaletteIndex(
    valueFrom(record, ["palette_index"]),
  );
  return {
    id: requiredUuid(record, ["id"], "미션 기여 ID"),
    blockId: requiredUuid(record, ["block_id"], "미션 블록 ID"),
    missionId: requiredUuid(record, ["mission_id"], "공동 미션 ID"),
    missionName: requiredString(record, ["mission_name"], "미션 이름"),
    missionLayer: requiredPositiveSafeInteger(
      record,
      ["mission_layer"],
      "미션 층",
    ),
    slotIndex,
    position: parsePosition(record),
    kind: parseBlockKind(
      requiredString(record, ["kind"], "미션 블록 종류"),
    ),
    rotation: parseRotation(
      requiredSafeInteger(record, ["rotation"], "미션 블록 회전"),
    ),
    paletteIndex,
    colorIndex,
    creator: {
      publicId: creator.publicId,
      nickname: creator.nickname,
      emblem: creator.emblem,
    },
    createdAt: requiredTimestamp(record, ["created_at"], "미션 설치 시각"),
  };
}

function parseMissionContributor(
  record: JsonRecord,
): MissionContributorSummary {
  const owner = parsePublicOwner({
    public_id: valueFrom(record, ["creator_public_tag"]),
    nickname: valueFrom(record, ["nickname_snapshot"]),
    emblem: valueFrom(record, ["creator_emblem"]),
  });
  const firstContributedAt = requiredTimestamp(
    record,
    ["first_contributed_at"],
    "최초 기여 시각",
  );
  const lastContributedAt = requiredTimestamp(
    record,
    ["last_contributed_at"],
    "최근 기여 시각",
  );
  if (lastContributedAt < firstContributedAt) {
    throw invalidResponse("기여자 시각 순서가 올바르지 않습니다.");
  }
  return {
    publicId: owner.publicId,
    nickname: owner.nickname,
    emblem: owner.emblem,
    contributionCount: requiredPositiveSafeInteger(
      record,
      ["contribution_count"],
      "기여 수",
    ),
    firstContributedAt,
    lastContributedAt,
  };
}

function parseMissionSlotIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidResponse("미션 슬롯 번호가 안전한 정수가 아닙니다.");
  }
  if (value < 0 || value > 23) {
    throw invalidResponse("미션 슬롯 번호가 허용 범위를 벗어났습니다.");
  }
  return value;
}

function parsePaletteColorIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidResponse("미션 색상 번호가 안전한 정수가 아닙니다.");
  }
  if (value < 0 || value > 11) {
    throw invalidResponse("미션 색상 번호가 허용 범위를 벗어났습니다.");
  }
  return value;
}

function parseMissionPaletteIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidResponse("미션 팔레트 선택이 안전한 정수가 아닙니다.");
  }
  if (value < 0 || value > 4) {
    throw invalidResponse("미션 팔레트 선택이 허용 범위를 벗어났습니다.");
  }
  return value;
}

function parseMissionStatus(value: string): MissionStatus {
  if (value !== "active" && value !== "completed") {
    throw invalidResponse("알 수 없는 공동 미션 상태입니다.");
  }
  return value;
}

function parseMissionStage(value: number): MissionStagePercent {
  if (value !== 0 && value !== 25 && value !== 50 && value !== 75 && value !== 100) {
    throw invalidResponse("알 수 없는 공동 미션 단계입니다.");
  }
  return value;
}

function parseBlock(
  record: JsonRecord,
  fallbackWorldId: string,
  expectedSource?: "free",
): VoxelBlock {
  const positionRecord = nestedRecord(record, ["position"], record);
  const ownerRecord = nestedRecord(record, ["owner", "creator"], record);
  const publicIdValue =
    valueFrom(record, [
      "creator_public_id",
      "creator_public_tag",
      "public_id",
      "public_tag",
      "creator_tag",
    ]) ?? valueFrom(ownerRecord, ["public_id", "public_tag"]);
  if (typeof publicIdValue !== "string" || publicIdValue.length === 0) {
    throw invalidResponse("제작자 공개 ID가 없습니다.");
  }
  const publicId = publicIdValue;
  const owner = parsePublicOwner({
    ...ownerRecord,
    public_id: valueFrom(ownerRecord, ["public_id", "public_tag"]) ?? publicId,
    nickname:
      valueFrom(record, ["nickname_snapshot", "creator_nickname"]) ??
      valueFrom(ownerRecord, ["nickname"]),
    emblem:
      valueFrom(record, ["creator_emblem", "emblem_snapshot"]) ??
      valueFrom(ownerRecord, ["emblem"]),
  });
  const kind = requiredString(record, ["kind", "block_kind"], "블록 종류");
  const zone = requiredString(record, ["zone", "zone_kind"], "블록 구역");
  const rotation = requiredSafeInteger(record, ["rotation"], "블록 회전");
  const supportId = optionalString(record, ["support_id", "supportId"]);
  const colorIndex = requiredSafeInteger(
    record,
    ["color_index", "colorIndex"],
    "색상 번호",
  );
  if (colorIndex < 0 || colorIndex > 11) {
    throw invalidResponse("색상 번호가 허용 범위를 벗어났습니다.");
  }
  const source = optionalString(record, ["source"]);
  if (expectedSource && source !== expectedSource) {
    throw invalidResponse("자유 모드 블록 출처가 올바르지 않습니다.");
  }
  const block: VoxelBlock = {
    id: requiredUuid(record, ["id", "block_id"], "블록 ID"),
    worldId: readWorldId(record, fallbackWorldId),
    position: parsePosition(positionRecord),
    kind: parseBlockKind(kind),
    rotation: parseRotation(rotation),
    colorIndex,
    owner,
    zone: parseZone(zone),
    createdAt: requiredTimestamp(
      record,
      ["created_at", "createdAt"],
      "생성 시각",
    ),
  };
  if (supportId) {
    assertUuid(supportId, "지지 블록 ID");
    block.supportId = supportId;
  }
  if (expectedSource) {
    block.source = expectedSource;
  }
  return block;
}

function parsePublicOwner(record: JsonRecord): BlockOwner {
  const publicId = requiredString(
    record,
    ["public_id", "public_tag", "creator_public_id"],
    "공개 ID",
  );
  if (!/^#[A-HJ-NP-Z2-9]{4}$/u.test(publicId)) {
    throw invalidResponse("공개 ID 형식이 올바르지 않습니다.");
  }
  const nickname = requiredString(
    record,
    ["nickname", "nickname_snapshot", "creator_nickname"],
    "닉네임",
  );
  const emblem = requiredString(
    record,
    ["emblem", "emblem_snapshot", "creator_emblem"],
    "문양",
  );
  if (!ALLOWED_NICKNAMES.has(nickname) || !ALLOWED_EMBLEMS.has(emblem)) {
    throw invalidResponse("공개 프로필 필드가 허용 목록에 없습니다.");
  }
  return {
    // 내부 auth UID 대신 고유 공개 태그를 클라이언트 소유자 식별자로 사용한다.
    id: publicId,
    publicId,
    nickname,
    emblem,
  };
}

function parseProgress(record: JsonRecord): LocalPlayerProgress {
  const manualProductionAt = optionalArray(
    record,
    ["manual_production_at", "manualProductionAt"],
  ).map((item) => timestampValue(item, "수동 생산 시각"));
  const inventory = requiredSafeInteger(record, ["inventory"], "재고");
  if (inventory < 0 || inventory > 36) {
    throw invalidResponse("재고가 허용 범위를 벗어났습니다.");
  }
  return {
    initialGrantClaimed: requiredBoolean(
      record,
      ["initial_grant_claimed", "initialGrantClaimed"],
      "최초 지급 상태",
    ),
    inventory,
    baseCompleted: requiredBoolean(
      record,
      ["base_completed", "baseCompleted"],
      "거점 완성 상태",
    ),
    baseCompletedAt: nullableTimestamp(
      record,
      ["base_completed_at", "baseCompletedAt"],
      "거점 완성 시각",
    ),
    producerCompleted: requiredBoolean(
      record,
      ["producer_completed", "producerCompleted"],
      "생산시설 완성 상태",
    ),
    producerCompletedAt: nullableTimestamp(
      record,
      ["producer_completed_at", "producerCompletedAt"],
      "생산시설 완성 시각",
    ),
    trialRewardClaimed: requiredBoolean(
      record,
      ["trial_reward_claimed", "trialRewardClaimed"],
      "시운전 보상 상태",
    ),
    productionLevel: parseProductionLevel(
      requiredSafeInteger(
        record,
        ["production_level", "productionLevel"],
        "생산 레벨",
      ),
    ),
    producerUpgradeCompletedAt: nullableTimestamp(
      record,
      ["producer_upgrade_completed_at", "producerUpgradeCompletedAt"],
      "생산시설 업그레이드 시각",
    ),
    lastSettledAt: requiredTimestamp(
      record,
      ["last_settled_at", "lastSettledAt"],
      "최근 생산 정산 시각",
    ),
    manualProductionAt,
  };
}

function parseFreeModeProgress(record: JsonRecord): FreeModeProgress {
  const inventory = requiredSafeInteger(record, ["inventory"], "자유 모드 재고");
  if (inventory < 0 || inventory > FREE_MODE_MAX_INVENTORY) {
    throw invalidResponse("자유 모드 재고가 허용 범위를 벗어났습니다.");
  }
  return {
    initialGrantClaimed: requiredBoolean(
      record,
      ["initial_grant_claimed", "initialGrantClaimed"],
      "자유 모드 최초 지급 상태",
    ),
    inventory,
    lastSettledAt: requiredTimestamp(
      record,
      ["last_settled_at", "lastSettledAt"],
      "자유 모드 최근 정산 시각",
    ),
  };
}

function serializeAction(action: WorldAction): JsonRecord {
  if (action.type === "reset_onboarding") {
    return { type: action.type };
  }
  if (action.type === "remove") {
    return {
      type: action.type,
      block_id: action.blockId,
    };
  }
  return {
    type: action.type,
    block_id: action.blockId,
    x: action.position.x,
    y: action.position.y,
    z: action.position.z,
    kind: action.kind,
    rotation: action.rotation,
    color_index: action.colorIndex,
    support_id: action.supportId ?? null,
  };
}

function parsePosition(record: JsonRecord): GridPosition {
  const position = {
    x: requiredSafeInteger(record, ["x"], "블록 X"),
    y: requiredSafeInteger(record, ["y"], "블록 Y"),
    z: requiredSafeInteger(record, ["z"], "블록 Z"),
  };
  validatePosition(position);
  return position;
}

function validatePosition(position: GridPosition): void {
  assertSafeInteger(position.x, "블록 X");
  assertSafeInteger(position.y, "블록 Y");
  assertSafeInteger(position.z, "블록 Z");
}

function validateNearbyRequest(request: NearbyBlocksRequest): void {
  assertSafeInteger(request.chunkX, "청크 X");
  assertSafeInteger(request.chunkY, "청크 Y");
  assertSafeInteger(request.chunkZ, "청크 Z");
  if (
    !Number.isSafeInteger(request.radius) ||
    request.radius < 0 ||
    request.radius > MAX_NEARBY_CHUNK_RADIUS
  ) {
    throw new RangeError(
      `주변 청크 반경은 0~${MAX_NEARBY_CHUNK_RADIUS} 정수여야 합니다.`,
    );
  }
  if (
    !Number.isSafeInteger(request.verticalRadius) ||
    request.verticalRadius < 0 ||
    request.verticalRadius > MAX_NEARBY_VERTICAL_CHUNK_RADIUS
  ) {
    throw new RangeError(
      `수직 청크 반경은 0~${MAX_NEARBY_VERTICAL_CHUNK_RADIUS} 정수여야 합니다.`,
    );
  }
}

function parseBlockKind(value: string): BlockKind {
  if (value !== "cube" && value !== "stair" && value !== "light") {
    throw invalidResponse("알 수 없는 블록 종류입니다.");
  }
  return value;
}

function parseRotation(value: number): BlockRotation {
  if (value !== 0 && value !== 1 && value !== 2 && value !== 3) {
    throw invalidResponse("알 수 없는 블록 회전입니다.");
  }
  return value;
}

function parseZone(value: string): ZoneKind {
  if (
    value !== "system" &&
    value !== "personal" &&
    value !== "producer" &&
    value !== "public" &&
    value !== "mission"
  ) {
    throw invalidResponse("알 수 없는 블록 구역입니다.");
  }
  return value;
}

function parseProductionLevel(value: number): 1 | 2 {
  if (value !== 1 && value !== 2) {
    throw invalidResponse("알 수 없는 생산 레벨입니다.");
  }
  return value;
}

function progressRecord(root: JsonRecord): JsonRecord {
  return nestedRecord(
    root,
    ["progress", "player_world_state", "world_state", "state"],
    root,
  );
}

function objectResult(data: unknown, label: string): JsonRecord {
  if (Array.isArray(data)) {
    if (data.length !== 1) {
      throw invalidResponse(`${label} 응답 행 수가 올바르지 않습니다.`);
    }
    return requiredRecord(data[0], label);
  }
  return requiredRecord(data, label);
}

function requiredRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse(`${label} 응답 형식이 올바르지 않습니다.`);
  }
  return value as JsonRecord;
}

function nestedRecord(
  record: JsonRecord,
  keys: readonly string[],
  fallback: JsonRecord,
): JsonRecord {
  const value = valueFrom(record, keys);
  return value === undefined ? fallback : requiredRecord(value, keys[0] ?? "객체");
}

function readWorldId(record: JsonRecord, fallback: string): string {
  const value = optionalString(record, ["world_id", "worldId"]);
  if (!value) {
    return fallback;
  }
  assertUuid(value, "월드 ID");
  if (value !== fallback) {
    throw invalidResponse("응답 월드가 요청 월드와 다릅니다.");
  }
  return value;
}

function readIdempotencyKey(record: JsonRecord, fallback: string): string {
  const value = optionalString(record, ["idempotency_key", "idempotencyKey"]);
  if (!value) {
    return fallback;
  }
  if (value !== fallback) {
    throw invalidResponse("응답 멱등 키가 요청과 다릅니다.");
  }
  return value;
}

function requiredArray(
  record: JsonRecord,
  keys: readonly string[],
  label: string,
): unknown[] {
  const value = valueFrom(record, keys);
  if (!Array.isArray(value)) {
    throw invalidResponse(`${label} 응답 형식이 올바르지 않습니다.`);
  }
  return value;
}

function optionalArray(record: JsonRecord, keys: readonly string[]): unknown[] {
  const value = valueFrom(record, keys);
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidResponse(`${keys[0] ?? "배열"} 응답 형식이 올바르지 않습니다.`);
  }
  return value;
}

function requiredString(
  record: JsonRecord,
  keys: readonly string[],
  label: string,
): string {
  const value = valueFrom(record, keys);
  if (typeof value !== "string" || value.length === 0) {
    throw invalidResponse(`${label}이(가) 없습니다.`);
  }
  return value;
}

function optionalString(
  record: JsonRecord,
  keys: readonly string[],
): string | undefined {
  const value = valueFrom(record, keys);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw invalidResponse(`${keys[0] ?? "문자열"} 응답 형식이 올바르지 않습니다.`);
  }
  return value;
}

function requiredUuid(
  record: JsonRecord,
  keys: readonly string[],
  label: string,
): string {
  const value = requiredString(record, keys, label);
  assertUuid(value, label);
  return value;
}

function requiredSafeInteger(
  record: JsonRecord,
  keys: readonly string[],
  label: string,
): number {
  const value = valueFrom(record, keys);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidResponse(`${label}이(가) 안전한 정수가 아닙니다.`);
  }
  return value;
}

function requiredNonNegativeSafeInteger(
  record: JsonRecord,
  keys: readonly string[],
  label: string,
): number {
  const value = requiredSafeInteger(record, keys, label);
  if (value < 0) {
    throw invalidResponse(`${label}이(가) 0보다 작습니다.`);
  }
  return value;
}

function requiredPositiveSafeInteger(
  record: JsonRecord,
  keys: readonly string[],
  label: string,
): number {
  const value = requiredSafeInteger(record, keys, label);
  if (value < 1) {
    throw invalidResponse(`${label}이(가) 1보다 작습니다.`);
  }
  return value;
}

function requiredBoolean(
  record: JsonRecord,
  keys: readonly string[],
  label: string,
): boolean {
  const value = valueFrom(record, keys);
  if (typeof value !== "boolean") {
    throw invalidResponse(`${label}이(가) 불리언이 아닙니다.`);
  }
  return value;
}

function optionalBoolean(
  record: JsonRecord,
  keys: readonly string[],
  fallback: boolean,
): boolean {
  const value = valueFrom(record, keys);
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw invalidResponse(`${keys[0] ?? "불리언"} 응답 형식이 올바르지 않습니다.`);
  }
  return value;
}

function nullableTimestamp(
  record: JsonRecord,
  keys: readonly string[],
  label: string,
): number | null {
  const value = valueFrom(record, keys);
  return value === null ? null : timestampValue(value, label);
}

function requiredTimestamp(
  record: JsonRecord,
  keys: readonly string[],
  label: string,
): number {
  return timestampValue(valueFrom(record, keys), label);
}

function timestampValue(value: unknown, label: string): number {
  const timestamp =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw invalidResponse(`${label} 형식이 올바르지 않습니다.`);
  }
  return timestamp;
}

function valueFrom(record: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label}은(는) 안전한 정수여야 합니다.`);
  }
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new RangeError(`${label}은(는) UUID여야 합니다.`);
  }
}

function assertIdempotencyKey(value: string): void {
  assertUuid(value, "멱등 키");
}

function invalidResponse(message: string): RepositoryRequestError {
  return new RepositoryRequestError(message, { code: "invalid-response" });
}

function repositoryError(
  message: string,
  cause?: { code?: string; status?: number } | Error,
): RepositoryRequestError {
  const rawCode =
    cause && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : "remote-error";
  const code = rawCode.trim() || "remote-error";
  const status =
    cause && "status" in cause && typeof cause.status === "number"
      ? cause.status
      : undefined;
  const retryable = isRetryableRemoteFailure(code, status);
  return new RepositoryRequestError(message, { code, retryable, cause });
}

function isRetryableRemoteFailure(code: string, status?: number): boolean {
  return (
    status === 0 ||
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    code === "57014" ||
    code === "53300" ||
    code === "57P01" ||
    /^PGRST00[0-3]$/u.test(code) ||
    code.startsWith("08")
  );
}

function normalizeRequestError(error: unknown): RepositoryRequestError {
  if (error instanceof RepositoryRequestError) {
    return error;
  }
  return new RepositoryRequestError(
    "공동 월드 서버에 연결하지 못했습니다.",
    { code: "network-unavailable", retryable: true, cause: error },
  );
}

function withRequestTimeout<T>(
  request: PromiseLike<T>,
  timeoutMs: number,
  controller?: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      controller?.abort();
      reject(
        new RepositoryRequestError(
          "공동 월드 서버의 응답 시간이 초과되었습니다.",
          { code: "request-timeout", retryable: true },
        ),
      );
    }, timeoutMs);

    void Promise.resolve(request).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function attachAbortSignal<T>(
  request: PromiseLike<T>,
  signal: AbortSignal,
): PromiseLike<T> {
  const candidate = request as PromiseLike<T> & {
    abortSignal?: (nextSignal: AbortSignal) => PromiseLike<T>;
  };
  return typeof candidate.abortSignal === "function"
    ? candidate.abortSignal(signal)
    : request;
}

function assertAnonymousUser(user: User): User {
  if (user.is_anonymous !== true) {
    throw new RepositoryRequestError(
      "온라인 공동 월드는 Supabase 익명 계정으로만 이용할 수 있습니다.",
      { code: "anonymous-auth-required" },
    );
  }
  return user;
}
