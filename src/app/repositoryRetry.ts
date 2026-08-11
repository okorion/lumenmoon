import { RepositoryRequestError } from "../data/CollaborativeWorldRepository";

export interface RepositoryRetryResult<T> {
  value: T;
  retried: boolean;
}

/**
 * 응답 유실 가능성이 있는 멱등 명령만 같은 요청 키로 정확히 한 번 재시도한다.
 * 호출자는 매 시도마다 새 키를 만들면 안 된다.
 */
export async function retryIdempotentOnce<T>(
  operation: () => Promise<T>,
): Promise<RepositoryRetryResult<T>> {
  try {
    return { value: await operation(), retried: false };
  } catch (error) {
    if (!(error instanceof RepositoryRequestError) || !error.retryable) {
      throw error;
    }
    return { value: await operation(), retried: true };
  }
}
