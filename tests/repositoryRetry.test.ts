import { describe, expect, it, vi } from "vitest";
import { RepositoryRequestError } from "../src/data/CollaborativeWorldRepository";
import { retryIdempotentOnce } from "../src/app/repositoryRetry";

describe("멱등 명령 재시도", () => {
  it("일시 오류 뒤 같은 작업을 한 번만 다시 호출한다", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new RepositoryRequestError("timeout", {
          code: "request-timeout",
          retryable: true,
        }),
      )
      .mockResolvedValueOnce("replayed");

    await expect(retryIdempotentOnce(operation)).resolves.toEqual({
      value: "replayed",
      retried: true,
    });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("서버 거절은 재시도하지 않는다", async () => {
    const error = new RepositoryRequestError("forbidden", {
      code: "42501",
      retryable: false,
    });
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(error);

    await expect(retryIdempotentOnce(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
