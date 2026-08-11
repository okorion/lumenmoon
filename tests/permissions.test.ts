import { describe, expect, it } from "vitest";
import {
  decidePlacement,
  decideRemoval,
  OTHER_PUBLIC_REMOVAL_HOLD_MS,
  type PermissionBlock,
} from "../src/domain/permissions";
import { LOCAL_PLAYER, SYSTEM_OWNER, WORLD_ID } from "../src/domain/types";

const OTHER_OWNER = {
  id: "other-player",
  publicId: "#OTHER",
  nickname: "다른 건축가",
  emblem: "◆",
};

function block(
  id: string,
  zone: PermissionBlock["zone"] = "public",
  owner = LOCAL_PLAYER,
  supportId?: string,
): PermissionBlock {
  return {
    id,
    worldId: WORLD_ID,
    position: { x: id.length, y: 1, z: 0 },
    kind: "cube",
    rotation: 0,
    colorIndex: 0,
    owner,
    zone,
    createdAt: 1,
    ...(supportId ? { supportId } : {}),
  };
}

describe("decidePlacement", () => {
  it("개인 영역과 생산시설은 베이 소유자만 배치할 수 있다", () => {
    for (const zone of ["personal", "producer"] as const) {
      expect(
        decidePlacement({
          actorId: LOCAL_PLAYER.id,
          zone,
          zoneOwnerId: LOCAL_PLAYER.id,
        }),
      ).toMatchObject({ allowed: true, reason: "allowed" });

      expect(
        decidePlacement({
          actorId: OTHER_OWNER.id,
          zone,
          zoneOwnerId: LOCAL_PLAYER.id,
        }),
      ).toEqual({
        allowed: false,
        requiresHold: false,
        holdMs: 0,
        reason: "owner-only",
        refundInventory: 0,
      });
    }
  });

  it("소유자가 명시되지 않은 개인 영역은 배치를 허용하지 않는다", () => {
    expect(
      decidePlacement({ actorId: LOCAL_PLAYER.id, zone: "personal" }),
    ).toMatchObject({ allowed: false, reason: "owner-only" });
  });

  it("공용 자유 확장부는 누구나 즉시 배치할 수 있다", () => {
    expect(
      decidePlacement({ actorId: OTHER_OWNER.id, zone: "public" }),
    ).toEqual({
      allowed: true,
      requiresHold: false,
      holdMs: 0,
      reason: "allowed",
      refundInventory: 0,
    });
  });

  it("공동 미션·시스템·스폰 구역은 배치할 수 없다", () => {
    for (const zone of ["mission", "system", "spawn"] as const) {
      expect(
        decidePlacement({ actorId: SYSTEM_OWNER.id, zone }),
      ).toMatchObject({ allowed: false, reason: "protected-zone" });
    }
  });
});

describe("decideRemoval", () => {
  it("공동 미션·시스템·스폰 블록은 소유자도 제거할 수 없다", () => {
    for (const zone of ["mission", "system", "spawn"] as const) {
      const target = block(`protected-${zone}`, zone, LOCAL_PLAYER);
      expect(
        decideRemoval({
          actorId: LOCAL_PLAYER.id,
          block: target,
          allBlocks: [target],
        }),
      ).toEqual({
        allowed: false,
        requiresHold: false,
        holdMs: 0,
        reason: "protected-zone",
        refundInventory: 0,
      });
    }
  });

  it("개인 영역과 생산시설은 베이 소유자만 수정할 수 있다", () => {
    for (const zone of ["personal", "producer"] as const) {
      const target = block(`private-${zone}`, zone);

      expect(
        decideRemoval({
          actorId: LOCAL_PLAYER.id,
          block: target,
          allBlocks: [target],
          zoneOwnerId: LOCAL_PLAYER.id,
        }),
      ).toMatchObject({ allowed: true, refundInventory: 1 });

      expect(
        decideRemoval({
          actorId: OTHER_OWNER.id,
          block: target,
          allBlocks: [target],
          zoneOwnerId: LOCAL_PLAYER.id,
          heldMs: OTHER_PUBLIC_REMOVAL_HOLD_MS,
        }),
      ).toMatchObject({
        allowed: false,
        requiresHold: false,
        reason: "owner-only",
        refundInventory: 0,
      });
    }
  });

  it("자기 공용 블록은 즉시 제거하고 재고 1개를 돌려받는다", () => {
    const target = block("own-public");
    expect(
      decideRemoval({
        actorId: LOCAL_PLAYER.id,
        block: target,
        allBlocks: [target],
      }),
    ).toEqual({
      allowed: true,
      requiresHold: false,
      holdMs: 0,
      reason: "allowed",
      refundInventory: 1,
    });
  });

  it("타인 공용 블록은 2.5초 경계까지 홀드해야 하며 보상은 없다", () => {
    const target = block("other-public", "public", OTHER_OWNER);
    const before = decideRemoval({
      actorId: LOCAL_PLAYER.id,
      block: target,
      allBlocks: [target],
      heldMs: OTHER_PUBLIC_REMOVAL_HOLD_MS - 1,
    });
    const complete = decideRemoval({
      actorId: LOCAL_PLAYER.id,
      block: target,
      allBlocks: [target],
      heldMs: OTHER_PUBLIC_REMOVAL_HOLD_MS,
    });

    expect(before).toEqual({
      allowed: false,
      requiresHold: true,
      holdMs: 2_500,
      reason: "hold-required",
      refundInventory: 0,
    });
    expect(complete).toEqual({
      allowed: true,
      requiresHold: true,
      holdMs: 2_500,
      reason: "allowed",
      refundInventory: 0,
    });
  });

  it("중단하거나 유효하지 않은 홀드 시간은 다음 판정에 누적하지 않는다", () => {
    const target = block("other-public", "public", OTHER_OWNER);

    expect(
      decideRemoval({
        actorId: LOCAL_PLAYER.id,
        block: target,
        allBlocks: [target],
        heldMs: 2_499,
      }).allowed,
    ).toBe(false);
    expect(
      decideRemoval({
        actorId: LOCAL_PLAYER.id,
        block: target,
        allBlocks: [target],
      }).allowed,
    ).toBe(false);
    expect(
      decideRemoval({
        actorId: LOCAL_PLAYER.id,
        block: target,
        allBlocks: [target],
        heldMs: Number.POSITIVE_INFINITY,
      }).allowed,
    ).toBe(false);
  });

  it("다른 블록의 supportId로 참조되는 블록은 누구도 제거할 수 없다", () => {
    const support = block("support");
    const dependent = block("dependent", "public", LOCAL_PLAYER, support.id);

    expect(
      decideRemoval({
        actorId: LOCAL_PLAYER.id,
        block: support,
        allBlocks: [support, dependent],
      }),
    ).toEqual({
      allowed: false,
      requiresHold: false,
      holdMs: 0,
      reason: "support-in-use",
      refundInventory: 0,
    });
    expect(
      decideRemoval({
        actorId: OTHER_OWNER.id,
        block: support,
        allBlocks: [support, dependent],
        heldMs: OTHER_PUBLIC_REMOVAL_HOLD_MS,
      }).reason,
    ).toBe("support-in-use");
  });
});
