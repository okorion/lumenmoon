import {
  ANALYTICS_FAILURE_CODES,
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_MILESTONES,
  type AnalyticsEnvironment,
  type AnalyticsEvent,
  type AnalyticsEventName,
  type AnalyticsEventPropertyMap,
} from "./types";

export const MAX_ANALYTICS_PAYLOAD_BYTES = 4 * 1_024;
export const MAX_ANALYTICS_EVENTS_PER_SESSION = 20;

const EVENT_NAMES = new Set<AnalyticsEventName>(ANALYTICS_EVENT_NAMES);

const DEVICE_CLASSES = new Set(["mobile", "desktop", "tablet"]);
const INPUT_MODES = new Set(["touch", "keyboard_mouse"]);
const ORIENTATIONS = new Set(["portrait", "landscape"]);
const ACQUISITIONS = new Set([
  "direct",
  "search",
  "social",
  "referral",
  "unknown",
]);
const PROGRESS_STAGES = new Set([
  "new_player",
  "base_in_progress",
  "base_completed",
  "producer_completed",
  "mission_contributor",
]);
const WORLD_READY_BUCKETS = new Set([
  "under_1s",
  "1s_to_3s",
  "3s_to_10s",
  "over_10s",
]);
const RENDERER_TIERS = new Set(["low", "medium", "high", "unknown"]);
const FPS_BUCKETS = new Set([
  "under_20",
  "20_to_39",
  "40_to_54",
  "55_plus",
  "unknown",
]);
const CREATOR_BUCKETS = new Set(["0", "1", "2_to_4", "5_to_9", "10_plus"]);
const FAILURE_STAGES = new Set([
  "boot",
  "renderer",
  "world_read",
  "world_write",
  "production",
  "mission",
]);
const ENVIRONMENTS = new Set<AnalyticsEnvironment>([
  "production",
  "staging",
  "development",
  "test",
]);

const STARTED_KEYS = [
  "first_visit",
  "progress_stage",
  "device_class",
  "input_mode",
  "orientation",
  "app_version",
  "acquisition",
  "world_ready_ms_bucket",
  "renderer_tier_bucket",
] as const;
const MILESTONE_KEYS = [
  "milestone",
  "time_from_first_session_seconds",
  "device_class",
] as const;
const SUMMARY_KEYS = [
  "active_seconds",
  "wall_seconds",
  "personal_zone_seconds",
  "producer_zone_seconds",
  "mission_zone_seconds",
  "public_zone_seconds",
  "archive_seconds",
  "personal_blocks_placed",
  "public_blocks_placed",
  "mission_blocks_placed",
  "own_blocks_removed",
  "foreign_blocks_removed",
  "manual_production_count",
  "creator_card_view_count",
  "distinct_other_creators_seen_bucket",
  "creator_highlight_count",
  "archive_open_count",
  "mission_contribution_count",
  "insufficient_inventory_count",
  "commit_failure_count",
  "context_loss_count",
  "average_fps_bucket",
  "summary_sequence",
  "final_summary",
] as const;
const FAILURE_KEYS = [
  "code",
  "stage",
  "recoverable",
  "retry_succeeded",
  "device_class",
] as const;

export const ANALYTICS_PROPERTY_KEYS: Readonly<
  Record<AnalyticsEventName, readonly string[]>
> = Object.freeze({
  game_session_started: STARTED_KEYS,
  player_milestone_reached: MILESTONE_KEYS,
  game_session_summary: SUMMARY_KEYS,
  game_failure: FAILURE_KEYS,
});

type UnknownRecord = Record<string, unknown>;

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === "string" && EVENT_NAMES.has(value as AnalyticsEventName);
}

export function validateAnalyticsProperties<N extends AnalyticsEventName>(
  name: N,
  value: unknown,
): AnalyticsEventPropertyMap[N] | null {
  if (!isRecord(value)) {
    return null;
  }

  const valid = (() => {
    switch (name) {
      case "game_session_started":
        return (
          hasExactKeys(value, STARTED_KEYS) &&
          typeof value.first_visit === "boolean" &&
          inSet(value.progress_stage, PROGRESS_STAGES) &&
          inSet(value.device_class, DEVICE_CLASSES) &&
          inSet(value.input_mode, INPUT_MODES) &&
          inSet(value.orientation, ORIENTATIONS) &&
          isSafeVersion(value.app_version) &&
          inSet(value.acquisition, ACQUISITIONS) &&
          inSet(value.world_ready_ms_bucket, WORLD_READY_BUCKETS) &&
          inSet(value.renderer_tier_bucket, RENDERER_TIERS)
        );
      case "player_milestone_reached":
        return (
          hasExactKeys(value, MILESTONE_KEYS) &&
          inSet(value.milestone, new Set(ANALYTICS_MILESTONES)) &&
          isNonNegativeInteger(value.time_from_first_session_seconds) &&
          inSet(value.device_class, DEVICE_CLASSES)
        );
      case "game_session_summary":
        return (
          hasExactKeys(value, SUMMARY_KEYS) &&
          SUMMARY_KEYS.filter(
            (key) =>
              key !== "distinct_other_creators_seen_bucket" &&
              key !== "average_fps_bucket" &&
              key !== "final_summary",
          ).every((key) => isNonNegativeInteger(value[key])) &&
          inSet(value.distinct_other_creators_seen_bucket, CREATOR_BUCKETS) &&
          inSet(value.average_fps_bucket, FPS_BUCKETS) &&
          typeof value.final_summary === "boolean" &&
          isNonNegativeInteger(value.summary_sequence) &&
          value.summary_sequence >= 1
        );
      case "game_failure":
        return (
          hasExactKeys(value, FAILURE_KEYS) &&
          inSet(value.code, new Set(ANALYTICS_FAILURE_CODES)) &&
          inSet(value.stage, FAILURE_STAGES) &&
          typeof value.recoverable === "boolean" &&
          typeof value.retry_succeeded === "boolean" &&
          inSet(value.device_class, DEVICE_CLASSES)
        );
    }
  })();

  return valid ? (value as unknown as AnalyticsEventPropertyMap[N]) : null;
}

export function createValidatedEvent<N extends AnalyticsEventName>(
  name: N,
  properties: unknown,
  environment: AnalyticsEnvironment,
): AnalyticsEvent<N> | null {
  if (!ENVIRONMENTS.has(environment)) {
    return null;
  }
  const validated = validateAnalyticsProperties(name, properties);
  if (!validated) {
    return null;
  }
  const event = {
    name,
    properties: { ...validated, environment },
  } as AnalyticsEvent<N>;
  return analyticsPayloadByteLength(event) <= MAX_ANALYTICS_PAYLOAD_BYTES
    ? event
    : null;
}

export function analyticsPayloadByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key))
  );
}

function inSet(value: unknown, allowed: ReadonlySet<unknown>): boolean {
  return allowed.has(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafeVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 40 &&
    /^[0-9A-Za-z._-]+$/u.test(value)
  );
}
