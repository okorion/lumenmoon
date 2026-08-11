import { describe, expect, it } from "vitest";
import { describeBootFailure } from "../src/app/bootFailure";
import { RepositoryRequestError } from "../src/data/CollaborativeWorldRepository";

describe("초기화 실패 공개 안내", () => {
  it("환경 변수 값이나 임의 오류 원문을 화면 설명에 반영하지 않는다", () => {
    const secret = "sb_secret_should-never-appear";
    const description = describeBootFailure(
      new Error(`VITE_SUPABASE_ANON_KEY=${secret}`),
    );

    expect(description.title).toContain("온라인 설정");
    expect(JSON.stringify(description)).not.toContain(secret);
  });

  it("재시도 가능한 원격 오류는 중복 방지와 재시도 방법을 안내한다", () => {
    const description = describeBootFailure(
      new RepositoryRequestError("raw remote response", {
        code: "request-timeout",
        retryable: true,
      }),
    );

    expect(description.title).toContain("응답");
    expect(description.message).toContain("중복되지 않습니다");
    expect(JSON.stringify(description)).not.toContain("raw remote response");
  });
});
