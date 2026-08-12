import {
  DEFAULT_AUDIO_PREFERENCES,
  readAudioPreferences,
  withAudioChannel,
  writeAudioPreferences,
  type AudioChannel,
  type AudioPreferences,
} from "./preferences";

export type MusicScene = "menu" | "free" | "mission";
export type GameSound =
  | "interface"
  | "select"
  | "start"
  | "jump"
  | "place"
  | "remove"
  | "footstep"
  | "contribute";

type PreferencesListener = (preferences: Readonly<AudioPreferences>) => void;

const MUSIC_PHRASE_INTERVAL_MS = 5_600;

/**
 * Small procedural sound system. It intentionally creates every tone in the
 * browser instead of downloading copyrighted samples or keeping decoded audio
 * assets in memory. WebAudio is not created until a user gesture unlocks it.
 */
export class GameAudio {
  private preferencesValue: AudioPreferences;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  private readonly listeners = new Set<PreferencesListener>();
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private interfaceGain: GainNode | null = null;
  private effectsGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private musicScene: MusicScene = "menu";
  private musicTimer: number | null = null;
  private readonly activeMusicNodes = new Set<OscillatorNode>();
  private readonly lastPlayedAt = new Map<GameSound, number>();
  private unlocked = false;
  private root: HTMLElement | null = null;

  constructor(storage: Storage | null = safeLocalStorage()) {
    this.storage = storage;
    this.preferencesValue = readAudioPreferences(storage);
    document.addEventListener("visibilitychange", () => {
      if (!this.context || !this.unlocked) {
        return;
      }
      if (document.hidden) {
        this.stopMusic();
        void this.context.suspend().catch(() => {});
      } else if (this.preferencesValue.enabled) {
        void this.context.resume().then(() => this.restartMusic()).catch(() => {});
      }
    });
  }

  get preferences(): Readonly<AudioPreferences> {
    return this.preferencesValue;
  }

  subscribe(listener: PreferencesListener): () => void {
    this.listeners.add(listener);
    listener(this.preferencesValue);
    return () => this.listeners.delete(listener);
  }

  attachUi(root: HTMLElement): void {
    if (this.root === root) {
      return;
    }
    this.root = root;
    root.addEventListener("pointerdown", this.unlockFromGesture, true);
    root.addEventListener("keydown", this.unlockFromKeyboard, true);
    root.addEventListener("click", this.playUiTarget, true);
  }

  setScene(scene: MusicScene): void {
    if (this.musicScene === scene) {
      return;
    }
    this.musicScene = scene;
    this.restartMusic();
  }

  setEnabled(enabled: boolean): void {
    this.commitPreferences({ ...this.preferencesValue, enabled });
    if (!enabled) {
      this.stopMusic();
      return;
    }
    void this.unlock().then(() => this.restartMusic());
  }

  enableAll(): void {
    const defaults = DEFAULT_AUDIO_PREFERENCES;
    this.commitPreferences({
      enabled: true,
      master:
        this.preferencesValue.master > 0
          ? this.preferencesValue.master
          : defaults.master,
      music:
        this.preferencesValue.music > 0
          ? this.preferencesValue.music
          : defaults.music,
      interface:
        this.preferencesValue.interface > 0
          ? this.preferencesValue.interface
          : defaults.interface,
      effects:
        this.preferencesValue.effects > 0
          ? this.preferencesValue.effects
          : defaults.effects,
    });
    void this.unlock().then(() => {
      this.restartMusic();
      this.play("interface");
    });
  }

  disableAll(): void {
    this.setEnabled(false);
  }

  setChannel(channel: AudioChannel, level: number): void {
    const musicWasAudible =
      this.preferencesValue.enabled &&
      this.preferencesValue.master > 0 &&
      this.preferencesValue.music > 0;
    this.commitPreferences(
      withAudioChannel(this.preferencesValue, channel, level),
    );
    const musicIsAudible =
      this.preferencesValue.enabled &&
      this.preferencesValue.master > 0 &&
      this.preferencesValue.music > 0;
    if (!musicIsAudible) {
      this.stopMusic();
    } else if (!musicWasAudible) {
      this.restartMusic();
    }
  }

