import { afterEach, describe, expect, it, vi } from "vitest";
import { GameAudio } from "../src/audio/GameAudio";

describe("GameAudio failure isolation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the game usable when AudioContext construction is rejected", async () => {
    vi.stubGlobal("document", {
      hidden: false,
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      AudioContext: class {
        constructor() {
          throw new Error("audio device unavailable");
        }
      },
    });

    const audio = new GameAudio(null);

    await expect(audio.unlock()).resolves.toBeUndefined();
    expect(() => audio.play("interface")).not.toThrow();
  });

  it("keeps the frame alive when an audio node cannot be allocated", async () => {
    const gain = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: {
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn(),
        setTargetAtTime: vi.fn(),
      },
    };
    vi.stubGlobal("document", {
      hidden: false,
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      AudioContext: class {
        readonly state = "running";
        readonly currentTime = 0;
        readonly destination = {};
        createGain() {
          return gain;
        }
        createOscillator(): never {
          throw new DOMException("resource exhausted");
        }
      },
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    });

    const audio = new GameAudio(null);
    await expect(audio.unlock()).resolves.toBeUndefined();

    expect(() => audio.play("interface")).not.toThrow();
  });

  it("cleans a failed music graph and lets the same scene retry", async () => {
    let failEnvelopeAllocation = false;
    let nextTimer = 0;
    const timers = new Map<number, () => void>();
    const clearInterval = vi.fn((timer: number) => {
      timers.delete(timer);
    });
    const oscillators: Array<{
      addEventListener: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      frequency: {
        exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
        setValueAtTime: ReturnType<typeof vi.fn>;
      };
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      type: OscillatorType;
    }> = [];
    const createGain = () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: {
        cancelScheduledValues: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
        setTargetAtTime: vi.fn(),
        setValueAtTime: vi.fn(),
      },
    });

    vi.stubGlobal("document", {
      hidden: false,
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      AudioContext: class {
        readonly state = "running";
        readonly currentTime = 0;
        readonly destination = {};
        createGain() {
          if (failEnvelopeAllocation) {
            throw new DOMException("resource exhausted");
          }
          return createGain();
        }
        createOscillator() {
          const oscillator = {
            addEventListener: vi.fn(),
            connect: vi.fn(),
            disconnect: vi.fn(),
            frequency: {
              exponentialRampToValueAtTime: vi.fn(),
              setValueAtTime: vi.fn(),
            },
            start: vi.fn(),
            stop: vi.fn(),
            type: "sine" as OscillatorType,
          };
          oscillators.push(oscillator);
          return oscillator;
        }
        close() {
          return Promise.resolve();
        }
      },
      setInterval: vi.fn((callback: () => void) => {
        const timer = ++nextTimer;
        timers.set(timer, callback);
        return timer;
      }),
      clearInterval,
    });

    const audio = new GameAudio(null);
    await expect(audio.unlock()).resolves.toBeUndefined();
    expect(timers.has(1)).toBe(true);

    failEnvelopeAllocation = true;
    expect(() => audio.setScene("free")).not.toThrow();
    const failedSceneNode = oscillators.at(-1);
    expect(failedSceneNode?.stop).toHaveBeenCalledTimes(1);
    expect(failedSceneNode?.disconnect).toHaveBeenCalledTimes(1);
    expect(clearInterval).toHaveBeenCalledWith(1);
    expect(timers.size).toBe(0);

    failEnvelopeAllocation = false;
    expect(() => audio.setScene("free")).not.toThrow();
    expect(timers.has(2)).toBe(true);

    failEnvelopeAllocation = true;
    expect(() => timers.get(2)?.()).not.toThrow();
    expect(clearInterval).toHaveBeenCalledWith(2);
    expect(timers.size).toBe(0);

    failEnvelopeAllocation = false;
    expect(() => audio.setScene("free")).not.toThrow();
    expect(timers.has(3)).toBe(true);

    audio.destroy();
  });
});
