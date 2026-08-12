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
});
