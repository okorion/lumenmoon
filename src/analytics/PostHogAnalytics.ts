import {
  GuardedAnalytics,
  type AnalyticsDiagnosticLogger,
} from "./Analytics";
import type {
  AnalyticsEnvironment,
  AnalyticsEvent,
} from "./types";
import {
  ANALYTICS_PROPERTY_KEYS,
  analyticsPayloadByteLength,
  createValidatedEvent,
  isAnalyticsEventName,
  MAX_ANALYTICS_PAYLOAD_BYTES,
} from "./validation";

export interface PostHogCaptureEvent {
  event?: unknown;
  properties?: unknown;
}

export interface PostHogInitOptions {
  api_host: string;
  autocapture: false;
  capture_pageview: false;
  capture_pageleave: false;
  capture_dead_clicks: false;
  capture_heatmaps: false;
  capture_performance: false;
  capture_exceptions: false;
  disable_session_recording: true;
  person_profiles: "identified_only";
  respect_dnt: true;
  mask_all_text: true;
  mask_all_element_attributes: true;
  advanced_disable_feature_flags: true;
  disable_surveys: true;
  disable_web_experiments: true;
  disable_external_dependency_loading: true;
  save_campaign_params: false;
  save_referrer: false;
  disable_capture_url_hashes: true;
  ip: false;
  advanced_disable_flags: true;
  advanced_disable_toolbar_metrics: true;
  before_send: (event: PostHogCaptureEvent | null) => PostHogCaptureEvent | null;
}

export interface PostHogClient {
  init(projectKey: string, options: PostHogInitOptions): void;
  capture(eventName: string, properties: Record<string, unknown>): void;
  opt_in_capturing?(options: { captureEventName: false }): void;
  opt_out_capturing?(): void;
  reset?(resetDeviceId?: boolean): void;
}

export type PostHogLoader = () => Promise<PostHogClient>;

export interface PostHogRuntimeContext {
  hostname: string;
  test: boolean;
  e2e: boolean;
}

export interface PostHogAnalyticsConfig {
  projectKey: string;
  host: string;
  environment: AnalyticsEnvironment;
  loader: PostHogLoader;
  runtime?: Partial<PostHogRuntimeContext>;
  logger?: AnalyticsDiagnosticLogger;
}

const PROVIDER_ANONYMOUS_KEYS = new Set([
  "distinct_id",
  "$distinct_id",
  "$device_id",
  "$session_id",
  "$lib",
  "$lib_version",
  "token",
]);

export class PostHogAnalytics extends GuardedAnalytics {
  private client: PostHogClient | null = null;
  private initialization: Promise<boolean> | null = null;
  private consentGeneration = 0;
  private readonly context: PostHogRuntimeContext;

