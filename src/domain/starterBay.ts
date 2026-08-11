import type {
  BlockKind,
  BlockRotation,
  GridPosition,
  Vector3Like,
  VoxelBlock,
  ZoneKind,
} from "./types";

export const STARTER_BAY_SLOT_SPACING = 26;
export const STARTER_BAY_RESERVED_SLOT_COUNT = 64;

export type GuideGroup = "base" | "producer" | "upgrade";

export type GuideRole =
  | "floor"
  | "core"
  | "wall"
  | "roof"
  | "decoration"
  | "producer"
  | "upgrade";

export interface GuideCell {
  position: GridPosition;
  kind: BlockKind;
  rotation: BlockRotation;
  group: GuideGroup;
  /** 그룹 안에서 사용하는 1부터 시작하는 결정적 순서다. */
  order: number;
  role: GuideRole;
}

export interface StarterBaySlot {
  index: number;
  ring: number;
  ringOffset: number;
  origin: GridPosition;
  rotation: BlockRotation;
  /** 한 칸 전진할 때 중앙탑에 가까워지는 수평 단위 벡터다. */
  towardTower: GridPosition;
}

export interface StarterBayLayout {
  slot: StarterBaySlot;
  safeSpawn: Vector3Like;
  spawnPlatform: readonly GridPosition[];
  path: readonly GridPosition[];
  systemPlatform: readonly GridPosition[];
  baseGuides: readonly GuideCell[];
  producerGuides: readonly GuideCell[];
  upgradeGuides: readonly GuideCell[];
  guides: readonly GuideCell[];
  /** 시스템 발판과 모든 가이드가 차지하는 XZ 풋프린트다. */
  footprint: readonly GridPosition[];
}

export type BayPlacementZone = ZoneKind | "spawn";

export interface StarterBayZoneMatch {
  zone: BayPlacementZone;
  slotIndex: number | null;
}

interface LocalGuide {
  position: GridPosition;
  kind: BlockKind;
  rotation: BlockRotation;
  role: GuideRole;
}

interface RingCoordinate {
  x: number;
  z: number;
  rotation: BlockRotation;
}

const BASE_GUIDES: readonly LocalGuide[] = [
  ...createRectangle(-1, 1, -1, 1).map((position) => ({
    position: { ...position, y: 1 },
    kind: "cube" as const,
    rotation: 0 as const,
    role: "floor" as const,
  })),
  {
    position: { x: 0, y: 2, z: -1 },
    kind: "light",
    rotation: 0,
    role: "core",
  },
  {
    position: { x: -1, y: 2, z: -1 },
    kind: "cube",
    rotation: 0,
    role: "wall",
  },
  {
    position: { x: 1, y: 2, z: -1 },
    kind: "cube",
    rotation: 0,
    role: "wall",
  },
  {
    position: { x: -1, y: 2, z: 0 },
    kind: "cube",
    rotation: 0,
    role: "wall",
  },
  {
    position: { x: -1, y: 3, z: -1 },
    kind: "stair",
    rotation: 1,
    role: "roof",
  },
  {
    position: { x: 1, y: 3, z: -1 },
    kind: "stair",
    rotation: 3,
    role: "roof",
  },
  {
    position: { x: 1, y: 2, z: 0 },
    kind: "stair",
    rotation: 2,
    role: "decoration",
  },
];

const PRODUCER_GUIDES: readonly LocalGuide[] = [
  ...createRectangle(3, 4, -1, 0).map((position) => ({
    position: { ...position, y: 1 },
    kind: "cube" as const,
    rotation: 0 as const,
    role: "producer" as const,
  })),
  {
    position: { x: 3, y: 2, z: -1 },
    kind: "cube",
    rotation: 0,
    role: "producer",
  },
  {
    position: { x: 4, y: 2, z: -1 },
    kind: "cube",
    rotation: 0,
    role: "producer",
  },
  {
    position: { x: 3, y: 2, z: 0 },
    kind: "stair",
    rotation: 1,
    role: "producer",
  },
  {
    position: { x: 4, y: 2, z: 0 },
    kind: "light",
    rotation: 0,
    role: "producer",
  },
];

const UPGRADE_GUIDES: readonly LocalGuide[] = createPerimeter(2, 5, -2, 1).map(
  (position, index) => ({
    position: { ...position, y: 1 },
    kind: index === 5 || index === 9 ? ("light" as const) : ("cube" as const),
    rotation: 0,
    role: "upgrade" as const,
  }),
);

