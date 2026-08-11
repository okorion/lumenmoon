import { describe, expect, it } from "vitest";
import {
  chunkKey,
  gridKey,
  parseChunkKey,
  parseGridKey,
  placementPosition,
  toChunkCoordinate,
  worldCenter,
} from "../src/domain/grid";

describe("복셀 좌표", () => {
  it("격자 좌표를 안정적인 키로 왕복한다", () => {
    const position = { x: -3, y: 12, z: 7 };
    expect(parseGridKey(gridKey(position))).toEqual(position);
    expect(parseGridKey("1,2")).toBeNull();
  });

  it("음수 좌표도 16칸 청크로 올바르게 나눈다", () => {
    expect(toChunkCoordinate({ x: 15, y: 0, z: 16 })).toEqual({
      x: 0,
      y: 0,
      z: 1,
    });
    expect(toChunkCoordinate({ x: -1, y: -1, z: -16 })).toEqual({
      x: -1,
      y: -1,
      z: -1,
    });
    const key = chunkKey({ x: -2, y: 1, z: 3 });
    expect(parseChunkKey(key)).toEqual({ x: -2, y: 1, z: 3 });
  });

  it("조준면 법선을 가장 가까운 격자 한 칸으로 스냅한다", () => {
    expect(
      placementPosition(
        { x: 2, y: 4, z: 6 },
        { x: 0.03, y: 0.98, z: -0.02 },
      ),
    ).toEqual({ x: 2, y: 5, z: 6 });
  });

  it("격자 좌표의 월드 중심을 계산한다", () => {
    expect(worldCenter({ x: -1, y: 0, z: 2 })).toEqual({
      x: -0.5,
      y: 0.5,
      z: 2.5,
    });
  });
});
