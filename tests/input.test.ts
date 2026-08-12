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
  exitPointerLockCalls = 0;

  exitPointerLock(): void {
    this.exitPointerLockCalls += 1;
    this.pointerLockElement = null;
    this.dispatchEvent(new Event("pointerlockchange"));
  }
}

function pointerEvent(
  type: string,
  properties: Record<string, boolean | number | string>,
): Event {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

function keyboardEvent(
  type: "keydown" | "keyup",
  code: string,
  options: { repeat?: boolean; target?: EventTarget } = {},
): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    code: { value: code },
    isComposing: { value: false },
    repeat: { value: options.repeat ?? false },
    ...(options.target ? { target: { value: options.target } } : {}),
  });
  return event;
}

class FakeInteractiveTarget extends EventTarget {
  constructor(private readonly matchingSelector: string) {
    super();
  }

  closest(selectors: string): FakeInteractiveTarget | null {
    return selectors.includes(this.matchingSelector) ? this : null;
  }
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

  it("키보드만으로 시점 네 방향과 이동을 지속 입력한다", () => {
    const fakeWindow = new EventTarget();
    const fakeDocument = new FakeDocument();
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    const { elements } = createInputElements();
    const input = new GameInput(elements, false, () => undefined);

    fakeWindow.dispatchEvent(keyboardEvent("keydown", "KeyA"));
    fakeWindow.dispatchEvent(keyboardEvent("keydown", "KeyW"));
    fakeWindow.dispatchEvent(keyboardEvent("keydown", "KeyJ"));
    fakeWindow.dispatchEvent(keyboardEvent("keydown", "KeyU"));

    expect(input.consumeFrame()).toMatchObject({
      moveX: -1,
      moveForward: 1,
      lookX: -0.035,
      lookY: -0.035,
    });
    expect(input.consumeFrame()).toMatchObject({
      moveX: -1,
      moveForward: 1,
      lookX: -0.035,
      lookY: -0.035,
    });

    for (const code of ["KeyA", "KeyW", "KeyJ", "KeyU"]) {
      fakeWindow.dispatchEvent(keyboardEvent("keyup", code));
    }
    fakeWindow.dispatchEvent(keyboardEvent("keydown", "KeyL"));
    fakeWindow.dispatchEvent(keyboardEvent("keydown", "KeyK"));

    expect(input.consumeFrame()).toMatchObject({
      moveX: 0,
      moveForward: 0,
      lookX: 0.035,
      lookY: 0.035,
    });
  });

  it("Enter로 놓고 Delete press/release로 제거 홀드를 유지한다", () => {
    const fakeWindow = new EventTarget();
    const fakeDocument = new FakeDocument();
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    const { elements } = createInputElements();
    const input = new GameInput(elements, false, () => undefined);

    const place = keyboardEvent("keydown", "Enter");
    const remove = keyboardEvent("keydown", "Delete");
    fakeWindow.dispatchEvent(place);
    fakeWindow.dispatchEvent(remove);

    expect(place.defaultPrevented).toBe(true);
    expect(remove.defaultPrevented).toBe(true);
    expect(input.consumeFrame()).toMatchObject({
      place: true,
      remove: true,
      removeHeld: true,
    });
    expect(input.consumeFrame()).toMatchObject({
      place: false,
      remove: false,
      removeHeld: true,
    });

    fakeWindow.dispatchEvent(keyboardEvent("keyup", "Delete"));
    expect(input.consumeFrame().removeHeld).toBe(false);
  });

  it("기존 점프·회전·종류·색상·유틸리티 단축키를 보존한다", () => {
    const fakeWindow = new EventTarget();
    const fakeDocument = new FakeDocument();
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    const { elements } = createInputElements();
    const input = new GameInput(elements, false, () => undefined);

    for (const code of ["Space", "KeyR", "Digit2", "KeyE", "KeyF", "KeyX"]) {
      fakeWindow.dispatchEvent(keyboardEvent("keydown", code));
    }

    expect(input.consumeFrame()).toMatchObject({
      jump: true,
      rotate: true,
      selectKind: "stair",
      colorDelta: 1,
      manualProduction: true,
      resetBay: true,
    });
  });

