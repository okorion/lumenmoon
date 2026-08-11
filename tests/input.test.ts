import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GameInput,
  desktopUtilityShortcut,
  type InputElements,
} from "../src/input/GameInput";

class FakeElement extends EventTarget {
  readonly style = { transform: "" };
  private readonly capturedPointers = new Set<number>();

  setPointerCapture(pointerId: number): void {
    this.capturedPointers.add(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.capturedPointers.has(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.capturedPointers.delete(pointerId);
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      top: 0,
      right: 116,
      bottom: 116,
      left: 0,
      width: 116,
      height: 116,
      toJSON: () => ({}),
    };
  }

  requestPointerLock(): void {}
}

class FakeDocument extends EventTarget {
  hidden = false;
  pointerLockElement: EventTarget | null = null;
}

function pointerEvent(
  type: string,
  properties: Record<string, number | string>,
): Event {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

function createInputElements(): {
  elements: InputElements;
  controls: Record<string, FakeElement>;
} {
  const controls = {
    canvas: new FakeElement(),
    joystick: new FakeElement(),
    joystickKnob: new FakeElement(),
    lookZone: new FakeElement(),
    placeButton: new FakeElement(),
    removeButton: new FakeElement(),
    jumpButton: new FakeElement(),
    rotateButton: new FakeElement(),
  };
  return {
    elements: controls as unknown as InputElements,
    controls,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("데스크톱 유틸리티 단축키", () => {
  it("건축 조작 중에도 수동 생산과 베이 초기화 경로를 제공한다", () => {
    expect(desktopUtilityShortcut("KeyF")).toBe("manual-production");
    expect(desktopUtilityShortcut("KeyX")).toBe("reset-bay");
    expect(desktopUtilityShortcut("KeyR")).toBeNull();
  });

  it("멀티터치 이동·시점·배치·제거·점프를 같은 프레임에 보존한다", () => {
    const fakeWindow = new EventTarget();
    const fakeDocument = new FakeDocument();
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    const { elements, controls } = createInputElements();
    const input = new GameInput(elements, true, () => undefined);

    controls.joystick!.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 1,
        pointerType: "touch",
        clientX: 90,
        clientY: 58,
      }),
    );
    controls.lookZone!.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 2,
        pointerType: "touch",
        clientX: 400,
        clientY: 100,
      }),
    );
    controls.lookZone!.dispatchEvent(
      pointerEvent("pointermove", {
        pointerId: 2,
        pointerType: "touch",
        clientX: 420,
        clientY: 110,
      }),
    );
    controls.placeButton!.dispatchEvent(
      pointerEvent("pointerdown", { pointerId: 3, pointerType: "touch" }),
    );
    controls.removeButton!.dispatchEvent(
      pointerEvent("pointerdown", { pointerId: 4, pointerType: "touch" }),
    );
    controls.jumpButton!.dispatchEvent(
      pointerEvent("pointerdown", { pointerId: 5, pointerType: "touch" }),
    );

    const frame = input.consumeFrame();
    expect(frame.moveX).toBeGreaterThan(0.7);
    expect(frame.lookX).toBeCloseTo(0.084);
    expect(frame.lookY).toBeCloseTo(0.042);
    expect(frame.place).toBe(true);
    expect(frame.remove).toBe(true);
    expect(frame.removeHeld).toBe(true);
    expect(frame.jump).toBe(true);
  });

  it("백그라운드 전환 시 캡처된 모바일 입력과 대기 동작을 모두 비운다", () => {
    const fakeWindow = new EventTarget();
    const fakeDocument = new FakeDocument();
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    const { elements, controls } = createInputElements();
    const input = new GameInput(elements, true, () => undefined);

    controls.joystick!.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 1,
        pointerType: "touch",
        clientX: 90,
        clientY: 58,
      }),
    );
    controls.removeButton!.dispatchEvent(
      pointerEvent("pointerdown", { pointerId: 2, pointerType: "touch" }),
    );
    fakeDocument.hidden = true;
    fakeDocument.dispatchEvent(new Event("visibilitychange"));

    expect(input.consumeFrame()).toMatchObject({
      moveX: 0,
      moveForward: 0,
      lookX: 0,
      lookY: 0,
      remove: false,
      removeHeld: false,
    });
    expect(controls.joystickKnob!.style.transform).toBe("translate(0px, 0px)");
  });
});