const LOCAL_SPAWN_PLATFORM: readonly GridPosition[] = createRectangle(
  -1,
  1,
  -4,
  -3,
);

const LOCAL_BAY_PLATFORM: readonly GridPosition[] = createRectangle(-2, 5, -2, 2);

const LOCAL_PATH: readonly GridPosition[] = Array.from({ length: 14 }, (_, index) => ({
  x: 0,
  y: 0,
  z: index + 3,
}));

export function getStarterBaySlot(index: number): StarterBaySlot {
  assertSlotIndex(index);

  let ring = 1;
  let precedingSlotCount = 0;
  while (index >= precedingSlotCount + ring * 8) {
    precedingSlotCount += ring * 8;
    ring += 1;
  }

  const ringOffset = index - precedingSlotCount;
  const coordinate = coordinateOnRing(ring, ringOffset);
  const origin = {
    x: coordinate.x * STARTER_BAY_SLOT_SPACING,
    y: 0,
    z: coordinate.z * STARTER_BAY_SLOT_SPACING,
  };
  const towardTower = rotateLocalPosition({ x: 0, y: 0, z: 1 }, coordinate.rotation);

  return {
    index,
    ring,
    ringOffset,
    origin,
    rotation: coordinate.rotation,
    towardTower,
  };
}

export function localToWorld(
  local: GridPosition,
  origin: GridPosition,
  rotation: BlockRotation,
): GridPosition {
  const rotated = rotateLocalPosition(local, rotation);
  return {
    x: origin.x + rotated.x,
    y: origin.y + rotated.y,
    z: origin.z + rotated.z,
  };
}

export function createStarterBayLayout(index: number): StarterBayLayout {
  const slot = getStarterBaySlot(index);
  const transformPosition = (position: GridPosition): GridPosition =>
    localToWorld(position, slot.origin, slot.rotation);

  const spawnPlatform = LOCAL_SPAWN_PLATFORM.map(transformPosition);
  const path = LOCAL_PATH.map(transformPosition);
  const systemPlatform = uniquePositions([
    ...LOCAL_BAY_PLATFORM.map(transformPosition),
    ...spawnPlatform,
    ...path,
  ]);
  const baseGuides = transformGuides(BASE_GUIDES, "base", slot);
  const producerGuides = transformGuides(PRODUCER_GUIDES, "producer", slot);
  const upgradeGuides = transformGuides(UPGRADE_GUIDES, "upgrade", slot);
  const guides = [...baseGuides, ...producerGuides, ...upgradeGuides];

  const localSpawn = { x: 0, y: 1, z: -3 };
  const spawnCell = transformPosition(localSpawn);
  const footprint = uniquePositions([
    ...systemPlatform,
    ...guides.map((guide) => ({
      x: guide.position.x,
      y: 0,
      z: guide.position.z,
    })),
  ]);

  return {
    slot,
    safeSpawn: {
      x: spawnCell.x + 0.5,
      y: spawnCell.y + 0.02,
      z: spawnCell.z + 0.5,
    },
    spawnPlatform,
    path,
    systemPlatform,
    baseGuides,
    producerGuides,
    upgradeGuides,
    guides,
    footprint,
  };
}

export function guideAtPosition(
  layout: StarterBayLayout,
  position: GridPosition,
): GuideCell | null {
  return (
    layout.guides.find((guide) => samePosition(guide.position, position)) ?? null
  );
}

export function countFilledGuides(
  guides: readonly GuideCell[],
  blocks: readonly VoxelBlock[],
  ownerId: string,
): number {
  const ownedPositions = new Set(
    blocks
      .filter((block) => block.owner.id === ownerId)
      .map((block) => positionKey(block.position)),
  );
  return guides.filter((guide) => ownedPositions.has(positionKey(guide.position)))
    .length;
}

