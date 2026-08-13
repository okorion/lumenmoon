import type { WorldSnapshot } from "../domain/types";
import {
  FREE_MODE_IDEMPOTENCY_CLEANUP_LIMIT,
  FREE_MODE_IDEMPOTENCY_RETENTION_MS,
  type LocalFreeModeOperation,
} from "../domain/freeMode";
import { preserveLocalMissionState } from "../domain/mission";
import { preserveLocalFreeModeState } from "../domain/freeMode";
import {
  assertFreeModeRevision,
  mergeWorldBlocksByAuthority,
  withoutInlineFreeModeOperations,
  type WorldRepository,
} from "./WorldRepository";

const DATABASE_NAME = "lumenmoon";
const DATABASE_VERSION = 3;
const WORLD_STORE = "worlds";
const FREE_MODE_OPERATION_STORE = "free-mode-operations";
const FREE_MODE_OPERATION_EXPIRATION_INDEX = "expires-at";

export class IndexedDbUpgradeBlockedError extends Error {
  constructor() {
    super("다른 탭이 저장소 갱신을 막고 있습니다. 다른 게임 탭을 닫고 다시 시도해 주세요.");
    this.name = "IndexedDbUpgradeBlockedError";
  }
}

interface StoredFreeModeOperation extends LocalFreeModeOperation {
  worldId: string;
  playerId: string;
  expiresAt: number;
}

