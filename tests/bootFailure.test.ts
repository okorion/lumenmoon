import { describe, expect, it } from "vitest";
import { describeBootFailure } from "../src/app/bootFailure";
import { RepositoryRequestError } from "../src/data/CollaborativeWorldRepository";
import { IndexedDbUpgradeBlockedError } from "../src/data/IndexedDbWorldRepository";

describe("초기화 실패 공개 안내", () => {
  it("다른 탭이 저장소 갱신을 막으면 임시 월드 대신 탭 닫기를 안내한다", () => {
    expect(describeBootFailure(new IndexedDbUpgradeBlockedError())).toEqual({
      title: "다른 게임 탭을 닫아 주세요",
      message:
        "저장 형식을 안전하게 갱신하려면 열려 있는 루멘문 탭을 모두 닫은 뒤 다시 시도해 주세요.",
    });
  });

  it("환경 변수 값이나 임의 오류 원문을 화면 설명에 반영하지 않는다", () => {
    const secret = "sb_secret_should-never-appear";
    const description = describeBootFailure(
      new Error(`VITE_SUPABASE_ANON_KEY=${secret}`),
    );

    expect(description.title).toContain("온라인 월드");
    expect(JSON.stringify(description)).not.toContain(secret);
  });

  it("재시도 가능한 원격 오류는 원문 없이 재시도 방법을 안내한다", () => {
    const description = describeBootFailure(
      new RepositoryRequestError("raw remote response", {
        code: "request-timeout",
        retryable: true,
      }),
    );

    expect(description.title).toContain("연결");
    expect(description.message).toContain("다시 시도해 주세요");
    expect(JSON.stringify(description)).not.toContain("raw remote response");
  });
});
