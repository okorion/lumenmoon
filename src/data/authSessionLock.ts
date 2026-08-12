import { RepositoryRequestError } from "./CollaborativeWorldRepository";

type AsyncOperation<T> = () => Promise<T>;

interface BakeryTicket {
  expiresAt: number;
  ticket: number;
}

const PROCESS_LOCKS = new Map<string, Promise<void>>();
const MIN_LOCK_WAIT_MS = 5_000;
const MIN_TICKET_LEASE_MS = 60_000;
const STORAGE_POLL_MS = 20;

/**
 * Supabase auth-js 2.112 does not lock its default browser auth path. Keep the
 * initial anonymous sign-up atomic across tabs that share the same auth
 * storage. No user id, token, or other credential is written to the lock.
 */
export async function withAuthSessionLock<T>(
  name: string,
  requestTimeoutMs: number,
  operation: AsyncOperation<T>,
): Promise<T> {
  const waitTimeoutMs = Math.max(
    MIN_LOCK_WAIT_MS,
    Math.min(requestTimeoutMs * 4 + 10_000, 300_000),
  );
  const lockManager = browserLockManager();
  if (lockManager) {
    return withWebLock(lockManager, name, waitTimeoutMs, operation);
  }

  const storage = browserLocalStorage();
  if (storage) {
    return withStorageBakeryLock(
      storage,
      name,
      waitTimeoutMs,
      Math.max(MIN_TICKET_LEASE_MS, requestTimeoutMs * 4 + 10_000),
      operation,
    );
  }

  if (typeof globalThis.window !== "undefined") {
    // A browser without either cross-tab primitive cannot prove that another
    // tab is not signing up at the same time. Fail closed instead of replacing
    // another anonymous session in shared storage.
    throw coordinationError(
      "이 브라우저에서는 익명 계정을 안전하게 만들 수 없습니다. 브라우저를 업데이트한 뒤 다시 시도해 주세요.",
      "auth-coordination-unavailable",
      false,
    );
  }

  // Node-based integration tests and non-browser runtimes have no tabs. A
  // process mutex still protects multiple repository instances in one realm.
  return withProcessLock(name, operation);
}

function browserLockManager(): LockManager | null {
  try {
    return typeof globalThis.navigator !== "undefined" &&
      globalThis.navigator.locks
      ? globalThis.navigator.locks
      : null;
  } catch {
    return null;
  }
}

