import type { WorldSnapshot } from "../domain/types";
import { preserveLocalMissionState } from "../domain/mission";
import type { WorldRepository } from "./WorldRepository";

const DATABASE_NAME = "lumenmoon";
const DATABASE_VERSION = 1;
const WORLD_STORE = "worlds";

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
    const transaction = database.transaction(WORLD_STORE, "readwrite");
    const store = transaction.objectStore(WORLD_STORE);
    const latest = await requestResult<WorldSnapshot | undefined>(
      store.get(snapshot.worldId),
    );
    store.put(
      structuredClone(preserveLocalMissionState(snapshot, latest ?? null)),
    );
    await transactionDone(transaction);
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) {
      return this.databasePromise;
    }

    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(WORLD_STORE)) {
          database.createObjectStore(WORLD_STORE, { keyPath: "worldId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB를 열 수 없습니다."));
      request.onblocked = () =>
        reject(new Error("다른 탭이 저장소 갱신을 막고 있습니다."));
    });

    return this.databasePromise;
  }
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
