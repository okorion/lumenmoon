import packageMetadata from "../../package.json";
import {
  createBrowserAnalyticsRuntime,
  type AnalyticsConsentController,
  MemoryAnalyticsMilestoneStore,
  SessionAnalytics,
  type AnalyticsConsentChoice,
  type AnalyticsFailureCode,
  type AnalyticsFailureStage,
  type AnalyticsMilestone,
  type AnalyticsMilestoneStore,
  type PostHogClient,
  type SessionCounter,
  type SessionStartContext,
  type SessionZone,
} from "../analytics";
import {
  canUseExternalAnalytics,
  readRuntimeAnalyticsConfig,
  type RuntimeAnalyticsConfig,
} from "../config/analyticsConfig";
import {
  classifyAnalyticsDevice,
  type AnalyticsDeviceContext,
} from "./analyticsContext";

export type GameAnalyticsStartContext = Omit<
  SessionStartContext,
  "app_version"
>;

export interface GameAnalyticsTick {
  now: number;
  visible: boolean;
  zone: SessionZone;
  framesPerSecond?: number;
}

interface PendingFailure {
  code: AnalyticsFailureCode;
  stage: AnalyticsFailureStage;
  recoverable: boolean;
  retrySucceeded: boolean;
}

interface GameAnalyticsBrowserContext {
  config: RuntimeAnalyticsConfig;
  hostname: string;
  webdriver: boolean;
  indexedDb?: IDBFactory;
  localStorage?: Storage;
  device: AnalyticsDeviceContext;
  loader?: () => Promise<PostHogClient>;
}

/**
 * 게임과 제품 분석 사이의 방화벽이다. 모든 메서드는 실패를 삼키며, 게임
 * 저장이나 RPC를 호출하지 않는다. 원시 좌표·ID·오류 객체도 받지 않는다.
 */
export class GameAnalytics {
  private session: SessionAnalytics | null = null;
  private startContext: SessionStartContext | null = null;
  private startPending: Promise<void> | null = null;
  private checkpointHandle: ReturnType<typeof setInterval> | null = null;
  private consentGeneration = 0;
  private readonly intervalCreators = new Set<string>();
  private readonly pendingFailures: PendingFailure[] = [];
  private initializationPromise: Promise<void> = Promise.resolve();

  private constructor(
    private readonly controller: AnalyticsConsentController,
    private readonly milestoneStore: AnalyticsMilestoneStore,
    readonly deviceClass: ReturnType<typeof classifyAnalyticsDevice>,
  ) {}

  static create(runtime = browserRuntime()): GameAnalytics {
    const externalAllowed = canUseExternalAnalytics(runtime.config, {
      hostname: runtime.hostname,
      webdriver: runtime.webdriver,
    });
    const browserAnalytics = createBrowserAnalyticsRuntime({
      enabled: externalAllowed,
      ...(runtime.config.projectKey
        ? { projectKey: runtime.config.projectKey }
        : {}),
      host: runtime.config.host,
      environment: runtime.config.environment,
      loader: runtime.loader ?? loadPostHog,
      ...(runtime.localStorage ? { storage: runtime.localStorage } : {}),
      ...(runtime.indexedDb ? { indexedDb: runtime.indexedDb } : {}),
      runtime: {
        hostname: runtime.hostname,
        test: !externalAllowed,
        e2e: runtime.webdriver,
      },
      developmentDiagnostics: runtime.config.diagnosticLogging,
    });
    const analytics = new GameAnalytics(
      browserAnalytics.analytics,
      browserAnalytics.milestoneStore ?? new MemoryAnalyticsMilestoneStore(),
      classifyAnalyticsDevice(runtime.device),
    );
    // A prior explicit choice may initialize the lazily imported provider, but
    // it never delays rendering or repository bootstrap.
    analytics.initializationPromise = browserAnalytics.analytics
      .applyStoredChoice()
      .then(() => {
        analytics.flushPendingFailures();
        return analytics.maybeStart();
      })
      .catch(() => {
        // Optional analytics initialization must never reject into gameplay.
      });
    return analytics;
  }

  get consentChoice(): AnalyticsConsentChoice {
    return this.controller.choice;
  }

  async setConsent(choice: AnalyticsConsentChoice): Promise<void> {
    const generation = ++this.consentGeneration;
    try {
      if (choice !== "allowed") {
        this.session?.pause();
        this.stopCheckpointing();
        this.intervalCreators.clear();
        this.pendingFailures.length = 0;
        await this.controller.setConsent(choice);
        return;
      }
      const enabled = await this.controller.setConsent(choice);
      if (
        !enabled ||
        generation !== this.consentGeneration ||
        this.controller.choice !== "allowed"
      ) {
        return;
      }
      this.flushPendingFailures();
      this.intervalCreators.clear();
      if (this.session?.isStarted()) {
        this.session.resume();
        this.startCheckpointing();
        return;
      }
      await this.maybeStart();
    } catch {
      // Analytics consent/provider failures must not affect the game.
    }
  }

  worldControllable(context: GameAnalyticsStartContext): void {
    this.startContext = {
      ...context,
      app_version: packageMetadata.version,
    };
    void this.maybeStart();
  }

