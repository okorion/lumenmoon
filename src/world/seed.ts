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

const starterBaySystemBlockCache = new Map<number, readonly VoxelBlock[]>();

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
  const identity = createIdentitySeedSnapshot(now);
  const progress = grantInitialInventory(
    createLocalPlayerProgress(now),
    config,
  );

  return {
    ...identity,
    localState: {
      playerId: LOCAL_PLAYER.id,
      baySlotIndex: 0,
      progress,
    },
    localMissionState: createInitialLocalMissionWorldState(WORLD_ID, now),
    localFreeModeStates: [],
    localFreeModeRevision: 0,
  };
}

/** 모드 선택 전에는 공개 정체성과 공용 지형만 만들고 두 진행 상태는 만들지 않는다. */
export function createIdentitySeedSnapshot(now = Date.now()): WorldSnapshot {
  // 로컬과 온라인이 같은 결정적 광장·코어를 사용해야 저장소 모드를 바꿔도
  // 맵의 형태와 충돌 표면이 달라지지 않는다.
  const blocks: VoxelBlock[] = createCentralOnlineSystemBlocks();

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

  return {
    schemaVersion: 3,
    worldId: WORLD_ID,
    blocks,
    updatedAt: now,
    localState: {
      playerId: LOCAL_PLAYER.id,
      baySlotIndex: 0,
      progress: createLocalPlayerProgress(now),
    },
  };
}

export function createStarterBaySystemBlocks(
  slotIndex: number,
): VoxelBlock[] {
  const cached = starterBaySystemBlockCache.get(slotIndex);
  if (cached) return cached.slice();

  const layout = createStarterBayLayout(slotIndex);
  const spawnPositions = horizontalPositionSet(layout.spawnPlatform);
  const pathPositions = horizontalPositionSet(layout.path);
  const basePositions = horizontalPositionSet(
    layout.baseGuides.map(({ position }) => position),
  );
  const producerPositions = horizontalPositionSet(
    layout.producerGuides.map(({ position }) => position),
  );
  const upgradePositions = horizontalPositionSet(
    layout.upgradeGuides.map(({ position }) => position),
  );
  const blocks = layout.systemPlatform.map((position, index) =>
    createBlock(
      // 기존 ID를 유지해 저장본 비교와 제작자 카드의 시스템 대상이 흔들리지 않는다.
      "starter-" + String(slotIndex) + "-" + String(index),
      position,
      starterPlatformColorIndex({
        position,
        slotIndex,
        spawnPositions,
        pathPositions,
        basePositions,
        producerPositions,
        upgradePositions,
      }),
      SYSTEM_OWNER,
      "system",
    ),
  );
  starterBaySystemBlockCache.set(slotIndex, blocks);
  return blocks.slice();
}

/** 온라인 월드에서 DB 행을 쓰지 않고 결정적으로 합성하는 중앙 지면과 불변 코어다. */
export function createCentralOnlineSystemBlocks(): VoxelBlock[] {
  const blocks: VoxelBlock[] = [];
  for (let x = -12; x <= 12; x += 1) {
    for (let z = -12; z <= 15; z += 1) {
      blocks.push(
        createBlock(
          "online-ground",
          { x, y: 0, z },
          centralPlazaColorIndex(x, z),
          SYSTEM_OWNER,
          "system",
        ),
      );
    }
  }

  // 별빛 관문의 대칭 설계 면은 중심에서 다섯 칸 떨어져 있다. 코어와
  // 부유 광륜은 반지름 두 칸 안에만 두어 현재·다음 층의 미션 슬롯을 피한다.
  for (let y = 1; y <= 8; y += 1) {
    blocks.push(
      createBlock(
        "online-tower-core",
        { x: 0, y, z: 0 },
        y === 8 ? 4 : y % 3 === 0 ? 7 : y % 2 === 0 ? 8 : 9,
        SYSTEM_OWNER,
        "system",
        y === 8 ? "light" : "cube",
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
        "system",
        "stair",
        index as BlockRotation,
      ),
    );
  }

  // 두 칸마다 방향이 바뀌는 월석 날개가 가느다란 코어에 나선형
  // 실루엣을 만든다. 반지름 1 안에만 두어 공동 미션 공간은 비운다.
  for (const [index, position] of [
    { x: -1, y: 2, z: 0 },
    { x: 1, y: 2, z: 0 },
    { x: -1, y: 4, z: 0 },
    { x: 1, y: 4, z: 0 },
    { x: -1, y: 6, z: 0 },
    { x: 1, y: 6, z: 0 },
  ].entries()) {
    blocks.push(
      createBlock(
        "online-core-fin-" + String(index),
        position,
        index % 3 === 0 ? 9 : index % 2 === 0 ? 7 : 8,
        SYSTEM_OWNER,
        "system",
        "stair",
        (index % 4) as BlockRotation,
      ),
    );
  }

  for (const [index, position] of [
    { x: -1, y: 3, z: 0 },
    { x: 0, y: 4, z: 1 },
    { x: 1, y: 5, z: 0 },
    { x: 0, y: 6, z: -1 },
  ].entries()) {
    blocks.push(
      createBlock(
        "online-core-orbit-" + String(index),
        position,
        index % 2 === 0 ? 6 : 7,
        SYSTEM_OWNER,
        "system",
        "light",
      ),
    );
  }

  for (const [index, position] of [
    { x: -1, y: 7, z: 0 },
    { x: 1, y: 7, z: 0 },
    { x: 0, y: 7, z: -1 },
    { x: 0, y: 7, z: 1 },
  ].entries()) {
    blocks.push(
      createBlock(
        "online-core-crown-" + String(index),
        position,
        index % 2 === 0 ? 8 : 7,
        SYSTEM_OWNER,
        "system",
        "stair",
        index as BlockRotation,
      ),
    );
  }

  return blocks;
}

