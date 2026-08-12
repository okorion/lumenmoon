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
  DEFAULT_GAME_RULES,
  SystemClock,
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
  type WorldMutationResult,
} from "../data/CollaborativeWorldRepository";
import { IndexedDbWorldRepository } from "../data/IndexedDbWorldRepository";
import { LocalCollaborativeWorldRepository } from "../data/LocalCollaborativeWorldRepository";
import {
  MemoryWorldRepository,
  type WorldRepository,
} from "../data/WorldRepository";
import { readRuntimeRepositoryConfig } from "../config/runtimeConfig";
import { isPerformanceHudEnabled } from "../config/performanceConfig";
import { GameInput, type InputFrame } from "../input/GameInput";
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
  SynchronizedServerClock,
  OnlineProgressGate,
  applyAuthoritativeMutation,
  createNearbyOnlineSystemBlocks,
  createOptimisticPlacementProgress,
  mergeServerAndSystemBlocks,
} from "./onlineWorld";
import { GameAnalytics } from "./GameAnalytics";
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
  analytics?: GameAnalytics;
}

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
  private readonly repository: WorldRepository | null;
  /** 모든 런타임 변경은 local/online 모두 이 검증 명령 저장소를 통과한다. */
  private readonly onlineRepository: CollaborativeWorldRepository;
  private readonly missionRepository: CollaborativeWorldRepository;
  private readonly repositoryMode: "local" | "online";
  private readonly playerOwner: typeof LOCAL_PLAYER;
  private readonly clock: Clock;
  private readonly serverClock: SynchronizedServerClock | null;
  private readonly config: Readonly<GameRulesConfig>;
  private readonly bay: StarterBayLayout;
  private readonly reservedBays: readonly StarterBayLayout[];
  private localState: LocalGameState;
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
  private readonly analytics: GameAnalytics;
  private readonly worldReadyMs: number;
  private readonly storageWarning: string | null;
  private readonly performanceHudEnabled = isPerformanceHudEnabled(
    import.meta.env,
    import.meta.env.DEV,
  );
  private lastPerformanceHudAt = Number.NEGATIVE_INFINITY;

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
    analytics: GameAnalytics,
    worldReadyMs: number,
  ) {
    if (!snapshot.localState) {
      throw new Error("로컬 플레이어 진행 상태를 준비하지 못했습니다.");
    }

    this.ui = new GameUI(root);
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
    this.world = new VoxelWorld(snapshot.worldId, snapshot.blocks);
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
    this.input = new GameInput(
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

    this.ui.bindStart(() => this.input.begin());
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
      this.ui.toast("건축 도구를 바꿨어요");
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

    this.ui.setRepositoryMode(repositoryMode, this.playerOwner.publicId);
    if (storageWarning) {
      this.ui.setSaveState("이번 접속만 저장", "warning");
      this.ui.toast(storageWarning);
      this.ui.setRecoveryNotice(
        "브라우저 저장소를 사용할 수 없습니다",
        storageWarning + " 저장 권한을 확인한 뒤 다시 시도할 수 있어요.",
        () => window.location.reload(),
      );
    } else if (repositoryMode === "online") {
      this.ui.setSaveState("공동 월드 동기화됨", "ready");
    } else {
      this.ui.setSaveState("브라우저에 저장됨", "ready");
    }

    if (repositoryMode === "local") {
      this.reconcileWorldProgress(this.clock.now());
    }
    this.updateGuides();
    this.updateHud(this.clock.now());

    window.addEventListener("resize", () => this.renderer.resize());
    document.addEventListener("visibilitychange", () => {
      this.lastFrameTime = performance.now();
      this.updateAnalyticsTime(Date.now());
      if (!document.hidden) {
        if (this.repositoryMode === "online") {
          void this.refreshOnlineWorld(true);
          void this.settleOnlineProduction();
          void this.refreshMissionState(false);
        } else {
          void this.refreshLocalCollaborativeWorld();
        }
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
        "3D 화면 연결이 끊겼습니다",
        "브라우저가 그래픽 컨텍스트를 닫았습니다. 페이지를 다시 열면 저장된 월드에서 이어집니다.",
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

    void this.refreshMissionState(true);
    requestAnimationFrame((time) => this.frame(time));
  }

  static async boot(
    root: HTMLElement,
    dependencies: GameDependencies = {},
  ): Promise<GameApp | null> {
    const bootStartedAt = performance.now();
    const analytics = dependencies.analytics ?? GameAnalytics.create();
    if (!supportsWebGL2()) {
      analytics.failure("webgl_unsupported", "renderer", false, false);
      const preliminaryUi = new GameUI(root);
      preliminaryUi.showFatal(
        "WebGL2가 필요합니다",
        "이 브라우저 또는 기기에서는 3D 월드를 표시할 수 없습니다. 최신 Safari, Chrome, Edge에서 다시 시도해 주세요.",
      );
      return null;
    }

    const clock = dependencies.clock ?? new SystemClock();
    const config = dependencies.config ?? DEFAULT_GAME_RULES;
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
      const bootstrap = await onlineRepository.bootstrapPlayer(runtime.worldId);
      const serverClock = new SynchronizedServerClock(bootstrap.serverNow);
      const onlineBay = createStarterBayLayout(bootstrap.baySlotIndex);
      const spawnChunk = toChunkCoordinate({
        x: Math.floor(onlineBay.safeSpawn.x),
        y: 0,
        z: Math.floor(onlineBay.safeSpawn.z),
      });
      const nearby = await onlineRepository.loadNearbyBlocks({
        worldId: runtime.worldId,
        chunkX: spawnChunk.x,
        chunkY: spawnChunk.y,
        chunkZ: spawnChunk.z,
        radius: 2,
        verticalRadius: 1,
      });
      serverClock.synchronize(nearby.serverNow);
      const systemBlocks = createNearbyOnlineSystemBlocks(
        runtime.worldId,
        spawnChunk.x,
        spawnChunk.y,
        spawnChunk.z,
        2,
        1,
      );
      const snapshot: WorldSnapshot = {
        schemaVersion: 2,
        worldId: runtime.worldId,
        blocks: mergeServerAndSystemBlocks(nearby.blocks, systemBlocks),
        updatedAt: nearby.serverNow,
        localState: {
          playerId: bootstrap.player.id,
          baySlotIndex: bootstrap.baySlotIndex,
          progress: bootstrap.progress,
        },
      };
      const app = new GameApp(
        root,
        snapshot,
        null,
        onlineRepository,
        onlineRepository,
        "online",
        bootstrap.player,
        null,
        serverClock,
        config,
        analytics,
        performance.now() - bootStartedAt,
      );
      void app.settleOnlineProduction();
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
        "이 브라우저는 IndexedDB를 지원하지 않아 이번 접속만 유지됩니다.";
    }

    let missionRepository = new LocalCollaborativeWorldRepository(
      repository,
      { clock, config, player: LOCAL_PLAYER },
    );
    try {
      await missionRepository.bootstrapPlayer(WORLD_ID);
      const loaded = await repository.load(WORLD_ID);
      if (!loaded) {
        throw new Error("로컬 월드를 준비하지 못했습니다.");
      }
      snapshot = loaded;
    } catch {
      repository = new MemoryWorldRepository();
      missionRepository = new LocalCollaborativeWorldRepository(repository, {
        clock,
        config,
        player: LOCAL_PLAYER,
      });
      await missionRepository.bootstrapPlayer(WORLD_ID);
      const loaded = await repository.load(WORLD_ID);
      if (!loaded) {
        throw new Error("임시 로컬 월드를 준비하지 못했습니다.");
      }
      snapshot = loaded;
      storageWarning =
        "월드 저장을 시작하지 못해 이번 접속만 변경이 유지됩니다.";
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
      analytics,
      performance.now() - bootStartedAt,
    );
    void app.settleOnlineProduction();
    return app;
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
      this.ui.isMissionArchiveOpen ||
      this.ui.isAnalyticsSettingsOpen ||
      this.renderer.isMissionCinematicActive ||
      this.missionContributionPending;
    const input =
      this.controlsActive && !interactionPaused
        ? queuedInput
        : neutralInputFrame();

    if (this.controlsActive && hasAnalyticsInput(queuedInput)) {
      this.analytics.markInput(analyticsNow);
    }

    if (input.selectKind) {
      this.ui.selectKind(input.selectKind);
      this.ui.toast("블록 모양을 바꿨어요");
    }
    if (input.colorDelta !== 0) {
      this.ui.cycleColor(input.colorDelta);
      this.ui.toast("블록 색을 바꿨어요");
    }
    if (input.rotate) {
      this.ui.rotateSelection();
      this.ui.toast("블록을 90° 회전했어요");
    }
    if (input.manualProduction) {
      this.advanceManualProduction();
    }
    if (input.resetBay) {
      this.resetBay();
    }

    const positionBeforeUpdate = { ...this.player.position };
    this.player.update(deltaSeconds, input);
    if (hasPlayerMoved(positionBeforeUpdate, this.player.position)) {
      this.analytics.milestone("first_move");
    }
    this.renderer.setPlayerPose(
      this.player.cameraPosition,
      this.player.yaw,
      this.player.pitch,
    );
    if (this.repositoryMode === "online") {
      void this.refreshOnlineWorld(false);
    }
    this.latestHit = this.renderer.pick();
    this.updateTargetUi(this.latestHit);

    if (input.place) {
      const contributorPublicId = this.renderer.pickMissionContributorLight();
      if (contributorPublicId) {
        this.highlightMissionCreator(contributorPublicId);
      } else {
        this.placeSelectedBlock();
      }
    }
    this.handleRemoval(input, time);
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
    const valid = this.canPlaceAt(position);
    const removal = this.getRemovalDecision(hit.block, 0);
    const removalLabel = removalHint(removal);
    const displayKey = [
      hit.mission?.visualId ?? hit.block.id,
      valid ? "place" : "blocked",
      removal.reason,
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
    if (!this.canPlaceAt(position)) {
      if (this.localState.progress.inventory <= 0) {
        this.analytics.increment("insufficient_inventory_count");
      }
      this.ui.toast(this.placementFailureMessage(position));
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
    this.ui.toast(
      events.onboardingCompleted
        ? "첫 거점 완성 · 시운전 보상 2블록을 받았어요"
        : events.producerUpgraded
          ? "생산시설 Lv.2 완성 · 2시간마다 1개 생산"
          : guide
            ? guidePlacementToast(guide)
            : "블록을 놓았어요",
    );
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
    this.ui.toast(
      removed.owner.id === this.playerOwner.id
        ? refunded > 0
          ? "블록을 회수했어요"
          : refundable
            ? "재고가 가득 차 블록만 정리했어요"
            : "블록을 정리했어요"
        : "공용 블록을 해체했어요 · 재료 보상 없음",
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
    this.ui.setSaveState("제거 확인 중", "saving");
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
    this.ui.setSaveState("철거 확인 중", "saving");
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
      this.ui.setSaveState("공동 월드 동기화됨", "ready");
      this.ui.toast("공용 블록을 해체했어요 · 재료 보상 없음");
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

  private canPlaceAt(position: GridPosition): boolean {
    if (
      this.missionContributionPending ||
      this.onlineProgressGate.busy ||
      this.localState.progress.inventory <= 0 ||
      !this.world.canPlace(position) ||
      blockIntersectsPlayer(this.player.position, position)
    ) {
      return false;
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
    if (this.localState.progress.inventory <= 0) {
      return "사용할 블록이 없습니다";
    }
    const zone = this.classifyPosition(position).zone;
    if (zone === "mission" || zone === "system" || zone === "spawn") {
      return "보호된 구역에는 놓을 수 없어요";
    }
    if (this.isOnboardingActive()) {
      return "먼저 민트·금빛 가이드 24칸을 완성해 주세요";
    }
    return "그 위치에는 블록을 놓을 수 없어요";
  }

  private getRemovalDecision(
    block: VoxelBlock,
    heldMs: number,
  ): PermissionDecision {
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
        this.ui.toast("생산시설을 복구하면 수동 작업을 다시 시작할 수 있어요");
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
        "자동 생산으로 " + String(settlement.produced) + "블록을 받았어요",
      );
    }
  }

  private advanceManualProduction(): void {
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
          ? "생산시설 8칸을 복구해 주세요"
          : "개인 거점 16칸과 생산시설 8칸을 먼저 완성해 주세요",
      );
      return;
    }
    if (
      getManualProductionRemainingAttempts(progress, now, this.config) <= 0
    ) {
      this.ui.toast("최근 24시간의 수동 생산 3회를 모두 사용했어요");
      return;
    }
    if (progress.inventory >= this.config.maxInventory) {
      this.ui.toast("재고가 가득 찼어요");
      return;
    }

    const stepDuration =
      this.config.manualProductionDurationMs /
      this.config.manualProductionStepCount;
    if (!this.manualProduction) {
      this.manualProduction = { step: 1, readyAt: now + stepDuration };
      this.ui.toast("1단계 동력을 충전합니다");
      return;
    }
    if (now < this.manualProduction.readyAt) {
      this.ui.toast("현재 단계를 조금만 더 유지해 주세요");
      return;
    }
    if (this.manualProduction.step < this.config.manualProductionStepCount) {
      this.manualProduction = {
        step: this.manualProduction.step + 1,
        readyAt: now + stepDuration,
      };
      this.ui.toast(
        String(this.manualProduction.step) + "단계 작업을 시작했어요",
      );
    }
  }

  private finishManualProduction(now: number): void {
    if (!this.isProducerOperational()) {
      this.manualProduction = null;
      this.ui.toast("생산시설이 멈춰 수동 작업을 취소했어요");
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
      this.ui.toast("수동 생산 완료 · 1블록을 받았어요");
    } else {
      this.ui.toast(
        result.reason === "inventory-full"
          ? "재고가 가득 차 생산을 멈췄어요"
          : "최근 24시간의 수동 생산을 모두 사용했어요",
      );
    }
  }

  private advanceOnlineManualProduction(): void {
    if (
      this.onlineManualStartPending ||
      this.onlineMutationPending ||
      this.onlineProgressGate.busy
    ) {
      this.ui.toast("생산 요청을 확인하고 있어요");
      return;
    }
    if (!this.isProducerOperational()) {
      this.ui.toast(
        this.localState.progress.trialRewardClaimed
          ? "생산시설 8칸을 복구해 주세요"
          : "개인 거점 16칸과 생산시설 8칸을 먼저 완성해 주세요",
      );
      return;
    }
    if (this.localState.progress.inventory >= this.config.maxInventory) {
      this.ui.toast("재고가 가득 찼어요");
      return;
    }
    if (
      getManualProductionRemainingAttempts(
        this.localState.progress,
        this.clock.now(),
        this.config,
      ) <= 0
    ) {
      this.ui.toast("최근 24시간의 수동 생산 3회를 모두 사용했어요");
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
      this.ui.toast("현재 단계를 조금만 더 유지해 주세요");
      return;
    }
    if (this.manualProduction.step < this.config.manualProductionStepCount) {
      this.manualProduction = {
        ...this.manualProduction,
        step: this.manualProduction.step + 1,
        readyAt: monotonicNow + stepDuration,
      };
      this.ui.toast(
        String(this.manualProduction.step) + "단계 작업을 시작했어요",
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
    this.ui.setSaveState("생산 시작 확인 중", "saving");
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
      this.ui.setSaveState("공동 월드 동기화됨", "ready");
      this.ui.toast("1단계 동력을 충전합니다");
    } catch (error) {
      this.analytics.failure("production_failed", "production", true, false);
      this.ui.setSaveState("생산 시작 실패", "warning");
      this.ui.toast(onlineFailureMessage(error));
      this.ui.setRecoveryNotice(
        "생산 요청을 확인하지 못했습니다",
        "연결을 확인하고 서버의 재고·생산 상태를 다시 불러오세요.",
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
    this.ui.setSaveState("생산 완료 확인 중", "saving");
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
      this.ui.setSaveState("공동 월드 동기화됨", "ready");
      this.ui.toast("수동 생산 완료 · 1블록을 받았어요");
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
          "자동 생산으로 " + String(result.produced) + "블록을 받았어요",
        );
      }
      this.ui.setSaveState("공동 월드 동기화됨", "ready");
    } catch {
      this.analytics.failure("production_failed", "production", true, false);
      this.ui.setSaveState("생산 정산 대기", "warning");
      this.ui.setRecoveryNotice(
        "생산 정산이 대기 중입니다",
        "연결 후 다시 동기화하면 서버 시각 기준 생산 상태를 복원합니다.",
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
      this.ui.toast("첫 거점을 완성한 뒤에는 다시 시작할 수 없어요");
      return;
    }
    if (!this.onlineProgressGate.tryEnter()) {
      this.ui.toast("이전 변경을 서버에서 확인하고 있어요");
      return;
    }
    this.onlineMutationPending = true;
    this.onlineChunkGeneration += 1;
    this.ui.setSaveState("베이 초기화 확인 중", "saving");
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
      this.ui.toast("내 온보딩 블록을 지우고 24블록으로 되돌렸어요");
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
      this.ui.toast("첫 거점을 완성한 뒤에는 다시 시작할 수 없어요");
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
    this.ui.toast("내 온보딩 블록을 지우고 24블록으로 되돌렸어요");
  }

  private updateGuides(): void {
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

  private async refreshMissionState(showFailure: boolean): Promise<void> {
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
          "공동 미션을 불러오지 못했습니다",
          "연결을 확인한 뒤 주변 월드와 미션 기록을 다시 동기화하세요.",
          () => this.retrySynchronization(),
        );
      }
    }
  }

  private async refreshMissionArchive(): Promise<void> {
    await this.refreshMissionState(true);
  }

  private async contributeToMission(
    request: ContributeToMissionRequest,
  ): Promise<void> {
    if (this.missionContributionPending) {
      return;
    }
    const enteredOnlineGate =
      this.repositoryMode === "online"
        ? this.onlineProgressGate.tryEnter()
        : false;
    if (this.repositoryMode === "online" && !enteredOnlineGate) {
      this.ui.toast("이전 변경을 서버에서 확인하고 있어요");
      return;
    }

    // 먼저 시작된 overview/archive 읽기가 성공 응답을 과거 상태로 덮지 못하게 한다.
    this.missionRefreshGeneration += 1;
    this.missionContributionPending = true;
    this.ui.setMissionContributionPending(true);
    this.ui.setSaveState("공동 미션 기여 확인 중", "saving");
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
        this.ui.toast("이미 반영된 별빛 기여를 확인했어요");
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
        this.ui.toast("별빛 관문이 완성되어 다음 층이 열렸어요");
      } else {
        this.presentMission(result.mission);
        this.ui.toast("정규 슬롯 1칸에 별빛을 보탰어요");
      }
      this.ui.setSaveState(
        this.repositoryMode === "online"
          ? "공동 월드 동기화됨"
          : "브라우저에 저장됨",
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
        this.ui.setSaveState("기여가 반영되지 않음", "warning");
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
    this.rescuePlayerFromMissionCollision();
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

  private rescuePlayerFromMissionCollision(): void {
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
              this.ui.toast("새 별빛 블록을 피해 안전한 칸으로 이동했어요");
              return;
            }
          }
        }
      }
    }
    this.player.respawn();
    this.ui.toast("새 별빛 블록과 겹쳐 안전 발판으로 돌아왔어요");
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
        ? "완성된 기념물은 변경할 수 없어요"
        : !onboardingComplete
          ? "거점 16칸과 생산시설 8칸을 먼저 완성하세요"
          : !hasInventory
            ? "공유 재고에 기여할 블록이 없어요"
            : this.missionContributionPending
              ? "서버에서 기여를 확인하고 있어요"
              : "선택 가능한 추천 슬롯이 없어요",
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
      this.ui.toast("이 제작자의 별빛 블록을 찾을 수 없어요");
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
      this.ui.toast("안전한 관람 위치를 찾지 못했어요");
    }
  }

  private visitMissionMonument(instanceId: string): void {
    const mission = this.completedMissions.find(({ id }) => id === instanceId);
    if (!mission) {
      this.ui.toast("기념물 기록을 다시 불러와 주세요");
      return;
    }
    this.clearMissionHighlight();
    this.presentMission(mission);
    const target =
      expandMissionBlocks(mission)[0]?.position ?? mission.origin;
    if (this.focusMissionPosition(target)) {
      this.ui.toast(String(mission.layer) + "층 기념물로 안내했어요");
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
            ? "시설 복구 후 생산 재개"
            : "거점·시설 완성 후 자동 생산"
          : nextAutomatic === null
            ? "재고 가득 참"
            : "자동 생산 " + formatDuration(nextAutomatic),
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
        "베이 " + String(this.localState.baySlotIndex + 1).padStart(2, "0"),
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
      this.ui.toast("이전 변경을 서버에서 확인하고 있어요");
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
      this.ui.setSaveState("배치 확인 중", "saving");
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
      this.ui.toast(
        guide ? guidePlacementToast(guide) : "공동 월드에 블록을 놓았어요",
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
      this.repositoryMode === "online"
        ? "공동 월드 동기화됨"
        : "브라우저에 저장됨",
      "ready",
    );
    void this.refreshMissionState(false);
  }

  private async refreshOnlineWorld(force: boolean): Promise<void> {
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
      this.ui.setSaveState("공동 월드 동기화됨", "ready");
      this.ui.setRecoveryNotice(null);
    } catch {
      this.analytics.failure("world_sync_failed", "world_read", true, false);
      if (generation === this.onlineChunkGeneration) {
        this.ui.setSaveState("주변 동기화 실패", "warning");
        this.ui.setRecoveryNotice(
          "공동 월드 동기화 실패",
          "연결을 확인한 뒤 주변 월드·재고·생산·미션 상태를 다시 불러오세요.",
          () => this.retrySynchronization(),
        );
      }
    }
  }

  /**
   * 로컬 모드도 모든 변경을 CollaborativeWorldRepository 명령으로 저장한다.
   * 탭 복귀 시 정산을 먼저 직렬화한 뒤 IndexedDB의 권위 스냅샷을 다시 읽어
   * 다른 탭의 배치·철거·미션 기여를 opaque snapshot save로 덮지 않는다.
   */
  private async refreshLocalCollaborativeWorld(): Promise<void> {
    if (this.repositoryMode !== "local" || !this.repository) {
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
        latest.blocks.filter(({ zone }) => zone !== "mission"),
      );
      this.renderer.rebuildAll();
      this.updateGuides();
      this.currentHitDisplayKey = "";
      await this.refreshMissionState(false);
      this.ui.setSaveState("브라우저에 저장됨", "ready");
      if (!this.storageWarning) {
        this.ui.setRecoveryNotice(null);
      }
    } catch {
      this.analytics.failure("world_sync_failed", "world_read", true, false);
      this.ui.setSaveState("로컬 동기화 실패", "warning");
      this.ui.toast("다른 탭의 최신 상태를 읽지 못했습니다. 다시 전환해 주세요.");
      this.ui.setRecoveryNotice(
        "브라우저 저장 동기화 실패",
        "다른 탭을 닫거나 저장 권한을 확인한 뒤 다시 읽어 보세요.",
        () => this.retrySynchronization(),
      );
    }
  }

  private async restoreOnlineState(cause: unknown): Promise<void> {
    const repository = this.onlineRepository;
    if (!repository) {
      return;
    }
    if (this.repositoryMode === "local" && this.repository) {
      this.ui.setSaveState("로컬 상태 복구 중", "saving");
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
          latest.blocks.filter(({ zone }) => zone !== "mission"),
        );
        this.renderer.rebuildAll();
        this.updateGuides();
        this.currentHitDisplayKey = "";
        this.ui.setSaveState("브라우저에 저장됨", "ready");
        if (!this.storageWarning) {
          this.ui.setRecoveryNotice(null);
        }
        this.ui.toast(onlineFailureMessage(cause));
      } catch {
        this.analytics.failure("storage_failed", "world_read", true, false);
        this.ui.setSaveState("로컬 복구 실패", "warning");
        this.ui.toast("최신 로컬 상태를 읽지 못했습니다. 새로고침해 주세요.");
        this.ui.setRecoveryNotice(
          "로컬 상태 복구 실패",
          "저장 권한과 다른 탭 상태를 확인한 뒤 다시 시도해 주세요.",
          () => this.retrySynchronization(),
        );
      }
      return;
    }
    this.ui.setSaveState("서버 상태 복구 중", "saving");
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
      this.ui.setSaveState("서버 상태로 복구됨", "ready");
      this.ui.setRecoveryNotice(null);
      this.ui.toast(onlineFailureMessage(cause));
    } catch {
      this.analytics.failure("world_sync_failed", "world_read", true, false);
      this.ui.setSaveState("온라인 복구 실패", "warning");
      this.ui.toast("서버 상태를 다시 읽지 못했습니다. 연결 후 새로고침해 주세요.");
      this.ui.setRecoveryNotice(
        "온라인 복구 실패",
        "Supabase 프로젝트 상태와 네트워크를 확인한 뒤 다시 동기화하세요.",
        () => this.retrySynchronization(),
      );
    }
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
          this.ui.setSaveState("브라우저에 저장됨", "ready");
        }
      })
      .catch(() => {
        this.analytics.increment("commit_failure_count");
        this.analytics.failure("storage_failed", "world_write", true, false);
        this.pendingSaveCount = Math.max(0, this.pendingSaveCount - 1);
        this.ui.setSaveState("저장 실패", "warning");
        this.ui.toast("저장하지 못했습니다. 브라우저 저장 설정을 확인해 주세요.");
      });
  }

  private createSnapshot(now: number): WorldSnapshot {
    const worldSnapshot = this.world.createSnapshot(now);
    return {
      ...worldSnapshot,
      schemaVersion: 2,
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
    if (!locked) {
      if (this.onlineRepository) {
        this.cancelOnlineRemovalHold();
      } else {
        this.cancelRemovalHold();
      }
    }
    if (locked) {
      this.ui.enterWorld();
      this.analyticsCreatorCardKey = "";
      this.analytics.worldControllable({
        progress_stage: progressStage(
          this.localState.progress,
          (this.activeMission?.myContributionCount ?? 0) > 0 ||
            this.completedMissions.some((mission) =>
              mission.contributors.some(
                ({ publicId }) => publicId === this.playerOwner.publicId,
              ),
            ),
        ),
        input_mode: classifyInputMode(navigator.maxTouchPoints),
        orientation: classifyOrientation(window.innerWidth, window.innerHeight),
        acquisition: classifyAcquisition(document.referrer),
        world_ready_ms_bucket: bucketWorldReadyMs(this.worldReadyMs),
        renderer_tier_bucket: bucketRendererTier(
          navigator.hardwareConcurrency,
        ),
      });
    } else if (
      !this.stopped &&
      !isTouchLayout() &&
      !this.ui.isAnalyticsSettingsOpen &&
      !this.ui.isRecoveryNoticeVisible
    ) {
      this.ui.showPointerLockPrompt();
    }
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
    return "추천 " + String(slotIndex + 1);
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
        return "다른 플레이어가 방금 그 슬롯을 완성했어요. 새 추천 위치를 불러왔어요.";
      case "onboarding-incomplete":
        return "거점 16칸과 생산시설 8칸을 현재 완성해야 기여할 수 있어요.";
      case "inventory-insufficient":
      case "insufficient-inventory":
        return "공유 재고에 기여할 블록이 없어요.";
      case "mission-not-active":
        return "이 층은 이미 완성됐어요. 새 활성 층을 불러왔어요.";
      case "idempotency-conflict":
        return "같은 요청 키가 다른 기여에 사용되어 반영하지 않았어요.";
      default:
        return error.message || "공동 미션 기여를 확인하지 못했어요.";
    }
  }
  return error instanceof Error
    ? error.message
    : "공동 미션 상태를 확인하지 못했어요.";
}

