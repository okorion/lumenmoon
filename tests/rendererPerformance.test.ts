import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  cappedDevicePixelRatio,
  chunkKeysAround,
  diffChunkWindow,
  disposeInstancedMeshState,
  missionParticleLimit,
} from "../src/rendering/VoxelRenderer";

describe("모바일 렌더링 비용 상한", () => {
  it("모바일과 데스크톱의 DPR을 각각 제한한다", () => {
    expect(cappedDevicePixelRatio(3, true)).toBe(1.25);
    expect(cappedDevicePixelRatio(3, false)).toBe(1.6);
    expect(cappedDevicePixelRatio(1, true)).toBe(1);
    expect(cappedDevicePixelRatio(Number.NaN, true)).toBe(1);
  });

  it("모바일 미션 파티클 수를 데스크톱보다 낮게 제한한다", () => {
    expect(missionParticleLimit(true)).toBe(18);
    expect(missionParticleLimit(false)).toBe(36);
  });

  it("청크·미션 교체 시 InstancedMesh의 GPU 인스턴스 상태를 해제한다", () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial(),
      2,
    );
    const dispose = vi.spyOn(mesh, "dispose");

    disposeInstancedMeshState(mesh);

    expect(dispose).toHaveBeenCalledOnce();
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });
});

describe("주변 청크 작업 집합", () => {
  it("모바일 반경 1과 수직 반경 2에서 정확히 45개 키만 만든다", () => {
    const keys = chunkKeysAround({ x: 4, y: 1, z: -3 }, 1, 2);
    expect(keys).toHaveLength(45);
    expect(new Set(keys).size).toBe(45);
    expect(keys).toContain("4:1:-3");
    expect(keys).not.toContain("6:1:-3");
  });

  it("음수·소수 반경을 안전한 정수 반경으로 정규화한다", () => {
    expect(chunkKeysAround({ x: 0, y: 0, z: 0 }, -2, -1)).toEqual([
      "0:0:0",
    ]);
    expect(chunkKeysAround({ x: 0, y: 0, z: 0 }, 1.9, 0.9)).toHaveLength(9);
  });

  it("청크 경계를 반복 이동해도 활성 키가 작업 집합 상한을 넘지 않는다", () => {
    const active = new Set<string>();
    let unloadCount = 0;
    for (let x = 0; x < 80; x += 1) {
      const desired = chunkKeysAround({ x, y: 0, z: 0 }, 1, 2);
      const diff = diffChunkWindow(active, desired);
      unloadCount += diff.unload.length;
      for (const key of diff.unload) {
        active.delete(key);
      }
      for (const key of diff.load) {
        active.add(key);
      }
      expect(active.size).toBe(45);
    }
    expect(unloadCount).toBeGreaterThan(0);
  });
});
