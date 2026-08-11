import {
  MAX_WORLD_ACTION_PAYLOAD_BYTES,
  MAX_WORLD_ACTIONS_PER_COMMIT,
  type CommitWorldActionsRequest,
  type PlaceWorldAction,
} from "./CollaborativeWorldRepository";

const WORLD_MIN = -512;
const WORLD_MAX = 512;
const WORLD_HEIGHT = 32_760;

export function validateCommitWorldActions(
  request: CommitWorldActionsRequest,
): void {
  assertUuid(request.idempotencyKey, "멱등 키");
  let payloadBytes: number;
  try {
    payloadBytes = new TextEncoder().encode(
      JSON.stringify(request.actions),
    ).byteLength;
  } catch {
    throw new RangeError("월드 작업 payload를 직렬화할 수 없습니다.");
  }
  if (payloadBytes > MAX_WORLD_ACTION_PAYLOAD_BYTES) {
    throw new RangeError(
      `월드 작업 payload는 ${MAX_WORLD_ACTION_PAYLOAD_BYTES}바이트 이하여야 합니다.`,
    );
  }
  if (
    request.actions.length === 0 ||
    request.actions.length > MAX_WORLD_ACTIONS_PER_COMMIT
  ) {
    throw new RangeError(
      `한 번에 1~${MAX_WORLD_ACTIONS_PER_COMMIT}개 작업만 보낼 수 있습니다.`,
    );
  }

  const placedPositions = new Set<string>();
  const placedById = new Map<string, PlaceWorldAction>();
  let resetCount = 0;
  for (const action of request.actions) {
    if (action.type === "reset_onboarding") {
      resetCount += 1;
      if (request.actions.length !== 1 || resetCount > 1) {
        throw new RangeError("온보딩 초기화는 단독 작업으로 보내야 합니다.");
      }
      continue;
    }

    assertUuid(action.blockId, "블록 ID");
    if (action.type === "remove") {
      continue;
    }

    validatePosition(action.position);
    if (
      action.kind !== "cube" &&
      action.kind !== "stair" &&
      action.kind !== "light"
    ) {
      throw new RangeError("알 수 없는 블록 종류입니다.");
    }
    if (
      action.rotation !== 0 &&
      action.rotation !== 1 &&
      action.rotation !== 2 &&
      action.rotation !== 3
    ) {
      throw new RangeError("블록 회전은 0~3 정수여야 합니다.");
    }
    if (
      !Number.isSafeInteger(action.colorIndex) ||
      action.colorIndex < 0 ||
      action.colorIndex > 11
    ) {
      throw new RangeError("색상 번호는 0~11 정수여야 합니다.");
    }
    if (action.supportId) {
      assertUuid(action.supportId, "지지 블록 ID");
      if (action.supportId === action.blockId) {
        throw new RangeError("블록은 자기 자신을 지지 블록으로 사용할 수 없습니다.");
      }
      const inBatchSupport = placedById.get(action.supportId);
      if (inBatchSupport && !areFaceAdjacent(inBatchSupport.position, action.position)) {
        throw new RangeError("같은 커밋의 지지 블록은 배치 면에 인접해야 합니다.");
      }
    }
    const positionKey = `${action.position.x},${action.position.y},${action.position.z}`;
    if (placedPositions.has(positionKey)) {
      throw new RangeError("한 커밋 안에서 배치 좌표가 중복되었습니다.");
    }
    placedPositions.add(positionKey);
    if (placedById.has(action.blockId)) {
      throw new RangeError("한 커밋 안에서 블록 ID가 중복되었습니다.");
    }
    placedById.set(action.blockId, action);
  }
}

export function areFaceAdjacent(
  left: Readonly<{ x: number; y: number; z: number }>,
  right: Readonly<{ x: number; y: number; z: number }>,
): boolean {
  return (
    Math.abs(left.x - right.x) +
      Math.abs(left.y - right.y) +
      Math.abs(left.z - right.z) ===
    1
  );
}

function validatePosition(position: Readonly<{ x: number; y: number; z: number }>): void {
  if (
    !Number.isSafeInteger(position.x) ||
    !Number.isSafeInteger(position.y) ||
    !Number.isSafeInteger(position.z)
  ) {
    throw new RangeError("블록 좌표는 안전한 정수여야 합니다.");
  }
  if (
    position.x < WORLD_MIN ||
    position.x > WORLD_MAX ||
    position.z < WORLD_MIN ||
    position.z > WORLD_MAX ||
    position.y < 0 ||
    position.y > WORLD_HEIGHT
  ) {
    throw new RangeError("블록 좌표가 월드 경계를 벗어났습니다.");
  }
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new RangeError(`${label}은(는) UUID여야 합니다.`);
  }
}
