import type { BlockKind } from "../domain/types";

export interface InputFrame {
  moveX: number;
  moveForward: number;
  lookX: number;
  lookY: number;
  jump: boolean;
  place: boolean;
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

export class GameInput {
  private readonly pressedKeys = new Set<string>();
  private mobileMoveX = 0;
  private mobileMoveForward = 0;
  private lookX = 0;
  private lookY = 0;
  private jumpQueued = false;
  private placeQueued = false;
  private removeQueued = false;
  private removeHeld = false;
  private rotateQueued = false;
  private manualProductionQueued = false;
  private resetBayQueued = false;
  private kindQueued: BlockKind | null = null;
  private colorDeltaQueued = 0;
  private joystickPointer: number | null = null;
  private lookPointer: number | null = null;
  private lastLookX = 0;
  private lastLookY = 0;

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

    const result = this.elements.canvas.requestPointerLock();
    if (result instanceof Promise) {
      void result.catch(() => this.onPointerLockChange(false));
    }
  }

  consumeFrame(): InputFrame {
    const keyMoveX =
      Number(this.pressedKeys.has("KeyD") || this.pressedKeys.has("ArrowRight")) -
      Number(this.pressedKeys.has("KeyA") || this.pressedKeys.has("ArrowLeft"));
    const keyMoveForward =
      Number(this.pressedKeys.has("KeyW") || this.pressedKeys.has("ArrowUp")) -
      Number(this.pressedKeys.has("KeyS") || this.pressedKeys.has("ArrowDown"));

    const frame: InputFrame = {
      moveX: clamp(keyMoveX + this.mobileMoveX, -1, 1),
      moveForward: clamp(keyMoveForward + this.mobileMoveForward, -1, 1),
      lookX: this.lookX,
      lookY: this.lookY,
      jump: this.jumpQueued,
      place: this.placeQueued,
      remove: this.removeQueued,
      removeHeld: this.removeHeld,
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
    this.removeQueued = false;
    this.removeHeld = false;
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
      this.pressedKeys.add(event.code);
      if (event.code === "Space" && !event.repeat) {
        this.jumpQueued = true;
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
        this.removeQueued = true;
        this.removeHeld = true;
      }
    });
    document.addEventListener("pointerup", (event) => {
      if (event.button === 2) {
        this.removeHeld = false;
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
      if (document.pointerLockElement !== this.elements.canvas) {
        this.resetTransientState();
      }
      this.onPointerLockChange(
        document.pointerLockElement === this.elements.canvas,
      );
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
  element.addEventListener("pointerdown", (event) => {
    action();
    event.preventDefault();
    event.stopPropagation();
  });
}

function bindHoldAction(
  element: HTMLElement,
  start: () => void,
  end: () => void,
): void {
  element.addEventListener("pointerdown", (event) => {
    element.setPointerCapture(event.pointerId);
    start();
    event.preventDefault();
    event.stopPropagation();
  });
  element.addEventListener("pointerup", end);
  element.addEventListener("pointercancel", end);
  element.addEventListener("lostpointercapture", end);
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
