import {
  addGridPositions,
  chunkKey,
  FACE_NEIGHBORS,
  gridKey,
  isGridPosition,
  toChunkCoordinate,
} from "./grid";
import type {
  BlockOwner,
  GridPosition,
  VoxelBlock,
  WorldSnapshot,
  ZoneKind,
} from "./types";

const WORLD_MIN = -512;
const WORLD_MAX = 512;
const WORLD_HEIGHT = 32_760;

export class VoxelWorld {
  readonly worldId: string;
  private readonly blocksByPosition = new Map<string, VoxelBlock>();
  private readonly blocksById = new Map<string, VoxelBlock>();

  constructor(worldId: string, blocks: readonly VoxelBlock[] = []) {
    this.worldId = worldId;
    for (const block of blocks) {
      this.addBlock(block);
    }
  }

  get size(): number {
    return this.blocksById.size;
  }

  get blocks(): readonly VoxelBlock[] {
    return Array.from(this.blocksById.values());
  }

  hasBlock(position: GridPosition): boolean {
    return this.blocksByPosition.has(gridKey(position));
  }

  getBlock(position: GridPosition): VoxelBlock | undefined {
    return this.blocksByPosition.get(gridKey(position));
  }

  getBlockById(id: string): VoxelBlock | undefined {
    return this.blocksById.get(id);
  }

  canPlace(position: GridPosition): boolean {
    return (
      isGridPosition(position) &&
      position.x >= WORLD_MIN &&
      position.x <= WORLD_MAX &&
      position.z >= WORLD_MIN &&
      position.z <= WORLD_MAX &&
      position.y >= 0 &&
      position.y <= WORLD_HEIGHT &&
      !this.hasBlock(position)
    );
  }

  addBlock(block: VoxelBlock): void {
    if (block.worldId !== this.worldId) {
      throw new Error("다른 월드의 블록은 추가할 수 없습니다.");
    }
    if (!isGridPosition(block.position)) {
      throw new Error("블록 좌표는 정수여야 합니다.");
    }
    if (this.blocksById.has(block.id) || this.hasBlock(block.position)) {
      throw new Error("이미 사용 중인 블록 ID 또는 좌표입니다.");
    }

    this.blocksById.set(block.id, block);
    this.blocksByPosition.set(gridKey(block.position), block);
  }

  canRemove(block: VoxelBlock, actor: BlockOwner): boolean {
    if (block.owner.id !== actor.id) {
      return false;
    }
    return (
      block.zone !== "system" &&
      block.zone !== "mission" &&
      !this.hasDependents(block.id)
    );
  }

  hasDependents(blockId: string): boolean {
    return this.blocks.some((block) => block.supportId === blockId);
  }

  removeOwnedBlock(id: string, actor: BlockOwner): VoxelBlock | null {
    const block = this.blocksById.get(id);
    if (!block || !this.canRemove(block, actor)) {
      return null;
    }

    return this.removeBlock(block.id);
  }

  removeBlock(id: string): VoxelBlock | null {
    const block = this.blocksById.get(id);
    if (!block) {
      return null;
    }
    this.blocksById.delete(block.id);
    this.blocksByPosition.delete(gridKey(block.position));
    return block;
  }

  /** 주변 청크를 서버 권위 상태로 교체할 때 기존 월드 인스턴스를 유지한다. */
  replaceBlocks(blocks: readonly VoxelBlock[]): void {
    const nextByPosition = new Map<string, VoxelBlock>();
    const nextById = new Map<string, VoxelBlock>();

    for (const block of blocks) {
      if (block.worldId !== this.worldId) {
        throw new Error("다른 월드의 블록은 교체 상태에 포함할 수 없습니다.");
      }
      if (!isGridPosition(block.position)) {
        throw new Error("블록 좌표는 정수여야 합니다.");
      }
      const positionKey = gridKey(block.position);
      if (nextById.has(block.id) || nextByPosition.has(positionKey)) {
        throw new Error("서버 월드 상태에 중복 블록 ID 또는 좌표가 있습니다.");
      }
      nextById.set(block.id, block);
      nextByPosition.set(positionKey, block);
    }

    this.blocksById.clear();
    this.blocksByPosition.clear();
    for (const [id, block] of nextById) {
      this.blocksById.set(id, block);
    }
    for (const [position, block] of nextByPosition) {
      this.blocksByPosition.set(position, block);
    }
  }

  blocksInChunk(key: string): readonly VoxelBlock[] {
    return this.blocks.filter(
      (block) => chunkKey(toChunkCoordinate(block.position)) === key,
    );
  }

  affectedChunkKeys(position: GridPosition): readonly string[] {
    const positions = [
      position,
      ...FACE_NEIGHBORS.map((offset) => addGridPositions(position, offset)),
    ];
    return Array.from(
      new Set(positions.map((candidate) => chunkKey(toChunkCoordinate(candidate)))),
    );
  }

  queryBounds(
    min: { x: number; y: number; z: number },
    max: { x: number; y: number; z: number },
  ): readonly VoxelBlock[] {
    const result: VoxelBlock[] = [];
    for (let x = Math.floor(min.x); x <= Math.floor(max.x); x += 1) {
      for (let y = Math.floor(min.y); y <= Math.floor(max.y); y += 1) {
        for (let z = Math.floor(min.z); z <= Math.floor(max.z); z += 1) {
          const block = this.getBlock({ x, y, z });
          if (block) {
            result.push(block);
          }
        }
      }
    }
    return result;
  }

  createSnapshot(now = Date.now()): WorldSnapshot {
    return {
      schemaVersion: 1,
      worldId: this.worldId,
      blocks: this.blocks.map((block) => ({
        ...block,
        position: { ...block.position },
        owner: { ...block.owner },
      })),
      updatedAt: now,
    };
  }
}

export function zoneAt(position: GridPosition): ZoneKind {
  if (position.z >= 5 && position.z <= 14 && Math.abs(position.x) <= 7) {
    return "personal";
  }
  if (Math.abs(position.x) <= 4 && Math.abs(position.z) <= 4) {
    return "mission";
  }
  return "public";
}