  async unlock(): Promise<void> {
    if (!this.preferencesValue.enabled || document.hidden) {
      return;
    }
    if (!this.context) {
      const Context = window.AudioContext;
      if (!Context) {
        return;
      }
      let context: AudioContext | null = null;
      try {
        context = new Context({ latencyHint: "interactive" });
        this.context = context;
        this.masterGain = context.createGain();
        this.musicGain = context.createGain();
        this.interfaceGain = context.createGain();
        this.effectsGain = context.createGain();
        this.musicGain.connect(this.masterGain);
        this.interfaceGain.connect(this.masterGain);
        this.effectsGain.connect(this.masterGain);
        this.masterGain.connect(context.destination);
        this.applyLevels(true);
      } catch {
        this.context = null;
        this.masterGain = null;
        this.musicGain = null;
        this.interfaceGain = null;
        this.effectsGain = null;
        void context?.close().catch(() => {});
        return;
      }
    }
    try {
      if (this.context.state === "suspended") {
        await this.context.resume();
      }
      if (this.context.state === "running") {
        const firstUnlock = !this.unlocked;
        this.unlocked = true;
        if (firstUnlock) {
          this.restartMusic();
        }
      }
    } catch {
      // Browser autoplay policy can still reject a synthetic/untrusted event.
      // The next genuine pointer or keyboard gesture will retry without noise.
    }
  }

  play(sound: GameSound): void {
    if (!this.preferencesValue.enabled) {
      return;
    }
    if (!this.context || this.context.state !== "running") {
      void this.unlock().then(() => this.tryPlayUnlocked(sound)).catch(() => {});
      return;
    }
    this.tryPlayUnlocked(sound);
  }

  destroy(): void {
    this.stopMusic();
    if (this.root) {
      this.root.removeEventListener("pointerdown", this.unlockFromGesture, true);
      this.root.removeEventListener("keydown", this.unlockFromKeyboard, true);
      this.root.removeEventListener("click", this.playUiTarget, true);
    }
    void this.context?.close().catch(() => {});
    this.context = null;
  }

  private readonly unlockFromGesture = (): void => {
    void this.unlock();
  };

  private readonly unlockFromKeyboard = (event: KeyboardEvent): void => {
    if (event.repeat || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    void this.unlock();
  };

  private readonly playUiTarget = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const control = target.closest<HTMLElement>("button, [data-audio]");
    if (
      !control ||
      !this.root?.contains(control) ||
      control.matches(":disabled")
    ) {
      return;
    }
    const requested = control.dataset["audio"];
    if (requested === "none") {
      return;
    }
    if (
      requested === "select" ||
      control.hasAttribute("data-kind") ||
      control.hasAttribute("data-color")
    ) {
      this.play("select");
      return;
    }
    if (requested === "start") {
      this.play("start");
      return;
    }
    this.play("interface");
  };

  private commitPreferences(preferences: AudioPreferences): void {
    this.preferencesValue = preferences;
    writeAudioPreferences(preferences, this.storage);
    this.applyLevels(false);
    for (const listener of this.listeners) {
      listener(this.preferencesValue);
    }
  }

