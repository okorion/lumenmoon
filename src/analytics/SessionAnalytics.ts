import type { AnalyticsMilestoneStore } from "./MilestoneStore";
import type {
  Analytics,
  AnalyticsFailureCode,
  AnalyticsFailureStage,
  AnalyticsMilestone,
  AverageFpsBucket,
  CreatorCountBucket,
  DeviceClass,
  GameSessionStartedProperties,
  GameSessionSummaryProperties,
  SessionCounter,
  SessionZone,
} from "./types";

const DEFAULT_INACTIVITY_MS = 60_000;
export const ANALYTICS_CHECKPOINT_MS = 5 * 60_000;

export interface AnalyticsClock {
  now(): number;
}

export type SessionStartContext = Omit<
  GameSessionStartedProperties,
  "first_visit" | "device_class"
>;

export interface SessionAnalyticsConfig {
  analytics: Analytics;
  milestoneStore: AnalyticsMilestoneStore;
  deviceClass: DeviceClass;
  clock?: AnalyticsClock;
  inactivityMs?: number;
  initialVisible?: boolean;
}

export interface IntervalScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

type CounterState = Record<SessionCounter, number>;

interface PendingSummary {
  activeMs: number;
  wallMs: number;
  zoneMs: Record<Exclude<SessionZone, "none">, number>;
  counters: CounterState;
  fpsTotal: number;
  fpsSamples: number;
}

export class SessionAnalytics {
  private readonly clock: AnalyticsClock;
  private readonly inactivityMs: number;
  private pending = createPendingSummary();
  private started = false;
  private starting = false;
  private finalized = false;
  private paused = false;
  private visible: boolean;
  private currentZone: SessionZone = "none";
  private lastTickAt = 0;
  private lastInputAt = 0;
  private summarySequence = 0;
  private distinctOtherCreatorsSeen = 0;
  private readonly requestedMilestones = new Set<AnalyticsMilestone>();
  private timer: { scheduler: IntervalScheduler; handle: unknown } | null = null;

  constructor(private readonly config: SessionAnalyticsConfig) {
    this.clock = config.clock ?? { now: () => Date.now() };
    this.inactivityMs = config.inactivityMs ?? DEFAULT_INACTIVITY_MS;
    this.visible = config.initialVisible ?? true;
  }

  isStarted(): boolean {
    return this.started;
  }

  async start(context: SessionStartContext, now = this.clock.now()): Promise<boolean> {
    if (
      this.started ||
      this.starting ||
      this.finalized ||
      !this.config.analytics.isEnabled()
    ) {
      return false;
    }
    this.starting = true;
    try {
      const firstSession = await this.config.milestoneStore.ensureFirstSession(now);
      const accepted = this.config.analytics.capture("game_session_started", {
        ...context,
        first_visit: firstSession.firstVisit,
        device_class: this.config.deviceClass,
      });
      if (!accepted) {
        return false;
      }
      this.started = true;
      this.lastTickAt = now;
      this.lastInputAt = now;
      return true;
    } catch {
      return false;
    } finally {
      this.starting = false;
    }
  }

  markInput(now = this.clock.now()): void {
    if (!this.started || this.finalized || this.paused) {
      return;
    }
    this.tick(now);
    this.lastInputAt = now;
  }

  setVisibility(visible: boolean, now = this.clock.now()): void {
    if (!this.started || this.finalized || this.visible === visible) {
      return;
    }
    if (this.paused) {
      this.visible = visible;
      this.lastTickAt = now;
      return;
    }
    this.tick(now);
    this.visible = visible;
  }

  setZone(zone: SessionZone, now = this.clock.now()): void {
    if (!this.started || this.finalized || this.currentZone === zone) {
      return;
    }
    if (this.paused) {
      this.currentZone = zone;
      this.lastTickAt = now;
      return;
    }
    this.tick(now);
    this.currentZone = zone;
  }

  tick(now = this.clock.now(), framesPerSecond?: number): void {
    if (!this.started || this.finalized || now <= this.lastTickAt) {
      return;
    }
    if (this.paused) {
      this.lastTickAt = now;
      return;
    }
    const start = this.lastTickAt;
    const end = now;
    this.pending.wallMs += end - start;
    if (this.visible) {
      const activeEnd = Math.min(end, this.lastInputAt + this.inactivityMs);
      const activeMs = Math.max(0, activeEnd - start);
      this.pending.activeMs += activeMs;
      if (this.currentZone !== "none") {
        this.pending.zoneMs[this.currentZone] += activeMs;
      }
    }
    if (
      framesPerSecond !== undefined &&
      Number.isFinite(framesPerSecond) &&
      framesPerSecond >= 0 &&
      framesPerSecond <= 1_000
    ) {
      this.pending.fpsTotal += framesPerSecond;
      this.pending.fpsSamples += 1;
    }
    this.lastTickAt = now;
  }

  increment(counter: SessionCounter, amount = 1): void {
    if (
      !this.started ||
      this.finalized ||
      this.paused ||
      !Number.isSafeInteger(amount) ||
      amount <= 0
    ) {
      return;
    }
    this.pending.counters[counter] += amount;
  }

  setDistinctOtherCreatorsSeen(count: number): void {
    if (
      this.started &&
      !this.finalized &&
      !this.paused &&
      Number.isSafeInteger(count) &&
      count >= 0
    ) {
      this.distinctOtherCreatorsSeen = Math.max(
        this.distinctOtherCreatorsSeen,
        count,
      );
    }
  }