interface StarterPlatformColorContext {
  position: GridPosition;
  slotIndex: number;
  spawnPositions: ReadonlySet<string>;
  pathPositions: ReadonlySet<string>;
  basePositions: ReadonlySet<string>;
  producerPositions: ReadonlySet<string>;
  upgradePositions: ReadonlySet<string>;
}

function starterPlatformColorIndex({
  position,
  slotIndex,
  spawnPositions,
  pathPositions,
  basePositions,
  producerPositions,
  upgradePositions,
}: StarterPlatformColorContext): number {
  const key = horizontalPositionKey(position);
  if (pathPositions.has(key)) {
    return Math.abs(position.x + position.z + slotIndex) % 5 === 0 ? 4 : 8;
  }
  if (spawnPositions.has(key)) {
    return Math.abs(position.x + position.z + slotIndex) % 2 === 0 ? 9 : 7;
  }
  if (producerPositions.has(key)) {
    return Math.abs(position.x + position.z) % 3 === 0 ? 6 : 8;
  }
  if (basePositions.has(key)) {
    return Math.abs(position.x + position.z) % 3 === 0 ? 0 : 9;
  }
  if (upgradePositions.has(key)) {
    return Math.abs(position.x - position.z) % 2 === 0 ? 8 : 1;
  }
  return Math.abs(position.x + position.z + slotIndex) % 2 === 0 ? 1 : 7;
}

function centralPlazaColorIndex(x: number, z: number): number {
  const absX = Math.abs(x);
  const absZ = Math.abs(z);
  const radius = Math.max(absX, absZ);
  const onGateFoundation =
    (absX === 5 && absZ <= 3) || (absZ === 5 && absX <= 3);
  if (onGateFoundation) {
    return (absX + absZ) % 3 === 0 ? 4 : 0;
  }

  const onApproach =
    (absX <= 1 && absZ >= 6) || (absZ <= 1 && absX >= 6);
  if (onApproach) {
    return radius % 5 === 0 ? 4 : 8;
  }

  const onHalo = radius === 7 || radius === 11;
  if (onHalo) {
    return radius === 7 ? 9 : 6;
  }

  const onConstellationNode =
    (absX === 3 && absZ === 3) ||
    (absX === 9 && absZ === 3) ||
    (absX === 3 && absZ === 9);
  if (onConstellationNode) {
    return 7;
  }

  // 넓은 바닥은 한 가지 남청 월석으로 비워 두고, 접근로·광륜·별자리
  // 결절에만 색을 사용한다. 질감의 미세 변화가 반복감을 대신한다.
  return 1;
}

function horizontalPositionSet(
  positions: readonly GridPosition[],
): ReadonlySet<string> {
  return new Set(positions.map(horizontalPositionKey));
}

function horizontalPositionKey(position: GridPosition): string {
  return `${position.x},${position.z}`;
}
