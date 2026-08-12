import { describe, expect, it } from "vitest";
import {
  AUDIO_PREFERENCES_STORAGE_KEY,
  DEFAULT_AUDIO_PREFERENCES,
  readAudioPreferences,
  sanitizeAudioPreferences,
  withAudioChannel,
  writeAudioPreferences,
} from "../src/audio/preferences";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("기기별 사운드 설정", () => {
  it("저장값이 없으면 편안한 저음량 기본값을 사용한다", () => {
    const storage = new MemoryStorage();

    expect(readAudioPreferences(storage)).toEqual(DEFAULT_AUDIO_PREFERENCES);
    expect(DEFAULT_AUDIO_PREFERENCES.master).toBeLessThanOrEqual(0.55);
    expect(DEFAULT_AUDIO_PREFERENCES.music).toBeLessThan(
      DEFAULT_AUDIO_PREFERENCES.effects,
    );
  });

  it("전체 켜짐 상태와 채널 음량을 같은 브라우저 저장소에 보존한다", () => {
    const storage = new MemoryStorage();
    const preferences = {
      enabled: false,
      master: 0.41,
      music: 0.23,
      interface: 0.32,
      effects: 0.37,
    };

    expect(writeAudioPreferences(preferences, storage)).toBe(true);
    expect(storage.values.has(AUDIO_PREFERENCES_STORAGE_KEY)).toBe(true);
    expect(readAudioPreferences(storage)).toEqual(preferences);
  });

  it("손상되거나 범위를 벗어난 값은 기본값 또는 0~1 범위로 정리한다", () => {
    expect(
      sanitizeAudioPreferences({
        enabled: "yes",
        master: 4,
        music: -2,
        interface: Number.NaN,
        effects: 0.72,
      }),
    ).toEqual({
      enabled: true,
      master: 1,
      music: 0,
      interface: DEFAULT_AUDIO_PREFERENCES.interface,
      effects: 0.72,
    });
  });

  it("한 채널만 변경하고 나머지 설정은 유지한다", () => {
    const changed = withAudioChannel(
      { ...DEFAULT_AUDIO_PREFERENCES },
      "music",
      0.15,
    );

    expect(changed.music).toBe(0.15);
    expect(changed.master).toBe(DEFAULT_AUDIO_PREFERENCES.master);
    expect(changed.enabled).toBe(true);
  });

  it("저장소 접근 실패가 게임 시작을 막지 않는다", () => {
    const unavailable = {
      getItem(): string | null {
        throw new Error("blocked");
      },
      setItem(): void {
        throw new Error("blocked");
      },
    };

    expect(readAudioPreferences(unavailable)).toEqual(
      DEFAULT_AUDIO_PREFERENCES,
    );
    expect(
      writeAudioPreferences({ ...DEFAULT_AUDIO_PREFERENCES }, unavailable),
    ).toBe(false);
  });
});
