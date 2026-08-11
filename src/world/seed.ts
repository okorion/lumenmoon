import {
  LOCAL_PLAYER,
  SYSTEM_OWNER,
  WORLD_ID,
  type BlockKind,
  type BlockOwner,
  type BlockRotation,
  type GridPosition,
  type VoxelBlock,
  type WorldSnapshot,
  type ZoneKind,
} from "../domain/types";
import { createStarterBayLayout } from "../domain/starterBay";
import {
  DEFAULT_GAME_RULES,
  createLocalPlayerProgress,
  grantInitialInventory,
  type GameRulesConfig,
} from "../domain/progression";
import { createInitialLocalMissionWorldState } from "../domain/mission";

const DAWN_OWNER: BlockOwner = {
  id: "sample-dawn",
  publicId: "#M2Q8",
  nickname: "새벽의 수달",
  emblem: "☼",
};

const TIDE_OWNER: BlockOwner = {
  id: "sample-tide",
  publicId: "#P4L1",
  nickname: "푸른 제비",
  emblem: "◈",
};

function createBlock(
  prefix: string,
  position: GridPosition,
  colorIndex: number,
  owner: BlockOwner,
  zone: ZoneKind,
  kind: BlockKind = "cube",
  rotation: BlockRotation = 0,
): VoxelBlock {
  return {
    id: [prefix, position.x, position.y, position.z].join("-"),
    worldId: WORLD_ID,
    position,
    kind,
    rotation,
    colorIndex,
    owner,
    zone,
    createdAt: 1_723_000_000_000 + position.x * 101 + position.z * 17 + position.y,
  };
}

export function createSeedSnapshot(
  now = Date.now(),
  config: Readonly<GameRulesConfig> = DEFAULT_GAME_RULES,
): WorldSnapshot {
  const blocks: VoxelBlock[] = [];

  for (let x = -12; x <= 12; x += 1) {
    for (let z = -12; z <= 15; z += 1) {
      const isPath = Math.abs(x) <= 1 && z >= 3;
      const isBay = z >= 6 && z <= 14 && Math.abs(x) <= 7;
      const color = isPath ? 10 : isBay ? 0 : (Math.abs(x + z) % 2 === 0 ? 1 : 7);
      blocks.push(
        createBlock("ground", { x, y: 0, z }, color, SYSTEM_OWNER, "system"),
      );
    }
  }

  blocks.push(
    createBlock(
      "public-sample-a",
      { x: -7, y: 1, z: 1 },
      2,
      DAWN_OWNER,
      "public",
      "stair",
      1,
    ),
    createBlock(
      "public-sample-b",
      { x: -7, y: 1, z: 2 },
      2,
      DAWN_OWNER,
      "public",
    ),
    createBlock(
      "public-sample-c",
      { x: 7, y: 1, z: 0 },
      6,
      TIDE_OWNER,
      "public",
      "light",
    ),
  );

  const occupied = new Set(
    blocks.map(({ position }) => `${position.x},${position.y},${position.z}`),
  );
  for (const block of createStarterBaySystemBlocks(0)) {
    const key = `${block.position.x},${block.position.y},${block.position.z}`;
    if (!occupied.has(key)) {
      blocks.push(block);
      occupied.add(key);
    }
  }

  const progress = grantInitialInventory(
    createLocalPlayerProgress(now),
    config,
  );

  return {
    schemaVersion: 2,
    worldId: WORLD_ID,
    blocks,
    updatedAt: now,
    localState: {
      playerId: LOCAL_PLAYER.id,
      baySlotIndex: 0,
      progress,
    },
    localMissionState: createInitialLocalMissionWorldState(WORLD_ID, now),
  };
}

export function createStarterBaySystemBlocks(
  slotIndex: number,
): VoxelBlock[] {
  const layout = createStarterBayLayout(slotIndex);
  return layout.systemPlatform.map((position, index) =>
    createBlock(
      "starter-" + String(slotIndex) + "-" + String(index),
      position,
      layout.spawnPlatform.some(
        (spawn) => spawn.x === position.x && spawn.z === position.z,
      )
        ? 6
        : layout.path.some(
              (path) => path.x === position.x && path.z === position.z,
            )
          ? 10
          : (index + slotIndex) % 2 === 0
            ? 1
            : 7,
      SYSTEM_OWNER,
      "system",
    ),
  );
}

/** 온라인 월드에서 DB 행을 쓰지 않고 결정적으로 합성하는 중앙 지면과 불변 코어다. */
export function createCentralOnlineSystemBlocks(): VoxelBlock[] {
  const blocks: VoxelBlock[] = [];
  for (let x = -12; x <= 12; x += 1) {
    for (let z = -12; z <= 15; z += 1) {
      const color = Math.abs(x + z) % 2 === 0 ? 1 : 7;
      blocks.push(
        createBlock(
          "online-ground",
          { x, y: 0, z },
          color,
          SYSTEM_OWNER,
          "system",
        ),
      );
    }
  }

  for (let y = 1; y <= 7; y += 1) {
    blocks.push(
      createBlock(
        "online-tower-core",
        { x: 0, y, z: 0 },
        y === 7 ? 4 : y % 2 === 0 ? 8 : 9,
        SYSTEM_OWNER,
        "mission",
        y === 7 ? "light" : "cube",
      ),
    );
  }
  for (const [index, position] of [
    { x: -1, y: 1, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 0, y: 1, z: -1 },
    { x: 0, y: 1, z: 1 },
  ].entries()) {
    blocks.push(
      createBlock(
        "online-tower-step-" + String(index),
        position,
        8,
        SYSTEM_OWNER,
        "mission",
        "stair",
        index as BlockRotation,
      ),
    );
  }
  return blocks;
}
