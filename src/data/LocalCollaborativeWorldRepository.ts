import {
  DEFAULT_GAME_RULES,
  SystemClock,
  getManualProductionRemainingAttempts,
  isProductionOperational,
  reconcileOnboardingCompletion,
  reconcileProductionUpgrade,
  resetOnboardingProgress,
  settleAutomaticProduction,
  tryManualProduction,
  type Clock,
  type GameRulesConfig,
} from "../domain/progression";
import {
  STARTER_BAY_RESERVED_SLOT_COUNT,
  classifyStarterBayPosition,
  countFilledGuides,
  createStarterBayLayout,
  guideAtPosition,
} from "../domain/starterBay";
import {
  MissionRuleError,
  activeMissionRecord,
  applyMissionContribution,
  missionInstanceView,
  type MissionIdentitySnapshot,
} from "../domain/mission";
import {
  LOCAL_PLAYER,
  SYSTEM_OWNER,
  type BlockOwner,
  type VoxelBlock,
  type WorldSnapshot,
  type ZoneKind,
} from "../domain/types";
import { createSeedSnapshot } from "../world/seed";
import {
  prepareLocalSnapshot,
  withoutOnboardingBlocks,
} from "../world/localWorld";
import { decidePlacement, decideRemoval } from "../domain/permissions";
import {
  MAX_COMPLETED_MISSIONS_PER_ARCHIVE,
  MAX_NEARBY_CHUNK_RADIUS,
  MAX_NEARBY_BLOCKS_PER_RESPONSE,
  MAX_NEARBY_VERTICAL_CHUNK_RADIUS,
  RepositoryRequestError,
  type CollaborativeWorldRepository,
  type CommitWorldActionsRequest,
  type CompletedMissionsResult,
  type ContributeToMissionRequest,
  type DismantleResult,
  type DismantleTicket,
  type ManualProductionSession,
  type MissionContributionResult,
  type MissionOverviewResult,
  type NearbyBlocksRequest,
  type NearbyBlocksResult,
  type PlayerBootstrap,
  type ProductionResult,
  type WorldMutationResult,
} from "./CollaborativeWorldRepository";
import type { WorldRepository } from "./WorldRepository";
import {
  areFaceAdjacent,
  validateCommitWorldActions,
} from "./worldActionValidation";

interface LocalRepositoryOptions {
  clock?: Clock;
  config?: Readonly<GameRulesConfig>;
  player?: BlockOwner;
}

interface LocalDismantleRecord extends DismantleTicket {
  idempotencyKey: string;
}

interface LocalManualProductionSession extends ManualProductionSession {
  expiresAt: number;
}

interface StoredMutation<T> {
  fingerprint: string;
  result: T;
}

const storageMutationQueues = new WeakMap<WorldRepository, Promise<void>>();
const CROSS_TAB_MUTATION_LOCK = "lumenmoon:world-repository-mutations";

/**
 * 기존 IndexedDB/Memory 저장소를 공동 월드 명령 계약에 맞춘 로컬 어댑터다.
 * 온라인 보안 경계의 대체물은 아니지만 같은 클라이언트 흐름을 테스트할 수 있다.
 * 멱등 처리 캐시는 현재 탭 수명에 한정된다. 새로고침·다중 탭 권위성은 DB에
 * operation 행을 보존하는 SupabaseRepository만 보장한다.
 */
