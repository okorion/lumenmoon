import { describe, expect, it } from "vitest";
import type {
  CommitFreeModeActionsRequest,
  CommitWorldActionsRequest,
} from "../src/data/CollaborativeWorldRepository";
import {
  validateCommitFreeModeActions,
  validateCommitWorldActions,
} from "../src/data/worldActionValidation";

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

  it("같은 블록을 한 커밋에서 놓고 다시 제거하는 모호한 델타를 거부한다", () => {
    const blockId = "00000000-0000-4000-8000-000000000003";
    const request: CommitWorldActionsRequest = {
      worldId: WORLD_ID,
      idempotencyKey: COMMIT_ID,
      actions: [
        {
          type: "place",
          blockId,
          position: { x: 20, y: 1, z: 20 },
          kind: "cube",
          rotation: 0,
          colorIndex: 0,
        },
        { type: "remove", blockId },
      ],
    };

    expect(() => validateCommitWorldActions(request)).toThrow(
      /같은 블록 ID를 두 번/u,
    );
  });

  it("자유 건축은 교착 없는 단일 블록 요청만 허용한다", () => {
    const request: CommitFreeModeActionsRequest = {
      worldId: WORLD_ID,
      idempotencyKey: COMMIT_ID,
      actions: [
        {
          type: "remove",
          blockId: "00000000-0000-4000-8000-000000000003",
        },
        {
          type: "remove",
          blockId: "00000000-0000-4000-8000-000000000004",
        },
      ],
    };

    expect(() => validateCommitFreeModeActions(request)).toThrow(
      /한 번에 하나씩/u,
    );
  });
});