  private applyLevels(immediate: boolean): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const at = context.currentTime;
    this.setGain(
      this.masterGain,
      this.preferencesValue.enabled ? this.preferencesValue.master : 0,
      at,
      immediate,
    );
    this.setGain(this.musicGain, this.preferencesValue.music, at, immediate);
    this.setGain(
      this.interfaceGain,
      this.preferencesValue.interface,
      at,
      immediate,
    );
    this.setGain(this.effectsGain, this.preferencesValue.effects, at, immediate);
  }

  private setGain(
    node: GainNode | null,
    value: number,
    at: number,
    immediate: boolean,
  ): void {
    if (!node) {
      return;
    }
    node.gain.cancelScheduledValues(at);
    if (immediate) {
      node.gain.setValueAtTime(value, at);
    } else {
      node.gain.setTargetAtTime(value, at, 0.025);
    }
  }

  private playUnlocked(sound: GameSound): void {
    if (!this.context || this.context.state !== "running") {
      return;
    }
    const now = monotonicNow();
    const debounceMs =
      sound === "footstep" ? 130 : sound === "interface" ? 35 : 18;
    if (
      now - (this.lastPlayedAt.get(sound) ?? Number.NEGATIVE_INFINITY) <
      debounceMs
    ) {
      return;
    }
    this.lastPlayedAt.set(sound, now);
    switch (sound) {
      case "interface":
        this.tone("sine", 430, 510, 0.055, 0.026, "interface");
        break;
      case "select":
        this.tone("triangle", 310, 390, 0.075, 0.032, "interface");
        this.tone("sine", 520, 590, 0.055, 0.015, "interface", 0.025);
        break;
      case "start":
        this.tone("sine", 262, 330, 0.26, 0.035, "interface");
        this.tone("sine", 392, 494, 0.32, 0.024, "interface", 0.06);
        break;
      case "jump":
        this.tone("sine", 175, 285, 0.18, 0.06, "effects");
        break;
      case "place":
        this.noise(0.075, 780, 0.035);
        this.tone("triangle", 145, 98, 0.11, 0.075, "effects");
        break;
      case "remove":
        this.noise(0.11, 620, 0.045);
        this.tone("triangle", 102, 164, 0.13, 0.06, "effects");
        break;
      case "footstep":
        this.noise(0.055, 420, 0.024);
        break;
      case "contribute":
        this.noise(0.07, 840, 0.026);
        this.tone("triangle", 150, 112, 0.1, 0.055, "effects");
        this.tone("sine", 392, 523, 0.35, 0.025, "effects", 0.055);
        break;
    }
  }

  private tryPlayUnlocked(sound: GameSound): void {
    try {
      this.playUnlocked(sound);
    } catch {
      // Audio nodes are optional. Resource pressure or a closing output device
      // must never interrupt the game loop.
    }
  }

  private tone(
    type: OscillatorType,
    fromHz: number,
    toHz: number,
    duration: number,
    volume: number,
    channel: "music" | "interface" | "effects",
    delay = 0,
  ): void {
    const context = this.context;
    const destination =
      channel === "music"
        ? this.musicGain
        : channel === "interface"
          ? this.interfaceGain
          : this.effectsGain;
    if (!context || !destination || context.state !== "running") {
      return;
    }
    const startsAt = context.currentTime + delay;
    const endsAt = startsAt + duration;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(fromHz, startsAt);
    oscillator.frequency.exponentialRampToValueAtTime(toHz, endsAt);
    envelope.gain.setValueAtTime(0.0001, startsAt);
    envelope.gain.exponentialRampToValueAtTime(volume, startsAt + Math.min(0.025, duration * 0.2));
    envelope.gain.exponentialRampToValueAtTime(0.0001, endsAt);
    oscillator.connect(envelope);
    envelope.connect(destination);
    oscillator.start(startsAt);
    oscillator.stop(endsAt + 0.015);
    oscillator.addEventListener(
      "ended",
      () => {
        oscillator.disconnect();
        envelope.disconnect();
        this.activeMusicNodes.delete(oscillator);
      },
      { once: true },
    );
    if (channel === "music") {
      this.activeMusicNodes.add(oscillator);
    }
  }

  private noise(duration: number, cutoffHz: number, volume: number): void {
    const context = this.context;
    if (!context || !this.effectsGain || context.state !== "running") {
      return;
    }
    if (!this.noiseBuffer) {
      const frameCount = Math.max(1, Math.ceil(context.sampleRate * 0.14));
      const buffer = context.createBuffer(1, frameCount, context.sampleRate);
      const data = buffer.getChannelData(0);
      let previous = 0;
      for (let index = 0; index < data.length; index += 1) {
        const white = Math.random() * 2 - 1;
        previous = previous * 0.78 + white * 0.22;
        data[index] = previous;
      }
      this.noiseBuffer = buffer;
    }
    const startsAt = context.currentTime;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    source.buffer = this.noiseBuffer;
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(cutoffHz, startsAt);
    filter.Q.setValueAtTime(0.45, startsAt);
    envelope.gain.setValueAtTime(volume, startsAt);
    envelope.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.effectsGain);
    source.start(startsAt);
    source.stop(startsAt + duration);
    source.addEventListener("ended", () => {
      source.disconnect();
      filter.disconnect();
      envelope.disconnect();
    }, { once: true });
  }

  private restartMusic(): void {
    this.stopMusic();
    if (
      !this.unlocked ||
      !this.preferencesValue.enabled ||
      this.preferencesValue.master <= 0 ||
      this.preferencesValue.music <= 0 ||
      !this.context ||
      this.context.state !== "running" ||
      document.hidden
    ) {
      return;
    }
    this.scheduleMusicPhrase();
    this.musicTimer = window.setInterval(
      () => this.scheduleMusicPhrase(),
      MUSIC_PHRASE_INTERVAL_MS,
    );
  }

  private stopMusic(): void {
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    for (const oscillator of this.activeMusicNodes) {
      try {
        oscillator.stop();
      } catch {
        // A node that ended between iteration and stop is already cleaned up.
      }
    }
    this.activeMusicNodes.clear();
  }

  private scheduleMusicPhrase(): void {
    const notes = musicNotes(this.musicScene);
    notes.forEach((frequency, index) => {
      const delay = index * 1.25;
      this.tone("sine", frequency, frequency * 1.002, 3.2, 0.018, "music", delay);
      this.tone("sine", frequency * 1.5, frequency * 1.502, 2.8, 0.007, "music", delay + 0.08);
    });
  }
}

function musicNotes(scene: MusicScene): readonly number[] {
  switch (scene) {
    case "menu":
      return [220, 277.18, 329.63];
    case "free":
      return [196, 246.94, 293.66, 369.99];
    case "mission":
      return [174.61, 220, 261.63, 349.23];
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
