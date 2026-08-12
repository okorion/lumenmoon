import { NoopAnalytics } from "./Analytics";
import type {
  Analytics,
  AnalyticsConsentChoice,
  AnalyticsEventName,
  AnalyticsEventPropertyMap,
} from "./types";

const CONSENT_STORAGE_KEY = "lumenmoon:analytics-consent:v1";

export interface AnalyticsConsentStore {
  read(): AnalyticsConsentChoice;
  write(choice: AnalyticsConsentChoice): void;
}

export class MemoryAnalyticsConsentStore implements AnalyticsConsentStore {
  constructor(private choice: AnalyticsConsentChoice = "undecided") {}

  read(): AnalyticsConsentChoice {
    return this.choice;
  }

  write(choice: AnalyticsConsentChoice): void {
    this.choice = choice;
  }
}

export class LocalStorageAnalyticsConsentStore implements AnalyticsConsentStore {
  constructor(private readonly storage: Storage) {}

  read(): AnalyticsConsentChoice {
    try {
      return parseConsent(this.storage.getItem(CONSENT_STORAGE_KEY));
    } catch {
      return "undecided";
    }
  }

  write(choice: AnalyticsConsentChoice): void {
    try {
      this.storage.setItem(CONSENT_STORAGE_KEY, choice);
    } catch {
      // Consent persistence must not affect gameplay.
    }
  }
}

export interface ConsentControlledAnalytics extends Analytics {
  enable(): Promise<boolean>;
  disable(): void;
}

export class AnalyticsConsentController implements Analytics {
  private readonly noop = new NoopAnalytics();
  private provider: ConsentControlledAnalytics | null = null;
  private active: Analytics = this.noop;
  private currentChoice: AnalyticsConsentChoice;
  private consentGeneration = 0;

  constructor(
    private readonly store: AnalyticsConsentStore,
    private readonly createProvider: () => ConsentControlledAnalytics,
  ) {
    this.currentChoice = store.read();
  }

  get choice(): AnalyticsConsentChoice {
    return this.currentChoice;
  }

  isEnabled(): boolean {
    return this.active.isEnabled();
  }

  async applyStoredChoice(): Promise<boolean> {
    return this.setConsent(this.store.read());
  }

  async setConsent(choice: AnalyticsConsentChoice): Promise<boolean> {
    const generation = ++this.consentGeneration;
    this.currentChoice = choice;
    this.store.write(choice);
    if (choice !== "allowed") {
      this.provider?.disable();
      this.active = this.noop;
      return false;
    }

    this.provider ??= this.createProvider();
    const enabled = await this.provider.enable();
    if (
      generation !== this.consentGeneration ||
      this.currentChoice !== "allowed"
    ) {
      if (enabled && this.currentChoice !== "allowed") {
        this.provider.disable();
      }
      return false;
    }
    this.active = enabled ? this.provider : this.noop;
    return enabled;
  }

  async withdraw(): Promise<void> {
    await this.setConsent("essential_only");
  }

  capture<N extends AnalyticsEventName>(
    name: N,
    properties: AnalyticsEventPropertyMap[N],
  ): boolean {
    try {
      return this.active.capture(name, properties);
    } catch {
      return false;
    }
  }
}

function parseConsent(value: string | null): AnalyticsConsentChoice {
  if (value === "allowed" || value === "essential_only") {
    return value;
  }
  return "undecided";
}
