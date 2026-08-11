import type { GridPosition, Vector3Like, VoxelBlock } from "./types";

export const PLAYER_RADIUS = 0.31;
export const PLAYER_HEIGHT = 1.78;
export const PLAYER_EYE_HEIGHT = 1.62;
const EPSILON = 0.001;

export interface AxisAlignedBounds {
  min: Vector3Like;
  max: Vector3Like;
}

export interface CollisionSource {
  queryBounds(min: Vector3Like, max: Vector3Like): readonly VoxelBlock[];
}

export interface MotionResult {
  position: Vector3Like;
  hitHorizontal: boolean;
  hitVertical: boolean;
  stepped: boolean;
}

export function playerBounds(position: Vector3Like): AxisAlignedBounds {
  return {
    min: {
      x: position.x - PLAYER_RADIUS,
      y: position.y,
      z: position.z - PLAYER_RADIUS,
    },
    max: {
      x: position.x + PLAYER_RADIUS,
      y: position.y + PLAYER_HEIGHT,
      z: position.z + PLAYER_RADIUS,
    },
  };
}

export function blockBounds(position: GridPosition): AxisAlignedBounds {
  return {
    min: { x: position.x, y: position.y, z: position.z },
    max: { x: position.x + 1, y: position.y + 1, z: position.z + 1 },
  };
}

export function boundsIntersect(
  left: AxisAlignedBounds,
  right: AxisAlignedBounds,
): boolean {
  return (
    left.min.x < right.max.x - EPSILON &&
    left.max.x > right.min.x + EPSILON &&
    left.min.y < right.max.y - EPSILON &&
    left.max.y > right.min.y + EPSILON &&
    left.min.z < right.max.z - EPSILON &&
    left.max.z > right.min.z + EPSILON
  );
}

export function collidesAt(
  source: CollisionSource,
  position: Vector3Like,
): boolean {
  const bounds = playerBounds(position);
  return source
    .queryBounds(bounds.min, bounds.max)
    .some(
      (block) =>
        block.kind !== "light" &&
        boundsIntersect(bounds, blockBounds(block.position)),
    );
}

export function blockIntersectsPlayer(
  playerPosition: Vector3Like,
  blockPosition: GridPosition,
): boolean {
  return boundsIntersect(playerBounds(playerPosition), blockBounds(blockPosition));
}

export function isGrounded(
  source: CollisionSource,
  position: Vector3Like,
): boolean {
  return collidesAt(source, {
    x: position.x,
    y: position.y - 0.04,
    z: position.z,
  });
}

export function resolvePlayerMotion(
  source: CollisionSource,
  position: Vector3Like,
  delta: Vector3Like,
  grounded: boolean,
): MotionResult {
  const next = { ...position };
  let hitHorizontal = false;
  let hitVertical = false;
  let stepped = false;

  const horizontalCandidate = {
    x: next.x + delta.x,
    y: next.y,
    z: next.z + delta.z,
  };

  if (!collidesAt(source, horizontalCandidate)) {
    next.x = horizontalCandidate.x;
    next.z = horizontalCandidate.z;
  } else {
    hitHorizontal = true;
    const stepCandidate = {
      x: horizontalCandidate.x,
      y: next.y + 1.01,
      z: horizontalCandidate.z,
    };

    if (grounded && !collidesAt(source, stepCandidate)) {
      next.x = stepCandidate.x;
      next.y = stepCandidate.y;
      next.z = stepCandidate.z;
      stepped = true;
    } else {
      const xCandidate = { ...next, x: next.x + delta.x };
      if (!collidesAt(source, xCandidate)) {
        next.x = xCandidate.x;
      }
      const zCandidate = { ...next, z: next.z + delta.z };
      if (!collidesAt(source, zCandidate)) {
        next.z = zCandidate.z;
      }
    }
  }

  const verticalCandidate = { ...next, y: next.y + delta.y };
  if (!collidesAt(source, verticalCandidate)) {
    next.y = verticalCandidate.y;
  } else {
    hitVertical = true;
  }

  return {
    position: next,
    hitHorizontal,
    hitVertical,
    stepped,
  };
}
