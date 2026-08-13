import type { WorldSnapshot } from "../domain/types";
import {
  cloneLocalFreeModeWorldState,
  FREE_MODE_IDEMPOTENCY_CLEANUP_LIMIT,
  FREE_MODE_IDEMPOTENCY_RETENTION_MS,
  type LocalFreeModeOperation,
} from "../domain/freeMode";
import { preserveLocalMissionState } from "../domain/mission";
import { preserveLocalFreeModeState } from "../domain/freeMode";

export interface WorldRepository {
  load(worldId: string): Promise<WorldSnapshot | null>;
  save(snapshot: WorldSnapshot): Promise<void>;
  loadFreeModeOperation(
    worldId: string,
    playerId: string,
    idempotencyKey: string,
    authorityNow: number,
  ): Promise<LocalFreeModeOperation | null>;
  saveFreeModeCommit(
    snapshot: WorldSnapshot,
    playerId: string,
    operation: LocalFreeModeOperation,
    expectedRevision: number,
  ): Promise<void>;
  saveFreeModeState(
    snapshot: WorldSnapshot,
    playerId: string,
    expectedRevision: number,
  ): Promise<void>;
}

export class FreeModeRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `자유 모드 상태가 변경되었습니다. expected=${expectedRevision}, actual=${actualRevision}`,
    );
    this.name = "FreeModeRevisionConflictError";
  }
}

export class MemoryWorldRepository implements WorldRepository {
  private readonly snapshots = new Map<string, WorldSnapshot>();
  private readonly freeModeOperations = new Map<string, LocalFreeModeOperation>();

