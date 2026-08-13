import {
  blockIntersectsPlayer,
  collidesAt,
  isGrounded,
  type CollisionSource,
} from "../domain/collision";
import { placementPosition, toChunkCoordinate } from "../domain/grid";
import {
  OTHER_PUBLIC_REMOVAL_HOLD_MS,
  decidePlacement,
  decideRemoval,
  type PermissionDecision,
} from "../domain/permissions";
import {
  decideFreeModeRemoval,
  hasFreeModeDeterministicGround,
  isFreeModeSpawnClearancePosition,
  type FreeModeProgress,
} from "../domain/freeMode";
import {
  DEFAULT_GAME_RULES,
  SystemClock,
  createLocalPlayerProgress,
  getManualProductionRemainingAttempts,
  getNextAutomaticProductionInMs,
  isProductionOperational,
  reconcileOnboardingCompletion,
  reconcileProductionUpgrade,
  resetOnboardingProgress,
  settleAutomaticProduction,
  tryManualProduction,
  type Clock,
  type GameRulesConfig,
} from "../domain/progression";
import {
  STARTER_BAY_RESERVED_SLOT_COUNT,
  classifyStarterBayPosition,
  countFilledGuides,
  createStarterBayLayout,
  guideAtPosition,
  type GuideCell,
  type StarterBayLayout,
  type StarterBayZoneMatch,
} from "../domain/starterBay";
import {
  cloneLocalMissionWorldState,
  expandMissionBlocks,
  getMissionTemplate,
  missionGlowFromFilledSlots,
  selectMissionRenderWindow,
  transformMissionSlot,
  type LocalMissionWorldState,
  type MissionInstance,
} from "../domain/mission";
import { queryMissionAwareBounds } from "../domain/missionCollision";
import {
  LOCAL_PLAYER,
  PALETTE,
  SYSTEM_OWNER,
  WORLD_ID,
  type BlockRotation,
  type GridPosition,
  type LocalGameState,
  type Vector3Like,
  type VoxelBlock,
  type WorldSnapshot,
  type ZoneKind,
} from "../domain/types";
import { VoxelWorld } from "../domain/world";
import {
  RepositoryRequestError,
  type CollaborativeWorldRepository,
  type ContributeToMissionRequest,
  type DismantleTicket,
  type FreeModeMutationResult,
  type FreeModeOverviewResult,
  type GameMode,
  type WorldMutationResult,
} from "../data/CollaborativeWorldRepository";
import {
  IndexedDbUpgradeBlockedError,
  IndexedDbWorldRepository,
} from "../data/IndexedDbWorldRepository";
import { LocalCollaborativeWorldRepository } from "../data/LocalCollaborativeWorldRepository";
import {
  MemoryWorldRepository,
  type WorldRepository,
} from "../data/WorldRepository";
import { readRuntimeRepositoryConfig } from "../config/runtimeConfig";
import { isPerformanceHudEnabled } from "../config/performanceConfig";
import type { GameAudio } from "../audio";
import type { SoundSettingsPanel } from "../audio/SoundSettingsPanel";
import type {
  GameInput,
  InputElements,
  InputFrame,
} from "../input/GameInput";
import { PlayerController } from "../player/PlayerController";
import {
  VoxelRenderer,
  missionDisplayBlocksToVisuals,
  selectMissionFocusVisual,
  type PickResult,
} from "../rendering/VoxelRenderer";
import {
  GameUI,
  isTouchLayout,
  type CompletedMissionArchiveEntry,
  type MissionPanelState,
} from "../ui/GameUI";
import {
  withoutOnboardingBlocks,
} from "../world/localWorld";
import {
  ChunkRequestGate,
  ExplicitRetryGate,
  SynchronizedServerClock,
  OnlineProgressGate,
  applyAuthoritativeMutation,
  createNearbyOnlineSystemBlocks,
  createOptimisticPlacementProgress,
  mergeServerAndSystemBlocks,
  reconcileFreeModeMutationResult,
} from "./onlineWorld";
import type { GameAnalytics } from "./GameAnalytics";
import { DeferredGameAnalytics } from "./DeferredGameAnalytics";
import { retryIdempotentOnce } from "./repositoryRetry";
import type {
  AnalyticsFailureCode,
  AnalyticsFailureStage,
} from "../analytics/types";
import {
  bucketRendererTier,
  bucketWorldReadyMs,
  classifyAcquisition,
  classifyInputMode,
  classifyOrientation,
  coarseAnalyticsZone,
  progressStage,
} from "./analyticsContext";

interface GameDependencies {
  clock?: Clock;
  config?: Readonly<GameRulesConfig>;
  analytics?: GameAnalyticsClient;
}

type GameAnalyticsClient = Pick<
  GameAnalytics,
  | "consentChoice"
  | "setConsent"
  | "worldControllable"
  | "markInput"
  | "tick"
  | "increment"
  | "otherCreatorSeen"
  | "creatorDetailsOpened"
  | "milestone"
  | "failure"
  | "checkpoint"
>;

interface GuideCounts {
  base: number;
  producer: number;
  upgrade: number;
}

interface RemovalHoldState {
  blockId: string;
  startedAt: number;
  ticket?: DismantleTicket;
  starting?: boolean;
  finishing?: boolean;
}

type RemovalUiDecision = PermissionDecision & {
  remainingMs?: number;
};

type GameInputConstructor = new (
  elements: InputElements,
  touchMode: boolean,
  onPointerLockChange: (locked: boolean) => void,
) => GameInput;

interface ManualProductionSession {
  step: number;
  readyAt: number;
  serverSessionId?: string;
}

interface ReconcileEvents {
  onboardingCompleted: boolean;
  producerUpgraded: boolean;
}

export class GameApp {
  private readonly ui: GameUI;
  private readonly world: VoxelWorld;
  private readonly renderer: VoxelRenderer;
  private readonly player: PlayerController;
  private readonly collisionSource: CollisionSource;
  private readonly input: GameInput;
  private readonly audio: GameAudio;
  private readonly repository: WorldRepository | null;
  /** 모든 런타임 변경은 local/online 모두 이 검증 명령 저장소를 통과한다. */
  private readonly onlineRepository: CollaborativeWorldRepository;
  private readonly missionRepository: CollaborativeWorldRepository;
  private readonly repositoryMode: "local" | "online";
  private readonly playerOwner: typeof LOCAL_PLAYER;
  private readonly clock: Clock;
  private readonly serverClock: SynchronizedServerClock | null;
  private readonly config: Readonly<GameRulesConfig>;
  private bay: StarterBayLayout;
  private readonly reservedBays: readonly StarterBayLayout[];
  private localState: LocalGameState;
  private gameMode: GameMode = "free";
  private gameModeActivated = false;
  private modeActivationPending = false;
  private freeModeOverview: FreeModeOverviewResult | null = null;
  private freeInventorySettlePending = false;
  private readonly freeInventoryRetryGate = new ExplicitRetryGate();
  private readonly freeChunkRequestGate = new ChunkRequestGate();
  private localMissionState: LocalMissionWorldState | null;
  private activeMission: MissionInstance | null = null;
  private completedMissions: MissionInstance[] = [];
  private missionCollisionBlocks: VoxelBlock[] = [];
  private renderedMission: MissionInstance | null = null;
  private highlightedMissionPublicId: string | null = null;
  private missionContributionPending = false;
  private missionRefreshGeneration = 0;
  private missionEligibility = {
    baseBuilt: 0,
    producerBuilt: 0,
    eligible: false,
  };
  private lastFrameTime = performance.now();
  private lastTimedRefreshAt = Number.NEGATIVE_INFINITY;
  private saveChain: Promise<void> = Promise.resolve();
  private currentHitDisplayKey = "";
  private analyticsCreatorCardKey = "";
  private lastHudDisplayKey = "";
  private lastManualDisplayKey = "";
  private pendingSaveCount = 0;
  private latestHit: PickResult | null = null;
  private removalHold: RemovalHoldState | null = null;
  private manualProduction: ManualProductionSession | null = null;
  private controlsActive = false;
  private stopped = false;
  private onlineMutationPending = false;
  private onlineProductionPending = false;
  private onlineManualStartPending = false;
  private onlineChunkKey = "";
  private onlineChunkGeneration = 0;
  private readonly onlineProgressGate = new OnlineProgressGate();
  private readonly analytics: GameAnalyticsClient;
  private readonly worldReadyMs: number;
  private readonly storageWarning: string | null;
  private readonly performanceHudEnabled = isPerformanceHudEnabled(
    import.meta.env,
    import.meta.env.DEV,
  );
  private lastPerformanceHudAt = Number.NEGATIVE_INFINITY;
  private footstepDistance = 0;

