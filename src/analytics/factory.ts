import { NoopAnalytics } from "./Analytics";
import {
  AnalyticsConsentController,
  LocalStorageAnalyticsConsentStore,
  MemoryAnalyticsConsentStore,
  type AnalyticsConsentStore,
  type ConsentControlledAnalytics,
} from "./consent";
import {
  IndexedDbAnalyticsMilestoneStore,
  MemoryAnalyticsMilestoneStore,
  type AnalyticsMilestoneStore,
} from "./MilestoneStore";
import {
  PostHogAnalytics,
  type PostHogAnalyticsConfig,
  type PostHogLoader,
  type PostHogRuntimeContext,
} from "./PostHogAnalytics";
import type { AnalyticsEnvironment } from "./types";

export interface AnalyticsFactoryConfig {
  enabled: boolean;
  projectKey?: string;
  host?: string;
  environment: AnalyticsEnvironment;
  loader?: PostHogLoader;
  storage?: Storage;
  indexedDb?: IDBFactory;
  runtime?: Partial<PostHogRuntimeContext>;
  developmentDiagnostics?: boolean;
}

export interface BrowserAnalyticsRuntime {
  analytics: AnalyticsConsentController;
  milestoneStore: AnalyticsMilestoneStore;
  consentStore: AnalyticsConsentStore;
}

/**
 * Creates inert analytics when disabled or incomplete. This never loads an SDK;
 * the controller only invokes the loader after `setConsent("allowed")`.
 */
export function createBrowserAnalyticsRuntime(
  config: AnalyticsFactoryConfig,
): BrowserAnalyticsRuntime {
  const consentStore = config.storage
    ? new LocalStorageAnalyticsConsentStore(config.storage)
    : new MemoryAnalyticsConsentStore();
  const providerConfig = resolveProviderConfig(config);
  const analytics = new AnalyticsConsentController(consentStore, () =>
    providerConfig
      ? new PostHogAnalytics(providerConfig)
      : new DisabledAnalyticsProvider(),
  );
  return {
    analytics,
    milestoneStore: config.indexedDb
      ? new IndexedDbAnalyticsMilestoneStore(config.indexedDb)
      : new MemoryAnalyticsMilestoneStore(),
    consentStore,
  };
}

function resolveProviderConfig(
  config: AnalyticsFactoryConfig,
): PostHogAnalyticsConfig | null {
  if (
    !config.enabled ||
    !config.projectKey?.trim() ||
    !config.host?.trim() ||
    !config.loader
  ) {
    return null;
  }
  const result: PostHogAnalyticsConfig = {
    projectKey: config.projectKey.trim(),
    host: config.host.trim(),
    environment: config.environment,
    loader: config.loader,
  };
  if (config.runtime) {
    result.runtime = config.runtime;
  }
  if (config.developmentDiagnostics) {
    result.logger = (code) => console.debug(`[analytics] ${code}`);
  }
  return result;
}

class DisabledAnalyticsProvider
  extends NoopAnalytics
  implements ConsentControlledAnalytics
{
  enable(): Promise<boolean> {
    return Promise.resolve(false);
  }

  disable(): void {
    // Already inert.
  }
}
