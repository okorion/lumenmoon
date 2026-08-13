import type { BlockKind } from "../domain/types";

export interface InputFrame {
  moveX: number;
  moveForward: number;
  lookX: number;
  lookY: number;
  jump: boolean;
  place: boolean;
  inspectOwner: boolean;
  remove: boolean;
  removeHeld: boolean;
  rotate: boolean;
  manualProduction: boolean;
  resetBay: boolean;
  selectKind: BlockKind | null;
  colorDelta: number;
}

export interface InputElements {
  canvas: HTMLCanvasElement;
  joystick: HTMLElement;
  joystickKnob: HTMLElement;
  lookZone: HTMLElement;
  placeButton: HTMLButtonElement;
  removeButton: HTMLButtonElement;
  jumpButton: HTMLButtonElement;
  rotateButton: HTMLButtonElement;
}

export type UtilityAction = "manual-production" | "reset-bay";

const KEYBOARD_LOOK_DELTA = 0.035;
const INTERACTIVE_KEYBOARD_TARGET = [
  "a[href]",
  "area[href]",
  "audio[controls]",
  "button",
  "dialog",
  "input",
  "select",
  "summary",
  "textarea",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='textbox']",
  "[tabindex]",
].join(",");

export class GameInput {
  private readonly pressedKeys = new Set<string>();
  private mobileMoveX = 0;
  private mobileMoveForward = 0;
  private lookX = 0;
  private lookY = 0;
  private jumpQueued = false;
  private placeQueued = false;
  private inspectOwnerQueued = false;
  private removeQueued = false;
  private removeHeld = false;
  private keyboardRemoveHeld = false;
  private rotateQueued = false;
  private manualProductionQueued = false;
  private resetBayQueued = false;
  private kindQueued: BlockKind | null = null;
  private colorDeltaQueued = 0;
  private joystickPointer: number | null = null;
  private lookPointer: number | null = null;
  private lastLookX = 0;
  private lastLookY = 0;
  private wantsPointerLock = false;

  constructor(
    private readonly elements: InputElements,
    private readonly touchMode: boolean,
    private readonly onPointerLockChange: (locked: boolean) => void,
  ) {
    this.bindKeyboard();
    this.bindDesktopPointer();
    this.bindMobilePointer();
  }

  begin(): void {
    if (this.touchMode) {
      this.onPointerLockChange(true);
      return;
    }

    this.wantsPointerLock = true;
    const result = this.elements.canvas.requestPointerLock();
    if (result instanceof Promise) {
      void result.catch(() => {
        this.wantsPointerLock = false;
        this.onPointerLockChange(false);
      });
    }
  }

  /**
   * Releases every active control before showing a clickable recovery surface.
   * Pointer Lock must be exited explicitly; clearing queued input alone leaves
   * the cursor captured by the canvas on desktop browsers.
   */
  release(): void {
    this.wantsPointerLock = false;
    this.resetTransientState();
    if (this.touchMode) {
      this.onPointerLockChange(false);
      return;
    }
    if (document.pointerLockElement === this.elements.canvas) {
      document.exitPointerLock();
    }
  }

  consumeFrame(): InputFrame {
    const keyMoveX =
      Number(this.pressedKeys.has("KeyD") || this.pressedKeys.has("ArrowRight")) -
      Number(this.pressedKeys.has("KeyA") || this.pressedKeys.has("ArrowLeft"));
    const keyMoveForward =
      Number(this.pressedKeys.has("KeyW") || this.pressedKeys.has("ArrowUp")) -
      Number(this.pressedKeys.has("KeyS") || this.pressedKeys.has("ArrowDown"));
    const keyboardLookX =
      Number(this.pressedKeys.has("KeyL")) -
      Number(this.pressedKeys.has("KeyJ"));
    const keyboardLookY =
      Number(this.pressedKeys.has("KeyK")) -
      Number(this.pressedKeys.has("KeyU"));

    const frame: InputFrame = {
      moveX: clamp(keyMoveX + this.mobileMoveX, -1, 1),
      moveForward: clamp(keyMoveForward + this.mobileMoveForward, -1, 1),
      lookX: this.lookX + keyboardLookX * KEYBOARD_LOOK_DELTA,
      lookY: this.lookY + keyboardLookY * KEYBOARD_LOOK_DELTA,
      jump: this.jumpQueued,
      place: this.placeQueued,
      inspectOwner: this.inspectOwnerQueued,
      remove: this.removeQueued,
      removeHeld: this.removeHeld || this.keyboardRemoveHeld,
      rotate: this.rotateQueued,
      manualProduction: this.manualProductionQueued,
      resetBay: this.resetBayQueued,
      selectKind: this.kindQueued,
      colorDelta: this.colorDeltaQueued,
    };

    this.lookX = 0;
    this.lookY = 0;
    this.jumpQueued = false;
    this.placeQueued = false;
    this.inspectOwnerQueued = false;
    this.removeQueued = false;
    this.rotateQueued = false;
    this.manualProductionQueued = false;
    this.resetBayQueued = false;
    this.kindQueued = null;
    this.colorDeltaQueued = 0;
    return frame;
  }