  private constructor(
    root: HTMLElement,
    snapshot: WorldSnapshot,
    repository: WorldRepository | null,
    onlineRepository: CollaborativeWorldRepository,
    missionRepository: CollaborativeWorldRepository,
    repositoryMode: "local" | "online",
    playerOwner: typeof LOCAL_PLAYER,
    storageWarning: string | null,
    clock: Clock,
    config: Readonly<GameRulesConfig>,
    audio: GameAudio,
    SoundSettingsPanelClass: new (root: HTMLElement) => SoundSettingsPanel,
    GameInputClass: GameInputConstructor,
    analytics: GameAnalyticsClient,
    worldReadyMs: number,
  ) {
    if (!snapshot.localState) {
      throw new Error("로컬 플레이어 진행 상태를 준비하지 못했습니다.");
    }

    this.ui = new GameUI(root);
    this.audio = audio;
    this.audio.attachUi(root);
    const soundPanel = new SoundSettingsPanelClass(root);
    this.ui.bindAudioSettings(soundPanel, (change) => {
      if (change.type === "enable-all") {
        this.audio.enableAll();
      } else if (change.type === "disable-all") {
        this.audio.disableAll();
      } else {
        this.audio.setChannel(change.channel, change.level);
      }
    });
    this.audio.subscribe((preferences) => {
      this.ui.setAudioPreferences(preferences);
    });
    this.audio.setScene("menu");
    this.repository = repository;
    this.onlineRepository = onlineRepository;
    this.missionRepository = missionRepository;
    this.repositoryMode = repositoryMode;
    this.playerOwner = { ...playerOwner };
    this.clock = clock;
    this.serverClock =
      clock instanceof SynchronizedServerClock ? clock : null;
    this.config = config;
    this.analytics = analytics;
    this.worldReadyMs = worldReadyMs;
    this.storageWarning = storageWarning;
    this.localState = cloneLocalState(snapshot.localState);
    this.localMissionState = snapshot.localMissionState
      ? cloneLocalMissionWorldState(snapshot.localMissionState)
      : null;
    this.bay = createStarterBayLayout(this.localState.baySlotIndex);
    this.reservedBays = Array.from(
      { length: STARTER_BAY_RESERVED_SLOT_COUNT },
      (_, index) => createStarterBayLayout(index),
    );
    // 자유/관문 모드는 같은 좌표를 각자의 저장 공간에서 사용할 수 있다.
    // 시작 선택 전에는 공통 지형과 관문 쪽 블록만 구성하고, 자유 블록은
    // activateFreeMode의 전용 nearby 조회로 원자 교체한다.
    this.world = new VoxelWorld(
      snapshot.worldId,
      snapshot.blocks.filter(({ source }) => source !== "free"),
    );
    const touchPreferred = isTouchLayout();
    this.renderer = new VoxelRenderer(
      this.ui.canvas,
      this.world,
      touchPreferred,
    );
    this.collisionSource = {
      queryBounds: (min, max) => this.queryCollisionBounds(min, max),
    };
    this.player = new PlayerController(this.collisionSource, this.bay.safeSpawn);
    this.player.yaw = yawToward(this.bay.slot.towardTower);
    this.input = new GameInputClass(
      {
        canvas: this.ui.canvas,
        joystick: this.ui.joystick,
        joystickKnob: this.ui.joystickKnob,
        lookZone: this.ui.lookZone,
        placeButton: this.ui.placeButton,
        removeButton: this.ui.removeButton,
        jumpButton: this.ui.jumpButton,
        rotateButton: this.ui.rotateButton,
      },
      touchPreferred,
      (locked) => this.handlePointerLock(locked),
    );

    this.ui.bindStart((mode) => {
      this.startSelectedMode(mode);
    });
    this.ui.setAnalyticsConsent(this.analytics.consentChoice);
    this.ui.bindAnalyticsConsentChange((choice) => {
      this.analytics.markInput();
      void this.analytics.setConsent(choice);
    });
    this.ui.bindResetBay(() => {
      this.analytics.markInput();
      this.resetBay();
    });
    this.ui.bindManualProduction(() => {
      this.analytics.markInput();
      this.advanceManualProduction();
    });
    this.ui.bindSelection(() => {
      this.analytics.markInput();
      this.ui.toast("블록 모양이나 색을 바꿨어요");
    });
    this.ui.bindMissionContribution((selection) => {
      this.analytics.markInput();
      void this.contributeToMission({
        worldId: this.world.worldId,
        missionInstanceId: selection.instanceId,
        slotIndex: selection.slotIndex,
        paletteIndex: selection.paletteIndex,
        idempotencyKey: crypto.randomUUID(),
      });
    });
    this.ui.bindMissionHighlightMine(() => {
      this.highlightMissionCreator(this.playerOwner.publicId);
    });
    this.ui.bindMissionArchiveOpen(() => {
      this.analytics.markInput();
      this.analytics.increment("archive_open_count");
      void this.refreshMissionArchive();
    });
    this.ui.bindContributorLightSelect((publicId) => {
      this.highlightMissionCreator(publicId);
    });
    this.ui.bindOwnerHighlight((publicId) => {
      this.highlightMissionCreator(publicId);
    });
    this.ui.bindOwnerDetailsOpen(() => {
      this.analytics.markInput();
      this.analytics.creatorDetailsOpened();
    });
    this.ui.bindOwnerFind((publicId, canonicalContributionId) => {
      this.focusMissionCreator(publicId, canonicalContributionId);
    });
    this.ui.bindArchiveVisit((instanceId) => {
      this.analytics.markInput();
      this.visitMissionMonument(instanceId);
    });
    this.ui.bindHighlightClear(() => {
      this.analytics.markInput();
      this.clearMissionHighlight();
    });
    this.ui.bindHighlightFind(() => {
      if (this.highlightedMissionPublicId) {
        this.focusMissionCreator(this.highlightedMissionPublicId);
      }
    });
    this.ui.bindCinematicSkip(() => {
      this.analytics.markInput();
      this.renderer.skipMissionCompletionCinematic();
      this.ui.setCompletionCinematicActive(false);
    });

    this.ui.setPlayerProfile(this.playerOwner);
    this.ui.setRepositoryMode(repositoryMode, this.playerOwner.publicId);
    this.ui.setGameMode(this.gameMode);
    if (storageWarning) {
      this.ui.setSaveState("이번 플레이는 저장되지 않아요", "warning");
      this.ui.toast(storageWarning);
      this.ui.setRecoveryNotice(
        "게임을 저장할 수 없어요",
        storageWarning + " 브라우저의 사이트 저장 권한을 확인해 주세요.",
        () => window.location.reload(),
      );
    } else if (repositoryMode === "online") {
      this.ui.setSaveState("저장됨", "ready");
    } else {
      this.ui.setSaveState("저장됨", "ready");
    }

    this.updateGuides();
    this.updateHud(this.clock.now());

    window.addEventListener("resize", () => this.renderer.resize());
    document.addEventListener("visibilitychange", () => {
      this.lastFrameTime = performance.now();
      this.updateAnalyticsTime(Date.now());
      if (!document.hidden && this.gameModeActivated) {
        void this.refreshActiveMode(true);
      }
    });
    this.ui.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.analytics.increment("context_loss_count");
      this.analytics.failure(
        "webgl_context_lost",
        "renderer",
        false,
        false,
      );
      this.analytics.checkpoint(true);
      this.stopped = true;
      this.controlsActive = false;
      this.input.resetTransientState();
      this.ui.showFatal(
        "3D 화면이 멈췄어요",
        "페이지를 다시 열면 저장된 곳에서 이어집니다.",
      );
    });
    window.addEventListener(
      "pagehide",
      () => this.analytics.checkpoint(true),
      { once: true },
    );

    if (this.analytics.consentChoice === "undecided") {
      queueMicrotask(() => this.ui.openAnalyticsSettings());
    }

    requestAnimationFrame((time) => this.frame(time));
  }

  static async boot(
    root: HTMLElement,
    dependencies: GameDependencies = {},
  ): Promise<GameApp | null> {
    const bootStartedAt = performance.now();
    const analytics = dependencies.analytics ?? DeferredGameAnalytics.create();
    if (!supportsWebGL2()) {
      analytics.failure("webgl_unsupported", "renderer", false, false);
      const preliminaryUi = new GameUI(root);
      preliminaryUi.showFatal(
        "이 기기에서 3D 화면을 열 수 없어요",
        "최신 Safari, Chrome 또는 Edge에서 다시 시도해 주세요.",
      );
      return null;
    }

    const clock = dependencies.clock ?? new SystemClock();
    const config = dependencies.config ?? DEFAULT_GAME_RULES;
    const [{ GameAudio, SoundSettingsPanel }, { GameInput }] = await Promise.all([
      import("../audio"),
      import("../input/GameInput"),
    ]);
    const audio = new GameAudio();
    const runtime = readRuntimeRepositoryConfig(import.meta.env);

    if (runtime.mode === "online") {
      const { createSupabaseRepository } = await import(
        "../data/SupabaseRepository"
      );
      const onlineRepository = createSupabaseRepository(
        runtime.supabaseUrl,
        runtime.supabaseAnonKey,
        { worldId: runtime.worldId },
      );
      // 모드 선택 전에는 자유 건축의 공개 프로필만 준비한다. 미션용
      // bootstrap_player는 사용자가 별빛 관문을 고른 뒤에만 호출해야
      // 베이 용량과 24개 미션 재고가 자유 건축 진입을 막지 않는다.
      const identity = await onlineRepository.getPlayerIdentity(
        runtime.worldId,
      );
      const serverClock = new SynchronizedServerClock(identity.serverNow);
      const onlineBay = createStarterBayLayout(0);
      const spawnChunk = toChunkCoordinate({
        x: Math.floor(onlineBay.safeSpawn.x),
        y: 0,
        z: Math.floor(onlineBay.safeSpawn.z),
      });
      const systemBlocks = createNearbyOnlineSystemBlocks(
        runtime.worldId,
        spawnChunk.x,
        spawnChunk.y,
        spawnChunk.z,
        2,
        1,
      );
      const snapshot: WorldSnapshot = {
        schemaVersion: 3,
        worldId: runtime.worldId,
        blocks: systemBlocks,
        updatedAt: identity.serverNow,
        localState: {
          playerId: identity.player.id,
          // 자유 건축은 베이를 점유하지 않는다. 별빛 관문을 선택하면
          // 권위 bootstrap 응답으로 이 임시 값과 spawn을 함께 교체한다.
          baySlotIndex: 0,
          progress: createLocalPlayerProgress(identity.serverNow),
        },
      };
      const app = new GameApp(
        root,
        snapshot,
        null,
        onlineRepository,
        onlineRepository,
        "online",
        identity.player,
        null,
        serverClock,
        config,
        audio,
        SoundSettingsPanel,
        GameInput,
        analytics,
        performance.now() - bootStartedAt,
      );
      return app;
    }

    let repository: WorldRepository;
    let snapshot: WorldSnapshot;
    let storageWarning: string | null = null;

    if ("indexedDB" in window) {
      repository = new IndexedDbWorldRepository(window.indexedDB);
    } else {
      repository = new MemoryWorldRepository();
      storageWarning =
        "이 기기에 저장할 수 없어 페이지를 닫으면 이번 플레이가 사라집니다.";
    }

    let missionRepository = new LocalCollaborativeWorldRepository(
      repository,
      { clock, config, player: LOCAL_PLAYER },
    );
    try {
      await missionRepository.getPlayerIdentity(WORLD_ID);
      const loaded = await repository.load(WORLD_ID);
      if (!loaded) {
        throw new Error("로컬 월드를 준비하지 못했습니다.");
      }
      snapshot = loaded;
    } catch (error) {
      // 열린 구버전 탭이 schema upgrade를 막는 경우 임시 메모리 월드로
      // 조용히 전환하지 않는다. 저장되지 않는 별도 월드가 생기는 대신,
      // 기존 탭을 닫고 같은 영구 월드로 안전하게 재시도하게 한다.
      if (error instanceof IndexedDbUpgradeBlockedError) {
        throw error;
      }
      repository = new MemoryWorldRepository();
      missionRepository = new LocalCollaborativeWorldRepository(repository, {
        clock,
        config,
        player: LOCAL_PLAYER,
      });
      await missionRepository.getPlayerIdentity(WORLD_ID);
      const loaded = await repository.load(WORLD_ID);
      if (!loaded) {
        throw new Error("임시 로컬 월드를 준비하지 못했습니다.", {
          cause: error,
        });
      }
      snapshot = loaded;
      storageWarning =
        "게임을 저장하지 못해 페이지를 닫으면 이번 플레이가 사라집니다.";
      analytics.failure("storage_failed", "boot", true, true);
    }

    const app = new GameApp(
      root,
      snapshot,
      repository,
      missionRepository,
      missionRepository,
      "local",
      LOCAL_PLAYER,
      storageWarning,
      clock,
      config,
      audio,
      SoundSettingsPanel,
      GameInput,
      analytics,
      performance.now() - bootStartedAt,
    );
    return app;
  }

  private startSelectedMode(mode: GameMode): void {
    if (this.gameModeActivated) {
      this.input.begin();
      return;
    }
    if (this.modeActivationPending) {
      return;
    }
    this.gameMode = mode;
    this.modeActivationPending = true;
    this.ui.setGameMode(mode);
    this.ui.setStartPending(true);

    // Pointer Lock은 사용자 제스처가 살아 있는 동기 구간에서 요청해야 한다.
    // 데이터 준비가 끝날 때까지 frame 입력은 modeActivationPending으로 막는다.
    this.input.begin();
    void this.activateSelectedMode();
  }

  private async activateSelectedMode(): Promise<void> {
    try {
      if (this.gameMode === "free") {
        await this.activateFreeMode();
      } else {
        await this.activateMissionMode();
      }
      this.gameModeActivated = true;
      this.audio.setScene(this.gameMode);
      this.ui.setStartPending(false);
      if (this.controlsActive) {
        this.ui.enterWorld();
        this.recordWorldControllable();
      }
    } catch (error) {
      this.analytics.failure(
        error instanceof RepositoryRequestError && !error.retryable
          ? "commit_rejected"
          : "world_sync_failed",
        "world_read",
        true,
        false,
      );
      this.controlsActive = false;
      this.input.release();
      this.ui.setStartPending(false);
      this.ui.setRecoveryNotice(
        this.gameMode === "free"
          ? "자유 건축을 열지 못했어요"
          : "별빛 관문을 열지 못했어요",
        "연결이나 저장 권한을 확인한 뒤 다시 시도해 주세요.",
        () => this.startSelectedMode(this.gameMode),
      );
    } finally {
      this.modeActivationPending = false;
    }
  }

  private async activateFreeMode(): Promise<void> {
    const overview = await this.onlineRepository.getFreeModeOverview(
      this.world.worldId,
    );
    this.applyFreeModeOverview(overview, false);
    await this.refreshFreeModeWorld(true, false, false, true);
    this.clearMissionPresentation();
    this.updateGuides();
    this.updateHud(this.clock.now());
    this.ui.toast(
      "블록 " +
        String(overview.progress.inventory) +
        "개 · 내 블록은 언제든 회수할 수 있어요",
    );
  }

  private async activateMissionMode(): Promise<void> {
    const bootstrap = await this.onlineRepository.bootstrapPlayer(
      this.world.worldId,
    );
    this.serverClock?.synchronize(bootstrap.serverNow);
    this.localState.playerId = bootstrap.player.id;
    this.localState.baySlotIndex = bootstrap.baySlotIndex;
    this.localState.progress = cloneProgress(bootstrap.progress);
    this.bay = createStarterBayLayout(bootstrap.baySlotIndex);
    this.player.setSpawn(this.bay.safeSpawn, true);
    this.onlineChunkKey = "";
    if (this.repositoryMode === "online") {
      await this.refreshOnlineWorld(true, true);
    } else {
      await this.refreshLocalCollaborativeWorld(true);
    }
    await this.settleOnlineProduction();
    await this.refreshMissionState(true, true);
    this.updateGuides();
    this.updateHud(this.clock.now());
  }

  private async refreshActiveMode(force: boolean): Promise<void> {
    if (this.gameMode === "free") {
      await this.refreshFreeModeWorld(force, true);
      return;
    }
    if (this.repositoryMode === "online") {
      await this.refreshOnlineWorld(force);
    } else {
      await this.refreshLocalCollaborativeWorld();
    }
    await this.settleOnlineProduction();
    await this.refreshMissionState(false);
  }

  private clearMissionPresentation(): void {
    this.activeMission = null;
    this.completedMissions = [];
    this.missionCollisionBlocks = [];
    this.renderedMission = null;
    this.highlightedMissionPublicId = null;
    this.renderer.setMissionVisuals(null);
    this.renderer.setMissionRecommendedPreviews([]);
    this.renderer.setMissionContributorLights([]);
    this.renderer.highlightMissionOwner(null);
    this.ui.setMissionPanel(null);
    this.ui.setMissionArchive([]);
    this.ui.setHighlightState(null);
  }

  private frame(time: number): void {
    if (this.stopped) {
      return;
    }

    const frameElapsedMs = Math.max(0, time - this.lastFrameTime);
    const deltaSeconds = Math.min(frameElapsedMs / 1000, 0.05);
    this.lastFrameTime = time;
    const now = this.clock.now();
    const analyticsNow = Date.now();
    const queuedInput = this.input.consumeFrame();
    const interactionPaused =
      this.modeActivationPending ||
      !this.gameModeActivated ||
      this.ui.isMissionArchiveOpen ||
      this.ui.isAnalyticsSettingsOpen ||
      this.ui.isWorldPanelExpanded ||
      this.ui.isOwnerCardExpanded ||
      this.ui.isMissionPanelExpanded ||
      this.ui.isPaletteExpanded ||
      this.renderer.isMissionCinematicActive ||
      this.missionContributionPending;
    if (interactionPaused) {
      this.input.resetTransientState();
    }
    const input =
      this.controlsActive && !interactionPaused
        ? queuedInput
        : neutralInputFrame();

    if (this.controlsActive && hasAnalyticsInput(queuedInput)) {
      this.analytics.markInput(analyticsNow);
    }

    if (input.selectKind) {
      this.ui.selectKind(input.selectKind);
      this.audio.play("select");
      this.ui.toast("블록 모양을 바꿨어요");
    }
    if (input.colorDelta !== 0) {
      this.ui.cycleColor(input.colorDelta);
      this.audio.play("select");
      this.ui.toast("블록 색을 바꿨어요");
    }
    if (input.rotate) {
      this.ui.rotateSelection();
      this.audio.play("select");
      this.ui.toast("블록을 90° 회전했어요");
    }
    if (this.gameMode === "mission" && input.manualProduction) {
      this.advanceManualProduction();
    }
    if (this.gameMode === "mission" && input.resetBay) {
      this.resetBay();
    }

    const positionBeforeUpdate = { ...this.player.position };
    const groundedBeforeUpdate = this.player.isGrounded;
    this.player.update(deltaSeconds, input);
    if (input.jump && groundedBeforeUpdate) {
      this.audio.play("jump");
    }
    if (hasPlayerMoved(positionBeforeUpdate, this.player.position)) {
      this.analytics.milestone("first_move");
    }
    const horizontalDistance = Math.hypot(
      this.player.position.x - positionBeforeUpdate.x,
      this.player.position.z - positionBeforeUpdate.z,
    );
    if (this.player.isGrounded && horizontalDistance > 0) {
      this.footstepDistance += horizontalDistance;
      if (this.footstepDistance >= 1.7) {
        this.footstepDistance %= 1.7;
        this.audio.play("footstep");
      }
    } else if (!this.player.isGrounded) {
      this.footstepDistance = 0;
    }
    this.renderer.setPlayerPose(
      this.player.cameraPosition,
      this.player.yaw,
      this.player.pitch,
    );
    if (this.gameModeActivated) {
      if (this.gameMode === "free") {
        void this.refreshFreeModeWorld(false, false);
      } else if (this.repositoryMode === "online") {
        void this.refreshOnlineWorld(false);
      }
    }
    this.latestHit = this.renderer.pick();
    this.updateTargetUi(this.latestHit);

    if (input.inspectOwner) {
      this.ui.showOwnerNotice(this.latestHit?.block ?? null);
    }
    if (input.place) {
      const contributorPublicId =
        this.gameMode === "mission"
          ? this.renderer.pickMissionContributorLight()
          : null;
      if (contributorPublicId) {
        this.highlightMissionCreator(contributorPublicId);
      } else {
        this.placeSelectedBlock();
      }
    }
    if (this.gameMode === "free") {
      this.handleFreeModeRemoval(input, time);
    } else {
      this.handleRemoval(input, time);
    }
    if (!this.missionContributionPending) {
      this.refreshTimedProgress(now, false, time);
    }
    this.updateHud(now);

    this.updateAnalyticsTime(
      analyticsNow,
      this.controlsActive && frameElapsedMs > 0 && frameElapsedMs <= 1_000
        ? 1_000 / frameElapsedMs
        : undefined,
    );

    this.renderer.render();
    if (
      this.performanceHudEnabled &&
      time - this.lastPerformanceHudAt >= 750
    ) {
      this.lastPerformanceHudAt = time;
      const performanceSnapshot = this.renderer.getPerformanceSnapshot();
      this.ui.setPerformanceHud({
        fps: performanceSnapshot.framesPerSecond,
        drawCalls: performanceSnapshot.drawCalls,
        visibleBlocks: performanceSnapshot.visibleBlockCount,
        activeChunks: performanceSnapshot.activeChunkCount,
      });
    }
    requestAnimationFrame((nextTime) => this.frame(nextTime));
  }

  private updateTargetUi(hit: PickResult | null): void {
    // 제작자 상세를 읽는 동안에는 열 당시의 블록 snapshot을 고정한다.
    // 닫힌 다음 프레임부터 현재 raycast 결과로 다시 동기화한다.
    if (this.ui.isOwnerCardExpanded) {
      this.renderer.showPlacementPreview(null, false);
      return;
    }
    if (!hit) {
      this.renderer.showPlacementPreview(null, false);
      this.analyticsCreatorCardKey = "";
      if (this.currentHitDisplayKey !== "none") {
        this.currentHitDisplayKey = "none";
        this.ui.setOwnerBlock(null, false);
      }
      return;
    }

    const position = placementPosition(hit.block.position, hit.normal);
    const valid = this.canPlaceAt(position, hit);
    const removal = this.getRemovalDecision(hit.block, 0);
    const removalLabel =
      this.gameMode === "free"
        ? this.freeModeRemovalHint(hit.block, removal)
        : removalHint(removal);
    const displayKey = [
      hit.mission?.visualId ?? hit.block.id,
      valid ? "place" : "blocked",
      removal.reason,
      removalLabel,
    ].join(":");
    const creatorCardKey = hit.mission?.visualId ?? hit.block.id;
    if (this.analyticsCreatorCardKey !== creatorCardKey) {
      this.analyticsCreatorCardKey = creatorCardKey;
      if (
        hit.block.owner.id !== this.playerOwner.id &&
        hit.block.owner.id !== SYSTEM_OWNER.id
      ) {
        this.analytics.otherCreatorSeen(hit.block.owner.publicId);
      }
    }
    this.renderer.showPlacementPreview(position, valid);

    if (this.currentHitDisplayKey !== displayKey) {
      this.currentHitDisplayKey = displayKey;
      this.ui.setOwnerBlock(
        hit.block,
        removal.allowed || removal.requiresHold,
        valid,
        removalLabel,
        hit.mission
          ? {
              missionName: hit.mission.missionName,
              layer: hit.mission.layer,
              canonicalContributionId:
                hit.mission.canonicalContributionId,
            }
          : undefined,
      );
    }
  }

  private placeSelectedBlock(): void {
    const hit = this.latestHit;
    if (!hit) {
      this.ui.toast("놓을 면을 먼저 조준해 주세요");
      return;
    }

    const position = placementPosition(hit.block.position, hit.normal);
    if (!this.canPlaceAt(position, hit)) {
      if (this.currentInventory() <= 0) {
        this.analytics.increment("insufficient_inventory_count");
      }
      this.ui.toast(this.placementFailureMessage(position));
      return;
    }

    if (this.gameMode === "free") {
      void this.commitFreeModePlacement(hit, position);
      return;
    }

    const now = this.clock.now();
    const guide = guideAtPosition(this.bay, position);
    const wasOperational = this.isProducerOperational();
    const onboarding = this.isOnboardingActive();
    const selection = this.ui.currentSelection;
    const zone = this.classifyPosition(position).zone;
    const supportCandidate =
      this.world.getBlock({
        x: position.x,
        y: position.y - 1,
        z: position.z,
      }) ?? hit.block;
    const supportId = isUuid(supportCandidate.id)
      ? supportCandidate.id
      : undefined;
    const block: VoxelBlock = {
      id: createLocalId(),
      worldId: this.world.worldId,
      position,
      kind: guide?.kind ?? selection.kind,
      rotation: (guide?.rotation ?? selection.rotation) as BlockRotation,
      colorIndex: selection.colorIndex,
      owner: this.playerOwner,
      zone: zone as ZoneKind,
      createdAt: now,
      ...(supportId ? { supportId } : {}),
      source: onboarding ? "onboarding" : "inventory",
    };

    if (this.onlineRepository) {
      void this.commitOnlinePlacement(block, guide);
      return;
    }

    this.world.addBlock(block);
    this.localState.progress = {
      ...this.localState.progress,
      inventory: this.localState.progress.inventory - 1,
    };
    this.renderer.updateAt(block.position);
    const countsAfterPlacement = this.getGuideCounts();
    if (
      !wasOperational &&
      isProductionOperational(
        this.localState.progress,
        countsAfterPlacement.producer,
        this.config,
      )
    ) {
      this.localState.progress = {
        ...this.localState.progress,
        lastSettledAt: Math.max(this.localState.progress.lastSettledAt, now),
      };
    }
    const events = this.reconcileWorldProgress(now);
    this.updateGuides();
    this.currentHitDisplayKey = "";
    this.queueSave();
    this.audio.play("place");
    this.ui.toast(
      events.onboardingCompleted
        ? "내 공간과 블록 공방 완성 · 블록 2개를 받았어요"
        : events.producerUpgraded
          ? "블록 공방 Lv.2 · 2시간마다 블록 1개"
          : guide
            ? guidePlacementToast(guide)
            : "블록을 놓았어요",
    );
  }

  private async commitFreeModePlacement(
    hit: PickResult,
    position: GridPosition,
  ): Promise<void> {
    if (
      this.onlineMutationPending ||
      !this.freeModeOverview ||
      !this.onlineProgressGate.tryEnter()
    ) {
      this.ui.toast("이전 작업을 확인하고 있어요");
      return;
    }
    const previous = structuredClone(this.freeModeOverview);
    const selection = this.ui.currentSelection;
    const supportCandidate =
      this.world.getBlock({
        x: position.x,
        y: position.y - 1,
        z: position.z,
      }) ?? hit.block;
    const block: VoxelBlock = {
      id: createLocalId(),
      worldId: this.world.worldId,
      position: { ...position },
      kind: selection.kind,
      rotation: selection.rotation,
      colorIndex: selection.colorIndex,
      owner: this.playerOwner,
      zone: "public",
      createdAt: this.clock.now(),
      source: "free",
      ...(supportCandidate.source === "free" && isUuid(supportCandidate.id)
        ? { supportId: supportCandidate.id }
        : {}),
    };
    const request = {
      worldId: this.world.worldId,
      idempotencyKey: crypto.randomUUID(),
      actions: [
        {
          type: "place" as const,
          blockId: block.id,
          position: { ...block.position },
          kind: block.kind,
          rotation: block.rotation,
          colorIndex: block.colorIndex,
          ...(block.supportId ? { supportId: block.supportId } : {}),
        },
      ],
    };
    this.onlineMutationPending = true;
    this.onlineChunkGeneration += 1;
    this.renderer.showPendingBlock(block);
    this.freeModeOverview = {
      ...previous,
      progress: {
        ...previous.progress,
        inventory: Math.max(0, previous.progress.inventory - 1),
      },
    };
    this.updateHud(this.clock.now());
    this.ui.setSaveState("블록 놓는 중", "saving");
    try {
      const attempt = await retryIdempotentOnce(() =>
        this.onlineRepository.commitFreeModeActions(request),
      );
      if (attempt.retried) {
        this.recordRecoveredRetry("commit_network_failed", "world_write");
      }
      await this.applyFreeModeMutationOrRefresh(attempt.value);
      if (!attempt.value.replayed || attempt.retried) {
        this.analytics.increment("public_blocks_placed");
        this.analytics.milestone("first_block");
      }
      if (!attempt.value.replayed || attempt.retried) {
        this.audio.play("place");
      }
      this.ui.toast("블록을 놓았어요");
    } catch (error) {
      this.freeModeOverview = previous;
      this.recordCommitFailure(error);
      await this.restoreActiveModeState(error);
    } finally {
      this.onlineMutationPending = false;
      this.onlineProgressGate.leave();
      this.renderer.showPendingBlock(null);
      this.updateHud(this.clock.now());
    }
  }

  private handleRemoval(input: InputFrame, monotonicNow: number): void {
    if (!input.removeHeld && !input.remove) {
      if (this.onlineRepository) {
        this.cancelOnlineRemovalHold();
      } else {
        this.cancelRemovalHold();
      }
      return;
    }

    const hit = this.latestHit;
    if (!hit) {
      if (input.remove) {
        this.ui.toast("제거할 블록을 먼저 조준해 주세요");
      }
      if (this.onlineRepository) {
        this.cancelOnlineRemovalHold();
      } else {
        this.cancelRemovalHold();
      }
      return;
    }

    if (this.onlineRepository) {
      this.handleOnlineRemoval(input, monotonicNow, hit.block);
      return;
    }

    if (this.removalHold && this.removalHold.blockId !== hit.block.id) {
      this.cancelRemovalHold();
      return;
    }

    if (input.remove && !this.removalHold) {
      const initial = this.getRemovalDecision(hit.block, 0);
      if (initial.allowed && !initial.requiresHold) {
        this.removeBlock(hit.block, initial);
        return;
      }
      if (!initial.requiresHold) {
        this.ui.toast(removalFailureMessage(initial));
        this.cancelRemovalHold();
        return;
      }
      this.removalHold = {
        blockId: hit.block.id,
        startedAt: monotonicNow,
      };
    }

    if (!this.removalHold || !input.removeHeld) {
      return;
    }

    const heldMs = Math.max(0, monotonicNow - this.removalHold.startedAt);
    const decision = this.getRemovalDecision(hit.block, heldMs);
    this.ui.setRemovalHold(heldMs / Math.max(1, decision.holdMs));
    if (decision.allowed) {
      this.removeBlock(hit.block, decision);
    }
  }

  private handleFreeModeRemoval(
    input: InputFrame,
    monotonicNow: number,
  ): void {
    if (!input.removeHeld && !input.remove) {
      this.cancelRemovalHold();
      return;
    }
    const block = this.latestHit?.block;
    if (!block) {
      if (input.remove) {
        this.ui.toast("제거할 블록을 먼저 조준해 주세요");
      }
      this.cancelRemovalHold();
      return;
    }
    if (this.removalHold && this.removalHold.blockId !== block.id) {
      this.cancelRemovalHold();
      return;
    }
    if (input.remove && !this.removalHold) {
      const initial = this.getRemovalDecision(block, 0);
      if (initial.allowed && !initial.requiresHold) {
        void this.commitFreeModeRemoval(block);
        return;
      }
      if (!initial.requiresHold) {
        this.ui.toast(this.freeModeRemovalFailureMessage(block, initial));
        return;
      }
      this.removalHold = {
        blockId: block.id,
        startedAt: monotonicNow,
      };
      this.ui.setRemovalHold(0);
    }
    if (!this.removalHold || !input.removeHeld) {
      return;
    }
    const heldMs = Math.max(0, monotonicNow - this.removalHold.startedAt);
    const decision = this.getRemovalDecision(block, heldMs);
    this.ui.setRemovalHold(heldMs / Math.max(1, decision.holdMs));
    if (decision.allowed) {
      void this.commitFreeModeRemoval(block);
    }
  }

  private async commitFreeModeRemoval(block: VoxelBlock): Promise<void> {
    if (
      this.onlineMutationPending ||
      !this.freeModeOverview ||
      !this.onlineProgressGate.tryEnter()
    ) {
      return;
    }
    const request = {
      worldId: this.world.worldId,
      idempotencyKey: crypto.randomUUID(),
      actions: [{ type: "remove" as const, blockId: block.id }],
    };
    this.onlineMutationPending = true;
    this.onlineChunkGeneration += 1;
    this.ui.setSaveState("블록 회수 중", "saving");
    try {
      const attempt = await retryIdempotentOnce(() =>
        this.onlineRepository.commitFreeModeActions(request),
      );
      if (attempt.retried) {
        this.recordRecoveredRetry("commit_network_failed", "world_write");
      }
      await this.applyFreeModeMutationOrRefresh(attempt.value);
      if (!attempt.value.replayed || attempt.retried) {
        this.analytics.increment(
          block.owner.id === this.playerOwner.id
            ? "own_blocks_removed"
            : "foreign_blocks_removed",
        );
      }
      if (!attempt.value.replayed || attempt.retried) {
        this.audio.play("remove");
      }
      this.ui.toast(
        block.owner.id === this.playerOwner.id
          ? "블록을 회수했어요"
          : "오래된 블록을 정리했어요",
      );
    } catch (error) {
      this.recordCommitFailure(error);
      await this.restoreActiveModeState(error);
    } finally {
      this.onlineMutationPending = false;
      this.onlineProgressGate.leave();
      this.cancelRemovalHold();
      this.updateHud(this.clock.now());
    }
  }

  private removeBlock(block: VoxelBlock, decision: PermissionDecision): void {
    const now = this.clock.now();
    const wasOperational = this.isProducerOperational();
    const inventoryBefore = this.localState.progress.inventory;
    const removed = this.world.removeBlock(block.id);
    if (!removed) {
      this.cancelRemovalHold();
      return;
    }

    const refundable =
      decision.refundInventory > 0 &&
      removed.owner.id === this.playerOwner.id &&
      (removed.source === "onboarding" || removed.source === "inventory");
    if (refundable) {
      this.localState.progress = {
        ...this.localState.progress,
        inventory: Math.min(
          this.config.maxInventory,
          this.localState.progress.inventory + decision.refundInventory,
        ),
      };
    }
    const refunded = this.localState.progress.inventory - inventoryBefore;

    this.renderer.updateAt(removed.position);
    this.reconcileWorldProgress(now);
    if (wasOperational && !this.isProducerOperational()) {
      this.localState.progress = {
        ...this.localState.progress,
        lastSettledAt: Math.max(this.localState.progress.lastSettledAt, now),
      };
      this.manualProduction = null;
    }
    this.updateGuides();
    this.currentHitDisplayKey = "";
    this.cancelRemovalHold();
    this.queueSave();
    this.audio.play("remove");
    this.ui.toast(
      removed.owner.id === this.playerOwner.id
        ? refunded > 0
          ? "블록을 회수했어요"
          : refundable
            ? "가지고 있는 블록이 가득 차 정리만 했어요"
            : "블록을 정리했어요"
        : "다른 사람이 놓은 블록을 제거했어요 · 블록은 돌아오지 않아요",
    );
  }

  private handleOnlineRemoval(
    input: InputFrame,
    monotonicNow: number,
    block: VoxelBlock,
  ): void {
    if (this.onlineProgressGate.busy) {
      return;
    }
    if (this.removalHold && this.removalHold.blockId !== block.id) {
      this.cancelOnlineRemovalHold();
      return;
    }
    if (!input.removeHeld && !input.remove) {
      this.cancelOnlineRemovalHold();
      return;
    }

    if (input.remove && !this.removalHold) {
      const decision = this.getRemovalDecision(block, 0);
      if (decision.allowed && !decision.requiresHold) {
        void this.commitOnlineRemoval(block);
        return;
      }
      if (!decision.requiresHold) {
        this.ui.toast(removalFailureMessage(decision));
        return;
      }
      const hold: RemovalHoldState = {
        blockId: block.id,
        startedAt: monotonicNow,
        starting: true,
      };
      this.removalHold = hold;
      this.ui.setRemovalHold(0);
      void this.startOnlineDismantle(block, hold);
      return;
    }

    const hold = this.removalHold;
    if (!hold || hold.starting || !hold.ticket || hold.finishing) {
      return;
    }
    const heldMs = Math.max(0, monotonicNow - hold.startedAt);
    this.ui.setRemovalHold(heldMs / OTHER_PUBLIC_REMOVAL_HOLD_MS);
    if (heldMs >= OTHER_PUBLIC_REMOVAL_HOLD_MS) {
      hold.finishing = true;
      void this.finishOnlineDismantle(hold.ticket);
    }
  }

  private async commitOnlineRemoval(block: VoxelBlock): Promise<void> {
    const repository = this.onlineRepository;
    if (
      !repository ||
      this.onlineMutationPending ||
      !this.onlineProgressGate.tryEnter()
    ) {
      return;
    }
    this.onlineMutationPending = true;
    this.onlineChunkGeneration += 1;
    this.ui.setSaveState("블록 회수 중", "saving");
    const request = {
      worldId: this.world.worldId,
      idempotencyKey: crypto.randomUUID(),
      actions: [{ type: "remove" as const, blockId: block.id }],
    };
    try {
      const attempt = await retryIdempotentOnce(() =>
        repository.commitWorldActions(request),
      );
      const result = attempt.value;
      if (attempt.retried) {
        this.recordRecoveredRetry("commit_network_failed", "world_write");
      }
      this.applyOnlineMutation(result);
      if (!result.replayed || attempt.retried) {
        this.analytics.increment(
          block.owner.id === this.playerOwner.id
            ? "own_blocks_removed"
            : "foreign_blocks_removed",
        );
      }
      if (!result.replayed || attempt.retried) {
        this.audio.play("remove");
      }
      this.ui.toast("블록을 회수했어요");
    } catch (error) {
      this.recordCommitFailure(error);
      await this.restoreOnlineState(error);
    } finally {
      this.onlineMutationPending = false;
      this.onlineProgressGate.leave();
      this.cancelRemovalHold();
      this.updateHud(this.clock.now());
    }
  }

  private async startOnlineDismantle(
    block: VoxelBlock,
    hold: RemovalHoldState,
  ): Promise<void> {
    const repository = this.onlineRepository;
    if (!repository) {
      return;
    }
    const idempotencyKey = crypto.randomUUID();
    try {
      const attempt = await retryIdempotentOnce(() =>
        repository.startDismantle(
          this.world.worldId,
          block.id,
          idempotencyKey,
        ),
      );
      const ticket = attempt.value;
      if (attempt.retried) {
        this.recordRecoveredRetry("commit_network_failed", "world_write");
      }
      if (this.removalHold !== hold) {
        await repository.cancelDismantle(this.world.worldId, ticket.id);
        return;
      }
      this.serverClock?.synchronize(ticket.serverNow);
      hold.ticket = ticket;
      hold.starting = false;
      hold.startedAt = performance.now();
    } catch (error) {
      this.recordCommitFailure(error);
      if (this.removalHold === hold) {
        this.cancelRemovalHold();
        this.ui.toast(onlineFailureMessage(error));
      }
    }
  }

  private async finishOnlineDismantle(
    ticket: DismantleTicket,
  ): Promise<void> {
    const repository = this.onlineRepository;
    if (
      !repository ||
      this.onlineMutationPending ||
      !this.onlineProgressGate.tryEnter()
    ) {
      if (this.removalHold) {
        this.removalHold.finishing = false;
      }
      return;
    }
    this.onlineMutationPending = true;
    this.onlineChunkGeneration += 1;
    this.ui.setSaveState("블록 제거 중", "saving");
    const idempotencyKey = crypto.randomUUID();
    try {
      const attempt = await retryIdempotentOnce(() =>
        repository.finishDismantle(
          this.world.worldId,
          ticket.id,
          idempotencyKey,
        ),
      );
      const result = attempt.value;
      if (attempt.retried) {
        this.recordRecoveredRetry("commit_network_failed", "world_write");
      }
      this.serverClock?.synchronize(result.serverNow);
      this.localState.progress = cloneProgress(result.progress);
      this.world.removeBlock(result.removedBlockId);
      if (!result.replayed || attempt.retried) {
        this.analytics.increment("foreign_blocks_removed");
      }
      this.renderer.rebuildAll();
      this.updateGuides();
      this.ui.setSaveState("저장됨", "ready");
      if (!result.replayed || attempt.retried) {
        this.audio.play("remove");
      }
      this.ui.toast("다른 사람이 놓은 블록을 제거했어요 · 블록은 돌아오지 않아요");
    } catch (error) {
      this.recordCommitFailure(error);
      await this.restoreOnlineState(error);
    } finally {
      this.onlineMutationPending = false;
      this.onlineProgressGate.leave();
      this.cancelRemovalHold();
      this.updateHud(this.clock.now());
    }
  }

  private cancelOnlineRemovalHold(): void {
    if (this.removalHold?.finishing) {
      return;
    }
    const ticket = this.removalHold?.ticket;
    const repository = this.onlineRepository;
    this.cancelRemovalHold();
    if (ticket && repository) {
      void repository
        .cancelDismantle(this.world.worldId, ticket.id)
        .catch(() => undefined);
    }
  }

  private canPlaceAt(position: GridPosition, hit?: PickResult): boolean {
    if (
      this.missionContributionPending ||
      this.onlineProgressGate.busy ||
      this.currentInventory() <= 0 ||
      !this.world.canPlace(position) ||
      blockIntersectsPlayer(this.player.position, position)
    ) {
      return false;
    }

    if (this.gameMode === "free") {
      if (isFreeModeSpawnClearancePosition(position)) {
        return false;
      }
      if (position.y === 1) {
        return hasFreeModeDeterministicGround(this.world.blocks, position);
      }
      // 서버와 같은 규칙으로, 공중 배치는 자유 건축 블록의 면에
      // 이어지는 경우만 미리 허용한다. 중앙 장식 위에 놓을 수 있는
      // 것처럼 보였다가 서버에서 거절되는 잘못된 미리보기를 막는다.
      const support =
        this.world.getBlock({
          x: position.x,
          y: position.y - 1,
          z: position.z,
        }) ?? hit?.block;
      return support?.source === "free";
    }

    const classification = this.classifyPosition(position);
    const zone = classification.zone;
    const permission = decidePlacement({
      actorId: this.playerOwner.id,
      zone,
      ...(zone === "personal" || zone === "producer"
        ? {
            zoneOwnerId:
              classification.slotIndex === this.localState.baySlotIndex
                ? this.playerOwner.id
                : "reserved-bay-" + String(classification.slotIndex),
          }
        : {}),
    });
    if (!permission.allowed) {
      return false;
    }

    if (!this.isOnboardingActive()) {
      return true;
    }

    const guide = guideAtPosition(this.bay, position);
    return guide?.group === "base" || guide?.group === "producer";
  }

  private placementFailureMessage(position: GridPosition): string {
    if (this.currentInventory() <= 0) {
      return "놓을 블록이 없어요";
    }
    if (this.gameMode === "free") {
      if (isFreeModeSpawnClearancePosition(position)) {
        return "시작 지점과 광장으로 가는 길은 비워 두고 조금 떨어진 곳에 놓아 주세요";
      }
      if (
        position.y === 1 &&
        !hasFreeModeDeterministicGround(this.world.blocks, position)
      ) {
        return "바닥이 있는 곳에 놓아 주세요";
      }
      return this.world.hasBlock(position)
        ? "이미 블록이 있는 자리예요"
        : "그 위치에는 블록을 놓을 수 없어요";
    }
    const zone = this.classifyPosition(position).zone;
    if (zone === "mission" || zone === "system" || zone === "spawn") {
      return "보호된 구역에는 놓을 수 없어요";
    }
    if (this.isOnboardingActive()) {
      return "먼저 민트빛 16칸과 금빛 8칸을 채워 주세요";
    }
    return "그 위치에는 블록을 놓을 수 없어요";
  }

  private getRemovalDecision(
    block: VoxelBlock,
    heldMs: number,
  ): RemovalUiDecision {
    if (this.gameMode === "free") {
      const decision = decideFreeModeRemoval({
        actorId: this.playerOwner.id,
        block,
        allBlocks: this.world.blocks,
        now: this.clock.now(),
      });
      if (!decision.allowed) {
        return {
          allowed: false,
          requiresHold: false,
          holdMs: 0,
          reason:
            decision.reason === "support-in-use"
              ? "support-in-use"
              : decision.reason === "protected-zone"
                ? "protected-zone"
                : "owner-only",
          refundInventory: 0,
          remainingMs: decision.remainingMs,
        };
      }
      const foreign = block.owner.id !== this.playerOwner.id;
      return {
        allowed: !foreign || heldMs >= OTHER_PUBLIC_REMOVAL_HOLD_MS,
        requiresHold: foreign,
        holdMs: foreign ? OTHER_PUBLIC_REMOVAL_HOLD_MS : 0,
        reason:
          foreign && heldMs < OTHER_PUBLIC_REMOVAL_HOLD_MS
            ? "hold-required"
            : "allowed",
        refundInventory: decision.refundInventory,
        remainingMs: 0,
      };
    }
    const classification = this.classifyPosition(block.position);
    const classifiedZone = classification.zone;
    const storedProtected =
      block.zone === "system" || block.zone === "mission";
    const effectiveZone =
      storedProtected || classifiedZone === "public"
        ? block.zone
        : classifiedZone;
    const effectiveBlock = { ...block, zone: effectiveZone };
    const isPrivate =
      effectiveZone === "personal" || effectiveZone === "producer";
    const belongsToLocalBay =
      isPrivate &&
      classifiedZone === effectiveZone &&
      classification.slotIndex === this.localState.baySlotIndex;
    return decideRemoval({
      actorId: this.playerOwner.id,
      block: effectiveBlock,
      allBlocks: this.world.blocks,
      ...(isPrivate
        ? {
            zoneOwnerId: belongsToLocalBay
              ? this.playerOwner.id
              : block.owner.id,
          }
        : {}),
      heldMs,
    });
  }

  private freeModeRemovalHint(
    block: VoxelBlock,
    decision: RemovalUiDecision,
  ): string {
    if (block.source !== "free") {
      return "이 블록은 바꿀 수 없어요";
    }
    if (block.owner.id === this.playerOwner.id && decision.allowed) {
      return "내 블록 · 바로 회수 가능";
    }
    if ((decision.remainingMs ?? 0) > 0) {
      return (
        formatFreeModeProtectionTime(decision.remainingMs ?? 0) +
        " 뒤부터 정리 가능"
      );
    }
    if (decision.requiresHold) {
      return "2.5초 길게 눌러 정리";
    }
    return removalFailureMessage(decision);
  }

  private freeModeRemovalFailureMessage(
    block: VoxelBlock,
    decision: RemovalUiDecision,
  ): string {
    if ((decision.remainingMs ?? 0) > 0) {
      return (
        "다른 사람이 놓은 블록은 " +
        formatFreeModeProtectionTime(decision.remainingMs ?? 0) +
        " 뒤부터 정리할 수 있어요"
      );
    }
    return this.freeModeRemovalHint(block, decision);
  }

  private currentInventory(): number {
    return this.gameMode === "free"
      ? (this.freeModeOverview?.progress.inventory ?? 0)
      : this.localState.progress.inventory;
  }

  private reconcileWorldProgress(now: number): ReconcileEvents {
    const counts = this.getGuideCounts();
    const previous = this.localState.progress;
    let next = reconcileOnboardingCompletion(
      previous,
      counts.base,
      counts.producer,
      now,
      this.config,
    );

    if (isProductionOperational(next, counts.producer, this.config)) {
      const upgrade = reconcileProductionUpgrade(
        next,
        counts.upgrade,
        counts.producer,
        now,
        this.config,
      );
      next = upgrade.progress;
    }

    this.localState.progress = next;
    return {
      onboardingCompleted:
        !previous.trialRewardClaimed && next.trialRewardClaimed,
      producerUpgraded:
        previous.productionLevel === 1 && next.productionLevel === 2,
    };
  }

  private refreshTimedProgress(
    now: number,
    force = false,
    monotonicNow = performance.now(),
  ): void {
    if (this.gameMode === "free") {
      if (
        !this.gameModeActivated ||
        this.freeInventorySettlePending ||
        !this.freeInventoryRetryGate.canAttempt(force) ||
        (!force &&
          now >= this.lastTimedRefreshAt &&
          now - this.lastTimedRefreshAt < 1_000)
      ) {
        return;
      }
      this.lastTimedRefreshAt = now;
      const overview = this.freeModeOverview;
      if (
        overview &&
        overview.progress.inventory < overview.maxInventory &&
        overview.progress.lastSettledAt + overview.grantIntervalMs <= now
      ) {
        void this.settleFreeModeInventory();
      }
      return;
    }
    if (this.onlineRepository) {
      if (
        this.repositoryMode === "local" &&
        (force ||
          now < this.lastTimedRefreshAt ||
          now - this.lastTimedRefreshAt >= 1_000)
      ) {
        this.lastTimedRefreshAt = now;
        if (this.isProducerOperational()) {
          const nextAutomaticIn = getNextAutomaticProductionInMs(
            this.localState.progress,
            now,
            this.config,
          );
          if (nextAutomaticIn !== null && nextAutomaticIn <= 0) {
            void this.settleOnlineProduction();
          }
        }
      }
      if (
        this.manualProduction?.serverSessionId &&
        this.manualProduction.step >= this.config.manualProductionStepCount &&
        monotonicNow >= this.manualProduction.readyAt
      ) {
        void this.finishOnlineManualProduction(
          this.manualProduction.serverSessionId,
        );
      }
      return;
    }
    if (
      !force &&
      now >= this.lastTimedRefreshAt &&
      now - this.lastTimedRefreshAt < 1_000
    ) {
      return;
    }
    this.lastTimedRefreshAt = now;
    const operational = this.isProducerOperational();

    if (
      this.manualProduction &&
      this.manualProduction.step >= this.config.manualProductionStepCount &&
      now >= this.manualProduction.readyAt
    ) {
      if (operational) {
        this.finishManualProduction(now);
      } else {
        this.manualProduction = null;
        this.ui.toast("블록 공방 8칸을 다시 채우면 만들기를 계속할 수 있어요");
      }
    }

    if (!operational) {
      return;
    }
    const settlement = settleAutomaticProduction(
      this.localState.progress,
      now,
      this.config,
    );
    if (settlement.elapsedSlots === 0) {
      return;
    }

    this.localState.progress = settlement.progress;
    this.queueSave();
    if (settlement.produced > 0) {
      this.ui.toast(
        "블록 공방에서 " + String(settlement.produced) + "개를 받았어요",
      );
    }
  }

  private async settleFreeModeInventory(): Promise<void> {
    if (
      this.freeInventorySettlePending ||
      this.gameMode !== "free" ||
      !this.freeInventoryRetryGate.canAttempt() ||
      !this.onlineProgressGate.tryEnter()
    ) {
      return;
    }
    this.freeInventorySettlePending = true;
    try {
      const overview = await this.onlineRepository.settleFreeModeInventory(
        this.world.worldId,
      );
      this.applyFreeModeOverview(overview, true);
      this.updateHud(this.clock.now());
    } catch {
      this.freeInventoryRetryGate.recordFailure();
      this.ui.setRecoveryNotice(
        "블록 충전을 확인하지 못했어요",
        "연결을 확인한 뒤 다시 시도해 주세요. 지금 가진 블록은 그대로 사용할 수 있어요.",
        () => this.retrySynchronization(),
      );
    } finally {
      this.freeInventorySettlePending = false;
      this.onlineProgressGate.leave();
    }
  }

  private advanceManualProduction(): void {
    if (this.gameMode !== "mission") {
      return;
    }
    if (this.onlineRepository) {
      this.advanceOnlineManualProduction();
      return;
    }
    const now = this.clock.now();
    this.refreshTimedProgress(now, true);
    const progress = this.localState.progress;
    const counts = this.getGuideCounts();
    if (!isProductionOperational(progress, counts.producer, this.config)) {
      this.ui.toast(
        progress.trialRewardClaimed
          ? "블록 공방 8칸을 다시 채워 주세요"
          : "내 공간 16칸과 블록 공방 8칸을 먼저 채워 주세요",
      );
      return;
    }
    if (
      getManualProductionRemainingAttempts(progress, now, this.config) <= 0
    ) {
      this.ui.toast("최근 24시간 동안 만들 수 있는 블록 3개를 모두 만들었어요");
      return;
    }
    if (progress.inventory >= this.config.maxInventory) {
      this.ui.toast("가지고 있는 블록이 가득 찼어요");
      return;
    }

    const stepDuration =
      this.config.manualProductionDurationMs /
      this.config.manualProductionStepCount;
    if (!this.manualProduction) {
      this.manualProduction = { step: 1, readyAt: now + stepDuration };
      this.ui.toast("1단계: 동력 채우기");
      return;
    }
    if (now < this.manualProduction.readyAt) {
      this.ui.toast("잠시 뒤 다시 눌러 주세요");
      return;
    }
    if (this.manualProduction.step < this.config.manualProductionStepCount) {
      this.manualProduction = {
        step: this.manualProduction.step + 1,
        readyAt: now + stepDuration,
      };
      this.ui.toast(
        String(this.manualProduction.step) + "단계를 시작했어요",
      );
    }
  }

  private finishManualProduction(now: number): void {
    if (!this.isProducerOperational()) {
      this.manualProduction = null;
      this.ui.toast("블록 공방 8칸이 채워지지 않아 만들기를 멈췄어요");
      return;
    }
    const result = tryManualProduction(
      this.localState.progress,
      now,
      this.config,
    );
    this.manualProduction = null;
    this.localState.progress = result.progress;
    if (result.produced) {
      this.queueSave();
      this.ui.toast("블록 만들기 완료 · 1개를 받았어요");
    } else {
      this.ui.toast(
        result.reason === "inventory-full"
          ? "가지고 있는 블록이 가득 찼어요"
          : "최근 24시간 동안 만들 수 있는 블록을 모두 만들었어요",
      );
    }
  }

  private advanceOnlineManualProduction(): void {
    if (
      this.onlineManualStartPending ||
      this.onlineMutationPending ||
      this.onlineProgressGate.busy
    ) {
      this.ui.toast("블록 만들기를 준비하고 있어요");
      return;
    }
    if (!this.isProducerOperational()) {
      this.ui.toast(
        this.localState.progress.trialRewardClaimed
          ? "블록 공방 8칸을 다시 채워 주세요"
          : "내 공간 16칸과 블록 공방 8칸을 먼저 채워 주세요",
      );
      return;
    }
    if (this.localState.progress.inventory >= this.config.maxInventory) {
      this.ui.toast("가지고 있는 블록이 가득 찼어요");
      return;
    }
    if (
      getManualProductionRemainingAttempts(
        this.localState.progress,
        this.clock.now(),
        this.config,
      ) <= 0
    ) {
      this.ui.toast("최근 24시간 동안 만들 수 있는 블록 3개를 모두 만들었어요");
      return;
    }

    const monotonicNow = performance.now();
    const stepDuration =
      this.config.manualProductionDurationMs /
      this.config.manualProductionStepCount;
    if (!this.manualProduction) {
      void this.startOnlineManualProduction(stepDuration);
      return;
    }
    if (monotonicNow < this.manualProduction.readyAt) {
      this.ui.toast("잠시 뒤 다시 눌러 주세요");
      return;
    }
    if (this.manualProduction.step < this.config.manualProductionStepCount) {
      this.manualProduction = {
        ...this.manualProduction,
        step: this.manualProduction.step + 1,
        readyAt: monotonicNow + stepDuration,
      };
      this.ui.toast(
        String(this.manualProduction.step) + "단계를 시작했어요",
      );
    }
  }

  private async startOnlineManualProduction(
    stepDuration: number,
  ): Promise<void> {
    const repository = this.onlineRepository;
    if (
      !repository ||
      this.onlineManualStartPending ||
      !this.onlineProgressGate.tryEnter()
    ) {
      return;
    }
    this.onlineManualStartPending = true;
      this.ui.setSaveState("블록 만들기 준비 중", "saving");
    const sessionId = crypto.randomUUID();
    try {
      const attempt = await retryIdempotentOnce(() =>
        repository.startManualProduction(this.world.worldId, sessionId),
      );
      const session = attempt.value;
      if (attempt.retried) {
        this.recordRecoveredRetry("production_failed", "production");
      }
      this.serverClock?.synchronize(session.serverNow);
      this.localState.progress = cloneProgress(session.progress);
      this.manualProduction = {
        step: 1,
        readyAt: performance.now() + stepDuration,
        serverSessionId: session.id,
      };
      this.ui.setSaveState("저장됨", "ready");
      this.ui.toast("1단계: 동력 채우기");
    } catch (error) {
      this.analytics.failure("production_failed", "production", true, false);
      this.ui.setSaveState("블록을 만들지 못했어요", "warning");
      this.ui.toast(onlineFailureMessage(error));
      this.ui.setRecoveryNotice(
        "블록을 만들지 못했어요",
        "연결을 확인하고 다시 시도해 주세요.",
        () => this.retrySynchronization(),
      );
    } finally {
      this.onlineManualStartPending = false;
      this.onlineProgressGate.leave();
      this.updateHud(this.clock.now());
    }
  }

  private async finishOnlineManualProduction(
    sessionId: string,
  ): Promise<void> {
    const repository = this.onlineRepository;
    if (
      !repository ||
      this.onlineProductionPending ||
      !this.onlineProgressGate.tryEnter()
    ) {
      return;
    }
    this.onlineProductionPending = true;
    this.ui.setSaveState("블록 완성 중", "saving");
    const idempotencyKey = crypto.randomUUID();
    try {
      const attempt = await retryIdempotentOnce(() =>
        repository.completeManualProduction(
          this.world.worldId,
          sessionId,
          idempotencyKey,
        ),
      );
      const result = attempt.value;
      if (attempt.retried) {
        this.recordRecoveredRetry("production_failed", "production");
      }
      this.serverClock?.synchronize(result.serverNow);
      this.localState.progress = cloneProgress(result.progress);
      this.manualProduction = null;
      if (result.produced > 0 && (!result.replayed || attempt.retried)) {
        this.analytics.increment("manual_production_count", result.produced);
        this.analytics.milestone("first_manual_production");
      }
      this.ui.setSaveState("저장됨", "ready");
      this.ui.toast("블록 만들기 완료 · 1개를 받았어요");
    } catch (error) {
      this.analytics.failure("production_failed", "production", true, false);
      this.manualProduction = null;
      await this.restoreOnlineState(error);
    } finally {
      this.onlineProductionPending = false;
      this.onlineProgressGate.leave();
      this.updateHud(this.clock.now());
    }
  }

  private async settleOnlineProduction(): Promise<void> {
    const repository = this.onlineRepository;
    if (
      !repository ||
      this.onlineProductionPending ||
      !this.onlineProgressGate.tryEnter()
    ) {
      return;
    }
    this.onlineProductionPending = true;
    try {
      const attempt = await retryIdempotentOnce(() =>
        repository.settleProduction(this.world.worldId),
      );
      const result = attempt.value;
      if (attempt.retried) {
        this.recordRecoveredRetry("production_failed", "production");
      }
      this.serverClock?.synchronize(result.serverNow);
      this.localState.progress = cloneProgress(result.progress);
      if (result.produced > 0) {
        this.ui.toast(
          "블록 공방에서 " + String(result.produced) + "개를 받았어요",
        );
      }
      this.ui.setSaveState("저장됨", "ready");
    } catch {
      this.analytics.failure("production_failed", "production", true, false);
      this.ui.setSaveState("다음 블록 확인 중", "warning");
      this.ui.setRecoveryNotice(
        "다음 블록을 확인하지 못했어요",
        "연결되면 받을 수 있는 블록을 다시 확인합니다.",
        () => this.retrySynchronization(),
      );
    } finally {
      this.onlineProductionPending = false;
      this.onlineProgressGate.leave();
      this.updateHud(this.clock.now());
    }
  }

  private async resetOnlineBay(): Promise<void> {
    const repository = this.onlineRepository;
    if (!repository || this.onlineMutationPending) {
      return;
    }
    if (this.localState.progress.trialRewardClaimed) {
      this.ui.toast("내 공간과 블록 공방을 모두 채운 뒤에는 다시 시작할 수 없어요");
      return;
    }
    if (!this.onlineProgressGate.tryEnter()) {
      this.ui.toast("이전 작업을 확인하고 있어요");
      return;
    }
    this.onlineMutationPending = true;
    this.onlineChunkGeneration += 1;
    this.ui.setSaveState("처음 상태로 되돌리는 중", "saving");
    const request = {
      worldId: this.world.worldId,
      idempotencyKey: crypto.randomUUID(),
      actions: [{ type: "reset_onboarding" as const }],
    };
    try {
      const attempt = await retryIdempotentOnce(() =>
        repository.commitWorldActions(request),
      );
      const result = attempt.value;
      if (attempt.retried) {
        this.recordRecoveredRetry("commit_network_failed", "world_write");
      }
      this.applyOnlineMutation(result);
      this.manualProduction = null;
      this.cancelRemovalHold();
      this.player.respawn();
      this.player.yaw = yawToward(this.bay.slot.towardTower);
      this.ui.toast("빛나는 자리에 놓은 블록을 지우고 24개로 되돌렸어요");
    } catch (error) {
      this.recordCommitFailure(error);
      await this.restoreOnlineState(error);
    } finally {
      this.onlineMutationPending = false;
      this.onlineProgressGate.leave();
      this.updateHud(this.clock.now());
    }
  }

  private resetBay(): void {
    if (this.gameMode !== "mission") {
      return;
    }
    if (this.onlineRepository) {
      void this.resetOnlineBay();
      return;
    }
    const now = this.clock.now();
    const reset = resetOnboardingProgress(
      this.localState.progress,
      now,
      this.config,
    );
    if (!reset.reset) {
      this.ui.toast("내 공간과 블록 공방을 모두 채운 뒤에는 다시 시작할 수 없어요");
      return;
    }

    const retainedIds = new Set(
      withoutOnboardingBlocks(this.world.blocks, this.playerOwner.id).map(
        (block) => block.id,
      ),
    );
    for (const block of [...this.world.blocks]) {
      if (!retainedIds.has(block.id)) {
        this.world.removeBlock(block.id);
      }
    }
    this.localState.progress = reset.progress;
    this.manualProduction = null;
    this.cancelRemovalHold();
    this.renderer.rebuildAll();
    this.player.respawn();
    this.player.yaw = yawToward(this.bay.slot.towardTower);
    this.reconcileWorldProgress(now);
    this.updateGuides();
    this.currentHitDisplayKey = "";
    this.queueSave();
    this.ui.toast("빛나는 자리에 놓은 블록을 지우고 24개로 되돌렸어요");
  }

  private updateGuides(): void {
    if (this.gameMode === "free") {
      this.renderer.updateGuides([]);
      return;
    }
    const visibleGuides = [
      ...this.bay.baseGuides,
      ...this.bay.producerGuides,
      ...(this.localState.progress.trialRewardClaimed
        ? this.bay.upgradeGuides
        : []),
    ].filter((guide) => !this.world.hasBlock(guide.position));
    this.renderer.updateGuides(visibleGuides);
  }

  private getGuideCounts(): GuideCounts {
    const blocks = this.world.blocks;
    return {
      base: countFilledGuides(
        this.bay.baseGuides,
        blocks,
        this.playerOwner.id,
      ),
      producer: countFilledGuides(
        this.bay.producerGuides,
        blocks,
        this.playerOwner.id,
      ),
      upgrade: countFilledGuides(
        this.bay.upgradeGuides,
        blocks,
        this.playerOwner.id,
      ),
    };
  }

  private classifyPosition(position: GridPosition): StarterBayZoneMatch {
    return classifyStarterBayPosition(this.reservedBays, position);
  }

  private updateAnalyticsTime(
    now: number,
    framesPerSecond?: number,
  ): void {
    const archiveOpen = this.ui.isMissionArchiveOpen;
    const zone =
      this.ui.isAnalyticsSettingsOpen || (!this.controlsActive && !archiveOpen)
        ? "none"
        : this.gameMode === "free"
          ? "public"
          : coarseAnalyticsZone(
              this.classifyPosition({
                x: Math.floor(this.player.position.x),
                y: Math.floor(this.player.position.y),
                z: Math.floor(this.player.position.z),
              }).zone,
              archiveOpen,
            );
    this.analytics.tick({
      now,
      visible: document.visibilityState === "visible",
      zone,
      ...(framesPerSecond === undefined ? {} : { framesPerSecond }),
    });
  }

  private recordProgressMilestones(
    previous: LocalGameState["progress"],
    next: LocalGameState["progress"],
  ): void {
    if (!previous.baseCompleted && next.baseCompleted) {
      this.analytics.milestone("base_completed");
    }
    if (!previous.producerCompleted && next.producerCompleted) {
      this.analytics.milestone("producer_completed");
    }
  }

  private recordCommitFailure(error: unknown): void {
    this.analytics.increment("commit_failure_count");
    if (
      this.repositoryMode === "local" &&
      !(error instanceof RepositoryRequestError)
    ) {
      this.analytics.failure("storage_failed", "world_write", true, false);
      return;
    }
    const retryable =
      !(error instanceof RepositoryRequestError) || error.retryable;
    this.analytics.failure(
      retryable ? "commit_network_failed" : "commit_rejected",
      "world_write",
      true,
      false,
    );
  }

  private recordRecoveredRetry(
    code: AnalyticsFailureCode,
    stage: AnalyticsFailureStage,
  ): void {
    this.analytics.increment("commit_failure_count");
    this.analytics.failure(code, stage, true, true);
  }

  private isProducerOperational(counts = this.getGuideCounts()): boolean {
    return isProductionOperational(
      this.localState.progress,
      counts.producer,
      this.config,
    );
  }

  private async refreshMissionState(
    showFailure: boolean,
    throwOnFailure = false,
  ): Promise<void> {
    if (this.gameMode !== "mission") {
      return;
    }
    const generation = ++this.missionRefreshGeneration;
    try {
      if (this.repositoryMode === "local") {
        await this.saveChain;
      }
      let overview = await this.missionRepository.getMissionOverview(
        this.world.worldId,
      );
      const archive = await this.missionRepository.listCompletedMissions(
        this.world.worldId,
      );
      // 두 HTTP 읽기 사이에 마지막 슬롯이 확정됐으면 archive에는 완료층,
      // overview에는 같은 ID의 과거 active가 올 수 있다. 한 번 재조회해 닫는다.
      if (
        archive.missions.some(({ id }) => id === overview.activeMission.id)
      ) {
        overview = await this.missionRepository.getMissionOverview(
          this.world.worldId,
        );
      }
      if (generation !== this.missionRefreshGeneration) {
        return;
      }
      this.serverClock?.synchronize(
        Math.max(overview.serverNow, archive.serverNow),
      );
      this.activeMission = overview.activeMission;
      this.missionEligibility = { ...overview.eligibility };
      this.completedMissions = archive.missions;
      await this.reloadLocalMissionSnapshot();
      this.presentMission(overview.activeMission);
      this.updateMissionArchiveUi();
    } catch (error) {
      if (generation !== this.missionRefreshGeneration) {
        return;
      }
      this.analytics.failure("world_sync_failed", "mission", true, false);
      this.ui.setMissionPanel(null);
      if (showFailure) {
        this.ui.toast(missionFailureMessage(error));
        this.ui.setRecoveryNotice(
          "별빛 관문을 불러오지 못했어요",
          "연결을 확인하고 다시 불러와 주세요.",
          () => this.retrySynchronization(),
        );
      }
      if (throwOnFailure) {
        throw error;
      }
    }
  }

  private async refreshMissionArchive(): Promise<void> {
    await this.refreshMissionState(true);
  }

  private async contributeToMission(
    request: ContributeToMissionRequest,
  ): Promise<void> {
    if (this.gameMode !== "mission") {
      return;
    }
    if (this.missionContributionPending) {
      return;
    }
    const enteredOnlineGate =
      this.repositoryMode === "online"
        ? this.onlineProgressGate.tryEnter()
        : false;
    if (this.repositoryMode === "online" && !enteredOnlineGate) {
      this.ui.toast("이전 작업을 확인하고 있어요");
      return;
    }

    // 먼저 시작된 overview/archive 읽기가 성공 응답을 과거 상태로 덮지 못하게 한다.
    this.missionRefreshGeneration += 1;
    this.missionContributionPending = true;
    this.ui.setMissionContributionPending(true);
    this.ui.setSaveState("관문에 블록 놓는 중", "saving");
    try {
      if (this.repositoryMode === "local") {
        // 일반 블록 저장이 미션 저장 뒤에 도착해 덮어쓰지 않게 먼저 비운다.
        await this.saveChain;
      }
      let result;
      let retryAttempted = false;
      try {
        result = await this.missionRepository.contributeToMission(request);
      } catch (error) {
        if (!(error instanceof RepositoryRequestError) || !error.retryable) {
          throw error;
        }
        // 응답만 유실됐을 수 있으므로 같은 키로 한 번만 안전하게 재시도한다.
        retryAttempted = true;
        result = await this.missionRepository.contributeToMission(request);
      }
      this.serverClock?.synchronize(result.serverNow);
      if (retryAttempted) {
        this.analytics.increment("commit_failure_count");
        this.analytics.failure(
          "mission_contribution_failed",
          "mission",
          true,
          true,
        );
      }

      if (!result.replayed || retryAttempted) {
        this.analytics.increment("mission_blocks_placed");
        this.analytics.increment("mission_contribution_count");
        this.analytics.milestone("first_mission_contribution");
      }

      if (result.replayed) {
        await this.reloadMissionAuthority();
        await this.refreshMissionState(false);
        this.ui.toast("이미 놓인 별빛 블록을 확인했어요");
        return;
      }

      this.localState.progress = cloneProgress(result.progress);
      await this.reloadLocalMissionSnapshot();
      if (result.mission.status === "completed") {
        this.completedMissions = upsertMission(
          this.completedMissions,
          result.mission,
        );
      }
      if (result.nextMission) {
        this.activeMission = result.nextMission;
      } else if (result.mission.status === "active") {
        this.activeMission = result.mission;
      }
      this.updateMissionArchiveUi();

      if (result.mission.status === "completed" && result.nextMission) {
        this.presentMission(result.mission);
        this.updateMissionPanel(result.nextMission);
        const finish = (): void => {
          this.ui.setCompletionCinematicActive(false);
          if (this.activeMission) {
            this.presentMission(this.activeMission);
          }
        };
        const cinematicStarted = this.renderer.startMissionCompletionCinematic(
          {
            x: result.mission.origin.x,
            y: result.mission.origin.y + 3,
            z: result.mission.origin.z,
          },
          1_800,
          finish,
        );
        this.ui.setCompletionCinematicActive(cinematicStarted);
        if (!result.replayed || retryAttempted) {
          this.audio.play("contribute");
        }
        this.ui.toast("별빛 관문이 완성되어 다음 층이 열렸어요");
      } else {
        this.presentMission(result.mission);
        if (!result.replayed || retryAttempted) {
          this.audio.play("contribute");
        }
        this.ui.toast("별빛 관문에 블록 하나를 놓았어요");
      }
      this.ui.setSaveState(
        "저장됨",
        "ready",
      );
    } catch (error) {
      if (
        error instanceof RepositoryRequestError &&
        (error.code === "inventory-insufficient" ||
          error.code === "insufficient-inventory")
      ) {
        this.analytics.increment("insufficient_inventory_count");
      }
      this.analytics.increment("commit_failure_count");
      this.analytics.failure(
        "mission_contribution_failed",
        "mission",
        error instanceof RepositoryRequestError ? error.retryable : true,
        false,
      );
      if (this.repositoryMode === "online") {
        await this.restoreOnlineState(error);
      } else {
        await this.reloadMissionAuthority();
        this.ui.setSaveState("관문에 놓지 못했어요", "warning");
        this.ui.toast(missionFailureMessage(error));
      }
      await this.refreshMissionState(false);
    } finally {
      this.missionContributionPending = false;
      this.ui.setMissionContributionPending(false);
      if (enteredOnlineGate) {
        this.onlineProgressGate.leave();
      }
      this.updateHud(this.clock.now());
      if (this.activeMission && this.renderedMission?.status === "active") {
        this.updateMissionPanel(this.activeMission);
      }
    }
  }

  private async reloadMissionAuthority(): Promise<void> {
    if (this.onlineRepository) {
      const bootstrap = await this.onlineRepository.bootstrapPlayer(
        this.world.worldId,
      );
      this.serverClock?.synchronize(bootstrap.serverNow);
      this.localState.progress = cloneProgress(bootstrap.progress);
      return;
    }
    await this.reloadLocalMissionSnapshot(true);
  }

  private async reloadLocalMissionSnapshot(
    includeProgress = false,
  ): Promise<void> {
    if (!this.repository) {
      return;
    }
    const latest = await this.repository.load(this.world.worldId);
    if (!latest) {
      return;
    }
    if (latest.localMissionState) {
      this.localMissionState = cloneLocalMissionWorldState(
        latest.localMissionState,
      );
    }
    if (includeProgress && latest.localState) {
      this.localState = cloneLocalState(latest.localState);
    }
  }

  private presentMission(focus: MissionInstance): void {
    const missions = selectMissionRenderWindow(
      uniqueMissions([
        ...this.completedMissions,
        ...(this.activeMission ? [this.activeMission] : []),
      ]),
      focus,
    );
    const expandedByMission = missions.map((mission) => ({
      mission,
      blocks: expandMissionBlocks(mission),
    }));
    this.missionCollisionBlocks = expandedByMission.flatMap(({ blocks }) =>
      blocks.map((block) => ({ ...block, position: { ...block.position } })),
    );
    this.rescuePlayerFromWorldCollision();
    const visuals = expandedByMission.flatMap(({ mission, blocks }) =>
      missionDisplayBlocksToVisuals(
        blocks,
        missionGlowFromFilledSlots(mission.filledSlots, mission.totalSlots),
      ),
    );
    this.renderedMission = focus;
    this.renderer.setMissionVisuals({
      instanceId: focus.id,
      stage: focus.stagePercent,
      anchor: focus.origin,
      blocks: visuals,
    });
    this.renderer.setMissionRecommendedPreviews(
      focus.status === "active"
        ? focus.recommendedSlotIndexes.map((slotIndex, index) => ({
            slotIndex,
            position: missionSlotPosition(focus, slotIndex),
            selected: index === 0,
          }))
        : [],
    );
    this.renderer.setMissionContributorLights(
      focus.contributors.map((contributor, index) => {
        const angle =
          (index / Math.max(1, focus.contributors.length)) * Math.PI * 2;
        return {
          publicId: contributor.publicId,
          nickname: contributor.nickname,
          emblem: contributor.emblem,
          position: {
            x: focus.origin.x + Math.cos(angle) * 4.3,
            y: focus.origin.y + 1.35,
            z: focus.origin.z + Math.sin(angle) * 4.3,
          },
        };
      }),
    );
    this.updateMissionPanel(focus);
    if (this.highlightedMissionPublicId) {
      this.highlightMissionCreator(this.highlightedMissionPublicId, false);
    }
  }

  private queryCollisionBounds(
    min: Vector3Like,
    max: Vector3Like,
  ): readonly VoxelBlock[] {
    return queryMissionAwareBounds(
      this.world,
      this.missionCollisionBlocks,
      min,
      max,
    );
  }

  private rescuePlayerFromWorldCollision(): void {
    if (!collidesAt(this.collisionSource, this.player.position)) {
      return;
    }
    const origin = { ...this.player.position };
    for (const verticalOffset of [0, 1, 2, 3, -1, -2]) {
      for (let radius = 1; radius <= 6; radius += 1) {
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          for (let offsetZ = -radius; offsetZ <= radius; offsetZ += 1) {
            if (Math.max(Math.abs(offsetX), Math.abs(offsetZ)) !== radius) {
              continue;
            }
            const candidate = {
              x: origin.x + offsetX,
              y: origin.y + verticalOffset,
              z: origin.z + offsetZ,
            };
            if (
              !collidesAt(this.collisionSource, candidate) &&
              isGrounded(this.collisionSource, candidate) &&
              this.player.teleport(candidate)
            ) {
              this.ui.toast("새 블록을 피해 안전한 곳으로 이동했어요");
              return;
            }
          }
        }
      }
    }
    this.player.respawn();
    this.ui.toast("새 블록과 겹쳐 안전 발판으로 돌아왔어요");
  }

  private updateMissionPanel(mission: MissionInstance): void {
    const counts = this.getGuideCounts();
    const onboardingComplete =
      this.repositoryMode === "online"
        ? this.missionEligibility.eligible
        : counts.base >= this.config.baseGuideSlots &&
          counts.producer >= this.config.producerGuideSlots;
    const hasInventory = this.localState.progress.inventory > 0;
    const active =
      mission.status === "active" && this.activeMission?.id === mission.id;
    const canContribute =
      active &&
      onboardingComplete &&
      hasInventory &&
      !this.missionContributionPending &&
      mission.recommendedSlotIndexes.length > 0;
    const state: MissionPanelState = {
      instanceId: mission.id,
      missionName: mission.name,
      layer: mission.layer,
      confirmedSlots: mission.filledSlots,
      totalSlots: mission.totalSlots,
      stage: mission.stagePercent,
      myContributionCount: mission.myContributionCount,
      contributorCount: mission.participantCount,
      recentContributions: mission.recentContributions.map((contribution) => ({
        publicId: contribution.creator.publicId,
        nickname: contribution.creator.nickname,
        emblem: contribution.creator.emblem,
        contributionCount: 1,
        contributedAt: contribution.createdAt,
      })),
      recommendedSlots: mission.recommendedSlotIndexes.map((slotIndex) => ({
        slotIndex,
        label: missionSlotLabel(mission, slotIndex),
      })),
      palette: mission.palette.map((colorIndex, paletteIndex) => ({
        paletteIndex,
        colorIndex,
        name: PALETTE[colorIndex]?.name ?? "별빛",
        value: PALETTE[colorIndex]?.value ?? 0xffffff,
      })),
      canContribute,
      contributionDisabledReason: !active
        ? "완성된 관문은 바꿀 수 없어요"
        : !onboardingComplete
          ? "내 공간 16칸과 블록 공방 8칸을 먼저 채워 주세요"
          : !hasInventory
            ? "관문에 놓을 블록이 없어요"
            : this.missionContributionPending
              ? "관문에 놓은 블록을 확인하고 있어요"
              : "지금 놓을 수 있는 자리가 없어요",
    };
    this.ui.setMissionPanel(state);
    this.ui.setContributorLights(mission.contributors);
  }

  private updateMissionArchiveUi(): void {
    const entries: CompletedMissionArchiveEntry[] = this.completedMissions
      .filter(
        (mission): mission is MissionInstance & { completedAt: number } =>
          mission.completedAt !== null,
      )
      .map((mission) => ({
        instanceId: mission.id,
        missionName: mission.name,
        layer: mission.layer,
        completedAt: mission.completedAt,
        contributors: mission.contributors,
      }));
    this.ui.setMissionArchive(entries);
  }

  private highlightMissionCreator(
    publicId: string,
    trackInteraction = true,
  ): void {
    const identity = this.findMissionIdentity(publicId);
    if (!identity) {
      this.ui.toast("이 사람이 놓은 별빛 블록을 찾을 수 없어요");
      return;
    }
    this.highlightedMissionPublicId = publicId;
    this.renderer.highlightMissionOwner(publicId);
    this.ui.setHighlightState({
      publicId,
      nickname: identity.nickname,
    });
    if (trackInteraction) {
      this.analytics.markInput();
      this.analytics.increment("creator_highlight_count");
      this.analytics.milestone("first_creator_highlight");
    }
  }

  private clearMissionHighlight(): void {
    this.highlightedMissionPublicId = null;
    this.renderer.highlightMissionOwner(null);
    this.ui.setHighlightState(null);
  }

  private focusMissionCreator(
    publicId: string,
    canonicalContributionId?: string,
  ): void {
    this.highlightMissionCreator(publicId);
    const visual = selectMissionFocusVisual(
      this.renderer.getMissionVisualsForOwner(publicId),
      publicId,
      canonicalContributionId,
    );
    if (!visual) {
      return;
    }
    if (!this.focusMissionPosition(visual.position)) {
      this.ui.toast("관문이 잘 보이는 곳을 찾지 못했어요");
    }
  }

  private visitMissionMonument(instanceId: string): void {
    const mission = this.completedMissions.find(({ id }) => id === instanceId);
    if (!mission) {
      this.ui.toast("완성된 관문을 다시 불러와 주세요");
      return;
    }
    this.clearMissionHighlight();
    this.presentMission(mission);
    const target =
      expandMissionBlocks(mission)[0]?.position ?? mission.origin;
    if (this.focusMissionPosition(target)) {
      this.ui.toast(String(mission.layer) + "층 관문으로 안내했어요");
    }
  }

  private focusMissionPosition(target: GridPosition): boolean {
    const nearbyMissionPlatforms = this.missionCollisionBlocks
      .filter(
        (block) =>
          block.kind !== "light" &&
          Math.abs(block.position.x - target.x) <= 9 &&
          Math.abs(block.position.z - target.z) <= 9,
      )
      .sort(
        (left, right) =>
          Math.abs(left.position.y - target.y) -
            Math.abs(right.position.y - target.y) ||
          right.position.y - left.position.y,
      );
    for (const platform of nearbyMissionPlatforms) {
      const candidate = {
        x: platform.position.x + 0.5,
        y: platform.position.y + 1.01,
        z: platform.position.z + 0.5,
      };
      if (
        !collidesAt(this.collisionSource, candidate) &&
        isGrounded(this.collisionSource, candidate) &&
        this.player.teleport(candidate)
      ) {
        this.aimPlayerAt(target);
        return true;
      }
    }

    const candidates: Array<{ x: number; z: number }> = [
      { x: 0, z: 6 },
      { x: 6, z: 0 },
      { x: 0, z: -6 },
      { x: -6, z: 0 },
      { x: 5, z: 5 },
      { x: -5, z: 5 },
      { x: 5, z: -5 },
      { x: -5, z: -5 },
    ];
    let destination: { x: number; y: number; z: number } | null = null;
    const topY = Math.max(1, Math.floor(target.y));
    for (let y = topY; y >= 1 && !destination; y -= 1) {
      for (const offset of candidates) {
        const candidate = {
          x: target.x + offset.x + 0.5,
          y,
          z: target.z + offset.z + 0.5,
        };
        if (
          !collidesAt(this.collisionSource, candidate) &&
          isGrounded(this.collisionSource, candidate)
        ) {
          destination = candidate;
          break;
        }
      }
    }
    if (!destination || !this.player.teleport(destination)) {
      return false;
    }
    this.aimPlayerAt(target);
    return true;
  }

  private aimPlayerAt(target: GridPosition): void {
    const camera = this.player.cameraPosition;
    const targetCenter = {
      x: target.x + 0.5,
      y: target.y + 0.5,
      z: target.z + 0.5,
    };
    const deltaX = targetCenter.x - camera.x;
    const deltaY = targetCenter.y - camera.y;
    const deltaZ = targetCenter.z - camera.z;
    this.player.yaw = Math.atan2(-deltaX, -deltaZ);
    this.player.pitch = Math.max(
      -Math.PI * 0.46,
      Math.min(Math.PI * 0.46, Math.atan2(deltaY, Math.hypot(deltaX, deltaZ))),
    );
  }

  private findMissionIdentity(
    publicId: string,
  ): { nickname: string; emblem: string } | null {
    for (const mission of uniqueMissions([
      ...this.completedMissions,
      ...(this.activeMission ? [this.activeMission] : []),
    ])) {
      const contributor = mission.contributors.find(
        (candidate) => candidate.publicId === publicId,
      );
      if (contributor) {
        return contributor;
      }
    }
    return publicId === this.playerOwner.publicId ? this.playerOwner : null;
  }

  private updateHud(now: number): void {
    if (this.gameMode === "free") {
      const overview = this.freeModeOverview;
      const inventory = overview?.progress.inventory ?? 0;
      const maxInventory = overview?.maxInventory ?? 100;
      const nextGrantInMs =
        !overview || inventory >= maxInventory
          ? null
          : Math.max(
              0,
              overview.progress.lastSettledAt +
                overview.grantIntervalMs -
                now,
            );
      // 표시 정밀도와 같은 1초 버킷으로 제한해 매 frame DOM 갱신을 막는다.
      const nextGrantDisplayMs =
        nextGrantInMs === null ? 0 : Math.ceil(nextGrantInMs / 1_000) * 1_000;
      const hudState = {
        inventory,
        maxInventory,
        grantAmount: overview?.grantAmount ?? 5,
        nextGrantInMs: nextGrantDisplayMs,
      } as const;
      const hudDisplayKey = JSON.stringify(hudState);
      if (hudDisplayKey !== this.lastHudDisplayKey) {
        this.lastHudDisplayKey = hudDisplayKey;
        this.ui.setPlayerState("자유 건축");
        this.ui.setFreeModeHud(hudState);
      }
      return;
    }
    const counts = this.getGuideCounts();
    const progress = this.localState.progress;
    const operational = this.isProducerOperational(counts);
    const nextAutomatic = operational
      ? getNextAutomaticProductionInMs(progress, now, this.config)
      : undefined;
    const hudState = {
      inventory: progress.inventory,
      baseBuilt: counts.base,
      producerBuilt: counts.producer,
      producerLevel: progress.productionLevel,
      nextAutomaticLabel:
        nextAutomatic === undefined
          ? progress.trialRewardClaimed
            ? "공방 8칸을 채우면 다시 만들어요"
            : "내 공간과 공방을 채우면 블록이 생겨요"
          : nextAutomatic === null
            ? "블록 가득 참"
            : "다음 블록 · " + formatDuration(nextAutomatic),
      manualRemaining: getManualProductionRemainingAttempts(
        progress,
        now,
        this.config,
      ),
      resetAvailable: !progress.trialRewardClaimed,
    } as const;
    const hudDisplayKey = JSON.stringify(hudState);
    if (hudDisplayKey !== this.lastHudDisplayKey) {
      this.lastHudDisplayKey = hudDisplayKey;
      this.ui.setPlayerState(
        "내 자리 " + String(this.localState.baySlotIndex + 1).padStart(2, "0"),
      );
      this.ui.setProgressHud(hudState);
      if (
        this.activeMission &&
        this.renderedMission?.id === this.activeMission.id
      ) {
        this.updateMissionPanel(this.activeMission);
      }
    }

    if (this.manualProduction) {
      const manualNow = this.onlineRepository ? performance.now() : now;
      const remaining = Math.max(
        0,
        this.manualProduction.readyAt - manualNow,
      );
      const label = manualStepLabel(
        this.manualProduction.step,
        this.config.manualProductionStepCount,
        remaining,
      );
      const enabled =
        manualNow >= this.manualProduction.readyAt &&
        this.manualProduction.step < this.config.manualProductionStepCount;
      const manualDisplayKey = label + ":" + String(enabled);
      if (manualDisplayKey !== this.lastManualDisplayKey) {
        this.lastManualDisplayKey = manualDisplayKey;
        this.ui.setManualProductionState(label, enabled);
      }
      return;
    }

    const manualEnabled =
      operational &&
      progress.inventory < this.config.maxInventory &&
      getManualProductionRemainingAttempts(progress, now, this.config) > 0;
    const manualDisplayKey = "idle:" + String(manualEnabled);
    if (manualDisplayKey !== this.lastManualDisplayKey) {
      this.lastManualDisplayKey = manualDisplayKey;
      this.ui.setManualProductionState(null, manualEnabled);
    }
  }

  private cancelRemovalHold(): void {
    this.removalHold = null;
    this.ui.setRemovalHold(null);
  }

  private isOnboardingActive(): boolean {
    return !this.localState.progress.trialRewardClaimed;
  }

  private async commitOnlinePlacement(
    block: VoxelBlock,
    guide: GuideCell | null,
  ): Promise<void> {
    const repository = this.onlineRepository;
    if (
      !repository ||
      this.onlineMutationPending ||
      !this.onlineProgressGate.tryEnter()
    ) {
      this.ui.toast("이전 작업을 확인하고 있어요");
      return;
    }

    const previousProgress = cloneProgress(this.localState.progress);
    this.onlineMutationPending = true;
    const request = {
      worldId: this.world.worldId,
      idempotencyKey: crypto.randomUUID(),
      actions: [
        {
          type: "place" as const,
          blockId: block.id,
          position: { ...block.position },
          kind: block.kind,
          rotation: block.rotation,
          colorIndex: block.colorIndex,
          ...(block.supportId ? { supportId: block.supportId } : {}),
        },
      ],
    };
    try {
      this.onlineChunkGeneration += 1;
      this.renderer.showPendingBlock(block);
      this.localState.progress = createOptimisticPlacementProgress(
        this.localState.progress,
      );
      this.ui.setSaveState("블록 놓는 중", "saving");
      this.updateHud(this.clock.now());
      const attempt = await retryIdempotentOnce(() =>
        repository.commitWorldActions(request),
      );
      const result = attempt.value;
      if (attempt.retried) {
        this.recordRecoveredRetry("commit_network_failed", "world_write");
      }
      this.applyOnlineMutation(result);
      if (!result.replayed || attempt.retried) {
        this.analytics.increment(
          block.zone === "public"
            ? "public_blocks_placed"
            : "personal_blocks_placed",
        );
        this.analytics.milestone("first_block");
        this.recordProgressMilestones(previousProgress, result.progress);
      }
      if (!result.replayed || attempt.retried) {
        this.audio.play("place");
      }
      this.ui.toast(
        guide ? guidePlacementToast(guide) : "블록을 놓았어요",
      );
    } catch (error) {
      this.recordCommitFailure(error);
      this.localState.progress = previousProgress;
      await this.restoreOnlineState(error);
    } finally {
      this.onlineMutationPending = false;
      this.onlineProgressGate.leave();
      this.renderer.showPendingBlock(null);
      this.updateHud(this.clock.now());
    }
  }

  private applyOnlineMutation(result: WorldMutationResult): void {
    this.serverClock?.synchronize(result.serverNow);
    this.localState.progress = cloneProgress(result.progress);
    this.world.replaceBlocks(
      applyAuthoritativeMutation(this.world.blocks, result),
    );
    this.renderer.rebuildAll();
    this.updateGuides();
    this.currentHitDisplayKey = "";
    this.ui.setSaveState(
      "저장됨",
      "ready",
    );
    void this.refreshMissionState(false);
  }

  private applyFreeModeMutation(result: FreeModeMutationResult): void {
    this.serverClock?.synchronize(result.serverNow);
    // 자유 건축 mutation 응답에도 서버가 정산한 최신 재고가 포함된다.
    // 이전 정산 조회가 실패했더라도 성공한 쓰기 뒤에는 다음 체크포인트를
    // 다시 시도할 수 있어야 한다.
    this.freeInventoryRetryGate.recordSuccess();
    if (!this.freeModeOverview) {
      return;
    }
    this.freeModeOverview = withFreeModeProgress(
      this.freeModeOverview,
      result.progress,
      result.serverNow,
    );
    const removed = new Set(result.removedBlockIds);
    const upserted = new Map(result.upsertedBlocks.map((block) => [block.id, block]));
    const blocks = this.world.blocks
      .filter((block) => !removed.has(block.id) && !upserted.has(block.id))
      .concat(result.upsertedBlocks);
    this.world.replaceBlocks(blocks);
    this.renderer.rebuildAll();
    this.currentHitDisplayKey = "";
    this.ui.setSaveState("저장됨", "ready");
  }

  /**
   * 응답 유실 뒤의 멱등 replay에는 최초 처리 시점의 delta와 재고가 들어
   * 있다. 같은 계정의 다른 탭이 그 뒤에 작업했을 수 있으므로 replay를
   * 현재 월드에 다시 적용하지 않고 overview와 주변 청크를 권위 재조회한다.
   */
  private async applyFreeModeMutationOrRefresh(
    result: FreeModeMutationResult,
  ): Promise<void> {
    await reconcileFreeModeMutationResult(result, {
      apply: (current) => this.applyFreeModeMutation(current),
      refresh: async () => {
        this.freeChunkRequestGate.reset();
        await this.refreshFreeModeWorld(true, true, true, true);
      },
    });
  }

  private applyFreeModeOverview(
    overview: FreeModeOverviewResult,
    announceProduced: boolean,
  ): void {
    this.serverClock?.synchronize(overview.serverNow);
    this.freeInventoryRetryGate.recordSuccess();
    this.freeModeOverview = structuredClone(overview);
    if (announceProduced && overview.produced > 0) {
      this.ui.toast(
        "블록 " +
          String(overview.produced) +
          "개가 도착했어요 · " +
          String(overview.progress.inventory) +
          "/" +
          String(overview.maxInventory),
      );
    }
  }

  private async refreshFreeModeWorld(
    force: boolean,
    settleInventory: boolean,
    allowDuringMutation = false,
    requireNearbySuccess = false,
  ): Promise<void> {
    if (this.onlineMutationPending && !allowDuringMutation) {
      return;
    }
    const coordinate = toChunkCoordinate({
      x: Math.floor(this.player.position.x),
      y: Math.floor(this.player.position.y),
      z: Math.floor(this.player.position.z),
    });
    const key = `free:${coordinate.x}:${coordinate.y}:${coordinate.z}`;
    if (!this.freeChunkRequestGate.shouldRequest(key, force)) {
      return;
    }
    const enteredProgressGate =
      settleInventory && !allowDuringMutation
        ? this.onlineProgressGate.tryEnter()
        : false;
    if (settleInventory && !allowDuringMutation && !enteredProgressGate) {
      return;
    }
    this.onlineChunkKey = key;
    const generation = ++this.onlineChunkGeneration;
    try {
      if (settleInventory || !this.freeModeOverview) {
        const overview = settleInventory
          ? await this.onlineRepository.settleFreeModeInventory(
              this.world.worldId,
            )
          : await this.onlineRepository.getFreeModeOverview(this.world.worldId);
        this.applyFreeModeOverview(overview, settleInventory);
      }
      const nearby = await this.onlineRepository.loadNearbyFreeModeBlocks({
        worldId: this.world.worldId,
        chunkX: coordinate.x,
        chunkY: coordinate.y,
        chunkZ: coordinate.z,
        radius: 2,
        verticalRadius: 1,
      });
      if (
        generation !== this.onlineChunkGeneration ||
        (this.onlineMutationPending && !allowDuringMutation) ||
        this.gameMode !== "free"
      ) {
        return;
      }
      this.serverClock?.synchronize(nearby.serverNow);
      this.world.replaceBlocks(
        mergeFreeModeAndSystemBlocks(nearby.blocks, this.onlineSystemBlocks()),
      );
      // 접속 중 다른 사람이 현재 위치에 블록을 확정했거나, 재접속한
      // 위치가 이미 채워졌어도 플레이어가 블록 안에 갇히지 않게 한다.
      this.rescuePlayerFromWorldCollision();
      this.renderer.rebuildAll();
      this.currentHitDisplayKey = "";
      this.ui.setSaveState("저장됨", "ready");
      this.ui.setRecoveryNotice(null);
      this.updateHud(this.clock.now());
    } catch (error) {
      if (generation !== this.onlineChunkGeneration) {
        return;
      }
      this.analytics.failure("world_sync_failed", "world_read", true, false);
      this.ui.setSaveState("새 내용을 불러오지 못함", "warning");
      this.ui.setRecoveryNotice(
        "자유 건축을 불러오지 못했어요",
        "연결이나 저장 권한을 확인한 뒤 다시 시도해 주세요.",
        () => this.retrySynchronization(),
      );
      if (!this.freeModeOverview || requireNearbySuccess) {
        throw error;
      }
    } finally {
      if (enteredProgressGate) {
        this.onlineProgressGate.leave();
      }
    }
  }

  private async refreshOnlineWorld(
    force: boolean,
    throwOnFailure = false,
  ): Promise<void> {
    if (this.gameMode !== "mission") {
      return;
    }
    const repository = this.onlineRepository;
    if (!repository || this.onlineMutationPending) {
      return;
    }
    const coordinate = toChunkCoordinate({
      x: Math.floor(this.player.position.x),
      y: Math.floor(this.player.position.y),
      z: Math.floor(this.player.position.z),
    });
    const key = `${coordinate.x}:${coordinate.y}:${coordinate.z}`;
    if (!force && key === this.onlineChunkKey) {
      return;
    }
    this.onlineChunkKey = key;
    const generation = ++this.onlineChunkGeneration;

    try {
      const nearby = await repository.loadNearbyBlocks({
        worldId: this.world.worldId,
        chunkX: coordinate.x,
        chunkY: coordinate.y,
        chunkZ: coordinate.z,
        radius: 2,
        verticalRadius: 1,
      });
      if (
        generation !== this.onlineChunkGeneration ||
        this.onlineMutationPending
      ) {
        return;
      }
      this.serverClock?.synchronize(nearby.serverNow);
      this.world.replaceBlocks(
        mergeServerAndSystemBlocks(nearby.blocks, this.onlineSystemBlocks()),
      );
      this.renderer.rebuildAll();
      this.updateGuides();
      this.currentHitDisplayKey = "";
      this.ui.setSaveState("저장됨", "ready");
      this.ui.setRecoveryNotice(null);
    } catch (error) {
      this.analytics.failure("world_sync_failed", "world_read", true, false);
      if (generation === this.onlineChunkGeneration) {
        this.ui.setSaveState("새 내용을 불러오지 못함", "warning");
        this.ui.setRecoveryNotice(
          "새 내용을 불러오지 못했어요",
          "연결을 확인하고 다시 불러와 주세요.",
          () => this.retrySynchronization(),
        );
      }
      if (throwOnFailure) {
        throw error;
      }
    }
  }

  /**
   * 로컬 모드도 모든 변경을 CollaborativeWorldRepository 명령으로 저장한다.
   * 탭 복귀 시 정산을 먼저 직렬화한 뒤 IndexedDB의 권위 스냅샷을 다시 읽어
   * 다른 탭의 배치·철거·미션 기여를 opaque snapshot save로 덮지 않는다.
   */
  private async refreshLocalCollaborativeWorld(
    throwOnFailure = false,
  ): Promise<void> {
    if (
      this.gameMode !== "mission" ||
      this.repositoryMode !== "local" ||
      !this.repository
    ) {
      return;
    }
    await this.settleOnlineProduction();
    if (this.onlineProgressGate.busy) {
      return;
    }
    try {
      const latest = await this.repository.load(this.world.worldId);
      if (!latest?.localState) {
        throw new Error("로컬 월드 진행 상태가 없습니다.");
      }
      this.localState = cloneLocalState(latest.localState);
      this.localMissionState = latest.localMissionState
        ? cloneLocalMissionWorldState(latest.localMissionState)
        : null;
      this.world.replaceBlocks(
        latest.blocks.filter(
          ({ zone, source }) => zone !== "mission" && source !== "free",
        ),
      );
      this.renderer.rebuildAll();
      this.updateGuides();
      this.currentHitDisplayKey = "";
      await this.refreshMissionState(false);
      this.ui.setSaveState("저장됨", "ready");
      if (!this.storageWarning) {
        this.ui.setRecoveryNotice(null);
      }
    } catch (error) {
      this.analytics.failure("world_sync_failed", "world_read", true, false);
      this.ui.setSaveState("저장 내용을 불러오지 못함", "warning");
      this.ui.toast("다른 탭에서 바뀐 내용을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
      this.ui.setRecoveryNotice(
        "저장 내용을 불러오지 못했어요",
        "다른 탭을 닫거나 저장 권한을 확인한 뒤 다시 읽어 보세요.",
        () => this.retrySynchronization(),
      );
      if (throwOnFailure) {
        throw error;
      }
    }
  }

  private async restoreOnlineState(cause: unknown): Promise<void> {
    const repository = this.onlineRepository;
    if (!repository) {
      return;
    }
    if (this.repositoryMode === "local" && this.repository) {
      this.ui.setSaveState("저장 내용 불러오는 중", "saving");
      try {
        const latest = await this.repository.load(this.world.worldId);
        if (!latest?.localState) {
          throw new Error("로컬 월드 진행 상태가 없습니다.");
        }
        this.localState = cloneLocalState(latest.localState);
        this.localMissionState = latest.localMissionState
          ? cloneLocalMissionWorldState(latest.localMissionState)
          : null;
        this.world.replaceBlocks(
          latest.blocks.filter(
            ({ zone, source }) => zone !== "mission" && source !== "free",
          ),
        );
        this.renderer.rebuildAll();
        this.updateGuides();
        this.currentHitDisplayKey = "";
        this.ui.setSaveState("저장됨", "ready");
        if (!this.storageWarning) {
          this.ui.setRecoveryNotice(null);
        }
        this.ui.toast(onlineFailureMessage(cause));
      } catch {
        this.analytics.failure("storage_failed", "world_read", true, false);
        this.ui.setSaveState("저장 내용을 불러오지 못함", "warning");
        this.ui.toast("최신 저장 내용을 읽지 못했어요. 새로고침해 주세요.");
        this.ui.setRecoveryNotice(
          "저장 내용을 불러오지 못했어요",
          "저장 권한과 다른 탭 상태를 확인한 뒤 다시 시도해 주세요.",
          () => this.retrySynchronization(),
        );
      }
      return;
    }
    this.ui.setSaveState("최신 내용 불러오는 중", "saving");
    const coordinate = toChunkCoordinate({
      x: Math.floor(this.player.position.x),
      y: Math.floor(this.player.position.y),
      z: Math.floor(this.player.position.z),
    });
    try {
      const bootstrap = await repository.bootstrapPlayer(this.world.worldId);
      if (bootstrap.baySlotIndex !== this.localState.baySlotIndex) {
        throw new Error("서버의 스타터 베이 배정이 현재 세션과 다릅니다.");
      }
      const nearby = await repository.loadNearbyBlocks({
        worldId: this.world.worldId,
        chunkX: coordinate.x,
        chunkY: coordinate.y,
        chunkZ: coordinate.z,
        radius: 2,
        verticalRadius: 1,
      });
      this.serverClock?.synchronize(nearby.serverNow);
      this.localState.progress = cloneProgress(bootstrap.progress);
      this.world.replaceBlocks(
        mergeServerAndSystemBlocks(nearby.blocks, this.onlineSystemBlocks()),
      );
      this.renderer.rebuildAll();
      this.updateGuides();
      this.currentHitDisplayKey = "";
      this.ui.setSaveState("최신 내용을 불러왔어요", "ready");
      this.ui.setRecoveryNotice(null);
      this.ui.toast(onlineFailureMessage(cause));
    } catch {
      this.analytics.failure("world_sync_failed", "world_read", true, false);
      this.ui.setSaveState("온라인에 연결하지 못함", "warning");
      this.ui.toast("최신 내용을 읽지 못했어요. 연결 후 새로고침해 주세요.");
      this.ui.setRecoveryNotice(
        "온라인에 연결하지 못했어요",
        "연결을 확인하고 잠시 뒤 다시 시도해 주세요.",
        () => this.retrySynchronization(),
      );
    }
  }

  private async restoreActiveModeState(cause: unknown): Promise<void> {
    if (this.gameMode === "free") {
      this.freeChunkRequestGate.reset();
      await this.refreshFreeModeWorld(true, true, true);
      this.ui.toast(freeModeFailureMessage(cause));
      return;
    }
    await this.restoreOnlineState(cause);
  }

  private onlineSystemBlocks(): VoxelBlock[] {
    const coordinate = toChunkCoordinate({
      x: Math.floor(this.player.position.x),
      y: Math.floor(this.player.position.y),
      z: Math.floor(this.player.position.z),
    });
    return createNearbyOnlineSystemBlocks(
      this.world.worldId,
      coordinate.x,
      coordinate.y,
      coordinate.z,
      2,
      1,
    );
  }

  private retrySynchronization(): void {
    this.ui.setRecoveryNotice(null);
    this.lastFrameTime = performance.now();
    if (this.gameMode === "free") {
      this.freeChunkRequestGate.reset();
      void this.refreshFreeModeWorld(true, true);
      return;
    }
    if (this.repositoryMode === "online") {
      this.onlineChunkKey = "";
      void this.refreshOnlineWorld(true);
      void this.settleOnlineProduction();
      void this.refreshMissionState(false);
      return;
    }
    void this.refreshLocalCollaborativeWorld();
  }

  private queueSave(): void {
    if (!this.repository) {
      return;
    }
    const snapshot = this.createSnapshot(this.clock.now());
    this.pendingSaveCount += 1;
    this.ui.setSaveState("저장 중", "saving");
    this.saveChain = this.saveChain
      .then(() => this.repository!.save(snapshot))
      .then(() => {
        this.pendingSaveCount -= 1;
        if (this.pendingSaveCount === 0) {
          this.ui.setSaveState("저장됨", "ready");
        }
      })
      .catch(() => {
        this.analytics.increment("commit_failure_count");
        this.analytics.failure("storage_failed", "world_write", true, false);
        this.pendingSaveCount = Math.max(0, this.pendingSaveCount - 1);
        this.ui.setSaveState("저장하지 못함", "warning");
        this.ui.toast("저장하지 못했어요. 브라우저의 사이트 저장 설정을 확인해 주세요.");
      });
  }

  private createSnapshot(now: number): WorldSnapshot {
    const worldSnapshot = this.world.createSnapshot(now);
    return {
      ...worldSnapshot,
      schemaVersion: 3,
      localState: cloneLocalState(this.localState),
      ...(this.localMissionState
        ? {
            localMissionState: cloneLocalMissionWorldState(
              this.localMissionState,
            ),
          }
        : {}),
    };
  }

  private handlePointerLock(locked: boolean): void {
    this.controlsActive = locked;
    this.ui.setPointerLocked(locked);
    if (!locked) {
      if (this.onlineRepository) {
        this.cancelOnlineRemovalHold();
      } else {
        this.cancelRemovalHold();
      }
    }
    if (locked) {
      this.analyticsCreatorCardKey = "";
      if (this.gameModeActivated) {
        this.ui.enterWorld();
        this.recordWorldControllable();
      }
    } else if (
      !this.stopped &&
      !isTouchLayout() &&
      !this.ui.isAnalyticsSettingsOpen &&
      !this.ui.isOwnerCardExpanded &&
      !this.ui.isRecoveryNoticeVisible
    ) {
      this.ui.showPointerLockPrompt();
    }
  }

  private recordWorldControllable(): void {
    this.analytics.worldControllable({
      progress_stage: progressStage(
        this.localState.progress,
        this.gameMode === "mission" &&
          ((this.activeMission?.myContributionCount ?? 0) > 0 ||
            this.completedMissions.some((mission) =>
              mission.contributors.some(
                ({ publicId }) => publicId === this.playerOwner.publicId,
              ),
            )),
      ),
      input_mode: classifyInputMode(navigator.maxTouchPoints),
      orientation: classifyOrientation(window.innerWidth, window.innerHeight),
      acquisition: classifyAcquisition(document.referrer),
      world_ready_ms_bucket: bucketWorldReadyMs(this.worldReadyMs),
      renderer_tier_bucket: bucketRendererTier(navigator.hardwareConcurrency),
    });
  }
}

