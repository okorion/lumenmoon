import { ANALYTICS_CONSENT_STORAGE_KEY } from "../analytics/storageKeys";
import type {
  AnalyticsConsentChoice,
  AnalyticsFailureCode,
  AnalyticsFailureStage,
  AnalyticsMilestone,
  SessionCounter,
} from "../analytics/types";
import type {
  GameAnalytics,
  GameAnalyticsStartContext,
  GameAnalyticsTick,
} from "./GameAnalytics";

type AnalyticsLoader = () => Promise<GameAnalytics>;
type IdleScheduler = (callback: () => void) => void;

export interface DeferredGameAnalyticsOptions {
  storage?: Storage;
  loader?: AnalyticsLoader;
  schedule?: IdleScheduler;
}

interface PendingFailure {
  code: AnalyticsFailureCode;
  stage: AnalyticsFailureStage;
  recoverable: boolean;
  retrySucceeded: boolean;
}

/** Keeps optional analytics outside the first render without losing consent order. */
export class DeferredGameAnalytics {
  private activeDelegate: GameAnalytics | null = null;
  private loadedDelegate: GameAnalytics | null = null;
  private loadPromise: Promise<GameAnalytics> | null = null;
  private transitionQueue: Promise<void> = Promise.resolve();
  private appliedChoice: AnalyticsConsentChoice | null = null;
  private choice: AnalyticsConsentChoice;
  private consentGeneration = 0;
  private startContext: GameAnalyticsStartContext | null = null;
  private latestTick: GameAnalyticsTick | null = null;
  private latestInputAt: number | null = null;
  private finalCheckpointPending = false;
  private readonly counters = new Map<SessionCounter, number>();
  private readonly milestones = new Set<AnalyticsMilestone>();
  private readonly otherCreators = new Set<string>();
  private readonly failures: PendingFailure[] = [];
  private creatorDetailsCount = 0;

  private readonly storage: Storage | undefined;
  private readonly loader: AnalyticsLoader;
  private readonly schedule: IdleScheduler;

  private constructor(options: DeferredGameAnalyticsOptions = {}) {
    this.storage = options.storage ?? safeLocalStorage();
    this.loader = options.loader ?? loadGameAnalytics;
    this.schedule = options.schedule ?? scheduleWhenIdle;
    this.choice = readConsent(this.storage);
    if (this.choice === "allowed") {
      const generation = this.consentGeneration;
      this.schedule(() => void this.queueTransition(generation));
    }
  }

  static create(options: DeferredGameAnalyticsOptions = {}): DeferredGameAnalytics {
    return new DeferredGameAnalytics(options);
  }

  get consentChoice(): AnalyticsConsentChoice {
    return this.choice;
  }

  setConsent(choice: AnalyticsConsentChoice): Promise<void> {
    const generation = ++this.consentGeneration;
    this.choice = choice;
    writeConsent(this.storage, choice);
    if (choice !== "allowed") {
      this.activeDelegate = null;
      this.clearPendingEvents();
      this.appliedChoice = null;
      const cancellation = this.loadedDelegate
        ? this.loadedDelegate.setConsent(choice).catch(() => undefined)
        : Promise.resolve();
      const queued = this.queueTransition(generation);
      return Promise.all([cancellation, queued]).then(() => undefined);
    }
    return this.queueTransition(generation);
  }

  worldControllable(context: GameAnalyticsStartContext): void {
    this.startContext = context;
    if (this.activeDelegate) {
      this.activeDelegate.worldControllable(context);
    } else if (this.choice === "allowed") {
      void this.queueTransition(this.consentGeneration);
    }
  }

  markInput(now = Date.now()): void {
    if (this.choice !== "allowed") return;
    if (this.activeDelegate) this.activeDelegate.markInput(now);
    else this.latestInputAt = now;
  }

  tick(input: GameAnalyticsTick): void {
    if (this.choice !== "allowed") return;
    if (this.activeDelegate) this.activeDelegate.tick(input);
    else this.latestTick = input;
  }

  increment(counter: SessionCounter, amount = 1): void {
    if (this.choice !== "allowed") return;
    if (this.activeDelegate) this.activeDelegate.increment(counter, amount);
    else this.counters.set(counter, (this.counters.get(counter) ?? 0) + amount);
  }

  otherCreatorSeen(publicId: string): void {
    if (this.choice !== "allowed" || !publicId) return;
    if (this.activeDelegate) this.activeDelegate.otherCreatorSeen(publicId);
    else if (this.otherCreators.size < 32) this.otherCreators.add(publicId);
  }