  it.each([
    ["버튼", "button"],
    ["라디오", "input"],
    ["슬라이더", "[role='slider']"],
    ["대화상자 내부", "[role='dialog']"],
    ["편집 가능 요소", "[contenteditable]"],
    ["별도 포커스 표면", "[tabindex]"],
  ])("%s에 포커스되면 Space·Enter와 게임 키를 가로채지 않는다", (_, selector) => {
    const fakeWindow = new EventTarget();
    const fakeDocument = new FakeDocument();
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    const { elements } = createInputElements();
    const input = new GameInput(elements, false, () => undefined);
    const target = new FakeInteractiveTarget(selector);
    const events = [
      keyboardEvent("keydown", "Space", { target }),
      keyboardEvent("keydown", "Enter", { target }),
      keyboardEvent("keydown", "Delete", { target }),
      keyboardEvent("keydown", "KeyJ", { target }),
      keyboardEvent("keydown", "KeyR", { target }),
    ];

    for (const event of events) {
      fakeWindow.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(input.consumeFrame()).toMatchObject({
      lookX: 0,
      jump: false,
      place: false,
      remove: false,
      removeHeld: false,
      rotate: false,
    });
  });

  it("모바일 액션 버튼의 포인터 click 중복을 막고 키보드 click은 한 번 처리한다", () => {
    const fakeWindow = new EventTarget();
    const fakeDocument = new FakeDocument();
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    const { elements, controls } = createInputElements();
    const input = new GameInput(elements, true, () => undefined);

    controls.placeButton!.dispatchEvent(
      pointerEvent("pointerdown", { pointerId: 1, pointerType: "touch" }),
    );
    expect(input.consumeFrame().place).toBe(true);
    controls.placeButton!.dispatchEvent(pointerEvent("click", { detail: 1 }));
    expect(input.consumeFrame().place).toBe(false);

    controls.placeButton!.dispatchEvent(pointerEvent("click", { detail: 0 }));
    expect(input.consumeFrame().place).toBe(true);
    expect(input.consumeFrame().place).toBe(false);

    controls.removeButton!.dispatchEvent(pointerEvent("click", { detail: 0 }));
    expect(input.consumeFrame()).toMatchObject({
      remove: true,
      removeHeld: false,
    });
    expect(input.consumeFrame()).toMatchObject({
      remove: false,
      removeHeld: false,
    });

    controls.removeButton!.dispatchEvent(
      pointerEvent("pointerdown", { pointerId: 2, pointerType: "touch" }),
    );
    expect(input.consumeFrame()).toMatchObject({
      remove: true,
      removeHeld: true,
    });
    controls.removeButton!.dispatchEvent(
      pointerEvent("pointerup", { pointerId: 2, pointerType: "touch" }),
    );
    controls.removeButton!.dispatchEvent(pointerEvent("click", { detail: 1 }));
    expect(input.consumeFrame()).toMatchObject({
      remove: false,
      removeHeld: false,
    });
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

  it("복구 화면을 열기 전에 데스크톱 Pointer Lock을 해제한다", () => {
    const fakeWindow = new EventTarget();
    const fakeDocument = new FakeDocument();
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    const { elements, controls } = createInputElements();
    const input = new GameInput(elements, false, () => undefined);
    fakeDocument.pointerLockElement = controls.canvas!;

    input.release();

    expect(fakeDocument.pointerLockElement).toBeNull();
    expect(fakeDocument.exitPointerLockCalls).toBe(1);
    expect(input.consumeFrame()).toMatchObject({
      moveX: 0,
      moveForward: 0,
      lookX: 0,
      lookY: 0,
      place: false,
      remove: false,
    });
  });

  it("복구 전 요청한 Pointer Lock이 늦게 승인돼도 즉시 해제한다", () => {
    const fakeWindow = new EventTarget();
    const fakeDocument = new FakeDocument();
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    const { elements, controls } = createInputElements();
    const input = new GameInput(elements, false, () => undefined);

    input.begin();
    input.release();
    fakeDocument.pointerLockElement = controls.canvas!;
    fakeDocument.dispatchEvent(new Event("pointerlockchange"));

    expect(fakeDocument.pointerLockElement).toBeNull();
    expect(fakeDocument.exitPointerLockCalls).toBe(1);
  });
});