function browserLocalStorage(): Storage | null {
  if (typeof globalThis.window === "undefined") {
    return null;
  }
  try {
    const storage = globalThis.localStorage;
    const probe = "lumenmoon:auth-lock:probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

async function withWebLock<T>(
  lockManager: LockManager,
  name: string,
  waitTimeoutMs: number,
  operation: AsyncOperation<T>,
): Promise<T> {
  const controller = new AbortController();
  let acquired = false;
  const timer = globalThis.setTimeout(() => controller.abort(), waitTimeoutMs);
  try {
    return await lockManager.request(
      name,
      { mode: "exclusive", signal: controller.signal },
      async (lock) => {
        if (!lock) {
          throw coordinationError(
            "익명 계정 준비 잠금을 얻지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
            "auth-lock-unavailable",
            true,
          );
        }
        acquired = true;
        globalThis.clearTimeout(timer);
        return operation();
      },
    );
  } catch (error) {
    if (!acquired && controller.signal.aborted) {
      throw coordinationError(
        "다른 탭의 익명 계정 준비가 끝나지 않았습니다. 잠시 뒤 다시 시도해 주세요.",
        "auth-lock-timeout",
        true,
      );
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function withStorageBakeryLock<T>(
  storage: Storage,
  name: string,
  waitTimeoutMs: number,
  leaseMs: number,
  operation: AsyncOperation<T>,
): Promise<T> {
  const prefix = `${name}:bakery:`;
  const contender = randomLockId();
  const choosingKey = `${prefix}choosing:${contender}`;
  const ticketKey = `${prefix}ticket:${contender}`;
  const deadline = Date.now() + waitTimeoutMs;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  try {
    writeTicket(storage, choosingKey, {
      expiresAt: Date.now() + leaseMs,
      ticket: 0,
    });
    const nextTicket = maxActiveTicket(storage, prefix) + 1;
    if (!Number.isSafeInteger(nextTicket)) {
      throw coordinationError(
        "익명 계정 준비 순서를 만들지 못했습니다. 다시 시도해 주세요.",
        "auth-lock-invalid-state",
        true,
      );
    }
    writeTicket(storage, ticketKey, {
      expiresAt: Date.now() + leaseMs,
      ticket: nextTicket,
    });
    storage.removeItem(choosingKey);

    while (!ownsLowestTicket(storage, prefix, contender, nextTicket)) {
      if (Date.now() >= deadline) {
        throw coordinationError(
          "다른 탭의 익명 계정 준비가 끝나지 않았습니다. 잠시 뒤 다시 시도해 주세요.",
          "auth-lock-timeout",
          true,
        );
      }
      await delay(STORAGE_POLL_MS);
    }

    heartbeat = globalThis.setInterval(() => {
      try {
        writeTicket(storage, ticketKey, {
          expiresAt: Date.now() + leaseMs,
          ticket: nextTicket,
        });
      } catch {
        // The lease is longer than the bounded auth sequence. If storage
        // becomes unavailable, new contenders fail closed.
      }
    }, Math.min(10_000, Math.max(1_000, Math.floor(leaseMs / 3))));

    return await operation();
  } catch (error) {
    if (error instanceof RepositoryRequestError) {
      throw error;
    }
    throw coordinationError(
      "브라우저 저장소에서 익명 계정 준비 순서를 확인하지 못했습니다.",
      "auth-lock-storage-failure",
      true,
      error,
    );
  } finally {
    if (heartbeat !== undefined) {
      globalThis.clearInterval(heartbeat);
    }
    try {
      storage.removeItem(choosingKey);
      storage.removeItem(ticketKey);
    } catch {
      // Expiring records contain random coordination ids only. The next
      // contender cleans them up; credentials are never stored here.
    }
  }
}

function maxActiveTicket(storage: Storage, prefix: string): number {
  let maximum = 0;
  for (const entry of activeTickets(storage, `${prefix}ticket:`)) {
    maximum = Math.max(maximum, entry.value.ticket);
  }
  return maximum;
}

function ownsLowestTicket(
  storage: Storage,
  prefix: string,
  contender: string,
  ownTicket: number,
): boolean {
  if (activeTickets(storage, `${prefix}choosing:`).length > 0) {
    return false;
  }
  const contenders = activeTickets(storage, `${prefix}ticket:`).sort(
    (left, right) =>
      left.value.ticket - right.value.ticket || left.id.localeCompare(right.id),
  );
  const winner = contenders[0];
  return winner?.id === contender && winner.value.ticket === ownTicket;
}

function activeTickets(
  storage: Storage,
  keyPrefix: string,
): Array<{ id: string; value: BakeryTicket }> {
  const now = Date.now();
  const active: Array<{ id: string; value: BakeryTicket }> = [];
  const keys = Array.from(
    { length: storage.length },
    (_, index) => storage.key(index),
  ).filter((key): key is string => key?.startsWith(keyPrefix) === true);

  for (const key of keys) {
    const value = parseTicket(storage.getItem(key));
    if (!value || value.expiresAt <= now) {
      storage.removeItem(key);
      continue;
    }
    active.push({ id: key.slice(keyPrefix.length), value });
  }
  return active;
}

function parseTicket(value: string | null): BakeryTicket | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<BakeryTicket>;
    return Number.isSafeInteger(parsed.expiresAt) &&
      Number.isSafeInteger(parsed.ticket) &&
      (parsed.ticket ?? -1) >= 0
      ? { expiresAt: parsed.expiresAt!, ticket: parsed.ticket! }
      : null;
  } catch {
    return null;
  }
}

function writeTicket(storage: Storage, key: string, value: BakeryTicket): void {
  const serialized = JSON.stringify(value);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) {
    throw new Error("lock record verification failed");
  }
}

async function withProcessLock<T>(
  name: string,
  operation: AsyncOperation<T>,
): Promise<T> {
  const previous = PROCESS_LOCKS.get(name) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  PROCESS_LOCKS.set(name, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (PROCESS_LOCKS.get(name) === tail) {
      PROCESS_LOCKS.delete(name);
    }
  }
}

function randomLockId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, durationMs));
}

function coordinationError(
  message: string,
  code: string,
  retryable: boolean,
  cause?: unknown,
): RepositoryRequestError {
  return new RepositoryRequestError(message, { code, retryable, cause });
}
