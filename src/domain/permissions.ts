import type { VoxelBlock, ZoneKind } from "./types";

export const OTHER_PUBLIC_REMOVAL_HOLD_MS = 2_500;

export type PermissionZone = ZoneKind | "spawn";
export type PermissionReason =
  | "allowed"
  | "protected-zone"
  | "owner-only"
  | "hold-required"
  | "support-in-use";

export type SupportedVoxelBlock = VoxelBlock & { supportId?: string };
export type PermissionBlock = Omit<SupportedVoxelBlock, "zone"> & {
  zone: PermissionZone;
};

export interface PermissionDecision {
  allowed: boolean;
  requiresHold: boolean;
  holdMs: number;
  reason: PermissionReason;
  refundInventory: number;
}

export interface PlacementPermissionInput {
  actorId: string;
  zone: PermissionZone;
  /** Required for personal and producer zones. */
  zoneOwnerId?: string;
}

export interface RemovalPermissionInput {
  actorId: string;
  block: PermissionBlock;
  allBlocks: readonly PermissionBlock[];
  /** Required for personal and producer zones; falls back to the block owner. */
  zoneOwnerId?: string;
  /** Ephemeral progress supplied by the current gesture; it is never persisted here. */
  heldMs?: number;
}

const IMMEDIATE_ALLOW: PermissionDecision = {
  allowed: true,
  requiresHold: false,
  holdMs: 0,
  reason: "allowed",
  refundInventory: 0,
};

function deny(reason: Exclude<PermissionReason, "allowed">): PermissionDecision {
  return {
    allowed: false,
    requiresHold: false,
    holdMs: 0,
    reason,
    refundInventory: 0,
  };
}

function isProtectedZone(zone: PermissionZone): boolean {
  return zone === "mission" || zone === "system" || zone === "spawn";
}

function isPrivateZone(zone: PermissionZone): boolean {
  return zone === "personal" || zone === "producer";
}

export function decidePlacement(
  input: PlacementPermissionInput,
): PermissionDecision {
  if (isProtectedZone(input.zone)) {
    return deny("protected-zone");
  }

  if (isPrivateZone(input.zone) && input.actorId !== input.zoneOwnerId) {
    return deny("owner-only");
  }

  return { ...IMMEDIATE_ALLOW };
}

export function decideRemoval(input: RemovalPermissionInput): PermissionDecision {
  if (isProtectedZone(input.block.zone)) {
    return deny("protected-zone");
  }

  if (input.allBlocks.some((candidate) => candidate.supportId === input.block.id)) {
    return deny("support-in-use");
  }

  if (isPrivateZone(input.block.zone)) {
    const zoneOwnerId = input.zoneOwnerId ?? input.block.owner.id;
    if (input.actorId !== zoneOwnerId) {
      return deny("owner-only");
    }

    return {
      ...IMMEDIATE_ALLOW,
      refundInventory: input.actorId === input.block.owner.id ? 1 : 0,
    };
  }

  if (input.actorId === input.block.owner.id) {
    return { ...IMMEDIATE_ALLOW, refundInventory: 1 };
  }

  const heldMs =
    typeof input.heldMs === "number" && Number.isFinite(input.heldMs)
      ? Math.max(0, input.heldMs)
      : 0;

  return {
    allowed: heldMs >= OTHER_PUBLIC_REMOVAL_HOLD_MS,
    requiresHold: true,
    holdMs: OTHER_PUBLIC_REMOVAL_HOLD_MS,
    reason:
      heldMs >= OTHER_PUBLIC_REMOVAL_HOLD_MS ? "allowed" : "hold-required",
    refundInventory: 0,
  };
}