function uniqueMissions(
  missions: readonly MissionInstance[],
): MissionInstance[] {
  const byId = new Map<string, MissionInstance>();
  for (const mission of missions) {
    const existing = byId.get(mission.id);
    if (existing?.status === "completed" && mission.status === "active") {
      continue;
    }
    byId.set(mission.id, mission);
  }
  return [...byId.values()].sort(
    (left, right) => left.layer - right.layer || left.id.localeCompare(right.id),
  );
}

function upsertMission(
  missions: readonly MissionInstance[],
  mission: MissionInstance,
): MissionInstance[] {
  return uniqueMissions([
    ...missions.filter(({ id }) => id !== mission.id),
    mission,
  ]);
}

function missionSlotPosition(
  mission: MissionInstance,
  slotIndex: number,
): GridPosition {
  const slot = getMissionTemplate(mission.templateKey).slots.find(
    (candidate) => candidate.slotIndex === slotIndex,
  );
  return slot
    ? transformMissionSlot(mission, slot).position
    : { ...mission.origin };
}

function missionSlotLabel(
  mission: MissionInstance,
  slotIndex: number,
): string {
  const slot = getMissionTemplate(mission.templateKey).slots.find(
    (candidate) => candidate.slotIndex === slotIndex,
  );
  if (!slot) {
    return "자리 " + String(slotIndex + 1);
  }
  const part =
    slot.position.y === 0
      ? "바닥 문양"
      : slot.position.y >= 4
        ? "상단 고리"
        : slot.position.x < 0
          ? "왼쪽 기둥"
          : "오른쪽 기둥";
  return part + " · " + String(slotIndex + 1);
}

