import type { LocalPlayerProgress } from "./progression";
import type { LocalMissionWorldState } from "./mission";

export const CHUNK_SIZE = 16;
export const WORLD_ID = "mvp-local-1";

export type BlockKind = "cube" | "stair" | "light";
export type ZoneKind = "system" | "personal" | "producer" | "public" | "mission";
export type BlockRotation = 0 | 1 | 2 | 3;
export type BlockSource = "onboarding" | "inventory";

export interface GridPosition {
  x: number;
  y: number;
  z: number;
}

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface BlockOwner {
  id: string;
  publicId: string;
  nickname: string;
  emblem: string;
}

export interface VoxelBlock {
  id: string;
  worldId: string;
  position: GridPosition;
  kind: BlockKind;
  rotation: BlockRotation;
  colorIndex: number;
  owner: BlockOwner;
  zone: ZoneKind;
  createdAt: number;
  supportId?: string;
  source?: BlockSource;
}

export interface LocalGameState {
  playerId: string;
  baySlotIndex: number;
  progress: LocalPlayerProgress;
}

export interface WorldSnapshot {
  schemaVersion: 1 | 2;
  worldId: string;
  blocks: VoxelBlock[];
  updatedAt: number;
  localState?: LocalGameState;
  /** 로컬 모드의 공동 미션 원본 슬롯·완료 기록·멱등 처리 상태. */
  localMissionState?: LocalMissionWorldState;
}

export interface PaletteColor {
  name: string;
  value: number;
}

export const PALETTE: readonly PaletteColor[] = [
  { name: "구름", value: 0xe8edf2 },
  { name: "먹빛", value: 0x263244 },
  { name: "산호", value: 0xf36f62 },
  { name: "호박", value: 0xf2a65a },
  { name: "햇살", value: 0xf6d365 },
  { name: "이끼", value: 0x73a96b },
  { name: "민트", value: 0x67c9b3 },
  { name: "하늘", value: 0x66a9d9 },
  { name: "남빛", value: 0x4d68b1 },
  { name: "라일락", value: 0x9b78c6 },
  { name: "장미", value: 0xd86f9b },
  { name: "모래", value: 0xc9ad82 },
] as const;

export const LOCAL_PLAYER: BlockOwner = {
  id: "local-player",
  publicId: "#B7K2",
  nickname: "고요한 여우",
  emblem: "✦",
};

export const SYSTEM_OWNER: BlockOwner = {
  id: "system",
  publicId: "#WORLD",
  nickname: "하늘탑",
  emblem: "◇",
};
