import type { LocalPlayerProgress } from "../domain/progression";
import type { FreeModeProgress } from "../domain/freeMode";
import type {
  MissionContribution,
  MissionInstance,
} from "../domain/mission";
import type {
  BlockKind,
  BlockOwner,
  BlockRotation,
  GridPosition,
  VoxelBlock,
} from "../domain/types";

export const MAX_WORLD_ACTIONS_PER_COMMIT = 24;
export const FREE_MODE_ACTIONS_PER_COMMIT = 1;
export const MAX_WORLD_ACTION_PAYLOAD_BYTES = 32_768;
export const MAX_NEARBY_CHUNK_RADIUS = 2;
export const MAX_NEARBY_VERTICAL_CHUNK_RADIUS = 1;
export const MAX_NEARBY_BLOCKS_PER_RESPONSE = 8_192;
export const MAX_COMPLETED_MISSIONS_PER_ARCHIVE = 50;

export type GameMode = "mission" | "free";

export interface PlayerIdentityResult {
  player: BlockOwner;
  serverNow: number;
}

export interface PlayerBootstrap {
  worldId: string;
  player: BlockOwner;
  baySlotIndex: number;
  progress: LocalPlayerProgress;
  serverNow: number;
}

export interface NearbyBlocksRequest {
  worldId: string;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  radius: number;
  verticalRadius: number;
}

export interface NearbyBlocksResult {
  worldId: string;
  blocks: VoxelBlock[];
  blockCount: number;
  blockLimit: number;
  serverNow: number;
}

export interface PlaceWorldAction {
  type: "place";
  blockId: string;
  position: GridPosition;
  kind: BlockKind;
  rotation: BlockRotation;
  colorIndex: number;
  supportId?: string;
}

export interface RemoveWorldAction {
  type: "remove";
  blockId: string;
}

export interface ResetOnboardingWorldAction {
  type: "reset_onboarding";
}

export type WorldAction =
  | PlaceWorldAction
  | RemoveWorldAction
  | ResetOnboardingWorldAction;

export interface CommitWorldActionsRequest {
  worldId: string;
  idempotencyKey: string;
  actions: readonly WorldAction[];
}

export interface WorldMutationResult {
  worldId: string;
  idempotencyKey: string;
  upsertedBlocks: VoxelBlock[];
  removedBlockIds: string[];
  progress: LocalPlayerProgress;
  serverNow: number;
  replayed: boolean;
}

export type FreeModeWorldAction = PlaceWorldAction | RemoveWorldAction;

export interface CommitFreeModeActionsRequest {
  worldId: string;
  idempotencyKey: string;
  actions: readonly FreeModeWorldAction[];
}

export interface FreeModeOverviewResult {
  worldId: string;
  /** 공개 프로필만 포함하며 내부 auth UID는 절대 반환하지 않는다. */
  player: BlockOwner;
  progress: FreeModeProgress;
  maxInventory: number;
  grantAmount: number;
  grantIntervalMs: number;
  foreignRemovalAgeMs: number;
  nextGrantInMs: number | null;
  produced: number;
  serverNow: number;
}

export interface FreeModeMutationResult {
  worldId: string;
  idempotencyKey: string;
  upsertedBlocks: VoxelBlock[];
  removedBlockIds: string[];
  progress: FreeModeProgress;
  serverNow: number;
  replayed: boolean;
}

export interface ProductionResult {
  worldId: string;
  progress: LocalPlayerProgress;
  produced: number;
  serverNow: number;
  idempotencyKey?: string;
  replayed?: boolean;
}

export interface ManualProductionSession {
  id: string;
  worldId: string;
  readyAt: number;
  expiresAt: number;
  serverNow: number;
  progress: LocalPlayerProgress;
}

export interface DismantleTicket {
  id: string;
  worldId: string;
  blockId: string;
  readyAt: number;
  expiresAt: number;
  serverNow: number;
}

export interface DismantleResult {
  worldId: string;
  idempotencyKey: string;
  removedBlockId: string;
  progress: LocalPlayerProgress;
  serverNow: number;
  replayed: boolean;
}

export interface MissionOverviewResult {
  worldId: string;
  activeMission: MissionInstance;
  eligibility: {
    baseBuilt: number;
    producerBuilt: number;
    eligible: boolean;
  };
  serverNow: number;
}

export interface ContributeToMissionRequest {
  worldId: string;
  missionInstanceId: string;
  slotIndex: number;
  /** 현재 미션의 5색 팔레트 안에서 고른 위치(0~4). */
  paletteIndex: number;
  idempotencyKey: string;
}

export interface MissionContributionResult {
  worldId: string;
  idempotencyKey: string;
  /** 요청한 층의 기여 직후 상태. 마지막 슬롯이면 completed 상태다. */
  mission: MissionInstance;
  contribution: MissionContribution;
  progress: LocalPlayerProgress;
  /** 마지막 슬롯을 확정했을 때 같은 트랜잭션에서 생성된 다음 활성 층. */
  nextMission?: MissionInstance;
  serverNow: number;
  replayed: boolean;
}

export interface CompletedMissionsResult {
  worldId: string;
  missions: MissionInstance[];
  serverNow: number;
}

/**
 * 로컬·온라인 구현이 공유하는 공동 월드 데이터 계약이다. 온라인 구현의 모든
 * 변경은 검증 RPC를 통하며, 인증 UID는 어떤 반환 타입에도 포함하지 않는다.
 */
export interface CollaborativeWorldRepository {
  readonly mode: "local" | "online";

  getPlayerIdentity(worldId: string): Promise<PlayerIdentityResult>;
  bootstrapPlayer(worldId: string): Promise<PlayerBootstrap>;
  loadNearbyBlocks(request: NearbyBlocksRequest): Promise<NearbyBlocksResult>;
  loadNearbyFreeModeBlocks(
    request: NearbyBlocksRequest,
  ): Promise<NearbyBlocksResult>;
  getPublicProfiles(publicIds: readonly string[]): Promise<BlockOwner[]>;
  commitWorldActions(
    request: CommitWorldActionsRequest,
  ): Promise<WorldMutationResult>;
  getFreeModeOverview(worldId: string): Promise<FreeModeOverviewResult>;
  settleFreeModeInventory(worldId: string): Promise<FreeModeOverviewResult>;
  commitFreeModeActions(
    request: CommitFreeModeActionsRequest,
  ): Promise<FreeModeMutationResult>;
  settleProduction(worldId: string): Promise<ProductionResult>;
  startManualProduction(
    worldId: string,
    sessionId: string,
  ): Promise<ManualProductionSession>;
  completeManualProduction(
    worldId: string,
    sessionId: string,
    idempotencyKey: string,
  ): Promise<ProductionResult>;
  /** 같은 사용자의 새 철거 시작은 이전 활성 티켓을 무효화한다. */
  startDismantle(
    worldId: string,
    blockId: string,
    idempotencyKey: string,
  ): Promise<DismantleTicket>;
  cancelDismantle(worldId: string, ticketId: string): Promise<void>;
  finishDismantle(
    worldId: string,
    ticketId: string,
    idempotencyKey: string,
  ): Promise<DismantleResult>;
  getMissionOverview(worldId: string): Promise<MissionOverviewResult>;
  contributeToMission(
    request: ContributeToMissionRequest,
  ): Promise<MissionContributionResult>;
  listCompletedMissions(worldId: string): Promise<CompletedMissionsResult>;
}

export class RepositoryRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { code?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "RepositoryRequestError";
    this.code = options.code ?? "repository-error";
    this.retryable = options.retryable ?? false;
  }
}
