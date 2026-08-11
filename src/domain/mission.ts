import type { LocalPlayerProgress } from "./progression";
import type {
  BlockKind,
  BlockRotation,
  GridPosition,
  VoxelBlock,
} from "./types";

export const STARLIGHT_GATE_TEMPLATE_KEY = "starlight-gate";
export const STARLIGHT_GATE_NAME = "루멘문";
export const MISSION_CANONICAL_SLOT_COUNT = 24;
export const MISSION_RECOMMENDATION_LIMIT = 3;
export const MISSION_RECENT_CONTRIBUTION_LIMIT = 8;
export const MISSION_RENDER_LAYER_RADIUS = 2;

/**
 * 렌더러·충돌에는 현재 관람 층 주변의 고정된 수만 전달한다. 기록 전체는
 * 기록관 데이터로 남되 오래 운영된 월드가 Three.js 객체 수를 무한히 늘리지
 * 않게 한다.
 */
export function selectMissionRenderWindow<
  T extends Readonly<{ id: string; layer: number }>,
>(missions: readonly T[], focus: T, radius = MISSION_RENDER_LAYER_RADIUS): T[] {
  const boundedRadius = Math.max(0, Math.floor(radius));
  const unique = new Map<string, T>();
  for (const mission of missions) {
    unique.set(mission.id, mission);
  }
  unique.set(focus.id, focus);
  return [...unique.values()]
    .sort(
      (left, right) =>
        Math.abs(left.layer - focus.layer) -
          Math.abs(right.layer - focus.layer) || left.layer - right.layer,
    )
    .slice(0, boundedRadius * 2 + 1)
    .sort((left, right) => left.layer - right.layer);
}

export type MissionStagePercent = 0 | 25 | 50 | 75 | 100;
export type MissionStatus = "active" | "completed";

export interface MissionTemplateSlot {
  slotIndex: number;
  position: GridPosition;
  kind: BlockKind;
  rotation: BlockRotation;
}

export interface MissionTemplate {
  key: string;
  name: string;
  slots: readonly MissionTemplateSlot[];
}

export interface MissionIdentitySnapshot {
  publicId: string;
  nickname: string;
  emblem: string;
}

/** 서버에 저장되는 정규 슬롯 한 칸이다. 대칭 복제본은 이 레코드에 포함하지 않는다. */
export interface MissionContribution {
  id: string;
  blockId: string;
  missionId: string;
  missionName: string;
  missionLayer: number;
  slotIndex: number;
  position: GridPosition;
  kind: BlockKind;
  rotation: BlockRotation;
  /** 사용자가 고른 현재 5색 팔레트 안의 위치(0~4). */
  paletteIndex: number;
  colorIndex: number;
  creator: MissionIdentitySnapshot;
  createdAt: number;
}

export interface MissionContributorSummary extends MissionIdentitySnapshot {
  contributionCount: number;
  firstContributedAt: number;
  lastContributedAt: number;
}

/** 저장용 인스턴스. 집계와 추천 슬롯은 읽을 때 다시 계산한다. */
export interface MissionInstanceRecord {
  id: string;
  worldId: string;
  templateKey: string;
  name: string;
  layer: number;
  origin: GridPosition;
  rotation: BlockRotation;
  paletteSeed: number;
  status: MissionStatus;
  startedAt: number;
  completedAt: number | null;
  contributions: MissionContribution[];
}

export interface MissionInstance extends Omit<MissionInstanceRecord, "contributions"> {
  palette: number[];
  filledSlots: number;
  totalSlots: number;
  stagePercent: MissionStagePercent;
  canonicalBlocks: MissionContribution[];
  contributors: MissionContributorSummary[];
  recentContributions: MissionContribution[];
  myContributionCount: number;
  participantCount: number;
  recommendedSlotIndexes: number[];
}

export interface LocalMissionOperationRecord {
  idempotencyKey: string;
  actorPublicId: string;
  fingerprint: string;
  contributionId: string;
  missionId: string;
  completedMissionId: string | null;
  nextMissionId: string | null;
  progressAfter: LocalPlayerProgress;
  serverNow: number;
}

export interface LocalMissionWorldState {
  activeMissionId: string;
  instances: MissionInstanceRecord[];
  operations: LocalMissionOperationRecord[];
}

export interface MissionDisplayMetadata {
  missionId: string;
  missionName: string;
  missionLayer: number;
  slotIndex: number;
  canonicalBlockId: string;
  replicaQuarterTurns: 0 | 1 | 2 | 3;
  isReplica: boolean;
}

