import type { WorldSnapshot } from "../domain/types";
import { preserveLocalMissionState } from "../domain/mission";

export interface WorldRepository {
  load(worldId: string): Promise<WorldSnapshot | null>;
  save(snapshot: WorldSnapshot): Promise<void>;
}

export class MemoryWorldRepository implements WorldRepository {
  private readonly snapshots = new Map<string, WorldSnapshot>();

  async load(worldId: string): Promise<WorldSnapshot | null> {
    const snapshot = this.snapshots.get(worldId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async save(snapshot: WorldSnapshot): Promise<void> {
    const latest = this.snapshots.get(snapshot.worldId) ?? null;
    this.snapshots.set(
      snapshot.worldId,
      structuredClone(preserveLocalMissionState(snapshot, latest)),
    );
  }
}
