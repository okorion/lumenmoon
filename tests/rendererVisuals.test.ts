import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { GuideCell, GuideGroup } from "../src/domain/starterBay";
import {
  LUMEN_SURFACE_ASSET_URLS,
  canonicalPlacementNormal,
  configureLumenSurfaceTexture,
  createGuideInstanceBatches,
  createLumenSurfaceAtlasData,
  lumenAtlasTileIndex,
  lumenAtlasUv,
  rendererVisualBudget,
} from "../src/rendering/VoxelRenderer";

describe("루멘문 렌더링 비주얼 자원", () => {
  it("모바일은 데스크톱보다 낮은 고정 자원 예산을 사용한다", () => {
    const mobile = rendererVisualBudget(true);
    const desktop = rendererVisualBudget(false);

    expect(mobile.atlasSize).toBeLessThan(desktop.atlasSize);
    expect(mobile.starCount).toBeLessThan(desktop.starCount);
    expect(mobile.anisotropyCap).toBeLessThan(desktop.anisotropyCap);
    expect(mobile.atlasTilesPerAxis).toBe(2);
  });

  it("동일 좌표의 표면 변형과 아틀라스 UV가 결정적이다", () => {
    const position = { x: -3, y: 4, z: 11 };
    expect(lumenAtlasTileIndex(position, 2)).toBe(
      lumenAtlasTileIndex(position, 2),
    );
    expect(lumenAtlasTileIndex(position, 2)).toBeGreaterThanOrEqual(0);
    expect(lumenAtlasTileIndex(position, 2)).toBeLessThan(4);

    const lower = lumenAtlasUv(0, 0, 0);
    const upper = lumenAtlasUv(3, 1, 1);
    expect(lower.u).toBeGreaterThan(0);
    expect(lower.v).toBeGreaterThan(0);
    expect(upper.u).toBeLessThan(1);
    expect(upper.v).toBeLessThan(1);
  });

  it("절차 아틀라스는 유효한 색상·표면·발광 데이터를 만든다", () => {
    const first = createLumenSurfaceAtlasData(64);
    const second = createLumenSurfaceAtlasData(64);

    expect(first.size).toBe(64);
    expect(first.albedo).toEqual(second.albedo);
    expect(first.albedo).toHaveLength(64 * 64 * 4);
    expect(first.surface.some((value) => value > 0)).toBe(true);
    expect(first.emissive.some((value) => value > 0)).toBe(true);
  });

  it("외부 문스톤 텍스처를 반복 가능한 제한 자원으로 설정한다", () => {
    expect(LUMEN_SURFACE_ASSET_URLS).toEqual({
      albedo: "/textures/lumenmoon-moonstone-v1.webp",
      normal: "/textures/lumenmoon-moonstone-normal-v1.webp",
    });

    const texture = new THREE.Texture();
    configureLumenSurfaceTexture(texture, 16, true);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    expect(texture.repeat.toArray()).toEqual([2, 2]);
    expect(texture.anisotropy).toBe(4);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    texture.dispose();
  });

  it("경사진 면도 정확히 인접한 한 축 배치 법선으로 정규화한다", () => {
    const normals = [
      canonicalPlacementNormal({ x: 0.57, y: 0.82, z: 0.03 }),
      canonicalPlacementNormal({ x: -0.91, y: 0.12, z: 0.4 }),
      canonicalPlacementNormal({ x: 0.1, y: -0.2, z: -0.96 }),
    ];

    expect(normals).toEqual([
      { x: 0, y: 1, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
    ]);
    for (const normal of normals) {
      expect(Math.abs(normal.x) + Math.abs(normal.y) + Math.abs(normal.z)).toBe(1);
    }
  });

  it("법선 절댓값 동률은 X, Y, Z 순서로 결정한다", () => {
    expect(canonicalPlacementNormal({ x: -0.5, y: 0.5, z: 0.5 })).toEqual({
      x: -1,
      y: 0,
      z: 0,
    });
    expect(canonicalPlacementNormal({ x: 0, y: -0.5, z: 0.5 })).toEqual({
      x: 0,
      y: -1,
      z: 0,
    });
    expect(canonicalPlacementNormal({ x: Number.NaN, y: 0, z: 0 })).toEqual({
      x: 0,
      y: 1,
      z: 0,
    });
  });

  it("36개 가이드를 최대 9 draw call과 3개 공유 geometry로 유지한다", () => {
    const groups: GuideGroup[] = ["base", "producer", "upgrade"];
    const kinds: GuideCell["kind"][] = ["cube", "stair", "light"];
    const guides: GuideCell[] = Array.from({ length: 36 }, (_, index) => ({
      position: { x: index % 9, y: 1 + Math.floor(index / 18), z: Math.floor(index / 9) },
      kind: kinds[index % kinds.length]!,
      rotation: (index % 4) as GuideCell["rotation"],
      group: groups[Math.floor(index / kinds.length) % groups.length]!,
      order: index + 1,
      role: "upgrade",
    }));

    const snapshots = Array.from({ length: 40 }, () => {
      const batches = createGuideInstanceBatches(guides);
      return {
        drawCalls: batches.length,
        geometryKinds: new Set(batches.map(({ kind }) => kind)).size,
        instances: batches.reduce((sum, batch) => sum + batch.guides.length, 0),
        keys: batches.map(({ key }) => key),
      };
    });

    expect(snapshots[0]).toMatchObject({
      drawCalls: 9,
      geometryKinds: 3,
      instances: 36,
    });
    expect(new Set(snapshots.map((snapshot) => JSON.stringify(snapshot))).size).toBe(1);
  });
});