function neutralInputFrame(): InputFrame {
  return {
    moveX: 0,
    moveForward: 0,
    lookX: 0,
    lookY: 0,
    jump: false,
    place: false,
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
    return "공동 월드 요청에 실패해 서버 상태를 다시 불러왔어요";
  }
  switch (error.code) {
    case "duplicate-coordinate":
    case "23505":
      return "다른 플레이어가 먼저 그 자리를 사용했어요";
    case "insufficient-inventory":
    case "inventory-full":
      return "서버 재고 상태가 달라 다시 맞췄어요";
    case "owner-only":
    case "protected-zone":
    case "42501":
      return "서버에서 이 구역의 변경을 허용하지 않았어요";
    case "support-in-use":
    case "invalid-support":
      return "지지 관계가 바뀌어 변경하지 못했어요";
    case "too-early":
      return "서버 기준 작업 시간이 아직 부족해요";
    default:
      return error.retryable
        ? "연결이 불안정해 서버 상태를 다시 확인했어요"
        : "서버가 변경을 거절해 최신 상태로 되돌렸어요";
  }
}

function yawToward(direction: GridPosition): number {
  return Math.atan2(-direction.x, -direction.z);
}

function removalHint(decision: PermissionDecision): string {
  if (decision.requiresHold) {
    return "2.5초 길게 눌러 해체";
  }
  if (decision.allowed) {
    return "바로 회수 가능";
  }
  return removalFailureMessage(decision);
}

function removalFailureMessage(decision: PermissionDecision): string {
  switch (decision.reason) {
    case "support-in-use":
      return "위 블록이 지지받고 있어 제거할 수 없어요";
    case "owner-only":
      return "소유자만 수정할 수 있는 영역이에요";
    case "protected-zone":
      return "보호된 시스템 블록이에요";
    case "hold-required":
      return "2.5초 길게 눌러 해체하세요";
    case "allowed":
      return "제거할 수 있어요";
  }
}

function guidePlacementToast(guide: GuideCell): string {
  const label =
    guide.group === "base"
      ? "거점"
      : guide.group === "producer"
        ? "생산시설"
        : "시설 확장";
  return label + " 가이드 " + String(guide.order) + "칸을 채웠어요";
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
  const names = ["동력 충전", "재료 압축", "블록 안정화"];
  const name = names[step - 1] ?? "생산 작업";
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  return [
    String(step) + "/" + String(stepCount),
    name,
    seconds > 0 ? String(seconds) + "초 유지" : "다음 단계 누르기",
  ].join(" · ");
}