  async reachMilestone(
    milestone: AnalyticsMilestone,
    now = this.clock.now(),
  ): Promise<boolean> {
    if (
      !this.started ||
      this.finalized ||
      this.paused ||
      this.requestedMilestones.has(milestone) ||
      !this.config.analytics.isEnabled()
    ) {
      return false;
    }
    this.requestedMilestones.add(milestone);
    try {
      const mark = await this.config.milestoneStore.markMilestone(milestone, now);
      if (!mark.firstReached) {
        return false;
      }
      return this.config.analytics.capture("player_milestone_reached", {
        milestone,
        time_from_first_session_seconds: Math.max(
          0,
          Math.floor((now - mark.firstSessionAt) / 1_000),
        ),
        device_class: this.config.deviceClass,
      });
    } catch {
      return false;
    }
  }

  failure(
    code: AnalyticsFailureCode,
    stage: AnalyticsFailureStage,
    recoverable: boolean,
    retrySucceeded: boolean,
  ): boolean {
    if (this.finalized || this.paused || !this.config.analytics.isEnabled()) {
      return false;
    }
    return this.config.analytics.capture("game_failure", {
      code,
      stage,
      recoverable,
      retry_succeeded: retrySucceeded,
      device_class: this.config.deviceClass,
    });
  }

  checkpoint(finalSummary = false, now = this.clock.now()): boolean {
    if (!this.started || this.finalized || this.paused) {
      return false;
    }
    this.tick(now);
    const nextSequence = this.summarySequence + 1;
    const accepted = this.config.analytics.capture("game_session_summary", {
      ...this.toSummaryProperties(),
      summary_sequence: nextSequence,
      final_summary: finalSummary,
    });
    if (accepted) {
      this.summarySequence = nextSequence;
      this.consumeReportedDelta();
    }
    if (finalSummary) {
      this.finalized = true;
      this.stopCheckpointing();
    }
    return accepted;
  }

  pagehide(now = this.clock.now()): boolean {
    return this.checkpoint(true, now);
  }

  withdraw(now = this.clock.now()): boolean {
    return this.checkpoint(true, now);
  }

  pause(now = this.clock.now()): void {
    if (!this.started || this.finalized || this.paused) {
      return;
    }
    this.tick(now);
    this.pending = createPendingSummary();
    this.distinctOtherCreatorsSeen = 0;
    this.paused = true;
    this.lastTickAt = now;
    this.stopCheckpointing();
  }

  resume(now = this.clock.now()): void {
    if (!this.started || this.finalized || !this.paused) {
      return;
    }
    this.paused = false;
    this.lastTickAt = now;
    this.lastInputAt = now;
  }

  startCheckpointing(scheduler: IntervalScheduler): void {
    if (this.timer || this.finalized) {
      return;
    }
    const handle = scheduler.setInterval(() => {
      this.checkpoint(false);
    }, ANALYTICS_CHECKPOINT_MS);
    this.timer = { scheduler, handle };
  }

  stopCheckpointing(): void {
    if (!this.timer) {
      return;
    }
    this.timer.scheduler.clearInterval(this.timer.handle);
    this.timer = null;
  }

  private toSummaryProperties(): Omit<
    GameSessionSummaryProperties,
    "summary_sequence" | "final_summary"
  > {
    return {
      active_seconds: Math.floor(this.pending.activeMs / 1_000),
      wall_seconds: Math.floor(this.pending.wallMs / 1_000),
      personal_zone_seconds: Math.floor(this.pending.zoneMs.personal / 1_000),
      producer_zone_seconds: Math.floor(this.pending.zoneMs.producer / 1_000),
      mission_zone_seconds: Math.floor(this.pending.zoneMs.mission / 1_000),
      public_zone_seconds: Math.floor(this.pending.zoneMs.public / 1_000),
      archive_seconds: Math.floor(this.pending.zoneMs.archive / 1_000),
      ...this.pending.counters,
      distinct_other_creators_seen_bucket: creatorCountBucket(
        this.distinctOtherCreatorsSeen,
      ),
      average_fps_bucket: averageFpsBucket(
        this.pending.fpsTotal,
        this.pending.fpsSamples,
      ),
    };
  }

  private consumeReportedDelta(): void {
    this.pending.activeMs %= 1_000;
    this.pending.wallMs %= 1_000;
    for (const zone of [
      "personal",
      "producer",
      "mission",
      "public",
      "archive",
    ] as const) {
      this.pending.zoneMs[zone] %= 1_000;
    }
    this.pending.counters = createCounters();
    this.distinctOtherCreatorsSeen = 0;
    this.pending.fpsTotal = 0;
    this.pending.fpsSamples = 0;
  }
}

export function creatorCountBucket(count: number): CreatorCountBucket {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 4) return "2_to_4";
  if (count <= 9) return "5_to_9";
  return "10_plus";
}

export function averageFpsBucket(
  total: number,
  samples: number,
): AverageFpsBucket {
  if (samples <= 0) return "unknown";
  const average = total / samples;
  if (average < 20) return "under_20";
  if (average < 40) return "20_to_39";
  if (average < 55) return "40_to_54";
  return "55_plus";
}

function createPendingSummary(): PendingSummary {
  return {
    activeMs: 0,
    wallMs: 0,
    zoneMs: {
      personal: 0,
      producer: 0,
      mission: 0,
      public: 0,
      archive: 0,
    },
    counters: createCounters(),
    fpsTotal: 0,
    fpsSamples: 0,
  };
}

function createCounters(): CounterState {
  return {
    personal_blocks_placed: 0,
    public_blocks_placed: 0,
    mission_blocks_placed: 0,
    own_blocks_removed: 0,
    foreign_blocks_removed: 0,
    manual_production_count: 0,
    creator_card_view_count: 0,
    creator_highlight_count: 0,
    archive_open_count: 0,
    mission_contribution_count: 0,
    insufficient_inventory_count: 0,
    commit_failure_count: 0,
    context_loss_count: 0,
  };
}