export function classifyBayPlacementZone(
  layout: StarterBayLayout,
  position: GridPosition,
): BayPlacementZone {
  if (Math.abs(position.x) <= 6 && Math.abs(position.z) <= 6) {
    return "mission";
  }

  if (
    Math.abs(position.x - layout.slot.origin.x) > 18 ||
    Math.abs(position.z - layout.slot.origin.z) > 18
  ) {
    return "public";
  }

  if (matchesHorizontal(layout.spawnPlatform, position)) {
    return "spawn";
  }
  if (matchesHorizontal(layout.path, position)) {
    return "system";
  }
  if (
    matchesHorizontal(
      [...layout.producerGuides, ...layout.upgradeGuides].map(
        (guide) => guide.position,
      ),
      position,
    )
  ) {
    return "producer";
  }
  if (matchesHorizontal(layout.systemPlatform, position)) {
    return "personal";
  }
  return "public";
}

export function classifyStarterBayPosition(
  layouts: readonly StarterBayLayout[],
  position: GridPosition,
): StarterBayZoneMatch {
  if (Math.abs(position.x) <= 6 && Math.abs(position.z) <= 6) {
    return { zone: "mission", slotIndex: null };
  }

  for (const layout of layouts) {
    const zone = classifyBayPlacementZone(layout, position);
    if (zone !== "public" && zone !== "mission") {
      return { zone, slotIndex: layout.slot.index };
    }
  }
  return { zone: "public", slotIndex: null };
}

function transformGuides(
  guides: readonly LocalGuide[],
  group: GuideGroup,
  slot: StarterBaySlot,
): GuideCell[] {
  return guides.map((guide, index) => ({
    position: localToWorld(guide.position, slot.origin, slot.rotation),
    kind: guide.kind,
    rotation: rotateBlock(guide.rotation, slot.rotation),
    group,
    order: index + 1,
    role: guide.role,
  }));
}

function coordinateOnRing(ring: number, offset: number): RingCoordinate {
  let cursor = offset;

  const northLength = ring + 1;
  if (cursor < northLength) {
    return { x: cursor, z: -ring, rotation: 0 };
  }
  cursor -= northLength;

  const eastLength = ring * 2;
  if (cursor < eastLength) {
    return { x: ring, z: -ring + 1 + cursor, rotation: 1 };
  }
  cursor -= eastLength;

  const southLength = ring * 2;
  if (cursor < southLength) {
    return { x: ring - 1 - cursor, z: ring, rotation: 2 };
  }
  cursor -= southLength;

  const westLength = ring * 2;
  if (cursor < westLength) {
    return { x: -ring, z: ring - 1 - cursor, rotation: 3 };
  }
  cursor -= westLength;

  return { x: -ring + 1 + cursor, z: -ring, rotation: 0 };
}

function rotateLocalPosition(
  position: GridPosition,
  rotation: BlockRotation,
): GridPosition {
  let rotated: GridPosition;
  switch (rotation) {
    case 0:
      rotated = { ...position };
      break;
    case 1:
      rotated = { x: -position.z, y: position.y, z: position.x };
      break;
    case 2:
      rotated = { x: -position.x, y: position.y, z: -position.z };
      break;
    case 3:
      rotated = { x: position.z, y: position.y, z: -position.x };
      break;
  }

  return {
    x: canonicalZero(rotated.x),
    y: canonicalZero(rotated.y),
    z: canonicalZero(rotated.z),
  };
}

function canonicalZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function rotateBlock(
  localRotation: BlockRotation,
  slotRotation: BlockRotation,
): BlockRotation {
  return ((localRotation + slotRotation) % 4) as BlockRotation;
}

function createRectangle(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): GridPosition[] {
  const positions: GridPosition[] = [];
  for (let z = minZ; z <= maxZ; z += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      positions.push({ x, y: 0, z });
    }
  }
  return positions;
}

function createPerimeter(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): GridPosition[] {
  return createRectangle(minX, maxX, minZ, maxZ).filter(
    ({ x, z }) => x === minX || x === maxX || z === minZ || z === maxZ,
  );
}

function uniquePositions(positions: readonly GridPosition[]): GridPosition[] {
  const seen = new Set<string>();
  return positions.filter((position) => {
    const key = `${position.x},${position.y},${position.z}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function matchesHorizontal(
  positions: readonly GridPosition[],
  candidate: GridPosition,
): boolean {
  return positions.some(
    (position) => position.x === candidate.x && position.z === candidate.z,
  );
}

function samePosition(left: GridPosition, right: GridPosition): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function positionKey(position: GridPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function assertSlotIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("스타터 베이 슬롯 인덱스는 0 이상의 안전한 정수여야 합니다.");
  }
}
