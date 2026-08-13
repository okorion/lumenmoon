export const AUDIO_PREFERENCES_STORAGE_KEY = "lumenmoon:audio:v1";

export type AudioChannel = "master" | "music" | "interface" | "effects";

export interface AudioPreferences {
  enabled: boolean;
  master: number;
  music: number;
  interface: number;
  effects: number;
}

export const DEFAULT_AUDIO_PREFERENCES: Readonly<AudioPreferences> = {
  enabled: true,
  master: 0.52,
  music: 0.32,
  interface: 0.38,
  effects: 0.44,
};

export function readAudioPreferences(
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): AudioPreferences {
  if (!storage) {
    return { ...DEFAULT_AUDIO_PREFERENCES };
  }
  try {
    const raw = storage.getItem(AUDIO_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_AUDIO_PREFERENCES };
    }
    return sanitizeAudioPreferences(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_AUDIO_PREFERENCES };
  }
}

export function writeAudioPreferences(
  preferences: AudioPreferences,
  storage: Pick<Storage, "setItem"> | null = safeLocalStorage(),
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(
      AUDIO_PREFERENCES_STORAGE_KEY,
      JSON.stringify(sanitizeAudioPreferences(preferences)),
    );
    return true;
  } catch {
    return false;
  }
}

export function sanitizeAudioPreferences(value: unknown): AudioPreferences {
  if (!isRecord(value)) {
    return { ...DEFAULT_AUDIO_PREFERENCES };
  }
  return {
    enabled:
      typeof value["enabled"] === "boolean"
        ? value["enabled"]
        : DEFAULT_AUDIO_PREFERENCES.enabled,
    master: finiteLevel(value["master"], DEFAULT_AUDIO_PREFERENCES.master),
    music: finiteLevel(value["music"], DEFAULT_AUDIO_PREFERENCES.music),
    interface: finiteLevel(
      value["interface"],
      DEFAULT_AUDIO_PREFERENCES.interface,
    ),
    effects: finiteLevel(value["effects"], DEFAULT_AUDIO_PREFERENCES.effects),
  };
}

export function withAudioChannel(
  preferences: AudioPreferences,
  channel: AudioChannel,
  level: number,
): AudioPreferences {
  return {
    ...preferences,
    [channel]: finiteLevel(level, preferences[channel]),
  };
}

function finiteLevel(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