function missionFailureMessage(error: unknown): string {
  if (error instanceof RepositoryRequestError) {
    switch (error.code) {
      case "slot-already-filled":
      case "23505":
        return "다른 플레이어가 방금 그 자리에 놓았어요. 새 자리를 골라 주세요.";
      case "onboarding-incomplete":
        return "내 공간 16칸과 블록 공방 8칸을 채워야 관문에 블록을 놓을 수 있어요.";
      case "inventory-insufficient":
      case "insufficient-inventory":
        return "관문에 놓을 블록이 없어요.";
      case "mission-not-active":
        return "이 관문은 완성됐어요. 다음 층이 열렸어요.";
      case "idempotency-conflict":
        return "같은 작업이 겹쳐 블록을 놓지 않았어요.";
      default:
        return "별빛 관문에 블록을 놓지 못했어요. 다시 시도해 주세요.";
    }
  }
  return "별빛 관문을 확인하지 못했어요. 다시 시도해 주세요.";
}

function freeModeFailureMessage(error: unknown): string {
  if (error instanceof RepositoryRequestError) {
    switch (error.code) {
      case "duplicate-coordinate":
      case "23505":
        return "다른 사람이 먼저 그 자리에 놓았어요";
      case "insufficient-inventory":
      case "inventory-insufficient":
        return "놓을 블록이 없어요";
      case "chunk-full":
      case "54000":
        return "이 구역은 블록이 가득 찼어요. 조금 떨어진 곳에 놓아 주세요";
      case "P0003":
        return "최근 블록 변경이 많아요. 잠시 후 다시 이용해 주세요";
      case "foreign-block-locked":
      case "P0004":
        return "다른 사람의 최근 블록은 3일이 지나야 정리할 수 있어요";
      case "support-in-use":
      case "P0005":
        return "위에 연결된 블록부터 정리해 주세요";
      case "protected-zone":
      case "42501":
        return "시작 지점과 광장으로 가는 길은 비워 두고 조금 떨어진 곳에 놓아 주세요";
      case "invalid-support":
      case "23503":
        return "바닥이나 다른 자유 건축 블록에 이어서 놓아 주세요";
      default:
        return error.retryable
          ? "연결 문제로 최신 내용을 다시 불러왔어요"
          : "작업을 반영하지 못해 최신 내용을 다시 불러왔어요";
    }
  }
  return "작업을 확인하지 못해 최신 내용을 다시 불러왔어요";
}

