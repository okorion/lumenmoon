import { describe, expect, it } from "vitest";
import type { CommitWorldActionsRequest } from "../src/data/CollaborativeWorldRepository";
import { validateCommitWorldActions } from "../src/data/worldActionValidation";

const WORLD_ID = "00000000-0000-4000-8000-000000000001";
const COMMIT_ID = "00000000-0000-4000-8000-000000000002";

describe("월드 action 요청 크기", () => {
  it("작업 수가 작아도 32KiB를 넘는 payload는 RPC 전에 거부한다", () => {
    const request = {
      worldId: WORLD_ID,
      idempotencyKey: COMMIT_ID,
      actions: [
        {
          type: "place",
          blockId: "x".repeat(32_768),
          position: { x: 0, y: 1, z: 0 },
          kind: "cube",
          rotation: 0,
          colorIndex: 0,
        },
      ],
    } as unknown as CommitWorldActionsRequest;

    expect(() => validateCommitWorldActions(request)).toThrow(/32768바이트/u);
  });
});
