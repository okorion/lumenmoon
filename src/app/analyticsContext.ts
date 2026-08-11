import type { LocalPlayerProgress } from "../domain/progression";
import type { StarterBayZoneMatch } from "../domain/starterBay";
import type {
  Acquisition,
  DeviceClass,
  InputMode,
  Orientation,
  ProgressStage,
  RendererTierBucket,
  SessionZone,
  WorldReadyBucket,
} from "../analytics";

export interface AnalyticsDeviceContext {
  viewportWidth: number;
  viewportHeight: number;
  touchPoints: number;
}

export function classifyAnalyticsDevice(
  input: AnalyticsDeviceContext,
): DeviceClass {
  if (input.touchPoints <= 0) {
    return "desktop";
  }
  return Math.min(input.viewportWidth, input.viewportHeight) >= 600
    ? "tablet"
    : "mobile";
}

export function classifyInputMode(touchPoints: number): InputMode {
  return touchPoints > 0 ? "touch" : "keyboard_mouse";
}

export function classifyOrientation(
  width: number,
  height: number,
): Orientation {
  return height >= width ? "portrait" : "landscape";
}

export function classifyAcquisition(referrer: string): Acquisition {
  if (!referrer) {
    return "direct";
  }
  let hostname: string;
  try {
    hostname = new URL(referrer).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (
    hostname === "google.com" ||
    hostname.endsWith(".google.com") ||
    hostname === "bing.com" ||
    hostname.endsWith(".bing.com") ||
    hostname === "naver.com" ||
    hostname.endsWith(".naver.com") ||
    hostname === "daum.net" ||
    hostname.endsWith(".daum.net") ||
    hostname === "duckduckgo.com" ||
    hostname.endsWith(".duckduckgo.com")
  ) {
    return "search";
  }
  if (
    hostname === "x.com" ||
    hostname === "twitter.com" ||
    hostname === "facebook.com" ||
    hostname.endsWith(".facebook.com") ||
    hostname === "instagram.com" ||
    hostname.endsWith(".instagram.com") ||
    hostname === "reddit.com" ||
    hostname.endsWith(".reddit.com") ||
    hostname === "linkedin.com" ||
    hostname.endsWith(".linkedin.com")
  ) {
    return "social";
  }
  return "referral";
}

export function bucketWorldReadyMs(milliseconds: number): WorldReadyBucket {
  if (milliseconds < 1_000) return "under_1s";
  if (milliseconds < 3_000) return "1s_to_3s";
  if (milliseconds < 10_000) return "3s_to_10s";
  return "over_10s";
}

export function bucketRendererTier(
  hardwareConcurrency?: number,
): RendererTierBucket {
  if (!hardwareConcurrency || hardwareConcurrency < 1) return "unknown";
  if (hardwareConcurrency <= 4) return "low";
  if (hardwareConcurrency <= 8) return "medium";
  return "high";
}

export function progressStage(
  progress: LocalPlayerProgress,
  hasMissionContribution = false,
): ProgressStage {
  if (hasMissionContribution) return "mission_contributor";
  if (progress.producerCompleted) return "producer_completed";
  if (progress.baseCompleted) return "base_completed";
  return progress.inventory < 24 ? "base_in_progress" : "new_player";
}

export function coarseAnalyticsZone(
  zone: StarterBayZoneMatch["zone"],
  archiveOpen: boolean,
): Exclude<SessionZone, "none"> {
  if (archiveOpen) return "archive";
  if (zone === "personal" || zone === "producer" || zone === "mission") {
    return zone;
  }
  return "public";
}