export class IndexedDbWorldRepository implements WorldRepository {
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory) {}

  async load(worldId: string): Promise<WorldSnapshot | null> {
    const database = await this.open();
    const transaction = database.transaction(WORLD_STORE, "readonly");
    const request = transaction.objectStore(WORLD_STORE).get(worldId);
    const value = await requestResult<WorldSnapshot | undefined>(request);
    await transactionDone(transaction);
    return value ? structuredClone(value) : null;
  }

  async save(snapshot: WorldSnapshot): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(
      [WORLD_STORE, FREE_MODE_OPERATION_STORE],
      "readwrite",
    );
    const store = transaction.objectStore(WORLD_STORE);
    const latest = await requestResult<WorldSnapshot | undefined>(
      store.get(snapshot.worldId),
    );
    const withBlocks = mergeWorldBlocksByAuthority(
      snapshot,
      latest ?? null,
      "non-free",
    );
    const withMissionState = preserveLocalMissionState(withBlocks, latest ?? null);
    const preserved = preserveLocalFreeModeState(withMissionState, latest ?? null);
    await migrateInlineFreeModeOperations(transaction, preserved);
    store.put(
      structuredClone(withoutInlineFreeModeOperations(preserved)),
    );
    await transactionDone(transaction);
  }

  async loadFreeModeOperation(
    worldId: string,
    playerId: string,
    idempotencyKey: string,
    authorityNow: number,
  ): Promise<LocalFreeModeOperation | null> {
    const database = await this.open();
    const transaction = database.transaction(
      FREE_MODE_OPERATION_STORE,
      "readwrite",
    );
    await deleteExpiredFreeModeOperations(transaction, authorityNow);
    const operationStore = transaction.objectStore(FREE_MODE_OPERATION_STORE);
    const operationKey = [worldId, playerId, idempotencyKey];
    const request = operationStore.get(operationKey);
    const stored = await requestResult<StoredFreeModeOperation | undefined>(request);
    if (stored && stored.expiresAt <= authorityNow) {
      operationStore.delete(operationKey);
      await transactionDone(transaction);
      return null;
    }
    await transactionDone(transaction);
    if (!stored) return null;
    return structuredClone({
      idempotencyKey: stored.idempotencyKey,
      fingerprint: stored.fingerprint,
      upsertedBlocks: stored.upsertedBlocks,
      removedBlockIds: stored.removedBlockIds,
      progress: stored.progress,
      serverNow: stored.serverNow,
    });
  }

  async saveFreeModeCommit(
    snapshot: WorldSnapshot,
    playerId: string,
    operation: LocalFreeModeOperation,
    expectedRevision: number,
  ): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(
      [WORLD_STORE, FREE_MODE_OPERATION_STORE],
      "readwrite",
    );
    const worldStore = transaction.objectStore(WORLD_STORE);
    const latest = await requestResult<WorldSnapshot | undefined>(
      worldStore.get(snapshot.worldId),
    );
    try {
      assertFreeModeRevision(
        latest ?? null,
        snapshot,
        expectedRevision,
      );
    } catch (error) {
      transaction.abort();
      throw error;
    }
    const withBlocks = mergeWorldBlocksByAuthority(
      snapshot,
      latest ?? null,
      "free",
    );
    const withMissionState = preserveLocalMissionState(withBlocks, latest ?? null);
    const preserved = preserveLocalFreeModeState(withMissionState, latest ?? null);
    await migrateInlineFreeModeOperations(transaction, preserved);
    const operationStore = transaction.objectStore(FREE_MODE_OPERATION_STORE);
    await deleteExpiredFreeModeOperations(transaction, operation.serverNow);
    let existing = await requestResult<StoredFreeModeOperation | undefined>(
      operationStore.get([snapshot.worldId, playerId, operation.idempotencyKey]),
    );
    if (existing && existing.expiresAt <= operation.serverNow) {
      operationStore.delete([
        snapshot.worldId,
        playerId,
        operation.idempotencyKey,
      ]);
      existing = undefined;
    }
    if (existing && existing.fingerprint !== operation.fingerprint) {
      transaction.abort();
      throw new Error("같은 action key의 저장 내용이 일치하지 않습니다.");
    }
    operationStore.put({
      ...structuredClone(operation),
      worldId: snapshot.worldId,
      playerId,
      expiresAt:
        operation.serverNow + FREE_MODE_IDEMPOTENCY_RETENTION_MS,
    } satisfies StoredFreeModeOperation);
    worldStore.put(structuredClone(withoutInlineFreeModeOperations(preserved)));
    await transactionDone(transaction);
  }

  async saveFreeModeState(
    snapshot: WorldSnapshot,
    _playerId: string,
    expectedRevision: number,
  ): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(
      [WORLD_STORE, FREE_MODE_OPERATION_STORE],
      "readwrite",
    );
    const worldStore = transaction.objectStore(WORLD_STORE);
    await deleteExpiredFreeModeOperations(transaction, snapshot.updatedAt);
    const latest = await requestResult<WorldSnapshot | undefined>(
      worldStore.get(snapshot.worldId),
    );
    try {
      assertFreeModeRevision(
        latest ?? null,
        snapshot,
        expectedRevision,
      );
    } catch (error) {
      transaction.abort();
      throw error;
    }
    const withBlocks = mergeWorldBlocksByAuthority(
      snapshot,
      latest ?? null,
      "free",
    );
    const withMissionState = preserveLocalMissionState(withBlocks, latest ?? null);
    const preserved = preserveLocalFreeModeState(withMissionState, latest ?? null);
    await migrateInlineFreeModeOperations(transaction, preserved);
    worldStore.put(structuredClone(withoutInlineFreeModeOperations(preserved)));
    await transactionDone(transaction);
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) {
      return this.databasePromise;
    }

    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = (event) => {
        const database = request.result;
        if (!database.objectStoreNames.contains(WORLD_STORE)) {
          database.createObjectStore(WORLD_STORE, { keyPath: "worldId" });
        }
        const operationStore = database.objectStoreNames.contains(
          FREE_MODE_OPERATION_STORE,
        )
          ? request.transaction!.objectStore(FREE_MODE_OPERATION_STORE)
          : database.createObjectStore(FREE_MODE_OPERATION_STORE, {
            keyPath: ["worldId", "playerId", "idempotencyKey"],
          });
        if (
          !operationStore.indexNames.contains(
            FREE_MODE_OPERATION_EXPIRATION_INDEX,
          )
        ) {
          operationStore.createIndex(
            FREE_MODE_OPERATION_EXPIRATION_INDEX,
            "expiresAt",
          );
        }
        if (event.oldVersion < 2 && request.transaction) {
          migrateVersionOneWorlds(request.transaction);
        }
        if (event.oldVersion >= 2 && event.oldVersion < 3 && request.transaction) {
          migrateVersionTwoOperations(request.transaction);
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          this.databasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB를 열 수 없습니다."));
      request.onblocked = () =>
        reject(new IndexedDbUpgradeBlockedError());
    });

    return this.databasePromise;
  }
}

