import { RepositoryRequestError } from "./CollaborativeWorldRepository";

type AsyncOperation<T> = () => Promise<T>;

const PROCESS_LOCKS = new Map<string, Promise<void>>();
const MIN_LOCK_WAIT_MS = 5_000;

/**
 * Supabase auth-js 2.112 does not lock its default browser auth path. Keep the
 * initial anonymous sign-up atomic across tabs that share the same auth
 * storage. The lock name contains only a public project namespace.
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

  if (typeof globalThis.window !== "undefined") {
    // A storage lease can expire while a background tab is suspended, letting
    // a second anonymous signup overtake a late auth write. Without Web Locks
    // there is no safe browser-side fencing token, so fail before signup.
    throw coordinationError(
      "이 브라우저에서는 익명 계정을 안전하게 만들 수 없습니다. 브라우저를 업데이트한 뒤 다시 시도해 주세요.",
      "auth-coordination-unavailable",
      false,
    );
  }

  // Node-based integration tests and non-browser runtimes have no tabs. A
  // process mutex still protects repository instances sharing one JS realm.
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
        // Do not race or abort this callback after acquisition. Web Locks keeps
        // ownership until the real auth promise settles, including while the
        // initiating caller has already received a bounded timeout notice.
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

function coordinationError(
  message: string,
  code: string,
  retryable: boolean,
): RepositoryRequestError {
  return new RepositoryRequestError(message, { code, retryable });
}