  creatorDetailsOpened(): void {
    if (this.choice !== "allowed") return;
    if (this.activeDelegate) this.activeDelegate.creatorDetailsOpened();
    else this.creatorDetailsCount = Math.min(16, this.creatorDetailsCount + 1);
  }

  milestone(milestone: AnalyticsMilestone): void {
    if (this.choice !== "allowed") return;
    if (this.activeDelegate) this.activeDelegate.milestone(milestone);
    else this.milestones.add(milestone);
  }

  failure(
    code: AnalyticsFailureCode,
    stage: AnalyticsFailureStage,
    recoverable: boolean,
    retrySucceeded = false,
  ): void {
    if (this.choice !== "allowed") return;
    if (this.activeDelegate) {
      this.activeDelegate.failure(code, stage, recoverable, retrySucceeded);
    } else if (this.failures.length < 4) {
      this.failures.push({ code, stage, recoverable, retrySucceeded });
    }
  }

  checkpoint(finalSummary = false): void {
    if (this.choice !== "allowed") return;
    if (this.activeDelegate) this.activeDelegate.checkpoint(finalSummary);
    else if (finalSummary) this.finalCheckpointPending = true;
  }

  private queueTransition(generation: number): Promise<void> {
    const run = this.transitionQueue.then(() => this.applyTransition(generation));
    this.transitionQueue = run.catch(() => undefined);
    return run.catch(() => undefined);
  }

  private async applyTransition(generation: number): Promise<void> {
    if (generation !== this.consentGeneration) return;
    const choice = this.choice;
    if (choice === "allowed" && this.activeDelegate) return;
    const delegate =
      choice === "allowed" ? await this.loadDelegate() : this.loadedDelegate;
    if (!delegate || generation !== this.consentGeneration) return;

    if (this.appliedChoice !== choice) {
      await delegate.setConsent(choice);
      if (generation !== this.consentGeneration) return;
      this.appliedChoice = choice;
    }
    if (choice !== "allowed" || !this.startContext) return;

    await delegate.prepareForReplay(this.startContext);
    if (generation !== this.consentGeneration || this.choice !== "allowed") return;
    this.activeDelegate = delegate;
    this.replayPending(delegate);
  }

  private loadDelegate(): Promise<GameAnalytics> {
    if (this.loadedDelegate) return Promise.resolve(this.loadedDelegate);
    this.loadPromise ??= this.loader()
      .then((delegate) => {
        this.loadedDelegate = delegate;
        return delegate;
      })
      .finally(() => {
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  private replayPending(delegate: GameAnalytics): void {
    if (this.latestInputAt !== null) delegate.markInput(this.latestInputAt);
    if (this.latestTick) delegate.tick(this.latestTick);
    for (const [counter, amount] of this.counters) delegate.increment(counter, amount);
    for (const milestone of this.milestones) delegate.milestone(milestone);
    for (const publicId of this.otherCreators) delegate.otherCreatorSeen(publicId);
    for (let index = 0; index < this.creatorDetailsCount; index += 1) {
      delegate.creatorDetailsOpened();
    }
    for (const failure of this.failures) {
      delegate.failure(
        failure.code,
        failure.stage,
        failure.recoverable,
        failure.retrySucceeded,
      );
    }
    if (this.finalCheckpointPending) delegate.checkpoint(true);
    this.clearPendingEvents();
  }

  private clearPendingEvents(): void {
    this.latestTick = null;
    this.latestInputAt = null;
    this.finalCheckpointPending = false;
    this.counters.clear();
    this.milestones.clear();
    this.otherCreators.clear();
    this.failures.length = 0;
    this.creatorDetailsCount = 0;
  }
}

async function loadGameAnalytics(): Promise<GameAnalytics> {
  const { GameAnalytics } = await import("./GameAnalytics");
  return GameAnalytics.create();
}

function scheduleWhenIdle(callback: () => void): void {
  if (typeof window === "undefined") queueMicrotask(callback);
  else if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(callback, { timeout: 2_000 });
  } else window.setTimeout(callback, 0);
}

function readConsent(storage: Storage | undefined): AnalyticsConsentChoice {
  try {
    const value = storage?.getItem(ANALYTICS_CONSENT_STORAGE_KEY);
    return value === "allowed" || value === "essential_only"
      ? value
      : "undecided";
  } catch {
    return "undecided";
  }
}

function writeConsent(
  storage: Storage | undefined,
  choice: AnalyticsConsentChoice,
): void {
  try {
    storage?.setItem(ANALYTICS_CONSENT_STORAGE_KEY, choice);
  } catch {
    // Optional analytics storage must never affect the game.
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