function withFreeModeProgress(
  overview: FreeModeOverviewResult,
  progress: FreeModeProgress,
  serverNow: number,
): FreeModeOverviewResult {
  return {
    ...overview,
    progress: { ...progress },
    nextGrantInMs:
      progress.inventory >= overview.maxInventory
        ? null
        : Math.max(
            0,
            progress.lastSettledAt + overview.grantIntervalMs - serverNow,
          ),
    produced: 0,
    serverNow,
  };
}

function mergeFreeModeAndSystemBlocks(
  freeBlocks: readonly VoxelBlock[],
  systemBlocks: readonly VoxelBlock[],
): VoxelBlock[] {
  const freePositions = new Set(
    freeBlocks.map(
      ({ position }) => `${position.x}:${position.y}:${position.z}`,
    ),
  );
  return [
    ...freeBlocks,
    ...systemBlocks.filter(
      ({ position }) =>
        !freePositions.has(`${position.x}:${position.y}:${position.z}`),
    ),
  ];
}

function formatFreeModeProtectionTime(durationMs: number): string {
  const totalHours = Math.max(1, Math.ceil(durationMs / (60 * 60 * 1_000)));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days === 0) {
    return String(hours) + "시간";
  }
  return hours === 0
    ? String(days) + "일"
    : String(days) + "일 " + String(hours) + "시간";
}

