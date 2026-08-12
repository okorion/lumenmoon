import {
  collidesAt,
  isGrounded,
  PLAYER_EYE_HEIGHT,
  resolvePlayerMotion,
  type CollisionSource,
} from "../domain/collision";
import type { Vector3Like } from "../domain/types";
import type { InputFrame } from "../input/GameInput";

const WALK_SPEED = 4.4;
const JUMP_SPEED = 7.4;
const GRAVITY = 21;
const MAX_PITCH = Math.PI * 0.48;

export class PlayerController {
  readonly position: Vector3Like;
  yaw = 0;
  pitch = -0.08;
  private verticalVelocity = 0;
  private grounded = false;

  constructor(
    private readonly collisionSource: CollisionSource,
    private spawn: Vector3Like,
  ) {
    this.position = { ...spawn };
    this.respawn();
  }

  /** 모드가 권위적인 시작 위치를 늦게 받는 경우 spawn과 위치를 함께 갱신한다. */
  setSpawn(spawn: Vector3Like, respawn = false): void {
    this.spawn = { ...spawn };
    if (respawn) {
      this.respawn();
    }
  }

  update(deltaSeconds: number, input: InputFrame): void {
    const delta = Math.min(deltaSeconds, 0.05);
    this.yaw -= input.lookX;
    this.pitch = clamp(this.pitch - input.lookY, -MAX_PITCH, MAX_PITCH);

    if (input.jump && this.grounded) {
      this.verticalVelocity = JUMP_SPEED;
      this.grounded = false;
    }
    this.verticalVelocity -= GRAVITY * delta;

    const forwardX = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    let moveX = rightX * input.moveX + forwardX * input.moveForward;
    let moveZ = rightZ * input.moveX + forwardZ * input.moveForward;
    const moveLength = Math.hypot(moveX, moveZ);
    if (moveLength > 1) {
      moveX /= moveLength;
      moveZ /= moveLength;
    }

    const motion = resolvePlayerMotion(
      this.collisionSource,
      this.position,
      {
        x: moveX * WALK_SPEED * delta,
        y: this.verticalVelocity * delta,
        z: moveZ * WALK_SPEED * delta,
      },
      this.grounded,
    );
    this.position.x = motion.position.x;
    this.position.y = motion.position.y;
    this.position.z = motion.position.z;

    if (motion.hitVertical) {
      this.verticalVelocity = 0;
    }
    this.grounded = isGrounded(this.collisionSource, this.position);

    if (this.position.y < -12) {
      this.respawn();
    }
  }

  get cameraPosition(): Vector3Like {
    return {
      x: this.position.x,
      y: this.position.y + PLAYER_EYE_HEIGHT,
      z: this.position.z,
    };
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  respawn(): void {
    const safePosition = findSafeRespawn(this.collisionSource, this.spawn);
    this.position.x = safePosition.x;
    this.position.y = safePosition.y;
    this.position.z = safePosition.z;
    this.verticalVelocity = 0;
    this.grounded = isGrounded(this.collisionSource, this.position);
  }

  /** 기록관의 `찾아가기`처럼 검증된 안전 위치로 즉시 안내할 때 사용한다. */
  teleport(position: Vector3Like): boolean {
    if (
      collidesAt(this.collisionSource, position) ||
      !isGrounded(this.collisionSource, position)
    ) {
      return false;
    }
    this.position.x = position.x;
    this.position.y = position.y;
    this.position.z = position.z;
    this.verticalVelocity = 0;
    this.grounded = true;
    return true;
  }
}

function findSafeRespawn(
  source: CollisionSource,
  origin: Vector3Like,
): Vector3Like {
  for (let lift = 0; lift <= 50; lift += 1) {
    for (let radius = 0; radius <= 8; radius += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        for (let offsetZ = -radius; offsetZ <= radius; offsetZ += 1) {
          if (Math.max(Math.abs(offsetX), Math.abs(offsetZ)) !== radius) {
            continue;
          }
          const candidate = {
            x: origin.x + offsetX,
            y: origin.y + lift,
            z: origin.z + offsetZ,
          };
          if (!collidesAt(source, candidate) && isGrounded(source, candidate)) {
            return candidate;
          }
        }
      }
    }
  }

  return { x: origin.x, y: origin.y + 51, z: origin.z };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