  constructor(private readonly config: PostHogAnalyticsConfig) {
    super(config.environment, config.logger);
    this.context = resolveRuntimeContext(config.runtime, config.environment);
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  /** Must only be called after the user explicitly allows anonymous analytics. */
  enable(): Promise<boolean> {
    if (this.client) {
      return Promise.resolve(true);
    }
    if (!isExternalAnalyticsAllowed(this.context)) {
      return Promise.resolve(false);
    }
    if (!isSafePostHogEndpoint(this.config.host, this.config.projectKey)) {
      this.diagnose("analytics_configuration_rejected");
      return Promise.resolve(false);
    }
    if (!this.initialization) {
      const generation = ++this.consentGeneration;
      this.initialization = this.loadClient(generation);
    }
    return this.initialization;
  }

  disable(): void {
    this.consentGeneration += 1;
    const client = this.client;
    this.client = null;
    this.initialization = null;
    if (!client) {
      return;
    }
    resetPostHogClient(client, () =>
      this.diagnose("analytics_identifier_reset_failed"),
    );
  }

  protected deliver(event: AnalyticsEvent): boolean {
    if (!this.client) {
      return false;
    }
    this.client.capture(event.name, { ...event.properties });
    return true;
  }

  private async loadClient(generation: number): Promise<boolean> {
    let loadedClient: PostHogClient | null = null;
    try {
      const client = await this.config.loader();
      loadedClient = client;
      if (generation !== this.consentGeneration) {
        return false;
      }
      client.init(this.config.projectKey, {
        api_host: this.config.host,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        capture_dead_clicks: false,
        capture_heatmaps: false,
        capture_performance: false,
        capture_exceptions: false,
        disable_session_recording: true,
        person_profiles: "identified_only",
        respect_dnt: true,
        mask_all_text: true,
        mask_all_element_attributes: true,
        advanced_disable_feature_flags: true,
        disable_surveys: true,
        disable_web_experiments: true,
        disable_external_dependency_loading: true,
        save_campaign_params: false,
        save_referrer: false,
        disable_capture_url_hashes: true,
        ip: false,
        advanced_disable_flags: true,
        advanced_disable_toolbar_metrics: true,
        before_send: (event) =>
          sanitizePostHogEvent(event, this.config.projectKey),
      });
      client.opt_in_capturing?.({ captureEventName: false });
      this.client = client;
      return true;
    } catch {
      if (loadedClient) {
        resetPostHogClient(loadedClient, () =>
          this.diagnose("analytics_identifier_reset_failed"),
        );
      }
      if (generation === this.consentGeneration) {
        this.client = null;
        this.initialization = null;
      }
      this.diagnose("analytics_initialization_failed");
      return false;
    }
  }
}

function resetPostHogClient(
  client: PostHogClient,
  onFailure: () => void,
): void {
  try {
    client.reset?.(true);
  } catch {
    onFailure();
  }
  try {
    client.opt_out_capturing?.();
  } catch {
    onFailure();
  }
}

export function isExternalAnalyticsAllowed(
  context: Readonly<PostHogRuntimeContext>,
): boolean {
  const hostname = context.hostname.toLowerCase();
  const localhost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost");
  return !localhost && !context.test && !context.e2e;
}

/** Final provider boundary: only the four events and their approved properties survive. */
export function sanitizePostHogEvent(
  input: PostHogCaptureEvent | null,
  providerProjectKey?: string,
): PostHogCaptureEvent | null {
  if (!input || !isAnalyticsEventName(input.event) || !isRecord(input.properties)) {
    return null;
  }
  const environment = input.properties.environment;
  if (!isEnvironment(environment)) {
    return null;
  }
  const approved: Record<string, unknown> = {};
  for (const key of ANALYTICS_PROPERTY_KEYS[input.event]) {
    approved[key] = input.properties[key];
  }
  const validated = createValidatedEvent(input.event, approved, environment);
  if (!validated) {
    return null;
  }

  const safeProperties: Record<string, unknown> = { ...validated.properties };
  for (const key of PROVIDER_ANONYMOUS_KEYS) {
    const value = input.properties[key];
    if (
      typeof value === "string" &&
      value.length <= 200 &&
      /^[0-9A-Za-z._:-]+$/u.test(value) &&
      (key !== "token" || value === providerProjectKey)
    ) {
      safeProperties[key] = value;
    }
  }
  if (input.properties.$process_person_profile === false) {
    safeProperties.$process_person_profile = false;
  }
  const output: PostHogCaptureEvent = {
    event: validated.name,
    properties: safeProperties,
  };
  return analyticsPayloadByteLength(output) <= MAX_ANALYTICS_PAYLOAD_BYTES
    ? output
    : null;
}

function resolveRuntimeContext(
  override: Partial<PostHogRuntimeContext> | undefined,
  environment: AnalyticsEnvironment,
): PostHogRuntimeContext {
  return {
    hostname:
      override?.hostname ??
      (typeof location === "undefined" ? "localhost" : location.hostname),
    test:
      environment === "test" ||
      (override?.test ?? import.meta.env.MODE === "test"),
    e2e:
      override?.e2e ??
      (typeof navigator !== "undefined" && navigator.webdriver === true),
  };
}

function isSafePostHogEndpoint(host: string, projectKey: string): boolean {
  if (!projectKey || projectKey.length > 200) {
    return false;
  }
  try {
    const url = new URL(host);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvironment(value: unknown): value is AnalyticsEnvironment {
  return (
    value === "production" ||
    value === "staging" ||
    value === "development" ||
    value === "test"
  );
}