export class LocalCollaborativeWorldRepository
  implements CollaborativeWorldRepository
{
  readonly mode = "local" as const;

  private readonly storage: WorldRepository;
  private readonly clock: Clock;
  private readonly config: Readonly<GameRulesConfig>;
  private readonly player: BlockOwner;
  private readonly mutations = new Map<
    string,
    StoredMutation<WorldMutationResult>
  >();
  private readonly productionMutations = new Map<
    string,
    StoredMutation<ProductionResult>
  >();
  private readonly manualSessions = new Map<
    string,
    LocalManualProductionSession
  >();
  private readonly completedManualSessions = new Set<string>();
  private readonly dismantleStarts = new Map<
    string,
    StoredMutation<LocalDismantleRecord>
  >();
  private readonly dismantleTickets = new Map<string, LocalDismantleRecord>();
  private readonly dismantleFinishes = new Map<
    string,
    StoredMutation<DismantleResult>
  >();
  private readonly worldIds = new Set<string>();

  constructor(storage: WorldRepository, options: LocalRepositoryOptions = {}) {
    this.storage = storage;
    this.clock = options.clock ?? new SystemClock();
    this.config = options.config ?? DEFAULT_GAME_RULES;
    this.player = options.player ?? LOCAL_PLAYER;
  }

  async bootstrapPlayer(worldId: string): Promise<PlayerBootstrap> {
    return this.serializeMutation(() => this.bootstrapPlayerInternal(worldId));
  }

  private async bootstrapPlayerInternal(worldId: string): Promise<PlayerBootstrap> {
    this.worldIds.add(worldId);
    const now = this.clock.now();
    const source =
      (await this.storage.load(worldId)) ?? createSeedSnapshot(now, this.config);
    if (source.worldId !== worldId) {
      throw new RepositoryRequestError("로컬 월드 ID가 일치하지 않습니다.", {
        code: "world-mismatch",
      });
    }
    const prepared = prepareLocalSnapshot(source, now, this.config);
    if (prepared.changed || !(await this.storage.load(worldId))) {
      await this.storage.save(prepared.snapshot);
    }
    const state = requireLocalState(prepared.snapshot);
    return {
      worldId,
      player: { ...this.player },
      baySlotIndex: state.baySlotIndex,
      progress: cloneProgress(state.progress),
      serverNow: now,
    };
  }

  async loadNearbyBlocks(
    request: NearbyBlocksRequest,
  ): Promise<NearbyBlocksResult> {
    validateChunkRequest(request);
    const snapshot = await this.requireSnapshot(request.worldId);
    const minX = request.chunkX - request.radius;
    const maxX = request.chunkX + request.radius;
    const minY = request.chunkY - request.verticalRadius;
    const maxY = request.chunkY + request.verticalRadius;
    const minZ = request.chunkZ - request.radius;
    const maxZ = request.chunkZ + request.radius;
    const blocks = snapshot.blocks
      // 공동 미션의 정규 원본은 mission overview가 유일한 읽기 소스다.
      // 일반 블록 조회에 섞으면 클라이언트 대칭 복제와 중복 렌더링된다.
      .filter(({ zone }) => zone !== "mission")
      .filter(({ position }) => {
        const chunkX = Math.floor(position.x / 16);
        const chunkY = Math.floor(position.y / 16);
        const chunkZ = Math.floor(position.z / 16);
        return (
          chunkX >= minX &&
          chunkX <= maxX &&
          chunkY >= minY &&
          chunkY <= maxY &&
          chunkZ >= minZ &&
          chunkZ <= maxZ
        );
      });
    if (blocks.length > MAX_NEARBY_BLOCKS_PER_RESPONSE) {
      throw new RepositoryRequestError(
        "주변 청크가 너무 밀집되어 안전하게 불러올 수 없습니다.",
        { code: "nearby-block-limit" },
      );
    }
    return {
      worldId: request.worldId,
      blocks: blocks.map(cloneBlock),
      blockCount: blocks.length,
      blockLimit: MAX_NEARBY_BLOCKS_PER_RESPONSE,
      serverNow: this.clock.now(),
    };
  }

  async getPublicProfiles(publicIds: readonly string[]): Promise<BlockOwner[]> {
    if (publicIds.length > 64) {
      throw new RangeError("공개 프로필은 한 번에 최대 64개까지 조회할 수 있습니다.");
    }
    for (const publicId of publicIds) {
      if (!/^#[A-HJ-NP-Z2-9]{4}$/u.test(publicId)) {
        throw new RangeError("공개 ID 형식이 올바르지 않습니다.");
      }
    }
    const requested = new Set(publicIds);
    const profiles = new Map<string, BlockOwner>([
      [this.player.publicId, this.player],
      [SYSTEM_OWNER.publicId, SYSTEM_OWNER],
    ]);
    for (const worldId of this.worldIds) {
      const snapshot = await this.storage.load(worldId);
      for (const block of snapshot?.blocks ?? []) {
        profiles.set(block.owner.publicId, block.owner);
      }
    }
    return [...profiles.values()]
      .filter((profile) => requested.has(profile.publicId))
      .map((profile) => ({ ...profile }));
  }

  async getMissionOverview(worldId: string): Promise<MissionOverviewResult> {
    const snapshot = await this.requireSnapshot(worldId);
    const state = requireLocalMissionState(snapshot);
    const localState = requireLocalState(snapshot);
    const bay = createStarterBayLayout(localState.baySlotIndex);
    const baseBuilt = countFilledGuides(
      bay.baseGuides,
      snapshot.blocks,
      this.player.id,
    );
    const producerBuilt = countFilledGuides(
      bay.producerGuides,
      snapshot.blocks,
      this.player.id,
    );
    return {
      worldId,
      activeMission: missionInstanceView(
        activeMissionRecord(state),
        this.player.publicId,
      ),
      eligibility: {
        baseBuilt,
        producerBuilt,
        eligible:
          baseBuilt >= this.config.baseGuideSlots &&
          producerBuilt >= this.config.producerGuideSlots,
      },
      serverNow: this.clock.now(),
    };
  }

  async listCompletedMissions(
    worldId: string,
  ): Promise<CompletedMissionsResult> {
    const snapshot = await this.requireSnapshot(worldId);
    const state = requireLocalMissionState(snapshot);
    return {
      worldId,
      missions: state.instances
        .filter(({ status }) => status === "completed")
        .sort(
          (left, right) =>
            right.layer - left.layer ||
            (right.completedAt ?? 0) - (left.completedAt ?? 0),
        )
        .slice(0, MAX_COMPLETED_MISSIONS_PER_ARCHIVE)
        .map((mission) => missionInstanceView(mission, this.player.publicId)),
      serverNow: this.clock.now(),
    };
  }

  async contributeToMission(
    request: ContributeToMissionRequest,
  ): Promise<MissionContributionResult> {
    return this.serializeMutation(() =>
      this.contributeToMissionInternal(request),
    );
  }

  private async contributeToMissionInternal(
    request: ContributeToMissionRequest,
  ): Promise<MissionContributionResult> {
    validateIdempotencyKey(request.idempotencyKey);
    if (!Number.isSafeInteger(request.slotIndex) || request.slotIndex < 0) {
      throw new RangeError("공동 미션 슬롯 번호가 올바르지 않습니다.");
    }
    if (!Number.isSafeInteger(request.paletteIndex)) {
      throw new RangeError("공동 미션 팔레트 위치가 올바르지 않습니다.");
    }
    const now = this.clock.now();
    const snapshot = await this.requireSnapshot(request.worldId);
    const localState = requireLocalState(snapshot);
    const missionState = requireLocalMissionState(snapshot);
    const isReplay = missionState.operations.some(
      ({ idempotencyKey, actorPublicId }) =>
        idempotencyKey === request.idempotencyKey &&
        actorPublicId === this.player.publicId,
    );
    let progressForContribution = localState.progress;
    if (!isReplay) {
      const bay = createStarterBayLayout(localState.baySlotIndex);
      const baseCount = countFilledGuides(
        bay.baseGuides,
        snapshot.blocks,
        this.player.id,
      );
      const producerCount = countFilledGuides(
        bay.producerGuides,
        snapshot.blocks,
        this.player.id,
      );
      if (
        baseCount < this.config.baseGuideSlots ||
        producerCount < this.config.producerGuideSlots
      ) {
        throw ruleError(
          "개인 영역과 생산시설을 현재 완성한 상태여야 합니다.",
          "onboarding-incomplete",
        );
      }
      if (
        isProductionOperational(
          localState.progress,
          producerCount,
          this.config,
        )
      ) {
        progressForContribution = settleAutomaticProduction(
          localState.progress,
          now,
          this.config,
        ).progress;
      }
    }
    let applied;
    try {
      applied = applyMissionContribution({
        state: missionState,
        worldId: request.worldId,
        missionInstanceId: request.missionInstanceId,
        slotIndex: request.slotIndex,
        paletteIndex: request.paletteIndex,
        idempotencyKey: request.idempotencyKey,
        actor: publicIdentitySnapshot(this.player),
        progress: progressForContribution,
        now,
      });
    } catch (error) {
      if (error instanceof MissionRuleError) {
        throw ruleError(error.message, error.code);
      }
      throw error;
    }

    if (!applied.replayed) {
      snapshot.localMissionState = applied.state;
      localState.progress = structuredClone(applied.progress);
      snapshot.updatedAt = now;
      await this.storage.save(snapshot);
    }
    return {
      worldId: request.worldId,
      idempotencyKey: request.idempotencyKey,
      mission: structuredClone(applied.mission),
      contribution: structuredClone(applied.contribution),
      progress: structuredClone(applied.progress),
      ...(applied.nextMission
        ? { nextMission: structuredClone(applied.nextMission) }
        : {}),
      serverNow: applied.replayed
        ? missionState.operations.find(
            ({ idempotencyKey, actorPublicId }) =>
              idempotencyKey === request.idempotencyKey &&
              actorPublicId === this.player.publicId,
          )?.serverNow ?? now
        : now,
      replayed: applied.replayed,
    };
  }

  async commitWorldActions(
    request: CommitWorldActionsRequest,
  ): Promise<WorldMutationResult> {
    return this.serializeMutation(() => this.commitWorldActionsInternal(request));
  }

  private async commitWorldActionsInternal(
    request: CommitWorldActionsRequest,
  ): Promise<WorldMutationResult> {
    validateCommitWorldActions(request);
    const fingerprint = fingerprintCommit(request);
    const stored = this.mutations.get(request.idempotencyKey);
    if (stored) {
      assertSameFingerprint(stored.fingerprint, fingerprint);
      return { ...cloneMutation(stored.result), replayed: true };
    }

    const now = this.clock.now();
    const source = await this.requireSnapshot(request.worldId);
    const next = cloneSnapshot(source);
    const state = requireLocalState(next);
    const bay = createStarterBayLayout(state.baySlotIndex);
    const reservedBays = Array.from(
      { length: STARTER_BAY_RESERVED_SLOT_COUNT },
      (_, index) => createStarterBayLayout(index),
    );
    const upsertedBlocks: VoxelBlock[] = [];
    const removedBlockIds: string[] = [];
    const producerCountBefore = countFilledGuides(
      bay.producerGuides,
      next.blocks,
      this.player.id,
    );
    const producerWasOperational = isProductionOperational(
      state.progress,
      producerCountBefore,
      this.config,
    );

    if (request.actions.some((action) => action.type === "reset_onboarding")) {
      if (request.actions.length !== 1) {
        throw ruleError("온보딩 초기화는 단독 작업이어야 합니다.");
      }
      const reset = resetOnboardingProgress(state.progress, now, this.config);
      if (!reset.reset) {
        throw ruleError("완성한 베이는 초기화할 수 없습니다.");
      }
      const retained = withoutOnboardingBlocks(next.blocks, this.player.id);
      removedBlockIds.push(
        ...next.blocks
          .filter((block) => !retained.some(({ id }) => id === block.id))
          .map(({ id }) => id),
      );
      next.blocks = retained;
      state.progress = reset.progress;
    } else {
      for (const action of request.actions) {
        if (action.type === "reset_onboarding") {
          continue;
        }
        if (action.type === "place") {
          if (next.blocks.some((block) => block.id === action.blockId)) {
            throw ruleError("이미 사용 중인 블록 ID입니다.", "duplicate-block");
          }
          if (
            next.blocks.some(
              ({ position }) =>
                position.x === action.position.x &&
                position.y === action.position.y &&
                position.z === action.position.z,
            )
          ) {
            throw ruleError("이미 블록이 있는 좌표입니다.", "duplicate-coordinate");
          }
          if (state.progress.inventory <= 0) {
            throw ruleError("블록 재고가 부족합니다.", "insufficient-inventory");
          }
          const match = classifyStarterBayPosition(reservedBays, action.position);
          const zoneOwnerId =
            match.slotIndex === state.baySlotIndex ? this.player.id : undefined;
          const permission = decidePlacement({
            actorId: this.player.id,
            zone: match.zone,
            ...(zoneOwnerId ? { zoneOwnerId } : {}),
          });
          if (!permission.allowed || match.zone === "spawn") {
            throw ruleError("이 구역에는 배치할 수 없습니다.", permission.reason);
          }
          const guide = guideAtPosition(bay, action.position);
          if (
            !state.progress.trialRewardClaimed &&
            (!guide || (guide.group !== "base" && guide.group !== "producer"))
          ) {
            throw ruleError("온보딩 중에는 가이드에만 배치할 수 있습니다.");
          }
          if (
            !state.progress.trialRewardClaimed &&
            guide &&
            (action.kind !== guide.kind || action.rotation !== guide.rotation)
          ) {
            throw ruleError(
              "온보딩 가이드의 블록 종류와 회전을 따라야 합니다.",
              "guide-mismatch",
            );
          }
          if (action.supportId) {
            const support = next.blocks.find(
              (block) => block.id === action.supportId,
            );
            if (!support || !areFaceAdjacent(support.position, action.position)) {
              throw ruleError(
                "지지 블록이 없거나 배치 면에 인접하지 않습니다.",
                "invalid-support",
              );
            }
          }

          const block: VoxelBlock = {
            id: action.blockId,
            worldId: request.worldId,
            position: { ...action.position },
            kind: action.kind,
            rotation: action.rotation,
            colorIndex: action.colorIndex,
            owner: { ...this.player },
            zone: match.zone as ZoneKind,
            createdAt: now,
            ...(action.supportId ? { supportId: action.supportId } : {}),
            ...(!state.progress.trialRewardClaimed
              ? { source: "onboarding" as const }
              : { source: "inventory" as const }),
          };
          next.blocks.push(block);
          upsertedBlocks.push(cloneBlock(block));
          state.progress.inventory -= 1;
        } else {
          const blockIndex = next.blocks.findIndex(
            (block) => block.id === action.blockId,
          );
          const block = next.blocks[blockIndex];
          if (!block) {
            throw ruleError("제거할 블록을 찾을 수 없습니다.", "block-not-found");
          }
          if (block.owner.id !== this.player.id) {
            throw ruleError(
              "타인 블록은 철거 티켓을 완료해야 합니다.",
              "dismantle-required",
            );
          }
          const permission = decideRemoval({
            actorId: this.player.id,
            block,
            allBlocks: next.blocks,
            zoneOwnerId: this.player.id,
          });
          if (!permission.allowed) {
            throw ruleError("블록을 제거할 수 없습니다.", permission.reason);
          }
          next.blocks.splice(blockIndex, 1);
          removedBlockIds.push(block.id);
          state.progress.inventory = Math.min(
            this.config.maxInventory,
            state.progress.inventory + permission.refundInventory,
          );
        }
      }
      const producerCountAfter = countFilledGuides(
        bay.producerGuides,
        next.blocks,
        this.player.id,
      );
      if (
        !producerWasOperational &&
        isProductionOperational(state.progress, producerCountAfter, this.config)
      ) {
        state.progress.lastSettledAt = Math.max(state.progress.lastSettledAt, now);
      }
      reconcileProgress(next, this.player.id, now, this.config);
    }

    next.updatedAt = now;
    await this.storage.save(next);
    const result: WorldMutationResult = {
      worldId: request.worldId,
      idempotencyKey: request.idempotencyKey,
      upsertedBlocks,
      removedBlockIds,
      progress: cloneProgress(state.progress),
      serverNow: now,
      replayed: false,
    };
    this.mutations.set(request.idempotencyKey, {
      fingerprint,
      result: cloneMutation(result),
    });
    return result;
  }

  async settleProduction(worldId: string): Promise<ProductionResult> {
    return this.serializeMutation(() => this.settleProductionInternal(worldId));
  }

  private async settleProductionInternal(
    worldId: string,
  ): Promise<ProductionResult> {
    const now = this.clock.now();
    const snapshot = await this.requireSnapshot(worldId);
    const state = requireLocalState(snapshot);
    const bay = createStarterBayLayout(state.baySlotIndex);
    const producerCount = countFilledGuides(
      bay.producerGuides,
      snapshot.blocks,
      this.player.id,
    );
    let produced = 0;
    if (isProductionOperational(state.progress, producerCount, this.config)) {
      const settlement = settleAutomaticProduction(
        state.progress,
        now,
        this.config,
      );
      state.progress = settlement.progress;
      produced = settlement.produced;
      snapshot.updatedAt = now;
      await this.storage.save(snapshot);
    }
    return {
      worldId,
      progress: cloneProgress(state.progress),
      produced,
      serverNow: now,
    };
  }

  async startManualProduction(
    worldId: string,
    sessionId: string,
  ): Promise<ManualProductionSession> {
    return this.serializeMutation(() =>
      this.startManualProductionInternal(worldId, sessionId),
    );
  }

  private async startManualProductionInternal(
    worldId: string,
    sessionId: string,
  ): Promise<ManualProductionSession> {
    validateIdempotencyKey(sessionId);
    const existing = this.manualSessions.get(sessionId);
    if (existing) {
      if (existing.worldId !== worldId) {
        throw ruleError(
          "같은 수동 생산 세션 ID를 다른 월드에 사용할 수 없습니다.",
          "idempotency-conflict",
        );
      }
      return structuredClone(existing);
    }
    const now = this.clock.now();
    const snapshot = await this.requireSnapshot(worldId);
    const state = requireLocalState(snapshot);
    const bay = createStarterBayLayout(state.baySlotIndex);
    const producerCount = countFilledGuides(
      bay.producerGuides,
      snapshot.blocks,
      this.player.id,
    );
    if (!isProductionOperational(state.progress, producerCount, this.config)) {
      throw ruleError("생산시설을 먼저 복구해야 합니다.", "producer-offline");
    }
    if (
      getManualProductionRemainingAttempts(state.progress, now, this.config) <= 0
    ) {
      throw ruleError("최근 24시간 수동 생산 횟수를 모두 사용했습니다.", "daily-limit");
    }
    const session: LocalManualProductionSession = {
      id: sessionId,
      worldId,
      readyAt: now + this.config.manualProductionDurationMs,
      expiresAt:
        now + this.config.manualProductionDurationMs + 5 * 60 * 1_000,
      serverNow: now,
      progress: cloneProgress(state.progress),
    };
    this.manualSessions.set(sessionId, structuredClone(session));
    return structuredClone(session);
  }

  async completeManualProduction(
    worldId: string,
    sessionId: string,
    idempotencyKey: string,
  ): Promise<ProductionResult> {
    return this.serializeMutation(() =>
      this.completeManualProductionInternal(worldId, sessionId, idempotencyKey),
    );
  }

  private async completeManualProductionInternal(
    worldId: string,
    sessionId: string,
    idempotencyKey: string,
  ): Promise<ProductionResult> {
    validateIdempotencyKey(idempotencyKey);
    const fingerprint = JSON.stringify({ worldId, sessionId });
    const stored = this.productionMutations.get(idempotencyKey);
    if (stored) {
      assertSameFingerprint(stored.fingerprint, fingerprint);
      return { ...cloneProduction(stored.result), replayed: true };
    }
    const now = this.clock.now();
    const session = this.manualSessions.get(sessionId);
    if (!session || session.worldId !== worldId) {
      throw ruleError("수동 생산 세션을 찾을 수 없습니다.", "session-not-found");
    }
    if (this.completedManualSessions.has(sessionId)) {
      throw ruleError("이미 완료한 수동 생산 세션입니다.", "session-completed");
    }
    if (now < session.readyAt) {
      throw ruleError("수동 생산 시간이 아직 끝나지 않았습니다.", "too-early");
    }
    if (now > session.expiresAt) {
      throw ruleError("수동 생산 세션이 만료되었습니다.", "session-expired");
    }
    const snapshot = await this.requireSnapshot(worldId);
    const state = requireLocalState(snapshot);
    const bay = createStarterBayLayout(state.baySlotIndex);
    const producerCount = countFilledGuides(
      bay.producerGuides,
      snapshot.blocks,
      this.player.id,
    );
    if (!isProductionOperational(state.progress, producerCount, this.config)) {
      throw ruleError("생산시설을 먼저 복구해야 합니다.", "producer-offline");
    }
    const production = tryManualProduction(state.progress, now, this.config);
    if (!production.produced) {
      throw ruleError(
        production.reason === "inventory-full"
          ? "재고가 가득 찼습니다."
          : "최근 24시간 수동 생산 횟수를 모두 사용했습니다.",
        production.reason,
      );
    }
    state.progress = production.progress;
    snapshot.updatedAt = now;
    await this.storage.save(snapshot);
    this.completedManualSessions.add(sessionId);
    const result: ProductionResult = {
      worldId,
      progress: cloneProgress(state.progress),
      produced: this.config.manualProductionReward,
      serverNow: now,
      idempotencyKey,
      replayed: false,
    };
    this.productionMutations.set(idempotencyKey, {
      fingerprint,
      result: cloneProduction(result),
    });
    return result;
  }

  async startDismantle(
    worldId: string,
    blockId: string,
    idempotencyKey: string,
  ): Promise<DismantleTicket> {
    return this.serializeMutation(() =>
      this.startDismantleInternal(worldId, blockId, idempotencyKey),
    );
  }

  private async startDismantleInternal(
    worldId: string,
    blockId: string,
    idempotencyKey: string,
  ): Promise<DismantleTicket> {
    validateIdempotencyKey(idempotencyKey);
    const fingerprint = JSON.stringify({ worldId, blockId });
    const stored = this.dismantleStarts.get(idempotencyKey);
    if (stored) {
      assertSameFingerprint(stored.fingerprint, fingerprint);
      if (!this.dismantleTickets.has(stored.result.id)) {
        throw ruleError("이미 취소된 철거 티켓입니다.", "ticket-cancelled");
      }
      return cloneTicket(stored.result);
    }
    const now = this.clock.now();
    const snapshot = await this.requireSnapshot(worldId);
    const block = snapshot.blocks.find(({ id }) => id === blockId);
    if (!block) {
      throw ruleError("철거할 블록을 찾을 수 없습니다.", "block-not-found");
    }
    const permission = decideRemoval({
      actorId: this.player.id,
      block,
      allBlocks: snapshot.blocks,
      heldMs: 0,
    });
    if (!permission.requiresHold || permission.reason !== "hold-required") {
      throw ruleError("이 블록은 타인 공용 블록 철거 대상이 아닙니다.");
    }

    // 한 플레이어의 새 철거 시작은 이전 활성 티켓을 무효화한다.
    this.dismantleTickets.clear();
    const ticket: LocalDismantleRecord = {
      id: crypto.randomUUID(),
      worldId,
      blockId,
      readyAt: now + permission.holdMs,
      expiresAt: now + permission.holdMs + 60_000,
      serverNow: now,
      idempotencyKey,
    };
    this.dismantleStarts.set(idempotencyKey, {
      fingerprint,
      result: { ...ticket },
    });
    this.dismantleTickets.set(ticket.id, { ...ticket });
    return cloneTicket(ticket);
  }

  async finishDismantle(
    worldId: string,
    ticketId: string,
    idempotencyKey: string,
  ): Promise<DismantleResult> {
    return this.serializeMutation(() =>
      this.finishDismantleInternal(worldId, ticketId, idempotencyKey),
    );
  }

  async cancelDismantle(worldId: string, ticketId: string): Promise<void> {
    return this.serializeMutation(async () => {
      const ticket = this.dismantleTickets.get(ticketId);
      if (ticket?.worldId === worldId) {
        this.dismantleTickets.delete(ticketId);
      }
    });
  }

  private async finishDismantleInternal(
    worldId: string,
    ticketId: string,
    idempotencyKey: string,
  ): Promise<DismantleResult> {
    validateIdempotencyKey(idempotencyKey);
    const fingerprint = JSON.stringify({ worldId, ticketId });
    const stored = this.dismantleFinishes.get(idempotencyKey);
    if (stored) {
      assertSameFingerprint(stored.fingerprint, fingerprint);
      return {
        ...stored.result,
        progress: cloneProgress(stored.result.progress),
        replayed: true,
      };
    }
    const now = this.clock.now();
    const ticket = this.dismantleTickets.get(ticketId);
    if (!ticket || ticket.worldId !== worldId) {
      throw ruleError("유효한 철거 티켓이 없습니다.", "ticket-not-found");
    }
    if (now < ticket.readyAt) {
      throw ruleError("철거 유지 시간이 아직 부족합니다.", "too-early");
    }
    if (now > ticket.expiresAt) {
      throw ruleError("철거 티켓이 만료되었습니다.", "ticket-expired");
    }
    const snapshot = await this.requireSnapshot(worldId);
    const state = requireLocalState(snapshot);
    const blockIndex = snapshot.blocks.findIndex(({ id }) => id === ticket.blockId);
    const block = snapshot.blocks[blockIndex];
    if (!block) {
      throw ruleError("철거할 블록을 찾을 수 없습니다.", "block-not-found");
    }
    const permission = decideRemoval({
      actorId: this.player.id,
      block,
      allBlocks: snapshot.blocks,
      heldMs: now - ticket.serverNow,
    });
    if (!permission.allowed) {
      throw ruleError("블록을 철거할 수 없습니다.", permission.reason);
    }
    snapshot.blocks.splice(blockIndex, 1);
    snapshot.updatedAt = now;
    await this.storage.save(snapshot);
    this.dismantleTickets.delete(ticketId);
    const result: DismantleResult = {
      worldId,
      idempotencyKey,
      removedBlockId: block.id,
      progress: cloneProgress(state.progress),
      serverNow: now,
      replayed: false,
    };
    this.dismantleFinishes.set(idempotencyKey, {
      fingerprint,
      result: {
        ...result,
        progress: cloneProgress(result.progress),
      },
    });
    return result;
  }

  private async requireSnapshot(worldId: string): Promise<WorldSnapshot> {
    const snapshot = await this.storage.load(worldId);
    if (!snapshot) {
      await this.bootstrapPlayerInternal(worldId);
      const bootstrapped = await this.storage.load(worldId);
      if (bootstrapped) {
        return bootstrapped;
      }
      throw new RepositoryRequestError("로컬 월드를 준비하지 못했습니다.");
    }
    return cloneSnapshot(snapshot);
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = storageMutationQueues.get(this.storage) ?? Promise.resolve();
    const run = () => withCrossTabMutationLock(operation);
    const result = previous.then(run, run);
    storageMutationQueues.set(this.storage, result.then(
      () => undefined,
      () => undefined,
    ));
    return result;
  }
}