export interface MissionDisplayBlock extends VoxelBlock {
  mission: MissionDisplayMetadata;
}

export interface ApplyMissionContributionInput {
  state: LocalMissionWorldState;
  worldId: string;
  missionInstanceId: string;
  slotIndex: number;
  paletteIndex: number;
  idempotencyKey: string;
  actor: MissionIdentitySnapshot;
  progress: LocalPlayerProgress;
  now: number;
}

export interface ApplyMissionContributionResult {
  state: LocalMissionWorldState;
  mission: MissionInstance;
  contribution: MissionContribution;
  progress: LocalPlayerProgress;
  nextMission?: MissionInstance;
  replayed: boolean;
}

export class MissionRuleError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "MissionRuleError";
  }
}

const STARLIGHT_GATE_SLOTS: readonly MissionTemplateSlot[] = Object.freeze([
  // SQL 템플릿과 같은 +Z 정규 관문 한 면이다.
  slot(0, -3, 0, 5, "cube", 0),
  slot(1, -2, 0, 5, "cube", 0),
  slot(2, -1, 0, 5, "light", 0),
  slot(3, 0, 0, 5, "cube", 0),
  slot(4, 1, 0, 5, "light", 0),
  slot(5, 2, 0, 5, "cube", 0),
  slot(6, 3, 0, 5, "cube", 0),
  slot(7, -3, 1, 5, "cube", 0),
  slot(8, -3, 2, 5, "cube", 0),
  slot(9, -3, 3, 5, "cube", 0),
  slot(10, -3, 4, 5, "stair", 1),
  slot(11, -3, 5, 5, "stair", 1),
  slot(12, 3, 1, 5, "cube", 0),
  slot(13, 3, 2, 5, "cube", 0),
  slot(14, 3, 3, 5, "cube", 0),
  slot(15, 3, 4, 5, "stair", 3),
  slot(16, 3, 5, 5, "stair", 3),
  slot(17, -2, 5, 5, "cube", 0),
  slot(18, -1, 5, 5, "light", 0),
  slot(19, 0, 5, 5, "cube", 0),
  slot(20, 1, 5, 5, "light", 0),
  slot(21, 2, 5, 5, "cube", 0),
  slot(22, -2, 4, 5, "light", 0),
  slot(23, 2, 4, 5, "light", 0),
]);

export const STARLIGHT_GATE_TEMPLATE: MissionTemplate = Object.freeze({
  key: STARLIGHT_GATE_TEMPLATE_KEY,
  name: STARLIGHT_GATE_NAME,
  slots: STARLIGHT_GATE_SLOTS,
});

const STARLIGHT_BASE_PALETTE = Object.freeze([1, 4, 6, 9, 11]);

export function getMissionTemplate(templateKey: string): MissionTemplate {
  if (templateKey !== STARLIGHT_GATE_TEMPLATE_KEY) {
    throw new MissionRuleError("알 수 없는 공동 미션 템플릿입니다.", "template-not-found");
  }
  return STARLIGHT_GATE_TEMPLATE;
}

export function getMissionPalette(paletteSeed: number): number[] {
  if (!Number.isSafeInteger(paletteSeed)) {
    throw new RangeError("미션 팔레트 시드는 안전한 정수여야 합니다.");
  }
  const offset = positiveModulo(paletteSeed, STARLIGHT_BASE_PALETTE.length);
  return Array.from(
    { length: STARLIGHT_BASE_PALETTE.length },
    (_, index) =>
      STARLIGHT_BASE_PALETTE[
        (index + offset) % STARLIGHT_BASE_PALETTE.length
      ]!,
  );
}

export function missionStageFromFilledSlots(
  filledSlots: number,
): MissionStagePercent {
  if (!Number.isSafeInteger(filledSlots) || filledSlots < 0) {
    throw new RangeError("확정 슬롯 수는 0 이상의 안전한 정수여야 합니다.");
  }
  if (filledSlots >= MISSION_CANONICAL_SLOT_COUNT) return 100;
  if (filledSlots >= 18) return 75;
  if (filledSlots >= 12) return 50;
  if (filledSlots >= 6) return 25;
  return 0;
}

