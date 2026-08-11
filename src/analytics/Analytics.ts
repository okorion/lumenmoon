import type {
  Analytics,
  AnalyticsEnvironment,
  AnalyticsEvent,
  AnalyticsEventName,
  AnalyticsEventPropertyMap,
} from "./types";
import {
  createValidatedEvent,
  MAX_ANALYTICS_EVENTS_PER_SESSION,
} from "./validation";

export type AnalyticsDiagnosticLogger = (code: string) => void;

export class NoopAnalytics implements Analytics {
  isEnabled(): boolean {
    return false;
  }

  capture<N extends AnalyticsEventName>(
    name: N,
    properties: AnalyticsEventPropertyMap[N],
  ): boolean {
    void name;
    void properties;
    return false;
  }
}

export abstract class GuardedAnalytics implements Analytics {
  private eventCount = 0;
  private readonly summarySequences = new Set<number>();

  protected constructor(
    private readonly environment: AnalyticsEnvironment,
    private readonly logger?: AnalyticsDiagnosticLogger,
  ) {}

  abstract isEnabled(): boolean;

  capture<N extends AnalyticsEventName>(
    name: N,
    properties: AnalyticsEventPropertyMap[N],
  ): boolean {
    if (!this.isEnabled() || this.eventCount >= MAX_ANALYTICS_EVENTS_PER_SESSION) {
      return false;
    }
    const event = createValidatedEvent(name, properties, this.environment);
    if (!event) {
      this.diagnose("analytics_event_rejected");
      return false;
    }
    const sequence =
      name === "game_session_summary"
        ? (event.properties as AnalyticsEventPropertyMap["game_session_summary"])
            .summary_sequence
        : null;
    if (sequence !== null && this.summarySequences.has(sequence)) {
      return false;
    }

    try {
      if (!this.deliver(event)) {
        return false;
      }
      this.eventCount += 1;
      if (sequence !== null) {
        this.summarySequences.add(sequence);
      }
      return true;
    } catch {
      this.diagnose("analytics_delivery_failed");
      return false;
    }
  }

  getAcceptedEventCount(): number {
    return this.eventCount;
  }

  protected abstract deliver(event: AnalyticsEvent): boolean;

  protected diagnose(code: string): void {
    try {
      this.logger?.(code);
    } catch {
      // Diagnostics must never escape into the game loop.
    }
  }
}

export class MemoryAnalytics extends GuardedAnalytics {
  readonly events: AnalyticsEvent[] = [];
  private enabled = true;

  constructor(environment: AnalyticsEnvironment = "test") {
    super(environment);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  protected deliver(event: AnalyticsEvent): boolean {
    this.events.push(structuredClone(event));
    return true;
  }
}