function neutralInputFrame(): InputFrame {
  return {
    moveX: 0,
    moveForward: 0,
    lookX: 0,
    lookY: 0,
    jump: false,
    place: false,
    inspectOwner: false,
    remove: false,
    removeHeld: false,
    rotate: false,
    manualProduction: false,
    resetBay: false,
    selectKind: null,
    colorDelta: 0,
  };
}

function hasAnalyticsInput(input: InputFrame): boolean {
  return (
    input.moveX !== 0 ||
    input.moveForward !== 0 ||
    input.lookX !== 0 ||
    input.lookY !== 0 ||
    input.jump ||
    input.place ||
    input.inspectOwner ||
    input.remove ||
    input.removeHeld ||
    input.rotate ||
    input.manualProduction ||
    input.resetBay ||
    input.selectKind !== null ||
    input.colorDelta !== 0
  );
}

function hasPlayerMoved(
  before: Vector3Like,
  after: Vector3Like,
): boolean {
  const x = after.x - before.x;
  const y = after.y - before.y;
  const z = after.z - before.z;
  return x * x + y * y + z * z > 0.000_001;
}

function supportsWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

function createLocalId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function cloneLocalState(state: LocalGameState): LocalGameState {
  return {
    ...state,
    progress: {
      ...state.progress,
      manualProductionAt: [...state.progress.manualProductionAt],
    },
  };
}