  async load(worldId: string): Promise<WorldSnapshot | null> {
    const snapshot = this.snapshots.get(worldId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async save(snapshot: WorldSnapshot): Promise<void> {
    const latest = this.snapshots.get(snapshot.worldId) ?? null;
    const withBlocks = mergeWorldBlocksByAuthority(snapshot, latest, "non-free");
    const withMissionState = preserveLocalMissionState(withBlocks, latest);
    const preserved = preserveLocalFreeModeState(withMissionState, latest);
    this.assertAndMigrateInlineFreeModeOperations(preserved);
    this.snapshots.set(
      snapshot.worldId,
      structuredClone(
        withoutInlineFreeModeOperations(preserved),
      ),
    );
  }

  async loadFreeModeOperation(
    worldId: string,
    playerId: string,
    idempotencyKey: string,
    authorityNow: number,
  ): Promise<LocalFreeModeOperation | null> {
    this.deleteExpiredFreeModeOperations(authorityNow);
    const key = freeModeOperationKey(worldId, playerId, idempotencyKey);
    const operation = this.freeModeOperations.get(key);
    if (
      operation &&
      operation.serverNow + FREE_MODE_IDEMPOTENCY_RETENTION_MS <= authorityNow
    ) {
      this.freeModeOperations.delete(key);
      return null;
    }
    return operation ? structuredClone(operation) : null;
  }

  async saveFreeModeCommit(
    snapshot: WorldSnapshot,
    playerId: string,
    operation: LocalFreeModeOperation,
    expectedRevision: number,
  ): Promise<void> {
    this.deleteExpiredFreeModeOperations(operation.serverNow);
    const latest = this.snapshots.get(snapshot.worldId) ?? null;
    assertFreeModeRevision(latest, snapshot, expectedRevision);
    const withBlocks = mergeWorldBlocksByAuthority(snapshot, latest, "free");
    const withMissionState = preserveLocalMissionState(withBlocks, latest);
    const preserved = preserveLocalFreeModeState(withMissionState, latest);
    this.assertAndMigrateInlineFreeModeOperations(preserved);
    const operationKey = freeModeOperationKey(
      snapshot.worldId,
      playerId,
      operation.idempotencyKey,
    );
    let existingOperation = this.freeModeOperations.get(operationKey);
    if (
      existingOperation &&
      existingOperation.serverNow + FREE_MODE_IDEMPOTENCY_RETENTION_MS <=
        operation.serverNow
    ) {
      this.freeModeOperations.delete(operationKey);
      existingOperation = undefined;
    }
    if (
      existingOperation &&
      existingOperation.fingerprint !== operation.fingerprint
    ) {
      throw new Error("같은 action key의 저장 내용이 일치하지 않습니다.");
    }
    this.freeModeOperations.set(
      operationKey,
      structuredClone(operation),
    );
    this.snapshots.set(
      snapshot.worldId,
      structuredClone(withoutInlineFreeModeOperations(preserved)),
    );
  }

  async saveFreeModeState(
    snapshot: WorldSnapshot,
    _playerId: string,
    expectedRevision: number,
  ): Promise<void> {
    this.deleteExpiredFreeModeOperations(snapshot.updatedAt);
    const latest = this.snapshots.get(snapshot.worldId) ?? null;
    assertFreeModeRevision(latest, snapshot, expectedRevision);
    const withBlocks = mergeWorldBlocksByAuthority(snapshot, latest, "free");
    const withMissionState = preserveLocalMissionState(withBlocks, latest);
    const preserved = preserveLocalFreeModeState(withMissionState, latest);
    this.assertAndMigrateInlineFreeModeOperations(preserved);
    this.snapshots.set(
      snapshot.worldId,
      structuredClone(withoutInlineFreeModeOperations(preserved)),
    );
  }

  private assertAndMigrateInlineFreeModeOperations(
    snapshot: WorldSnapshot,
  ): void {
    const pending: Array<[string, LocalFreeModeOperation]> = [];
    for (const state of snapshot.localFreeModeStates ?? []) {
      for (const operation of state.operations) {
        const key = freeModeOperationKey(
          snapshot.worldId,
          state.playerId,
          operation.idempotencyKey,
        );
        const existing = this.freeModeOperations.get(key);
        if (existing && existing.fingerprint !== operation.fingerprint) {
          throw new Error("같은 action key의 저장 내용이 일치하지 않습니다.");
        }
        if (!existing) {
          pending.push([key, structuredClone(operation)]);
        }
      }
    }
    for (const [key, operation] of pending) {
      this.freeModeOperations.set(key, operation);
    }
  }

  private deleteExpiredFreeModeOperations(authorityNow: number): void {
    let deleted = 0;
    for (const [key, operation] of this.freeModeOperations) {
      if (
        operation.serverNow + FREE_MODE_IDEMPOTENCY_RETENTION_MS <=
        authorityNow
      ) {
        this.freeModeOperations.delete(key);
        deleted += 1;
        if (deleted >= FREE_MODE_IDEMPOTENCY_CLEANUP_LIMIT) return;
      }
    }
  }
}

export function withoutInlineFreeModeOperations(
  snapshot: WorldSnapshot,
): WorldSnapshot {
  if (!snapshot.localFreeModeStates) return snapshot;
  return {
    ...snapshot,
    localFreeModeStates: snapshot.localFreeModeStates.map((state) => ({
      ...cloneLocalFreeModeWorldState(state),
      operations: [],
    })),
  };
}

export function freeModeOperationKey(
  worldId: string,
  playerId: string,
  idempotencyKey: string,
): string {
  return `${worldId}\u0000${playerId}\u0000${idempotencyKey}`;
}

export function freeModeRevision(
  snapshot: WorldSnapshot | null,
): number {
  if (!snapshot) return 0;
  const stateRevision = (snapshot.localFreeModeStates ?? []).reduce(
    (highest, state) => Math.max(highest, state.revision ?? 0),
    0,
  );
  if (
    Number.isSafeInteger(snapshot.localFreeModeRevision) &&
    (snapshot.localFreeModeRevision ?? -1) >= 0
  ) {
    return Math.max(snapshot.localFreeModeRevision!, stateRevision);
  }
  return stateRevision;
}

export function assertFreeModeRevision(
  latest: WorldSnapshot | null,
  incoming: WorldSnapshot,
  expectedRevision: number,
): void {
  const actualRevision = freeModeRevision(latest);
  if (actualRevision !== expectedRevision) {
    throw new FreeModeRevisionConflictError(expectedRevision, actualRevision);
  }
  const incomingRevision = freeModeRevision(incoming);
  if (incomingRevision !== expectedRevision + 1) {
    throw new RangeError(
      "자유 모드 저장 revision은 이전 값보다 정확히 1 커야 합니다.",
    );
  }
}

/**
 * 일반 저장은 non-free 블록만, 자유 저장은 free 블록만 이번 snapshot을 권위로 본다.
 * IndexedDB transaction 안의 최신 상대 모드 블록을 합쳐 병행 탭의 덮어쓰기를 막는다.
 */
export function mergeWorldBlocksByAuthority(
  incoming: WorldSnapshot,
  latest: WorldSnapshot | null,
  authority: "non-free" | "free",
): WorldSnapshot {
  if (!latest) {
    return authority === "free"
      ? { ...incoming, localFreeModeRevision: freeModeRevision(incoming) }
      : incoming;
  }
  const incomingBlocks = incoming.blocks.filter(({ source }) =>
    authority === "free" ? source === "free" : source !== "free",
  );
  const latestBlocks = latest.blocks.filter(({ source }) =>
    authority === "free" ? source !== "free" : source === "free",
  );
  return {
    ...incoming,
    updatedAt: Math.max(incoming.updatedAt, latest.updatedAt),
    ...(authority === "free" && latest.localState
      ? { localState: structuredClone(latest.localState) }
      : {}),
    localFreeModeRevision:
      authority === "free"
        ? freeModeRevision(incoming)
        : freeModeRevision(latest),
    blocks:
      authority === "free"
        ? [...latestBlocks, ...incomingBlocks]
        : [...incomingBlocks, ...latestBlocks],
  };
}
