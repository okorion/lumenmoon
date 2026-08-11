import type { Clock } from "../domain/progression";
import { WORLD_ID } from "../domain/types";
import {
  readRuntimeRepositoryConfig,
  type EnvironmentSource,
  type RuntimeRepositoryConfig,
} from "../config/runtimeConfig";
import type { CollaborativeWorldRepository } from "./CollaborativeWorldRepository";
import { IndexedDbWorldRepository } from "./IndexedDbWorldRepository";
import { LocalCollaborativeWorldRepository } from "./LocalCollaborativeWorldRepository";
import { createSupabaseRepository } from "./SupabaseRepository";
import {
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
      "IndexedDB를 사용할 수 없어 이번 접속 동안만 로컬 월드를 유지합니다.",
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

class LocalStorageFallback implements WorldRepository {
  private useFallback = false;
  private warningAdded = false;

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
      return await this.primary.load(worldId);
    } catch {
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
    } catch {
      this.activateFallback();
      await this.fallback.save(snapshot);
    }
  }

  private activateFallback(): void {
    this.useFallback = true;
    if (!this.warningAdded) {
      this.warningAdded = true;
      this.warnings.push(
        "IndexedDB 저장에 실패해 이번 접속 동안만 로컬 월드를 유지합니다.",
      );
    }
  }
}
