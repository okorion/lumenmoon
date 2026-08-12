import type { Clock } from "../domain/progression";
import { WORLD_ID } from "../domain/types";
import {
  readRuntimeRepositoryConfig,
  type EnvironmentSource,
  type RuntimeRepositoryConfig,
} from "../config/runtimeConfig";
import type { CollaborativeWorldRepository } from "./CollaborativeWorldRepository";
import {
  IndexedDbUpgradeBlockedError,
  IndexedDbWorldRepository,
} from "./IndexedDbWorldRepository";
import { LocalCollaborativeWorldRepository } from "./LocalCollaborativeWorldRepository";
import { createSupabaseRepository } from "./SupabaseRepository";
import {
  FreeModeRevisionConflictError,
  MemoryWorldRepository,
  type WorldRepository,
} from "./WorldRepository";

export interface RepositorySelection {
  mode: "local" | "online";
  worldId: string;
  repository: CollaborativeWorldRepository;
  /** 로컬 영속 저장 실패 시 추가되는 사용자 안내용 경고다. */
  warnings: string[];
}

export interface RepositoryFactoryDependencies {
  indexedDb?: IDBFactory;
  clock?: Clock;
}

export function createRepositoryFromEnvironment(
  environment: EnvironmentSource = import.meta.env,
  dependencies: RepositoryFactoryDependencies = {},
): RepositorySelection {
  return createRepositorySelection(
    readRuntimeRepositoryConfig(environment),
    dependencies,
  );
}

export function createRepositorySelection(
  config: RuntimeRepositoryConfig,
  dependencies: RepositoryFactoryDependencies = {},
): RepositorySelection {
  if (config.mode === "online") {
    return {
      mode: config.mode,
      worldId: config.worldId,
      repository: createSupabaseRepository(
        config.supabaseUrl,
        config.supabaseAnonKey,
        { worldId: config.worldId },
      ),
      warnings: [],
    };
  }

  const indexedDb = dependencies.indexedDb ?? globalThis.indexedDB;
  const warnings: string[] = [];
  const memory = new MemoryWorldRepository();
  const storage: WorldRepository = indexedDb
    ? new LocalStorageFallback(
        new IndexedDbWorldRepository(indexedDb),
        memory,
        warnings,
      )
    : memory;
  if (!indexedDb) {
    warnings.push(
      "이 기기에 저장할 수 없어 페이지를 닫으면 이번 플레이가 사라집니다.",
    );
  }
  return {
    mode: config.mode,
    worldId: WORLD_ID,
    repository: new LocalCollaborativeWorldRepository(
      storage,
      dependencies.clock ? { clock: dependencies.clock } : {},
    ),
    warnings,
  };
}

export class LocalStorageFallback implements WorldRepository {
  private useFallback = false;
  private warningAdded = false;
  private primaryReadSucceeded = false;

  constructor(
    private readonly primary: WorldRepository,
    private readonly fallback: WorldRepository,
    private readonly warnings: string[],
  ) {}

  async load(worldId: string) {
    if (this.useFallback) {
      return this.fallback.load(worldId);
    }
    try {
      const snapshot = await this.primary.load(worldId);
      this.primaryReadSucceeded = true;
      return snapshot;
    } catch (error) {
      if (this.shouldRethrow(error)) throw error;
      this.activateFallback();
      return this.fallback.load(worldId);
    }
  }

  async save(snapshot: Parameters<WorldRepository["save"]>[0]): Promise<void> {
    if (this.useFallback) {
      await this.fallback.save(snapshot);
      return;
    }
    try {
      await this.primary.save(snapshot);
      this.primaryReadSucceeded = true;
    } catch (error) {
      if (this.shouldRethrow(error)) throw error;
      this.activateFallback();
      await this.fallback.save(snapshot);
    }
  }

  async loadFreeModeOperation(
    ...args: Parameters<WorldRepository["loadFreeModeOperation"]>
  ) {
    if (this.useFallback) {
      return this.fallback.loadFreeModeOperation(...args);
    }
    try {
      const operation = await this.primary.loadFreeModeOperation(...args);
      this.primaryReadSucceeded = true;
      return operation;
    } catch (error) {
      if (this.shouldRethrow(error)) throw error;
      this.activateFallback();
      return this.fallback.loadFreeModeOperation(...args);
    }
  }

  async saveFreeModeCommit(
    ...args: Parameters<WorldRepository["saveFreeModeCommit"]>
  ): Promise<void> {
    if (this.useFallback) {
      await this.fallback.saveFreeModeCommit(...args);
      return;
    }
    try {
      await this.primary.saveFreeModeCommit(...args);
      this.primaryReadSucceeded = true;
    } catch (error) {
      if (this.shouldRethrow(error)) throw error;
      this.activateFallback();
      await this.fallback.saveFreeModeCommit(...args);
    }
  }

  async saveFreeModeState(
    ...args: Parameters<WorldRepository["saveFreeModeState"]>
  ): Promise<void> {
    if (this.useFallback) {
      await this.fallback.saveFreeModeState(...args);
      return;
    }
    try {
      await this.primary.saveFreeModeState(...args);
      this.primaryReadSucceeded = true;
    } catch (error) {
      if (this.shouldRethrow(error)) throw error;
      this.activateFallback();
      await this.fallback.saveFreeModeState(...args);
    }
  }

  private activateFallback(): void {
    this.useFallback = true;
    if (!this.warningAdded) {
      this.warningAdded = true;
      this.warnings.push(
        "이 기기에 저장하지 못해 페이지를 닫으면 이번 플레이가 사라집니다.",
      );
    }
  }

  private shouldRethrow(error: unknown): boolean {
    return (
      this.primaryReadSucceeded ||
      error instanceof IndexedDbUpgradeBlockedError ||
      error instanceof FreeModeRevisionConflictError
    );
  }
}