function cloneProgress(
  progress: LocalGameState["progress"],
): LocalGameState["progress"] {
  return {
    ...progress,
    manualProductionAt: [...progress.manualProductionAt],
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function onlineFailureMessage(error: unknown): string {
  if (!(error instanceof RepositoryRequestError)) {
    return "연결 문제로 최신 내용을 다시 불러왔어요";
  }
  switch (error.code) {
    case "duplicate-coordinate":
    case "23505":
      return "다른 플레이어가 먼저 그 자리를 사용했어요";
    case "insufficient-inventory":
    case "inventory-full":
      return "가지고 있는 블록 수를 다시 맞췄어요";
    case "owner-only":
    case "protected-zone":
    case "42501":
      return "이곳은 바꿀 수 없어요";
    case "support-in-use":
    case "invalid-support":
      return "연결된 블록이 있어 바꿀 수 없어요";
    case "too-early":
      return "조금 더 길게 눌러 주세요";
    default:
      return error.retryable
        ? "연결이 불안정해 최신 내용을 다시 확인했어요"
        : "블록을 놓지 못해 원래 상태로 돌아갔어요";
  }
}

function yawToward(direction: GridPosition): number {
  return Math.atan2(-direction.x, -direction.z);
}

function removalHint(decision: PermissionDecision): string {
  if (decision.requiresHold) {
    return "2.5초 길게 눌러 제거";
  }
  if (decision.allowed) {
    return "바로 회수 가능";
  }
  return removalFailureMessage(decision);
}

function removalFailureMessage(decision: PermissionDecision): string {
  switch (decision.reason) {
    case "support-in-use":
      return "이 블록에 다른 블록이 연결돼 있어 제거할 수 없어요";
    case "owner-only":
      return "이곳은 만든 사람만 바꿀 수 있어요";
    case "protected-zone":
      return "이 블록은 바꿀 수 없어요";
    case "hold-required":
      return "2.5초 길게 눌러 제거하세요";
    case "allowed":
      return "제거할 수 있어요";
  }
}

function guidePlacementToast(guide: GuideCell): string {
  const label =
    guide.group === "base"
      ? "내 공간"
      : guide.group === "producer"
        ? "블록 공방"
        : "공방 확장";
  return label + " " + String(guide.order) + "칸을 채웠어요";
}

function formatDuration(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.ceil(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return String(minutes) + "분";
  }
  if (minutes === 0) {
    return String(hours) + "시간";
  }
  return String(hours) + "시간 " + String(minutes) + "분";
}

function manualStepLabel(
  step: number,
  stepCount: number,
  remainingMs: number,
): string {
  const names = ["동력 채우기", "재료 다듬기", "블록 굳히기"];
  const name = names[step - 1] ?? "블록 만들기";
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  return [
    String(step) + "/" + String(stepCount),
    name,
    seconds > 0 ? String(seconds) + "초 유지" : "다음 단계 누르기",
  ].join(" · ");
}