async function withCrossTabMutationLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const lockManager =
    typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!lockManager) {
    return operation();
  }
  return lockManager.request(
    CROSS_TAB_MUTATION_LOCK,
    { mode: "exclusive" },
    () => operation(),
  );
}

function reconcileProgress(
  snapshot: WorldSnapshot,
  ownerId: string,
  now: number,
  config: Readonly<GameRulesConfig>,
): void {
  const state = requireLocalState(snapshot);
  const bay = createStarterBayLayout(state.baySlotIndex);
  const baseCount = countFilledGuides(bay.baseGuides, snapshot.blocks, ownerId);
  const producerCount = countFilledGuides(
    bay.producerGuides,
    snapshot.blocks,
    ownerId,
  );
  const upgradeCount = countFilledGuides(
    bay.upgradeGuides,
    snapshot.blocks,
    ownerId,
  );
  state.progress = reconcileOnboardingCompletion(
    state.progress,
    baseCount,
    producerCount,
    now,
    config,
  );
  state.progress = reconcileProductionUpgrade(
    state.progress,
    upgradeCount,
    producerCount,
    now,
    config,
  ).progress;
}

function validateChunkRequest(request: NearbyBlocksRequest): void {
  if (
    !Number.isSafeInteger(request.chunkX) ||
    !Number.isSafeInteger(request.chunkY) ||
    !Number.isSafeInteger(request.chunkZ)
  ) {
    throw new RangeError("청크 좌표는 안전한 정수여야 합니다.");
  }
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

function validateIdempotencyKey(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new RangeError("멱등 키는 UUID여야 합니다.");
  }
}