/** v1 snapshot inline 원장을 v2 별도 store로 같은 upgrade transaction에서 옮긴다. */
function migrateVersionOneWorlds(transaction: IDBTransaction): void {
  const worlds = transaction.objectStore(WORLD_STORE);
  const operations = transaction.objectStore(FREE_MODE_OPERATION_STORE);
  const request = worlds.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const snapshot = cursor.value as WorldSnapshot;
    const seen = new Map<string, string>();
    let hasInlineOperations = false;
    for (const state of snapshot.localFreeModeStates ?? []) {
      for (const operation of state.operations) {
        const key = `${state.playerId}\u0000${operation.idempotencyKey}`;
        const fingerprint = seen.get(key);
        if (fingerprint && fingerprint !== operation.fingerprint) {
          transaction.abort();
          return;
        }
        seen.set(key, operation.fingerprint);
        hasInlineOperations = true;
        operations.put({
          ...structuredClone(operation),
          worldId: snapshot.worldId,
          playerId: state.playerId,
          expiresAt:
            operation.serverNow + FREE_MODE_IDEMPOTENCY_RETENTION_MS,
        } satisfies StoredFreeModeOperation);
      }
    }
    if (hasInlineOperations) {
      cursor.update(
        structuredClone(withoutInlineFreeModeOperations(snapshot)),
      );
    }
    cursor.continue();
  };
}

/** v2 원장에 만료 시각을 더해 v3 만료 index에 포함시킨. */
function migrateVersionTwoOperations(transaction: IDBTransaction): void {
  const operations = transaction.objectStore(FREE_MODE_OPERATION_STORE);
  const request = operations.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const operation = cursor.value as Omit<StoredFreeModeOperation, "expiresAt"> & {
      expiresAt?: number;
    };
    if (!Number.isFinite(operation.expiresAt)) {
      cursor.update({
        ...operation,
        expiresAt:
          operation.serverNow + FREE_MODE_IDEMPOTENCY_RETENTION_MS,
      } satisfies StoredFreeModeOperation);
    }
    cursor.continue();
  };
}

async function migrateInlineFreeModeOperations(
  transaction: IDBTransaction,
  snapshot: WorldSnapshot,
): Promise<void> {
  const store = transaction.objectStore(FREE_MODE_OPERATION_STORE);
  for (const state of snapshot.localFreeModeStates ?? []) {
    for (const operation of state.operations) {
      const key = [snapshot.worldId, state.playerId, operation.idempotencyKey];
      const existing = await requestResult<StoredFreeModeOperation | undefined>(
        store.get(key),
      );
      if (existing && existing.fingerprint !== operation.fingerprint) {
        transaction.abort();
        throw new Error("같은 action key의 저장 내용이 일치하지 않습니다.");
      }
      store.put({
        ...structuredClone(operation),
        worldId: snapshot.worldId,
        playerId: state.playerId,
        expiresAt:
          operation.serverNow + FREE_MODE_IDEMPOTENCY_RETENTION_MS,
      } satisfies StoredFreeModeOperation);
    }
  }
}

function deleteExpiredFreeModeOperations(
  transaction: IDBTransaction,
  authorityNow: number,
): Promise<void> {
  const index = transaction
    .objectStore(FREE_MODE_OPERATION_STORE)
    .index(FREE_MODE_OPERATION_EXPIRATION_INDEX);
  return new Promise((resolve, reject) => {
    let deleted = 0;
    const request = index.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || Number(cursor.key) > authorityNow) {
        resolve();
        return;
      }
      cursor.delete();
      deleted += 1;
      if (deleted >= FREE_MODE_IDEMPOTENCY_CLEANUP_LIMIT) {
        resolve();
        return;
      }
      cursor.continue();
    };
    request.onerror = () =>
      reject(
        request.error ??
          new Error("IndexedDB 만료 멱등 기록을 정리하지 못했습니다."),
      );
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB 요청에 실패했습니다."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB 저장에 실패했습니다."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB 저장이 취소되었습니다."));
  });
}
