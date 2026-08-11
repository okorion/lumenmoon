import { CHUNK_SIZE, type GridPosition, type Vector3Like } from "./types";

export interface ChunkCoordinate {
  x: number;
  y: number;
  z: number;
}

export function isGridPosition(value: GridPosition): boolean {
  return (
    Number.isSafeInteger(value.x) &&
    Number.isSafeInteger(value.y) &&
    Number.isSafeInteger(value.z)
  );
}

export function gridKey(position: GridPosition): string {
  return [position.x, position.y, position.z].join(",");
}

export function parseGridKey(key: string): GridPosition | null {
  const values = key.split(",").map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isSafeInteger(value))) {
    return null;
  }

  return {
    x: values[0]!,
    y: values[1]!,
    z: values[2]!,
  };
}

export function toChunkCoordinate(
  position: GridPosition,
  size = CHUNK_SIZE,
): ChunkCoordinate {
  return {
    x: Math.floor(position.x / size),
    y: Math.floor(position.y / size),
    z: Math.floor(position.z / size),
  };
}

export function chunkKey(coordinate: ChunkCoordinate): string {
  return [coordinate.x, coordinate.y, coordinate.z].join(":");
}

export function parseChunkKey(key: string): ChunkCoordinate | null {
  const values = key.split(":").map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isSafeInteger(value))) {
    return null;
  }

  return {
    x: values[0]!,
    y: values[1]!,
    z: values[2]!,
  };
}

export function worldCenter(position: GridPosition): Vector3Like {
  return {
    x: position.x + 0.5,
    y: position.y + 0.5,
    z: position.z + 0.5,
  };
}

export function placementPosition(
  target: GridPosition,
  faceNormal: Vector3Like,
): GridPosition {
  return {
    x: target.x + Math.round(faceNormal.x),
    y: target.y + Math.round(faceNormal.y),
    z: target.z + Math.round(faceNormal.z),
  };
}

export const FACE_NEIGHBORS: readonly GridPosition[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
] as const;

export function addGridPositions(
  left: GridPosition,
  right: GridPosition,
): GridPosition {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}