export function createStarlightGateInstance(
  worldId: string,
  layer: number,
  startedAt: number,
  id = localMissionId(layer),
): MissionInstanceRecord {
  if (!worldId) throw new RangeError("월드 ID가 필요합니다.");
  if (!Number.isSafeInteger(layer) || layer < 1) {
    throw new RangeError("미션 층은 1 이상의 안전한 정수여야 합니다.");
  }
  if (!Number.isFinite(startedAt) || startedAt < 0) {
    throw new RangeError("미션 시작 시각이 올바르지 않습니다.");
  }
  return {
    id,
    worldId,
    templateKey: STARLIGHT_GATE_TEMPLATE_KEY,
    name: STARLIGHT_GATE_NAME,
    layer,
    origin: { x: 0, y: 1 + (layer - 1) * 7, z: 0 },
    rotation: positiveModulo(layer - 1, 4) as BlockRotation,
    paletteSeed: layer - 1,
    status: "active",
    startedAt,
    completedAt: null,
    contributions: [],
  };
}

export function createInitialLocalMissionWorldState(
  worldId: string,
  now: number,
): LocalMissionWorldState {
  const first = createStarlightGateInstance(worldId, 1, now);
  return {
    activeMissionId: first.id,
    instances: [first],
    operations: [],
  };
}

export function cloneLocalMissionWorldState(
  state: LocalMissionWorldState,
): LocalMissionWorldState {
  return structuredClone(state);
}

/** GameApp 같은 기존 저장 경로가 미션 필드를 모를 때 최신 미션 상태를 보존한다. */
export function preserveLocalMissionState<T extends { localMissionState?: LocalMissionWorldState }>(
  snapshot: T,
  latest: { localMissionState?: LocalMissionWorldState } | null,
): T {
  const latestState = latest?.localMissionState;
  if (
    !latestState ||
    (snapshot.localMissionState &&
      compareMissionStateFreshness(snapshot.localMissionState, latestState) >= 0)
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    localMissionState: cloneLocalMissionWorldState(latestState),
  };
}