function ruleError(
  message: string,
  code = "rule-violation",
): RepositoryRequestError {
  return new RepositoryRequestError(message, { code });
}

function requireLocalState(snapshot: WorldSnapshot) {
  if (!snapshot.localState) {
    throw new RepositoryRequestError("로컬 플레이어 상태가 없습니다.");
  }
  return snapshot.localState;
}

function requireLocalMissionState(snapshot: WorldSnapshot) {
  if (!snapshot.localMissionState) {
    throw new RepositoryRequestError("로컬 공동 미션 상태가 없습니다.", {
      code: "mission-state-missing",
    });
  }
  return snapshot.localMissionState;
}

function publicIdentitySnapshot(owner: BlockOwner): MissionIdentitySnapshot {
  return {
    publicId: owner.publicId,
    nickname: owner.nickname,
    emblem: owner.emblem,
  };
}

function cloneSnapshot(snapshot: WorldSnapshot): WorldSnapshot {
  return structuredClone(snapshot);
}

function cloneBlock(block: VoxelBlock): VoxelBlock {
  return structuredClone(block);
}

function cloneProgress<T extends PlayerBootstrap["progress"]>(progress: T): T {
  return structuredClone(progress);
}

function cloneMutation(result: WorldMutationResult): WorldMutationResult {
  return structuredClone(result);
}

function cloneProduction(result: ProductionResult): ProductionResult {
  return structuredClone(result);
}

function cloneTicket(ticket: DismantleTicket): DismantleTicket {
  return { ...ticket };
}

function fingerprintCommit(request: CommitWorldActionsRequest): string {
  return JSON.stringify({
    worldId: request.worldId,
    actions: request.actions.map((action) => {
      if (action.type === "reset_onboarding") {
        return { type: action.type };
      }
      if (action.type === "remove") {
        return { type: action.type, blockId: action.blockId };
      }
      return {
        type: action.type,
        blockId: action.blockId,
        position: {
          x: action.position.x,
          y: action.position.y,
          z: action.position.z,
        },
        kind: action.kind,
        rotation: action.rotation,
        colorIndex: action.colorIndex,
        supportId: action.supportId ?? null,
      };
    }),
  });
}

function assertSameFingerprint(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new RepositoryRequestError(
      "같은 멱등 키를 다른 요청에 다시 사용할 수 없습니다.",
      { code: "idempotency-conflict" },
    );
  }
}
