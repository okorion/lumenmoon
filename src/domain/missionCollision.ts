import type { CollisionSource } from "./collision";
import type { Vector3Like, VoxelBlock } from "./types";

/** DB에 복제 행을 만들지 않으면서 원본·대칭 복제 모두를 물리 충돌에 포함한다. */
export function queryMissionAwareBounds(
  base: CollisionSource,
  missionBlocks: readonly VoxelBlock[],
  min: Vector3Like,
  max: Vector3Like,
): readonly VoxelBlock[] {
  const missionHits = missionBlocks.filter(({ position }) =>
    position.x < max.x &&
    position.x + 1 > min.x &&
    position.y < max.y &&
    position.y + 1 > min.y &&
    position.z < max.z &&
    position.z + 1 > min.z,
  );
  return [...base.queryBounds(min, max), ...missionHits];
}
