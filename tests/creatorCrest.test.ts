import { describe, expect, it } from "vitest";
import { missionContributorCrestDesign } from "../src/rendering/VoxelRenderer";
import {
  createCreatorCrest,
  creatorCrestLabel,
  creatorCrestSvg,
  type CreatorCrestIdentity,
} from "../src/ui/icons";

const CREATOR: CreatorCrestIdentity = {
  publicId: "#A2B3",
  nickname: "고요한 여우",
  emblem: "✦",
};
const ADJECTIVES = ["고요한", "빛나는", "푸른", "따뜻한", "용감한", "느긋한"] as const;
const ANIMALS = ["여우", "수달", "참새", "고래", "토끼", "사슴"] as const;

describe("결정적 제작자 문장", () => {
  it("같은 닉네임과 공개 ID는 언제나 같은 문장을 만든다", () => {
    const first = createCreatorCrest(CREATOR);
    const second = createCreatorCrest({ ...CREATOR });

    expect(second).toEqual(first);
    expect(creatorCrestSvg(CREATOR)).toBe(creatorCrestSvg({ ...CREATOR }));
    expect(first.signatureAngles).toHaveLength(4);
  });

  it("공개 ID가 다르면 문장의 공개 태그 서명이 달라진다", () => {
    const first = createCreatorCrest(CREATOR);
    const second = createCreatorCrest({ ...CREATOR, publicId: "#A2B4" });

    expect(second.key).not.toBe(first.key);
    expect(second.signatureAngles).not.toEqual(first.signatureAngles);
    expect(creatorCrestSvg({ ...CREATOR, publicId: "#A2B4" })).not.toBe(
      creatorCrestSvg(CREATOR),
    );
  });

  it("같은 공개 ID여도 허용 닉네임이 다르면 다른 key와 SVG를 만든다", () => {
    const first = createCreatorCrest(CREATOR);
    const renamed = createCreatorCrest({ ...CREATOR, nickname: "빛나는 여우" });

    expect(renamed.key).not.toBe(first.key);
    expect(renamed.accentAngle).not.toBe(first.accentAngle);
    expect(creatorCrestSvg({ ...CREATOR, nickname: "빛나는 여우" })).not.toBe(
      creatorCrestSvg(CREATOR),
    );
  });

  it("허용 닉네임 36조합은 같은 공개 ID에서도 고유한 crest key를 가진다", () => {
    const keys = ADJECTIVES.flatMap((adjective) =>
      ANIMALS.map((animal) =>
        createCreatorCrest({
          ...CREATOR,
          nickname: `${adjective} ${animal}`,
        }).key,
      ),
    );

    expect(keys).toHaveLength(36);
    expect(new Set(keys)).toHaveLength(36);
  });

  it("기존 문양 의미를 내부 glyph와 접근성 이름으로 보존한다", () => {
    const pentagon = { ...CREATOR, emblem: "⬟" };
    const crest = createCreatorCrest(pentagon);
    const svg = creatorCrestSvg(pentagon);

    expect(crest.icon).toBe("emblem-pentagon");
    expect(crest.emblemLabel).toBe("오각 문양");
    expect(creatorCrestLabel(pentagon)).toContain("제작자 표식, 오각 문양");
    expect(svg.match(/<svg\b/gu)).toHaveLength(1);
    expect(svg).not.toContain("<text");
    expect(svg).not.toContain("⬟");
  });

  it("DOM 공개 신원과 월드 내 기여자의 빛이 같은 설계를 공유한다", () => {
    expect(missionContributorCrestDesign(CREATOR)).toEqual(
      createCreatorCrest(CREATOR),
    );
  });
});