  async prepareForReplay(context: GameAnalyticsStartContext): Promise<void> {
    this.startContext = {
      ...context,
      app_version: packageMetadata.version,
    };
    await this.initializationPromise;
    await this.maybeStart();
  }

  markInput(now = Date.now()): void {
    try {
      this.session?.markInput(now);
    } catch {
      // No analytics exception may escape into the frame loop.
    }
  }

  tick(input: GameAnalyticsTick): void {
    try {
      const session = this.session;
      if (!session) return;
      session.setVisibility(input.visible, input.now);
      session.setZone(input.zone, input.now);
      session.tick(input.now, input.framesPerSecond);
    } catch {
      // No analytics exception may escape into the frame loop.
    }
  }

  increment(counter: SessionCounter, amount = 1): void {
    try {
      this.session?.increment(counter, amount);
    } catch {
      // Counters are best-effort only.
    }
  }

  otherCreatorSeen(publicId: string): void {
    try {
      if (!this.session || !this.controller.isEnabled() || !publicId) return;
      this.intervalCreators.add(publicId);
      this.session.setDistinctOtherCreatorsSeen(this.intervalCreators.size);
      void this.session.reachMilestone("first_other_creator_seen");
    } catch {
      // The public ID is held only in this volatile set and never transmitted.
    }
  }

  creatorDetailsOpened(): void {
    try {
      this.session?.increment("creator_card_view_count");
    } catch {
      // Explicit detail views are best-effort and never gate creator UI.
    }
  }

  milestone(milestone: AnalyticsMilestone): void {
    try {
      void this.session?.reachMilestone(milestone);
    } catch {
      // Milestones never gate gameplay.
    }
  }

  failure(
    code: AnalyticsFailureCode,
    stage: AnalyticsFailureStage,
    recoverable: boolean,
    retrySucceeded = false,
  ): void {
    try {
      if (this.session?.isStarted()) {
        this.session.failure(code, stage, recoverable, retrySucceeded);
        return;
      }
      const captured = this.controller.capture("game_failure", {
        code,
        stage,
        recoverable,
        retry_succeeded: retrySucceeded,
        device_class: this.deviceClass,
      });
      if (
        !captured &&
        this.controller.choice === "allowed" &&
        !this.controller.isEnabled() &&
        this.pendingFailures.length < 4
      ) {
        this.pendingFailures.push({
          code,
          stage,
          recoverable,
          retrySucceeded,
        });
      }
    } catch {
      // Only enum values cross the analytics boundary; raw errors stay local.
    }
  }

  checkpoint(finalSummary = false): void {
    try {
      const accepted = this.session?.checkpoint(finalSummary) ?? false;
      if (accepted) {
        this.intervalCreators.clear();
      }
      if (finalSummary) {
        this.stopCheckpointing();
      }
    } catch {
      // Checkpoint loss must not affect gameplay.
    }
  }

  private async maybeStart(): Promise<void> {
    if (
      !this.startContext ||
      !this.controller.isEnabled() ||
      this.session?.isStarted() ||
      this.startPending
    ) {
      return this.startPending ?? Promise.resolve();
    }
    this.session = new SessionAnalytics({
      analytics: this.controller,
      milestoneStore: this.milestoneStore,
      deviceClass: this.deviceClass,
    });
    const session = this.session;
    this.startPending = session
      .start(this.startContext)
      .then((started) => {
        if (started && this.session === session) {
          this.startCheckpointing();
        }
      })
      .finally(() => {
        this.startPending = null;
      });
    return this.startPending;
  }

  private flushPendingFailures(): void {
    if (!this.controller.isEnabled()) {
      if (this.controller.choice !== "allowed") {
        this.pendingFailures.length = 0;
      }
      return;
    }
    for (const failure of this.pendingFailures.splice(0)) {
      this.controller.capture("game_failure", {
        code: failure.code,
        stage: failure.stage,
        recoverable: failure.recoverable,
        retry_succeeded: failure.retrySucceeded,
        device_class: this.deviceClass,
      });
    }
  }

  private startCheckpointing(): void {
    if (this.checkpointHandle !== null) return;
    this.checkpointHandle = globalThis.setInterval(
      () => this.checkpoint(false),
      5 * 60_000,
    );
  }

  private stopCheckpointing(): void {
    if (this.checkpointHandle === null) return;
    globalThis.clearInterval(this.checkpointHandle);
    this.checkpointHandle = null;
  }
}

async function loadPostHog(): Promise<PostHogClient> {
  const module = await import("posthog-js");
  return module.default as unknown as PostHogClient;
}

function browserRuntime(): GameAnalyticsBrowserContext {
  const localStorage = safeLocalStorage();
  return {
    config: readRuntimeAnalyticsConfig(import.meta.env),
    hostname: window.location.hostname,
    webdriver: navigator.webdriver === true,
    ...(typeof indexedDB === "undefined" ? {} : { indexedDb: indexedDB }),
    ...(localStorage ? { localStorage } : {}),
    device: {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      touchPoints: navigator.maxTouchPoints,
    },
  };
}

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
