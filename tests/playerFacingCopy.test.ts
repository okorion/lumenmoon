import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PLAYER_COPY_FILES = [
  "src/ui/GameUI.ts",
  "src/app/GameApp.ts",
  "src/app/bootFailure.ts",
  "src/data/repositoryFactory.ts",
  "index.html",
  "public/manifest.webmanifest",
  "README.md",
  "package.json",
] as const;

const RETIRED_PLAYER_PHRASES = [
  "비동기 공동 건축 실험",
  "개인 거점",
  "생산시설",
  "공동 미션",
  "정규 설계 슬롯",
  "기여자의 빛",
  "내 기여",
  "추천 위치",
  "블록 보태",
  "내 블록 강조",
  "LOCAL WORLD",
  "ONLINE WORLD",
  "제작자 표식",
  "익명 이용 통계",
  "흔적",
] as const;

describe("플레이어 화면 문구", () => {
  it("개발 용어와 번역투 표현을 공개 화면에 다시 노출하지 않는다", async () => {
    const sources = await Promise.all(
      PLAYER_COPY_FILES.map(async (path) => ({
        path,
        content: playerFacingSection(
          path,
          await readFile(join(ROOT, path), "utf8"),
        ),
      })),
    );
    const violations = sources.flatMap(({ path, content }) =>
      RETIRED_PLAYER_PHRASES.filter((phrase) => content.includes(phrase)).map(
        (phrase) => path + ": " + phrase,
      ),
    );

    expect(violations).toEqual([]);
  });

  it("관문 행동을 직접적인 놓기 표현으로 안내한다", async () => {
    const ui = await readFile(join(ROOT, "src/ui/GameUI.ts"), "utf8");

    expect(ui).toContain("관문에 블록 놓기");
    expect(ui).toContain("내가 놓은 블록");
    expect(ui).toContain("놓을 자리와 색을 골라 주세요");
  });
});

function playerFacingSection(path: string, content: string): string {
  if (path === "README.md") {
    return content.split("## 기술 구조", 1)[0] ?? content;
  }
  return content;
}