function compareMissionStateFreshness(
  left: LocalMissionWorldState,
  right: LocalMissionWorldState,
): number {
  const version = (state: LocalMissionWorldState): readonly number[] => [
    state.operations.length,
    state.instances.reduce(
      (total, instance) => total + instance.contributions.length,
      0,
    ),
    state.instances.filter(({ status }) => status === "completed").length,
    state.instances.length,
    Math.max(0, ...state.instances.map(({ layer }) => layer)),
  ];
  const leftVersion = version(left);
  const rightVersion = version(right);
  for (let index = 0; index < leftVersion.length; index += 1) {
    const difference = leftVersion[index]! - rightVersion[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function missionInstanceView(
  record: MissionInstanceRecord,
  viewerPublicId?: string,
): MissionInstance {
  const template = getMissionTemplate(record.templateKey);
  const canonicalBlocks = record.contributions.map(cloneContribution);
  const contributors = summarizeMissionContributors(canonicalBlocks);
  return {
    id: record.id,
    worldId: record.worldId,
    templateKey: record.templateKey,
    name: record.name,
    layer: record.layer,
    origin: { ...record.origin },
    rotation: record.rotation,
    paletteSeed: record.paletteSeed,
    palette: getMissionPalette(record.paletteSeed),
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    filledSlots: canonicalBlocks.length,
    totalSlots: template.slots.length,
    stagePercent: missionStageFromFilledSlots(canonicalBlocks.length),
    canonicalBlocks,
    contributors,
    recentContributions: [...canonicalBlocks]
      .sort(compareContributionNewestFirst)
      .slice(0, MISSION_RECENT_CONTRIBUTION_LIMIT),
    myContributionCount: viewerPublicId
      ? canonicalBlocks.filter(({ creator }) => creator.publicId === viewerPublicId)
          .length
      : 0,
    participantCount: contributors.length,
    recommendedSlotIndexes:
      record.status === "active"
        ? recommendMissionSlotIndexes(record)
        : [],
  };
}

export function activeMissionRecord(
  state: LocalMissionWorldState,
): MissionInstanceRecord {
  const active = state.instances.find(({ id }) => id === state.activeMissionId);
  if (!active || active.status !== "active") {
    throw new MissionRuleError("활성 공동 미션을 찾을 수 없습니다.", "active-mission-not-found");
  }
  return active;
}

export function recommendMissionSlotIndexes(
  instance: MissionInstanceRecord,
): number[] {
  const occupied = new Set(instance.contributions.map(({ slotIndex }) => slotIndex));
  return getMissionTemplate(instance.templateKey).slots
    .map(({ slotIndex }) => slotIndex)
    .filter((slotIndex) => !occupied.has(slotIndex))
    .slice(0, MISSION_RECOMMENDATION_LIMIT);
}

export function summarizeMissionContributors(
  contributions: readonly MissionContribution[],
): MissionContributorSummary[] {
  const byPublicId = new Map<string, MissionContributorSummary>();
  for (const contribution of [...contributions].sort(compareContributionOldestFirst)) {
    const previous = byPublicId.get(contribution.creator.publicId);
    if (!previous) {
      byPublicId.set(contribution.creator.publicId, {
        ...contribution.creator,
        contributionCount: 1,
        firstContributedAt: contribution.createdAt,
        lastContributedAt: contribution.createdAt,
      });
      continue;
    }
    // 공개 ID로 과거 기여를 묶되, 표시 신원은 해당 미션의 마지막 기여 시점 스냅샷이다.
    previous.nickname = contribution.creator.nickname;
    previous.emblem = contribution.creator.emblem;
    previous.contributionCount += 1;
    previous.lastContributedAt = contribution.createdAt;
  }
  return [...byPublicId.values()].sort(
    (left, right) =>
      left.firstContributedAt - right.firstContributedAt ||
      left.publicId.localeCompare(right.publicId),
  );
}

export function transformMissionSlot(
  instance: Pick<MissionInstanceRecord, "origin" | "rotation">,
  templateSlot: MissionTemplateSlot,
): Pick<MissionContribution, "position" | "kind" | "rotation"> {
  const rotated = rotateGridAroundY(templateSlot.position, instance.rotation);
  return {
    position: {
      x: instance.origin.x + rotated.x,
      y: instance.origin.y + rotated.y,
      z: instance.origin.z + rotated.z,
    },
    kind: templateSlot.kind,
    rotation: rotateBlockRotation(templateSlot.rotation, instance.rotation),
  };
}

/** 한 정규 블록을 4방향으로 복제하되 대칭축 중복 좌표는 한 번만 반환한다. */
export function expandMissionContribution(
  instance: MissionInstanceRecord | MissionInstance,
  contribution: MissionContribution,
): MissionDisplayBlock[] {
  const relative = {
    x: contribution.position.x - instance.origin.x,
    y: contribution.position.y - instance.origin.y,
    z: contribution.position.z - instance.origin.z,
  };
  const unique = new Map<string, MissionDisplayBlock>();
  for (const quarterTurns of [0, 1, 2, 3] as const) {
    const rotated = rotateGridAroundY(relative, quarterTurns);
    const position = {
      x: instance.origin.x + rotated.x,
      y: instance.origin.y + rotated.y,
      z: instance.origin.z + rotated.z,
    };
    const key = gridKey(position);
    if (unique.has(key)) continue;
    const isReplica = quarterTurns !== 0;
    unique.set(key, {
      id: isReplica
        ? `${contribution.blockId}:replica:${quarterTurns}`
        : contribution.blockId,
      worldId: instance.worldId,
      position,
      kind: contribution.kind,
      rotation: rotateBlockRotation(contribution.rotation, quarterTurns),
      colorIndex: contribution.colorIndex,
      owner: {
        id: contribution.creator.publicId,
        publicId: contribution.creator.publicId,
        nickname: contribution.creator.nickname,
        emblem: contribution.creator.emblem,
      },
      zone: "mission",
      createdAt: contribution.createdAt,
      mission: {
        missionId: instance.id,
        missionName: instance.name,
        missionLayer: instance.layer,
        slotIndex: contribution.slotIndex,
        canonicalBlockId: contribution.blockId,
        replicaQuarterTurns: quarterTurns,
        isReplica,
      },
    });
  }
  return [...unique.values()];
}

/** 인스턴스 전체를 확장하면서 템플릿 오류로 생길 수 있는 교차 슬롯 중복도 제거한다. */
export function expandMissionBlocks(
  instance: MissionInstanceRecord | MissionInstance,
): MissionDisplayBlock[] {
  const contributions =
    "canonicalBlocks" in instance
      ? instance.canonicalBlocks
      : instance.contributions;
  const unique = new Map<string, MissionDisplayBlock>();
  for (const contribution of contributions) {
    for (const block of expandMissionContribution(instance, contribution)) {
      const key = gridKey(block.position);
      if (!unique.has(key)) unique.set(key, block);
    }
  }
  return [...unique.values()];
}

export function missionBlocksByCreator(
  instance: MissionInstanceRecord | MissionInstance,
  publicId: string,
): MissionDisplayBlock[] {
  return expandMissionBlocks(instance).filter(
    ({ owner }) => owner.publicId === publicId,
  );
}

export function fingerprintMissionContribution(input: {
  worldId: string;
  missionInstanceId: string;
  slotIndex: number;
  paletteIndex: number;
}): string {
  return JSON.stringify({
    worldId: input.worldId,
    missionInstanceId: input.missionInstanceId,
    slotIndex: input.slotIndex,
    paletteIndex: input.paletteIndex,
  });
}

/** 로컬 저장소가 쓰는 순수 트랜잭션. 실패하면 입력 state/progress를 변경하지 않는다. */
export function applyMissionContribution(
  input: ApplyMissionContributionInput,
): ApplyMissionContributionResult {
  const fingerprint = fingerprintMissionContribution(input);
  const priorOperation = input.state.operations.find(
    ({ idempotencyKey, actorPublicId }) =>
      idempotencyKey === input.idempotencyKey &&
      actorPublicId === input.actor.publicId,
  );
  if (priorOperation) {
    if (priorOperation.fingerprint !== fingerprint) {
      throw new MissionRuleError(
        "같은 멱등 키를 다른 공동 미션 요청에 사용할 수 없습니다.",
        "idempotency-conflict",
      );
    }
    const priorMission = requireMission(input.state, priorOperation.missionId);
    const contribution = priorMission.contributions.find(
      ({ id }) => id === priorOperation.contributionId,
    );
    if (!contribution) {
      throw new MissionRuleError("멱등 기여 기록이 손상되었습니다.", "operation-corrupt");
    }
    const nextMission = priorOperation.nextMissionId
      ? requireMission(input.state, priorOperation.nextMissionId)
      : undefined;
    return {
      state: cloneLocalMissionWorldState(input.state),
      mission: missionInstanceView(priorMission, input.actor.publicId),
      contribution: cloneContribution(contribution),
      progress: structuredClone(priorOperation.progressAfter),
      ...(nextMission
        ? { nextMission: missionInstanceView(nextMission, input.actor.publicId) }
        : {}),
      replayed: true,
    };
  }

  validateContributionInput(input);
  const nextState = cloneLocalMissionWorldState(input.state);
  const mission = requireMission(nextState, input.missionInstanceId);
  if (
    nextState.activeMissionId !== mission.id ||
    mission.status !== "active"
  ) {
    throw new MissionRuleError("현재 활성 공동 미션이 아닙니다.", "mission-not-active");
  }
  const recommendation = recommendMissionSlotIndexes(mission);
  if (!recommendation.includes(input.slotIndex)) {
    const alreadyFilled = mission.contributions.some(
      ({ slotIndex }) => slotIndex === input.slotIndex,
    );
    throw new MissionRuleError(
      alreadyFilled
        ? "이미 확정된 공동 미션 슬롯입니다."
        : "현재 추천된 공동 미션 슬롯이 아닙니다.",
      alreadyFilled ? "slot-already-filled" : "slot-not-recommended",
    );
  }

  const template = getMissionTemplate(mission.templateKey);
  const templateSlot = template.slots.find(
    ({ slotIndex }) => slotIndex === input.slotIndex,
  );
  if (!templateSlot) {
    throw new MissionRuleError("공동 미션 슬롯을 찾을 수 없습니다.", "slot-not-found");
  }
  const palette = getMissionPalette(mission.paletteSeed);
  if (input.paletteIndex < 0 || input.paletteIndex >= palette.length) {
    throw new MissionRuleError("미션 팔레트 위치가 올바르지 않습니다.", "color-not-allowed");
  }

  const transformed = transformMissionSlot(mission, templateSlot);
  const contribution: MissionContribution = {
    id: localContributionId(input.actor.publicId, input.idempotencyKey),
    blockId: localMissionBlockId(mission.id, input.slotIndex),
    missionId: mission.id,
    missionName: mission.name,
    missionLayer: mission.layer,
    slotIndex: input.slotIndex,
    position: transformed.position,
    kind: transformed.kind,
    rotation: transformed.rotation,
    paletteIndex: input.paletteIndex,
    colorIndex: palette[input.paletteIndex]!,
    creator: { ...input.actor },
    createdAt: input.now,
  };
  mission.contributions.push(contribution);
  const progress = {
    ...structuredClone(input.progress),
    inventory: input.progress.inventory - 1,
  };

  let nextMission: MissionInstanceRecord | undefined;
  if (mission.contributions.length === template.slots.length) {
    mission.status = "completed";
    mission.completedAt = input.now;
    nextMission = createStarlightGateInstance(
      input.worldId,
      mission.layer + 1,
      input.now,
    );
    if (nextState.instances.some(({ id }) => id === nextMission!.id)) {
      throw new MissionRuleError("다음 공동 미션이 이미 존재합니다.", "next-mission-conflict");
    }
    nextState.instances.push(nextMission);
    nextState.activeMissionId = nextMission.id;
  }

  nextState.operations.push({
    idempotencyKey: input.idempotencyKey,
    actorPublicId: input.actor.publicId,
    fingerprint,
    contributionId: contribution.id,
    missionId: mission.id,
    completedMissionId: mission.status === "completed" ? mission.id : null,
    nextMissionId: nextMission?.id ?? null,
    progressAfter: structuredClone(progress),
    serverNow: input.now,
  });

  return {
    state: nextState,
    mission: missionInstanceView(mission, input.actor.publicId),
    contribution: cloneContribution(contribution),
    progress,
    ...(nextMission
      ? { nextMission: missionInstanceView(nextMission, input.actor.publicId) }
      : {}),
    replayed: false,
  };
}

function validateContributionInput(input: ApplyMissionContributionInput): void {
  if (input.worldId.length === 0 || input.state.instances.some(({ worldId }) => worldId !== input.worldId)) {
    throw new MissionRuleError("공동 미션 월드가 일치하지 않습니다.", "world-mismatch");
  }
  if (!input.progress.baseCompleted || !input.progress.producerCompleted) {
    throw new MissionRuleError(
      "개인 영역과 생산시설을 먼저 완성해야 합니다.",
      "onboarding-incomplete",
    );
  }
  if (input.progress.inventory < 1) {
    throw new MissionRuleError("블록 재고가 부족합니다.", "insufficient-inventory");
  }
  if (!Number.isSafeInteger(input.slotIndex) || input.slotIndex < 0) {
    throw new MissionRuleError("공동 미션 슬롯 번호가 올바르지 않습니다.", "slot-not-found");
  }
  if (!Number.isSafeInteger(input.paletteIndex)) {
    throw new MissionRuleError("공동 미션 팔레트 위치가 올바르지 않습니다.", "color-not-allowed");
  }
  if (!Number.isFinite(input.now) || input.now < 0) {
    throw new RangeError("기여 시각이 올바르지 않습니다.");
  }
}

function requireMission(
  state: LocalMissionWorldState,
  missionId: string,
): MissionInstanceRecord {
  const mission = state.instances.find(({ id }) => id === missionId);
  if (!mission) {
    throw new MissionRuleError("공동 미션을 찾을 수 없습니다.", "mission-not-found");
  }
  return mission;
}

function slot(
  slotIndex: number,
  x: number,
  y: number,
  z: number,
  kind: BlockKind,
  rotation: BlockRotation,
): MissionTemplateSlot {
  return Object.freeze({
    slotIndex,
    position: Object.freeze({ x, y, z }),
    kind,
    rotation,
  });
}

function rotateGridAroundY(
  position: GridPosition,
  quarterTurns: number,
): GridPosition {
  switch (positiveModulo(quarterTurns, 4)) {
    case 1:
      return { x: -position.z, y: position.y, z: position.x };
    case 2:
      return { x: -position.x, y: position.y, z: -position.z };
    case 3:
      return { x: position.z, y: position.y, z: -position.x };
    default:
      return { ...position };
  }
}

function rotateBlockRotation(
  rotation: BlockRotation,
  quarterTurns: number,
): BlockRotation {
  return positiveModulo(rotation + quarterTurns, 4) as BlockRotation;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function compareContributionOldestFirst(
  left: MissionContribution,
  right: MissionContribution,
): number {
  return left.createdAt - right.createdAt || left.slotIndex - right.slotIndex;
}

function compareContributionNewestFirst(
  left: MissionContribution,
  right: MissionContribution,
): number {
  return right.createdAt - left.createdAt || right.slotIndex - left.slotIndex;
}

function cloneContribution(
  contribution: MissionContribution,
): MissionContribution {
  return structuredClone(contribution);
}

function gridKey(position: GridPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function localMissionId(layer: number): string {
  return `local-mission-layer-${layer}`;
}

function localContributionId(publicId: string, idempotencyKey: string): string {
  return `local-mission-contribution-${publicId.slice(1)}-${idempotencyKey}`;
}

function localMissionBlockId(missionId: string, slotIndex: number): string {
  return `${missionId}-slot-${slotIndex}`;
}

