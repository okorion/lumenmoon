export type AnalyticsConsentChoice =
  | "undecided"
  | "allowed"
  | "essential_only";

export type AnalyticsEnvironment =
  | "production"
  | "staging"
  | "development"
  | "test";

export type DeviceClass = "mobile" | "desktop" | "tablet";
export type InputMode = "touch" | "keyboard_mouse";
export type Orientation = "portrait" | "landscape";
export type Acquisition =
  | "direct"
  | "search"
  | "social"
  | "referral"
  | "unknown";
export type ProgressStage =
  | "new_player"
  | "base_in_progress"
  | "base_completed"
  | "producer_completed"
  | "mission_contributor";
export type WorldReadyBucket = "under_1s" | "1s_to_3s" | "3s_to_10s" | "over_10s";
export type RendererTierBucket = "low" | "medium" | "high" | "unknown";
export type AverageFpsBucket =
  | "under_20"
  | "20_to_39"
  | "40_to_54"
  | "55_plus"
  | "unknown";
export type CreatorCountBucket = "0" | "1" | "2_to_4" | "5_to_9" | "10_plus";

export const ANALYTICS_MILESTONES = [
  "first_move",
  "first_block",
  "base_completed",
  "producer_completed",
  "first_manual_production",
  "first_other_creator_seen",
  "first_creator_highlight",
  "first_mission_contribution",
] as const;

export type AnalyticsMilestone = (typeof ANALYTICS_MILESTONES)[number];

export const ANALYTICS_FAILURE_CODES = [
  "webgl_unsupported",
  "webgl_context_lost",
  "repository_bootstrap_failed",
  "world_sync_failed",
  "commit_rejected",
  "commit_network_failed",
  "production_failed",
  "mission_contribution_failed",
  "storage_failed",
] as const;

export type AnalyticsFailureCode = (typeof ANALYTICS_FAILURE_CODES)[number];
export type AnalyticsFailureStage =
  | "boot"
  | "renderer"
  | "world_read"
  | "world_write"
  | "production"
  | "mission";

export interface GameSessionStartedProperties {
  first_visit: boolean;
  progress_stage: ProgressStage;
  device_class: DeviceClass;
  input_mode: InputMode;
  orientation: Orientation;
  app_version: string;
  acquisition: Acquisition;
  world_ready_ms_bucket: WorldReadyBucket;
  renderer_tier_bucket: RendererTierBucket;
}

export interface PlayerMilestoneReachedProperties {
  milestone: AnalyticsMilestone;
  time_from_first_session_seconds: number;
  device_class: DeviceClass;
}

export interface GameSessionSummaryProperties {
  active_seconds: number;
  wall_seconds: number;
  personal_zone_seconds: number;
  producer_zone_seconds: number;
  mission_zone_seconds: number;
  public_zone_seconds: number;
  archive_seconds: number;
  personal_blocks_placed: number;
  public_blocks_placed: number;
  mission_blocks_placed: number;
  own_blocks_removed: number;
  foreign_blocks_removed: number;
  manual_production_count: number;
  creator_card_view_count: number;
  distinct_other_creators_seen_bucket: CreatorCountBucket;
  creator_highlight_count: number;
  archive_open_count: number;
  mission_contribution_count: number;
  insufficient_inventory_count: number;
  commit_failure_count: number;
  context_loss_count: number;
  average_fps_bucket: AverageFpsBucket;
  summary_sequence: number;
  final_summary: boolean;
}

export interface GameFailureProperties {
  code: AnalyticsFailureCode;
  stage: AnalyticsFailureStage;
  recoverable: boolean;
  retry_succeeded: boolean;
  device_class: DeviceClass;
}

export interface AnalyticsEventPropertyMap {
  game_session_started: GameSessionStartedProperties;
  player_milestone_reached: PlayerMilestoneReachedProperties;
  game_session_summary: GameSessionSummaryProperties;
  game_failure: GameFailureProperties;
}

export type AnalyticsEventName = keyof AnalyticsEventPropertyMap;

export const ANALYTICS_EVENT_NAMES = [
  "game_session_started",
  "player_milestone_reached",
  "game_session_summary",
  "game_failure",
] as const satisfies readonly AnalyticsEventName[];

export interface AnalyticsEvent<N extends AnalyticsEventName = AnalyticsEventName> {
  name: N;
  properties: AnalyticsEventPropertyMap[N] & {
    environment: AnalyticsEnvironment;
  };
}

export interface Analytics {
  isEnabled(): boolean;
  capture<N extends AnalyticsEventName>(
    name: N,
    properties: AnalyticsEventPropertyMap[N],
  ): boolean;
}

export type SessionZone =
  | "personal"
  | "producer"
  | "mission"
  | "public"
  | "archive"
  | "none";

export type SessionCounter =
  | "personal_blocks_placed"
  | "public_blocks_placed"
  | "mission_blocks_placed"
  | "own_blocks_removed"
  | "foreign_blocks_removed"
  | "manual_production_count"
  | "creator_card_view_count"
  | "creator_highlight_count"
  | "archive_open_count"
  | "mission_contribution_count"
  | "insufficient_inventory_count"
  | "commit_failure_count"
  | "context_loss_count";