  /**
   * Clears input that must never survive a tab switch, rotation, or pointer-lock
   * transition. In particular, mobile pointer cancellation is not guaranteed on
   * every browser when the page is backgrounded.
   */
  resetTransientState(): void {
    this.pressedKeys.clear();
    this.mobileMoveX = 0;
    this.mobileMoveForward = 0;
    this.lookX = 0;
    this.lookY = 0;
    this.jumpQueued = false;
    this.placeQueued = false;
    this.inspectOwnerQueued = false;
    this.removeQueued = false;
    this.removeHeld = false;
    this.keyboardRemoveHeld = false;
    this.rotateQueued = false;
    this.manualProductionQueued = false;
    this.resetBayQueued = false;
    this.kindQueued = null;
    this.colorDeltaQueued = 0;
    releaseCapturedPointer(this.elements.joystick, this.joystickPointer);
    releaseCapturedPointer(this.elements.lookZone, this.lookPointer);
    this.joystickPointer = null;
    this.lookPointer = null;
    this.elements.joystickKnob.style.transform = "translate(0px, 0px)";
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", (event) => {
      if (
        event.isComposing ||
        isInteractiveKeyboardTarget(event.target, this.elements.canvas)
      ) {
        return;
      }

      if (
        event.code === "Escape" &&
        document.pointerLockElement === this.elements.canvas
      ) {
        event.preventDefault();
        this.release();
        return;
      }

      this.pressedKeys.add(event.code);
      if (event.code === "Space" && !event.repeat) {
        this.jumpQueued = true;
        event.preventDefault();
      }
      if (event.code === "Enter" && !event.repeat) {
        this.placeQueued = true;
        event.preventDefault();
      }
      if (event.code === "Delete") {
        if (!event.repeat) {
          this.removeQueued = true;
        }
        this.keyboardRemoveHeld = true;
        event.preventDefault();
      }
      if (event.code === "KeyR" && !event.repeat) {
        this.rotateQueued = true;
      }
      if (!event.repeat) {
        const utilityAction = desktopUtilityShortcut(event.code);
        this.manualProductionQueued ||= utilityAction === "manual-production";
        this.resetBayQueued ||= utilityAction === "reset-bay";
      }
      if (!event.repeat) {
        this.kindQueued = desktopKindShortcut(event.code) ?? this.kindQueued;
        if (event.code === "KeyQ") {
          this.colorDeltaQueued -= 1;
        } else if (event.code === "KeyE") {
          this.colorDeltaQueued += 1;
        }
      }
    });
    window.addEventListener("keyup", (event) => {
      this.pressedKeys.delete(event.code);
      if (event.code === "Delete") {
        this.keyboardRemoveHeld = false;
      }
    });
    window.addEventListener("blur", () => this.resetTransientState());
    window.addEventListener("orientationchange", () =>
      this.resetTransientState(),
    );
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.resetTransientState();
      }
    });
  }

  private bindDesktopPointer(): void {
    this.elements.canvas.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse") {
        return;
      }
      if (document.pointerLockElement !== this.elements.canvas) {
        this.begin();
        return;
      }
      if (event.button === 0) {
        this.placeQueued = true;
      } else if (event.button === 2) {
        // Desktop secondary click is reserved for the aimed block's public
        // creator summary. Removal remains an explicit Delete hold so an
        // information request can never mutate the world by accident.
        this.inspectOwnerQueued = true;
      }
    });
    this.elements.canvas.addEventListener("contextmenu", (event) =>
      event.preventDefault(),
    );
    document.addEventListener("mousemove", (event) => {
      if (document.pointerLockElement !== this.elements.canvas) {
        return;
      }
      this.lookX += event.movementX * 0.0021;
      this.lookY += event.movementY * 0.0021;
    });
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === this.elements.canvas;
      // requestPointerLock 승인이 RPC 실패보다 늦게 도착해도 복구 화면을
      // 다시 잠그지 않는다.
      if (locked && !this.wantsPointerLock) {
        document.exitPointerLock();
        this.onPointerLockChange(false);
        return;
      }
      if (!locked) {
        this.wantsPointerLock = false;
        this.resetTransientState();
      }
      this.onPointerLockChange(locked);
    });
  }

  private bindMobilePointer(): void {
    this.elements.joystick.addEventListener("pointerdown", (event) => {
      if (this.joystickPointer !== null) {
        return;
      }
      this.joystickPointer = event.pointerId;
      this.elements.joystick.setPointerCapture(event.pointerId);
      this.updateJoystick(event.clientX, event.clientY);
      event.preventDefault();
    });
    this.elements.joystick.addEventListener("pointermove", (event) => {
      if (event.pointerId !== this.joystickPointer) {
        return;
      }
      this.updateJoystick(event.clientX, event.clientY);
      event.preventDefault();
    });
    const releaseJoystick = (event: PointerEvent): void => {
      if (event.pointerId !== this.joystickPointer) {
        return;
      }
      this.joystickPointer = null;
      this.mobileMoveX = 0;
      this.mobileMoveForward = 0;
      this.elements.joystickKnob.style.transform = "translate(0px, 0px)";
    };
    this.elements.joystick.addEventListener("pointerup", releaseJoystick);
    this.elements.joystick.addEventListener("pointercancel", releaseJoystick);
    this.elements.joystick.addEventListener(
      "lostpointercapture",
      releaseJoystick,
    );

    this.elements.lookZone.addEventListener("pointerdown", (event) => {
      if (this.lookPointer !== null) {
        return;
      }
      this.lookPointer = event.pointerId;
      this.lastLookX = event.clientX;
      this.lastLookY = event.clientY;
      this.elements.lookZone.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    this.elements.lookZone.addEventListener("pointermove", (event) => {
      if (event.pointerId !== this.lookPointer) {
        return;
      }
      this.lookX += (event.clientX - this.lastLookX) * 0.0042;
      this.lookY += (event.clientY - this.lastLookY) * 0.0042;
      this.lastLookX = event.clientX;
      this.lastLookY = event.clientY;
      event.preventDefault();
    });
    const releaseLook = (event: PointerEvent): void => {
      if (event.pointerId === this.lookPointer) {
        this.lookPointer = null;
      }
    };
    this.elements.lookZone.addEventListener("pointerup", releaseLook);
    this.elements.lookZone.addEventListener("pointercancel", releaseLook);
    this.elements.lookZone.addEventListener("lostpointercapture", releaseLook);

    bindAction(this.elements.placeButton, () => {
      this.placeQueued = true;
    });
    bindHoldAction(
      this.elements.removeButton,
      () => {
        this.removeQueued = true;
        this.removeHeld = true;
      },
      () => {
        this.removeHeld = false;
      },
    );
    bindAction(this.elements.jumpButton, () => {
      this.jumpQueued = true;
    });
    bindAction(this.elements.rotateButton, () => {
      this.rotateQueued = true;
    });
  }

  private updateJoystick(clientX: number, clientY: number): void {
    const rect = this.elements.joystick.getBoundingClientRect();
    const radius = Math.max(1, rect.width * 0.34);
    const rawX = clientX - (rect.left + rect.width / 2);
    const rawY = clientY - (rect.top + rect.height / 2);
    const length = Math.hypot(rawX, rawY);
    const scale = length > radius ? radius / length : 1;
    const x = rawX * scale;
    const y = rawY * scale;
    this.mobileMoveX = x / radius;
    this.mobileMoveForward = -y / radius;
    this.elements.joystickKnob.style.transform =
      "translate(" + String(x) + "px, " + String(y) + "px)";
  }
}

function bindAction(element: HTMLElement, action: () => void): void {
  let pointerActionPending = false;
  element.addEventListener("pointerdown", (event) => {
    pointerActionPending = true;
    action();
    event.preventDefault();
    event.stopPropagation();
  });
  element.addEventListener("click", (event) => {
    if (pointerActionPending && event.detail !== 0) {
      pointerActionPending = false;
      return;
    }
    pointerActionPending = false;
    action();
  });
}

function bindHoldAction(
  element: HTMLElement,
  start: () => void,
  end: () => void,
): void {
  let pointerActionPending = false;
  element.addEventListener("pointerdown", (event) => {
    pointerActionPending = true;
    element.setPointerCapture(event.pointerId);
    start();
    event.preventDefault();
    event.stopPropagation();
  });
  element.addEventListener("pointerup", end);
  element.addEventListener("pointercancel", end);
  element.addEventListener("lostpointercapture", end);
  element.addEventListener("click", (event) => {
    if (pointerActionPending && event.detail !== 0) {
      pointerActionPending = false;
      return;
    }
    pointerActionPending = false;
    start();
    end();
  });
}

function isInteractiveKeyboardTarget(
  target: EventTarget | null,
  gameCanvas: HTMLCanvasElement,
): boolean {
  if (target === null || target === gameCanvas) {
    return false;
  }

  const candidate = target as EventTarget & {
    closest?: (selectors: string) => Element | null;
  };
  return (
    typeof candidate.closest === "function" &&
    candidate.closest(INTERACTIVE_KEYBOARD_TARGET) !== null
  );
}

function releaseCapturedPointer(
  element: HTMLElement,
  pointerId: number | null,
): void {
  if (pointerId === null || !element.hasPointerCapture(pointerId)) {
    return;
  }
  element.releasePointerCapture(pointerId);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function desktopKindShortcut(code: string): BlockKind | null {
  if (code === "Digit1" || code === "Numpad1") {
    return "cube";
  }
  if (code === "Digit2" || code === "Numpad2") {
    return "stair";
  }
  if (code === "Digit3" || code === "Numpad3") {
    return "light";
  }
  return null;
}

export function desktopUtilityShortcut(code: string): UtilityAction | null {
  if (code === "KeyF") {
    return "manual-production";
  }
  if (code === "KeyX") {
    return "reset-bay";
  }
  return null;
}
