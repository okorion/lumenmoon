import type { AnalyticsMilestone } from "./types";

const DATABASE_NAME = "one-more-block-analytics";
const DATABASE_VERSION = 1;
const STORE_NAME = "lifecycle";
const STATE_KEY = "device";

export interface AnalyticsLifecycleState {
  firstSessionAt: number | null;
  milestones: Partial<Record<AnalyticsMilestone, number>>;
}

export interface FirstSessionResult {
  firstSessionAt: number;
  firstVisit: boolean;
}

export interface MilestoneMarkResult {
  firstSessionAt: number;
  firstReached: boolean;
}

export interface AnalyticsMilestoneStore {
  ensureFirstSession(timestamp: number): Promise<FirstSessionResult>;
  markMilestone(
    milestone: AnalyticsMilestone,
    timestamp: number,
  ): Promise<MilestoneMarkResult>;
  read(): Promise<AnalyticsLifecycleState>;
}

export class MemoryAnalyticsMilestoneStore implements AnalyticsMilestoneStore {
  private state: AnalyticsLifecycleState = createEmptyState();

  async ensureFirstSession(timestamp: number): Promise<FirstSessionResult> {
    const firstVisit = this.state.firstSessionAt === null;
    this.state.firstSessionAt ??= timestamp;
    return { firstSessionAt: this.state.firstSessionAt, firstVisit };
  }

  async markMilestone(
    milestone: AnalyticsMilestone,
    timestamp: number,
  ): Promise<MilestoneMarkResult> {
    this.state.firstSessionAt ??= timestamp;
    const firstReached = this.state.milestones[milestone] === undefined;
    if (firstReached) {
      this.state.milestones[milestone] = timestamp;
    }
    return {
      firstSessionAt: this.state.firstSessionAt,
      firstReached,
    };
  }

  async read(): Promise<AnalyticsLifecycleState> {
    return structuredClone(this.state);
  }
}

export class IndexedDbAnalyticsMilestoneStore
  implements AnalyticsMilestoneStore
{
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory) {}

  async ensureFirstSession(timestamp: number): Promise<FirstSessionResult> {
    return this.update((state) => {
      const firstVisit = state.firstSessionAt === null;
      state.firstSessionAt ??= timestamp;
      return { firstSessionAt: state.firstSessionAt, firstVisit };
    });
  }

  async markMilestone(
    milestone: AnalyticsMilestone,
    timestamp: number,
  ): Promise<MilestoneMarkResult> {
    return this.update((state) => {
      state.firstSessionAt ??= timestamp;
      const firstReached = state.milestones[milestone] === undefined;
      if (firstReached) {
        state.milestones[milestone] = timestamp;
      }
      return { firstSessionAt: state.firstSessionAt, firstReached };
    });
  }

  async read(): Promise<AnalyticsLifecycleState> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const state = await requestResult<AnalyticsLifecycleState | undefined>(
      transaction.objectStore(STORE_NAME).get(STATE_KEY),
    );
    await transactionDone(transaction);
    return structuredClone(state ?? createEmptyState());
  }

  private async update<T>(
    mutate: (state: AnalyticsLifecycleState) => T,
  ): Promise<T> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const existing = await requestResult<AnalyticsLifecycleState | undefined>(
      store.get(STATE_KEY),
    );
    const state = structuredClone(existing ?? createEmptyState());
    const result = mutate(state);
    store.put(state, STATE_KEY);
    await transactionDone(transaction);
    return result;
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) {
      return this.databasePromise;
    }
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("analytics_db_open"));
      request.onblocked = () => reject(new Error("analytics_db_blocked"));
    });
    return this.databasePromise;
  }
}

function createEmptyState(): AnalyticsLifecycleState {
  return { firstSessionAt: null, milestones: {} };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("analytics_db_request"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("analytics_db_transaction"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("analytics_db_transaction_aborted"));
  });
}
