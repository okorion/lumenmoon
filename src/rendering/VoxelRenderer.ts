import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  addGridPositions,
  chunkKey,
  parseChunkKey,
  toChunkCoordinate,
  worldCenter,
  type ChunkCoordinate,
} from "../domain/grid";
import {
  PALETTE,
  type GridPosition,
  type Vector3Like,
  type VoxelBlock,
} from "../domain/types";
import type { VoxelWorld } from "../domain/world";
import type { GuideCell, GuideGroup } from "../domain/starterBay";
import type {
  MissionDisplayBlock,
  MissionGlowPercent,
  MissionStagePercent,
} from "../domain/mission";
import {
  createCreatorCrest,
  type CreatorCrestDesign,
  type CreatorCrestIdentity,
  type UiIconName,
} from "../ui/icons";

interface CubeFace {
  normal: GridPosition;
  corners: readonly (readonly [number, number, number])[];
}

export interface PickResult {
  block: VoxelBlock;
  normal: Vector3Like;
  distance: number;
  mission?: MissionPickMetadata;
}

export type MissionVisualStage = MissionGlowPercent;

export interface MissionPickMetadata {
  instanceId: string;
  missionName: string;
  layer: number;
  canonicalContributionId: string;
  sourceId: string;
  visualId: string;
  position: GridPosition;
  isReplica: boolean;
  symmetryQuarter: 0 | 1 | 2 | 3;
}

export interface MissionVisualBlock extends MissionPickMetadata {
  sourceBlock: VoxelBlock;
  kind: VoxelBlock["kind"];
  rotation: VoxelBlock["rotation"];
  colorIndex: number;
  stage: MissionVisualStage;
}

export interface MissionVisualState {
  instanceId: string;
  stage: MissionStagePercent;
  anchor: Vector3Like;
  blocks: readonly MissionVisualBlock[];
}

export interface MissionSlotPreview {
  slotIndex: number;
  position: GridPosition;
  selected: boolean;
}

export interface MissionContributorLightVisual {
  publicId: string;
  nickname: string;
  emblem: string;
  position: Vector3Like;
}

export function missionContributorCrestDesign(
  identity: Readonly<CreatorCrestIdentity>,
): CreatorCrestDesign {
  return createCreatorCrest(identity);
}

export function selectMissionFocusVisual(
  visuals: readonly MissionVisualBlock[],
  publicId: string,
  canonicalContributionId?: string,
): MissionVisualBlock | undefined {
  const owned = visuals.filter(
    (visual) => visual.sourceBlock.owner.publicId === publicId,
  );
  if (canonicalContributionId) {
    const matching = owned.filter(
      (visual) =>
        visual.canonicalContributionId === canonicalContributionId,
    );
    return matching.find(({ isReplica }) => !isReplica) ?? matching[0];
  }
  return owned.find(({ isReplica }) => !isReplica) ?? owned[0];
}

interface MissionMeshRecord {
  mesh: THREE.InstancedMesh;
  material: THREE.MeshStandardMaterial;
  ownerPublicId: string;
  stage: MissionVisualStage;
  visuals: readonly MissionVisualBlock[];
}

interface MissionCinematic {
  focus: THREE.Vector3;
  startedAt: number;
  durationMs: number;
  startPosition: THREE.Vector3;
  onComplete?: () => void;
}

interface PlayerPose {
  position: Vector3Like;
  yaw: number;
  pitch: number;
}

export interface RendererPerformanceSnapshot {
  framesPerSecond: number;
  drawCalls: number;
  triangles: number;
  visibleBlockCount: number;
  activeChunkCount: number;
  sceneObjectCount: number;
  geometries: number;
  textures: number;
  pixelRatio: number;
}

export interface RendererVisualBudget {
  atlasSize: number;
  atlasTilesPerAxis: number;
  starCount: number;
  anisotropyCap: number;
  skyWidthSegments: number;
  skyHeightSegments: number;
}

export interface LumenSurfaceAtlasData {
  size: number;
  albedo: Uint8Array;
  surface: Uint8Array;
  emissive: Uint8Array;
}

export interface GuideInstanceBatch {
  key: string;
  kind: GuideCell["kind"];
  group: GuideGroup;
  guides: readonly GuideCell[];
}

interface LumenSurfaceTextures {
  albedo: THREE.DataTexture;
  surface: THREE.DataTexture;
  emissive: THREE.DataTexture;
}

export const LUMEN_SURFACE_ASSET_URLS = Object.freeze({
  albedo: "/textures/lumenmoon-moonstone-v1.webp",
  normal: "/textures/lumenmoon-moonstone-normal-v1.webp",
});

const FACE_UV_CORNERS = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
] as const;

const CUBE_FACES: readonly CubeFace[] = [
  {
    normal: { x: 1, y: 0, z: 0 },
    corners: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
  },
  {
    normal: { x: -1, y: 0, z: 0 },
    corners: [
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
      [0, 0, 0],
    ],
  },
  {
    normal: { x: 0, y: 1, z: 0 },
    corners: [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
  },
  {
    normal: { x: 0, y: -1, z: 0 },
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
  },
  {
    normal: { x: 0, y: 0, z: 1 },
    corners: [
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
      [0, 0, 1],
    ],
  },
  {
    normal: { x: 0, y: 0, z: -1 },
    corners: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
  },
] as const;

export class VoxelRenderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(72, 1, 0.05, 180);
  readonly renderer: THREE.WebGLRenderer;

  private readonly worldRoot = new THREE.Group();
  private readonly guideRoot = new THREE.Group();
  private readonly missionRoot = new THREE.Group();
  private readonly missionEffectRoot = new THREE.Group();
  private readonly missionPreviewRoot = new THREE.Group();
  private readonly contributorLightRoot = new THREE.Group();
  private readonly environmentRoot = new THREE.Group();
  private readonly chunkGroups = new Map<string, THREE.Group>();
  private readonly interactionObjects: THREE.Object3D[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly center = new THREE.Vector2(0, 0);
  private readonly cubeMaterial: THREE.MeshStandardMaterial;
  private readonly surfaceTextures: LumenSurfaceTextures;
  private activeSurfaceAlbedo: THREE.Texture;
  private activeSurfaceNormal: THREE.Texture | null = null;
  private readonly loadedSurfaceTextures = new Set<THREE.Texture>();
  private readonly environmentTextures: THREE.Texture[] = [];
  private readonly stairGeometry: THREE.BufferGeometry;
  private readonly lightGeometry = createLumenLanternGeometry();
  private readonly materialCache = new Map<string, THREE.Material>();
  private readonly guideMaterials = new Map<GuideGroup, THREE.MeshBasicMaterial>();
  private readonly missionMeshes: MissionMeshRecord[] = [];
  private readonly missionInteractionObjects: THREE.Object3D[] = [];
  private readonly contributorLightObjects: THREE.Sprite[] = [];
  private readonly blocksByChunk = new Map<string, readonly VoxelBlock[]>();
  private readonly preview: THREE.Mesh;
  private readonly pendingMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
  });
  private pendingMesh: THREE.Mesh | null = null;
  private lastCenterChunk = "";
  private readonly visibleRadius: number;
  private missionStage: MissionStagePercent = 0;
  private highlightedMissionOwner: string | null = null;
  private currentMissionVisuals: readonly MissionVisualBlock[] = [];
  private cinematic: MissionCinematic | null = null;
  private lastPlayerPose: PlayerPose | null = null;
  private lastRenderAt = 0;
  private smoothedFramesPerSecond = 0;
  private isDisposed = false;
  private readonly reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: VoxelWorld,
    private readonly touchPreferred: boolean,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !touchPreferred,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = touchPreferred ? 1.08 : 1.14;
    this.renderer.setPixelRatio(
      cappedDevicePixelRatio(window.devicePixelRatio, touchPreferred),
    );

    const visualBudget = rendererVisualBudget(touchPreferred);
    const anisotropy = Math.min(
      visualBudget.anisotropyCap,
      this.renderer.capabilities.getMaxAnisotropy(),
    );
    this.surfaceTextures = createLumenSurfaceTextures(
      visualBudget.atlasSize,
      anisotropy,
    );
    this.activeSurfaceAlbedo = this.surfaceTextures.albedo;
    this.cubeMaterial = createLumenStoneMaterial(this.surfaceTextures, true);
    this.loadLumenSurfaceAssets(anisotropy);

    this.scene.background = new THREE.Color(0x0a1025);
    this.scene.fog = new THREE.FogExp2(0x111a35, touchPreferred ? 0.0165 : 0.0145);
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.worldRoot);
    this.scene.add(this.guideRoot);
    this.scene.add(
      this.missionRoot,
      this.missionEffectRoot,
      this.missionPreviewRoot,
      this.contributorLightRoot,
    );
    this.scene.add(this.environmentRoot);

    const hemisphere = new THREE.HemisphereLight(0xaecfff, 0x17152c, 1.75);
    const moon = new THREE.DirectionalLight(0xc8dcff, 2.35);
    moon.position.set(-14, 22, -9);
    const gateGlow = new THREE.DirectionalLight(0xffdca0, 0.52);
    gateGlow.position.set(11, 8, 15);
    const coreGlow = new THREE.PointLight(
      0x78e8d2,
      touchPreferred ? 10 : 13,
      22,
      2,
    );
    coreGlow.position.set(0.5, 5.5, 0.5);
    this.scene.add(hemisphere, moon, gateGlow, coreGlow);
    this.buildLumenEnvironment(visualBudget);

    this.stairGeometry = createStairGeometry();
    this.preview = new THREE.Mesh(
      new THREE.BoxGeometry(1.025, 1.025, 1.025),
      new THREE.MeshBasicMaterial({
        color: 0x7fffd4,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        wireframe: false,
      }),
    );
    this.preview.visible = false;
    this.preview.renderOrder = 20;
    this.scene.add(this.preview);
    this.visibleRadius = touchPreferred ? 1 : 2;

    this.guideMaterials.set("base", createGuideMaterial(0x78f0c6));
    this.guideMaterials.set("producer", createGuideMaterial(0xf4d27e));
    this.guideMaterials.set("upgrade", createGuideMaterial(0xb89cff));

    this.rebuildAll();
    this.resize();
  }

  rebuildAll(): void {
    for (const group of this.chunkGroups.values()) {
      this.disposeChunkGroup(group);
      this.worldRoot.remove(group);
    }
    this.chunkGroups.clear();
    this.reindexWorldChunks();
    this.syncLoadedChunks();
  }

  updateAt(position: GridPosition): void {
    const affectedKeys = this.world.affectedChunkKeys(position);
    for (const key of affectedKeys) {
      this.reindexWorldChunk(key);
      if (this.chunkGroups.has(key)) {
        this.rebuildChunk(key);
      }
    }
    this.syncLoadedChunks();
  }

  updateGuides(guides: readonly GuideCell[]): void {
    this.disposeGuideInstances();
    this.guideRoot.clear();
    for (const batch of createGuideInstanceBatches(guides)) {
      const geometry =
        batch.kind === "stair"
          ? this.stairGeometry
          : batch.kind === "light"
            ? this.lightGeometry
            : GUIDE_CUBE_GEOMETRY;
      const material = this.guideMaterials.get(batch.group);
      if (!material) {
        continue;
      }
      const mesh = new THREE.InstancedMesh(
        geometry,
        material,
        batch.guides.length,
      );
      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3(1, 1, 1);
      batch.guides.forEach((guide, index) => {
        const center = worldCenter(guide.position);
        position.set(center.x, center.y, center.z);
        quaternion.setFromAxisAngle(WORLD_UP, guide.rotation * (Math.PI / 2));
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.name = `guide-${batch.key}`;
      mesh.renderOrder = 8;
      this.guideRoot.add(mesh);
    }
  }

  setMissionVisuals(state: MissionVisualState | null): void {
    this.clearMissionVisuals();
    this.currentMissionVisuals = state
      ? deduplicateMissionVisualBlocks(state.blocks)
      : [];
    this.missionStage = state?.stage ?? 0;

    if (!state) {
      this.highlightMissionOwner(null);
      return;
    }

    const groups = new Map<string, MissionVisualBlock[]>();
    for (const visual of this.currentMissionVisuals) {
      const key = [
        visual.kind,
        visual.colorIndex,
        visual.sourceBlock.owner.publicId,
        visual.stage,
      ].join(":");
      const blocks = groups.get(key) ?? [];
      blocks.push(visual);
      groups.set(key, blocks);
    }

    for (const visuals of groups.values()) {
      const first = visuals[0];
      if (!first) {
        continue;
      }
      const geometry = this.geometryForBlockKind(first.kind);
      const paletteColor =
        PALETTE[first.colorIndex % PALETTE.length] ?? PALETTE[0]!;
      const material = new THREE.MeshStandardMaterial({
        color: paletteColor.value,
        map: this.activeSurfaceAlbedo,
        normalMap: this.activeSurfaceNormal,
        normalScale: new THREE.Vector2(0.58, 0.58),
        bumpMap: this.activeSurfaceNormal ? null : this.surfaceTextures.surface,
        bumpScale: this.activeSurfaceNormal ? 0 : 0.018,
        roughnessMap: this.surfaceTextures.surface,
        emissive: paletteColor.value,
        emissiveMap: this.surfaceTextures.emissive,
        emissiveIntensity: missionEmissiveIntensity(first.stage),
        roughness: 0.38,
        metalness: 0.05,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, visuals.length);
      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3(1.008, 1.008, 1.008);
      visuals.forEach((visual, index) => {
        const center = worldCenter(visual.position);
        quaternion.setFromAxisAngle(
          WORLD_UP,
          visual.rotation * (Math.PI / 2),
        );
        matrix.compose(
          new THREE.Vector3(center.x, center.y, center.z),
          quaternion,
          scale,
        );
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.userData["pickType"] = "mission-instances";
      mesh.userData["missionVisuals"] = visuals;
      mesh.renderOrder = 4;
      this.missionRoot.add(mesh);
      this.missionInteractionObjects.push(mesh);
      this.missionMeshes.push({
        mesh,
        material,
        ownerPublicId: first.sourceBlock.owner.publicId,
        stage: first.stage,
        visuals,
      });
    }

    this.buildMissionStageEffects(state.anchor, state.stage);
    this.highlightMissionOwner(this.highlightedMissionOwner);
    this.refreshInteractionObjects();
  }

  setMissionRecommendedPreviews(
    previews: readonly MissionSlotPreview[],
  ): void {
    this.disposeObjectTree(this.missionPreviewRoot, false);
    this.missionPreviewRoot.clear();
    for (const preview of previews.slice(0, 3)) {
      const material = new THREE.MeshBasicMaterial({
        color: preview.selected ? 0xf8d987 : 0x78f0c6,
        transparent: true,
        opacity: preview.selected ? 0.5 : 0.24,
        depthWrite: false,
        wireframe: true,
      });
      const mesh = new THREE.Mesh(GUIDE_CUBE_GEOMETRY, material);
      const center = worldCenter(preview.position);
      mesh.position.set(center.x, center.y, center.z);
      mesh.userData["missionSlotIndex"] = preview.slotIndex;
      mesh.renderOrder = 17;
      this.missionPreviewRoot.add(mesh);
    }
  }

  highlightMissionOwner(publicId: string | null): void {
    this.highlightedMissionOwner = publicId;
    const fading = publicId !== null;
    this.setWorldOpacity(fading ? 0.16 : 1);
    for (const record of this.missionMeshes) {
      const highlighted = !fading || record.ownerPublicId === publicId;
      record.material.transparent = !highlighted;
      record.material.opacity = highlighted ? 1 : 0.12;
      record.material.depthWrite = highlighted;
      record.material.emissiveIntensity = highlighted
        ? missionEmissiveIntensity(record.stage) + (fading ? 0.7 : 0)
        : 0.04;
      record.mesh.renderOrder = highlighted ? 6 : 2;
    }
  }

  getMissionVisualsForOwner(
    publicId: string,
  ): readonly MissionVisualBlock[] {
    return this.currentMissionVisuals.filter(
      (visual) => visual.sourceBlock.owner.publicId === publicId,
    );
  }

  setMissionContributorLights(
    contributors: readonly MissionContributorLightVisual[],
  ): void {
    this.disposeContributorLights();
    for (const contributor of contributors) {
      const texture = createCreatorCrestTexture(contributor);
      const material = new THREE.SpriteMaterial({
        map: texture,
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(
        contributor.position.x,
        contributor.position.y,
        contributor.position.z,
      );
      sprite.scale.set(0.72, 0.72, 0.72);
      sprite.userData["contributorPublicId"] = contributor.publicId;
      sprite.userData["contributorNickname"] = contributor.nickname;
      sprite.renderOrder = 9;
      this.contributorLightRoot.add(sprite);
      this.contributorLightObjects.push(sprite);
    }
  }

  pickMissionContributorLight(maxDistance = 8): string | null {
    this.raycaster.far = maxDistance;
    this.raycaster.setFromCamera(this.center, this.camera);
    const first = this.raycaster.intersectObjects(
      this.contributorLightObjects,
      false,
    )[0];
    const publicId = first?.object.userData["contributorPublicId"];
    return typeof publicId === "string" ? publicId : null;
  }

  startMissionCompletionCinematic(
    focus: Vector3Like,
    durationMs = 1_800,
    onComplete?: () => void,
  ): boolean {
    this.skipMissionCompletionCinematic();
    if (this.reduceMotion) {
      onComplete?.();
      return false;
    }
    const cinematic: MissionCinematic = {
      focus: new THREE.Vector3(focus.x, focus.y, focus.z),
      startedAt: performance.now(),
      durationMs: Math.max(600, Math.min(2_200, durationMs)),
      startPosition: this.camera.position.clone(),
    };
    if (onComplete) {
      cinematic.onComplete = onComplete;
    }
    this.cinematic = cinematic;
    return true;
  }

  skipMissionCompletionCinematic(): void {
    const cinematic = this.cinematic;
    this.cinematic = null;
    this.applyLatestPlayerPose();
    cinematic?.onComplete?.();
  }

  get isMissionCinematicActive(): boolean {
    return this.cinematic !== null;
  }

  setPlayerPose(position: Vector3Like, yaw: number, pitch: number): void {
    this.lastPlayerPose = {
      position: { ...position },
      yaw,
      pitch,
    };
    if (!this.cinematic) {
      this.applyLatestPlayerPose();
    }

    const coordinate = toChunkCoordinate({
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    });
    const key = chunkKey(coordinate);
    if (key !== this.lastCenterChunk) {
      this.lastCenterChunk = key;
      this.syncLoadedChunks();
    }
  }

  pick(maxDistance = 8): PickResult | null {
    this.raycaster.far = maxDistance;
    this.raycaster.setFromCamera(this.center, this.camera);
    const intersections = this.raycaster.intersectObjects(
      this.interactionObjects,
      false,
    );

    for (const intersection of intersections) {
      const missionVisual = this.resolveMissionVisual(intersection);
      const blockId = this.resolveBlockId(intersection);
      const block = missionVisual
        ? missionVisualPickBlock(missionVisual)
        : blockId
          ? this.world.getBlockById(blockId)
          : undefined;
      if (!block || !intersection.face) {
        continue;
      }

      const normal = intersection.face.normal.clone();
      if (
        intersection.object instanceof THREE.InstancedMesh &&
        intersection.instanceId !== undefined
      ) {
        const matrix = new THREE.Matrix4();
        intersection.object.getMatrixAt(intersection.instanceId, matrix);
        normal.transformDirection(new THREE.Matrix4().extractRotation(matrix));
      }

      const placementNormal = canonicalPlacementNormal({
        x: normal.x,
        y: normal.y,
        z: normal.z,
      });
      return {
        block,
        normal: placementNormal,
        distance: intersection.distance,
        ...(missionVisual
          ? {
              mission: {
                instanceId: missionVisual.instanceId,
                missionName: missionVisual.missionName,
                layer: missionVisual.layer,
                canonicalContributionId:
                  missionVisual.canonicalContributionId,
                sourceId: missionVisual.sourceId,
                visualId: missionVisual.visualId,
                position: { ...missionVisual.position },
                isReplica: missionVisual.isReplica,
                symmetryQuarter: missionVisual.symmetryQuarter,
              },
            }
          : {}),
      };
    }

    return null;
  }

  showPlacementPreview(position: GridPosition | null, valid: boolean): void {
    if (!position) {
      this.preview.visible = false;
      return;
    }

    const center = worldCenter(position);
    this.preview.position.set(center.x, center.y, center.z);
    this.preview.visible = true;
    const material = this.preview.material as THREE.MeshBasicMaterial;
    material.color.setHex(valid ? 0x78f0c6 : 0xff6d78);
    material.opacity = valid ? 0.34 : 0.24;
  }

  showPendingBlock(block: VoxelBlock | null): void {
    if (this.pendingMesh) {
      this.scene.remove(this.pendingMesh);
      this.pendingMesh = null;
    }
    if (!block) {
      return;
    }

    const geometry =
      block.kind === "stair"
        ? this.stairGeometry
        : block.kind === "light"
          ? this.lightGeometry
          : GUIDE_CUBE_GEOMETRY;
    const paletteColor = PALETTE[block.colorIndex % PALETTE.length] ?? PALETTE[0]!;
    this.pendingMaterial.color.setHex(paletteColor.value);
    const mesh = new THREE.Mesh(geometry, this.pendingMaterial);
    const center = worldCenter(block.position);
    mesh.position.set(center.x, center.y, center.z);
    mesh.rotation.y = block.rotation * (Math.PI / 2);
    mesh.renderOrder = 18;
    this.pendingMesh = mesh;
    this.scene.add(mesh);
  }

  render(): void {
    const now = performance.now();
    this.updateFrameRate(now);
    this.updateMissionAnimation(now);
    this.environmentRoot.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const pixelRatio = cappedDevicePixelRatio(
      window.devicePixelRatio,
      this.touchPreferred,
    );
    if (this.renderer.getPixelRatio() !== pixelRatio) {
      this.renderer.setPixelRatio(pixelRatio);
    }
    this.renderer.setSize(width, height, false);
  }

  getPerformanceSnapshot(): RendererPerformanceSnapshot {
    let visibleBlockCount = this.currentMissionVisuals.length;
    for (const key of this.chunkGroups.keys()) {
      visibleBlockCount += this.blocksByChunk.get(key)?.length ?? 0;
    }
    let sceneObjectCount = 0;
    this.scene.traverse((object) => {
      if (object.visible) {
        sceneObjectCount += 1;
      }
    });
    return {
      framesPerSecond: this.smoothedFramesPerSecond,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      visibleBlockCount,
      activeChunkCount: this.chunkGroups.size,
      sceneObjectCount,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      pixelRatio: this.renderer.getPixelRatio(),
    };
  }

  dispose(): void {
    this.isDisposed = true;
    this.cinematic = null;
    for (const group of this.chunkGroups.values()) {
      this.disposeChunkGroup(group);
      this.worldRoot.remove(group);
    }
    this.chunkGroups.clear();
    this.blocksByChunk.clear();
    this.clearMissionVisuals();
    this.disposeObjectTree(this.missionPreviewRoot, false);
    this.disposeObjectTree(this.missionEffectRoot, true);
    this.disposeContributorLights();
    this.disposeGuideInstances();
    this.guideRoot.clear();
    this.disposeObjectTree(this.environmentRoot, true);
    for (const texture of this.environmentTextures) {
      texture.dispose();
    }
    this.renderer.dispose();
    this.cubeMaterial.dispose();
    this.surfaceTextures.albedo.dispose();
    this.surfaceTextures.surface.dispose();
    this.surfaceTextures.emissive.dispose();
    for (const texture of this.loadedSurfaceTextures) {
      texture.dispose();
    }
    this.loadedSurfaceTextures.clear();
    this.stairGeometry.dispose();
    this.lightGeometry.dispose();
    this.preview.geometry.dispose();
    (this.preview.material as THREE.Material).dispose();
    this.pendingMaterial.dispose();
    for (const material of this.materialCache.values()) {
      material.dispose();
    }
    for (const material of this.guideMaterials.values()) {
      material.dispose();
    }
  }

  private buildLumenEnvironment(budget: RendererVisualBudget): void {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(
        112,
        budget.skyWidthSegments,
        budget.skyHeightSegments,
      ),
      createLumenSkyMaterial(),
    );
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    this.environmentRoot.add(sky);

    const stars = createLumenStarField(budget.starCount);
    stars.renderOrder = -990;
    this.environmentRoot.add(stars);

    const moonTexture = createLumenMoonTexture(128);
    this.environmentTextures.push(moonTexture);
    const moon = new THREE.Sprite(createLumenMoonMaterial(moonTexture));
    moon.position.set(-42, 35, -79);
    moon.scale.set(13.5, 13.5, 1);
    moon.renderOrder = -980;
    this.environmentRoot.add(moon);
  }

  private disposeGuideInstances(): void {
    for (const child of this.guideRoot.children) {
      if (child instanceof THREE.InstancedMesh) {
        disposeInstancedMeshState(child);
      }
    }
  }

  private loadLumenSurfaceAssets(anisotropy: number): void {
    const loader = new THREE.TextureLoader();
    const albedoRequest = loader.load(
      LUMEN_SURFACE_ASSET_URLS.albedo,
      (texture) => {
        if (this.isDisposed) {
          texture.dispose();
          return;
        }
        configureLumenSurfaceTexture(texture, anisotropy, true);
        this.loadedSurfaceTextures.add(texture);
        this.activeSurfaceAlbedo = texture;
        this.applyLoadedSurfaceTextures();
      },
      undefined,
      () => {
        albedoRequest.dispose();
      },
    );

    const normalRequest = loader.load(
      LUMEN_SURFACE_ASSET_URLS.normal,
      (texture) => {
        if (this.isDisposed) {
          texture.dispose();
          return;
        }
        configureLumenSurfaceTexture(texture, anisotropy, false);
        this.loadedSurfaceTextures.add(texture);
        this.activeSurfaceNormal = texture;
        this.applyLoadedSurfaceTextures();
      },
      undefined,
      () => {
        normalRequest.dispose();
      },
    );
  }

  private applyLoadedSurfaceTextures(): void {
    applyLumenSurfaceMaps(
      this.cubeMaterial,
      this.activeSurfaceAlbedo,
      this.activeSurfaceNormal,
      this.surfaceTextures.surface,
    );
    for (const [key, material] of this.materialCache.entries()) {
      if (!key.startsWith("stair:") || !(material instanceof THREE.MeshStandardMaterial)) {
        continue;
      }
      applyLumenSurfaceMaps(
        material,
        this.activeSurfaceAlbedo,
        this.activeSurfaceNormal,
        this.surfaceTextures.surface,
      );
    }
    for (const record of this.missionMeshes) {
      applyLumenSurfaceMaps(
        record.material,
        this.activeSurfaceAlbedo,
        this.activeSurfaceNormal,
        this.surfaceTextures.surface,
      );
    }
  }

  private geometryForBlockKind(kind: VoxelBlock["kind"]): THREE.BufferGeometry {
    if (kind === "stair") {
      return this.stairGeometry;
    }
    if (kind === "light") {
      return this.lightGeometry;
    }
    return GUIDE_CUBE_GEOMETRY;
  }

  private clearMissionVisuals(): void {
    for (const record of this.missionMeshes) {
      // InstancedMesh owns an instanceMatrix GPU buffer even when geometry and
      // material are shared. Removing it from the scene does not free it.
      disposeInstancedMeshState(record.mesh);
      record.material.dispose();
    }
    this.missionMeshes.length = 0;
    this.missionInteractionObjects.length = 0;
    this.missionRoot.clear();
    this.disposeObjectTree(this.missionEffectRoot, true);
    this.missionEffectRoot.clear();
    this.refreshInteractionObjects();
  }

  private buildMissionStageEffects(
    anchor: Vector3Like,
    stage: MissionStagePercent,
  ): void {
    this.disposeObjectTree(this.missionEffectRoot, true);
    this.missionEffectRoot.clear();
    if (stage < 25) {
      return;
    }

    const color = stage === 100 ? 0xffeaa0 : 0x78f0c6;
    const floorMaterial = createMissionEffectMaterial(color, stage === 100 ? 1.8 : 1);
    const floorPattern = new THREE.Mesh(
      new THREE.RingGeometry(1.35, 3.15, 40, 2),
      floorMaterial,
    );
    floorPattern.position.set(anchor.x, anchor.y + 0.035, anchor.z);
    floorPattern.rotation.x = -Math.PI / 2;
    floorPattern.renderOrder = 3;
    this.missionEffectRoot.add(floorPattern);

    if (stage >= 50) {
      for (const side of [-1, 1]) {
        const column = new THREE.Mesh(
          new THREE.CylinderGeometry(0.12, 0.2, 4.4, 8),
          createMissionEffectMaterial(color, stage === 100 ? 2 : 1.15),
        );
        column.position.set(anchor.x + side * 2.65, anchor.y + 2.2, anchor.z);
        this.missionEffectRoot.add(column);
      }
    }

    if (stage >= 75) {
      const topRing = new THREE.Mesh(
        new THREE.TorusGeometry(2.08, 0.12, 8, 40),
        createMissionEffectMaterial(color, stage === 100 ? 2.25 : 1.35),
      );
      topRing.position.set(anchor.x, anchor.y + 4.45, anchor.z);
      topRing.userData["missionPulse"] = true;
      this.missionEffectRoot.add(topRing);

      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.12, 4.2, 8),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: stage === 100 ? 0.62 : 0.34,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      beam.position.set(anchor.x, anchor.y + 2.2, anchor.z);
      beam.userData["missionBeam"] = true;
      this.missionEffectRoot.add(beam);

      const particleGeometry = new THREE.BufferGeometry();
      const positions: number[] = [];
      const particleCount = missionParticleLimit(this.touchPreferred);
      for (let index = 0; index < particleCount; index += 1) {
        const angle = (index / particleCount) * Math.PI * 2;
        const radius = 1.15 + ((index * 17) % 13) * 0.12;
        positions.push(
          anchor.x + Math.cos(angle) * radius,
          anchor.y + 0.35 + ((index * 7) % 29) * 0.14,
          anchor.z + Math.sin(angle) * radius,
        );
      }
      particleGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      const particles = new THREE.Points(
        particleGeometry,
        new THREE.PointsMaterial({
          color,
          size: stage === 100 ? 0.12 : 0.08,
          transparent: true,
          opacity: stage === 100 ? 0.78 : 0.46,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      particles.userData["missionParticles"] = true;
      this.missionEffectRoot.add(particles);
    }
  }

  private setWorldOpacity(opacity: number): void {
    const update = (material: THREE.Material): void => {
      material.transparent = opacity < 1;
      material.opacity = opacity;
      material.depthWrite = opacity >= 1;
      material.needsUpdate = true;
    };
    update(this.cubeMaterial);
    for (const material of this.materialCache.values()) {
      update(material);
    }
  }

  private disposeObjectTree(root: THREE.Object3D, disposeGeometry: boolean): void {
    root.traverse((child) => {
      if (child instanceof THREE.Sprite) {
        child.material.dispose();
        return;
      }
      if (!(child instanceof THREE.Mesh || child instanceof THREE.Points)) {
        return;
      }
      if (disposeGeometry) {
        child.geometry.dispose();
      }
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      for (const material of materials) {
        material.dispose();
      }
    });
  }

  private disposeContributorLights(): void {
    for (const sprite of this.contributorLightObjects) {
      const material = sprite.material;
      material.map?.dispose();
      material.dispose();
    }
    this.contributorLightObjects.length = 0;
    this.contributorLightRoot.clear();
  }

  private applyLatestPlayerPose(): void {
    const pose = this.lastPlayerPose;
    if (!pose) {
      return;
    }
    this.camera.position.set(
      pose.position.x,
      pose.position.y,
      pose.position.z,
    );
    this.camera.rotation.set(pose.pitch, pose.yaw, 0, "YXZ");
  }

  private updateMissionAnimation(now: number): void {
    const animated = !this.reduceMotion;
    const pulse = animated ? 0.78 + Math.sin(now * 0.004) * 0.18 : 0.9;
    this.missionEffectRoot.traverse((child) => {
      if (child.userData["missionPulse"] && child instanceof THREE.Mesh) {
        child.scale.setScalar(animated ? 1 + Math.sin(now * 0.003) * 0.025 : 1);
        const material = child.material;
        if (material instanceof THREE.MeshStandardMaterial) {
          material.emissiveIntensity =
            (this.missionStage === 100 ? 2.25 : 1.35) * pulse;
        }
      }
      if (
        animated &&
        child.userData["missionParticles"] &&
        child instanceof THREE.Points
      ) {
        child.rotation.y = now * 0.00008;
      }
      if (child.userData["missionBeam"] && child instanceof THREE.Mesh) {
        const material = child.material;
        if (material instanceof THREE.MeshBasicMaterial) {
          material.opacity =
            (this.missionStage === 100 ? 0.62 : 0.34) * pulse;
        }
      }
    });

    const cinematic = this.cinematic;
    if (!cinematic) {
      return;
    }
    const progress = Math.min(1, (now - cinematic.startedAt) / cinematic.durationMs);
    const eased = 1 - Math.pow(1 - progress, 3);
    const relative = cinematic.startPosition.clone().sub(cinematic.focus);
    if (relative.lengthSq() < 1) {
      relative.set(0, 1.8, 4.5);
    }
    relative.applyAxisAngle(WORLD_UP, Math.sin(eased * Math.PI) * 0.22);
    this.camera.position
      .copy(cinematic.focus)
      .add(relative)
      .addScaledVector(WORLD_UP, Math.sin(eased * Math.PI) * 0.65);
    this.camera.lookAt(cinematic.focus);

    if (progress >= 1) {
      this.cinematic = null;
      this.applyLatestPlayerPose();
      cinematic.onComplete?.();
    }
  }

  private updateFrameRate(now: number): void {
    if (this.lastRenderAt > 0) {
      const elapsed = now - this.lastRenderAt;
      if (elapsed > 0 && elapsed <= 1_000) {
        const instantaneous = 1_000 / elapsed;
        this.smoothedFramesPerSecond =
          this.smoothedFramesPerSecond === 0
            ? instantaneous
            : this.smoothedFramesPerSecond * 0.9 + instantaneous * 0.1;
      }
    }
    this.lastRenderAt = now;
  }

  private reindexWorldChunks(): void {
    this.blocksByChunk.clear();
    const grouped = new Map<string, VoxelBlock[]>();
    for (const block of this.world.blocks) {
      const key = chunkKey(toChunkCoordinate(block.position));
      const blocks = grouped.get(key) ?? [];
      blocks.push(block);
      grouped.set(key, blocks);
    }
    for (const [key, blocks] of grouped) {
      this.blocksByChunk.set(key, blocks);
    }
  }

  private reindexWorldChunk(key: string): void {
    const blocks = this.world.blocksInChunk(key);
    if (blocks.length === 0) {
      this.blocksByChunk.delete(key);
      return;
    }
    this.blocksByChunk.set(key, blocks);
  }

  private resolveMissionVisual(
    intersection: THREE.Intersection,
  ): MissionVisualBlock | null {
    if (
      intersection.object.userData["pickType"] !== "mission-instances" ||
      intersection.instanceId === undefined
    ) {
      return null;
    }
    const visuals = intersection.object.userData["missionVisuals"] as
      | MissionVisualBlock[]
      | undefined;
    return visuals?.[intersection.instanceId] ?? null;
  }

  private rebuildChunk(key: string): void {
    const previous = this.chunkGroups.get(key);
    if (previous) {
      this.disposeChunkGroup(previous);
      this.worldRoot.remove(previous);
      this.chunkGroups.delete(key);
    }

    const blocks = this.blocksByChunk.get(key) ?? [];
    if (blocks.length === 0) {
      return;
    }

    const group = new THREE.Group();
    group.name = "chunk-" + key;
    group.userData["chunkKey"] = key;

    const cubeMesh = this.buildCubeMesh(
      blocks.filter((block) => block.kind === "cube"),
    );
    if (cubeMesh) {
      group.add(cubeMesh);
    }

    const instanceGroups = new Map<string, VoxelBlock[]>();
    for (const block of blocks) {
      if (block.kind === "cube") {
        continue;
      }
      const instanceKey = [block.kind, block.colorIndex].join(":");
      const list = instanceGroups.get(instanceKey) ?? [];
      list.push(block);
      instanceGroups.set(instanceKey, list);
    }

    for (const instanceBlocks of instanceGroups.values()) {
      const mesh = this.buildInstanceMesh(instanceBlocks);
      if (mesh) {
        group.add(mesh);
      }
    }

    this.chunkGroups.set(key, group);
    this.worldRoot.add(group);
  }

  private buildCubeMesh(blocks: readonly VoxelBlock[]): THREE.Mesh | null {
    if (blocks.length === 0) {
      return null;
    }

    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const triangleBlockIds: string[] = [];
    let vertexOffset = 0;

    for (const block of blocks) {
      const paletteColor =
        PALETTE[block.colorIndex % PALETTE.length] ?? PALETTE[0]!;
      const color = new THREE.Color(paletteColor.value);

      for (const [faceIndex, face] of CUBE_FACES.entries()) {
        const neighborPosition = addGridPositions(block.position, face.normal);
        const neighbor = this.world.getBlock(neighborPosition);
        if (neighbor?.kind === "cube") {
          continue;
        }

        const atlasTile = lumenAtlasTileIndex(block.position, faceIndex);
        for (const [cornerIndex, corner] of face.corners.entries()) {
          positions.push(
            block.position.x + corner[0],
            block.position.y + corner[1],
            block.position.z + corner[2],
          );
          normals.push(face.normal.x, face.normal.y, face.normal.z);
          const tone = lumenFaceTone(face.normal, block.position);
          colors.push(color.r * tone, color.g * tone, color.b * tone);
          const uvCorner = FACE_UV_CORNERS[cornerIndex]!;
          const uv = lumenAtlasUv(atlasTile, uvCorner[0], uvCorner[1]);
          uvs.push(uv.u, uv.v);
        }

        indices.push(
          vertexOffset,
          vertexOffset + 1,
          vertexOffset + 2,
          vertexOffset,
          vertexOffset + 2,
          vertexOffset + 3,
        );
        triangleBlockIds.push(block.id, block.id);
        vertexOffset += 4;
      }
    }

    if (positions.length === 0) {
      return null;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, this.cubeMaterial);
    mesh.userData["pickType"] = "cube-chunk";
    mesh.userData["triangleBlockIds"] = triangleBlockIds;
    return mesh;
  }

  private buildInstanceMesh(
    blocks: readonly VoxelBlock[],
  ): THREE.InstancedMesh | null {
    const first = blocks[0];
    if (!first) {
      return null;
    }

    const geometry =
      first.kind === "stair" ? this.stairGeometry : this.lightGeometry;
    const material = this.getInstanceMaterial(first.kind, first.colorIndex);
    const mesh = new THREE.InstancedMesh(geometry, material, blocks.length);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const blockIds: string[] = [];

    blocks.forEach((block, index) => {
      const center = worldCenter(block.position);
      quaternion.setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        block.rotation * (Math.PI / 2),
      );
      matrix.compose(
        new THREE.Vector3(center.x, center.y, center.z),
        quaternion,
        scale,
      );
      mesh.setMatrixAt(index, matrix);
      blockIds.push(block.id);
    });

    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.userData["pickType"] = "instances";
    mesh.userData["blockIds"] = blockIds;
    return mesh;
  }

  private getInstanceMaterial(
    kind: VoxelBlock["kind"],
    colorIndex: number,
  ): THREE.Material {
    const key = [kind, colorIndex].join(":");
    const cached = this.materialCache.get(key);
    if (cached) {
      return cached;
    }

    const paletteColor = PALETTE[colorIndex % PALETTE.length] ?? PALETTE[0]!;
    const material =
      kind === "light"
        ? new THREE.MeshStandardMaterial({
            color: paletteColor.value,
            emissive: paletteColor.value,
            emissiveMap: this.surfaceTextures.emissive,
            emissiveIntensity: 2.1,
            map: this.surfaceTextures.albedo,
            roughnessMap: this.surfaceTextures.surface,
            roughness: 0.38,
            metalness: 0.18,
          })
        : new THREE.MeshStandardMaterial({
            color: paletteColor.value,
            map: this.activeSurfaceAlbedo,
            roughnessMap: this.surfaceTextures.surface,
            bumpMap: this.activeSurfaceNormal ? null : this.surfaceTextures.surface,
            bumpScale: this.activeSurfaceNormal ? 0 : 0.022,
            normalMap: this.activeSurfaceNormal,
            normalScale: new THREE.Vector2(0.72, 0.72),
            emissive: 0x7bb9c9,
            emissiveMap: this.surfaceTextures.emissive,
            emissiveIntensity: 0.09,
            roughness: 0.76,
            metalness: 0.04,
            flatShading: true,
          });
    this.materialCache.set(key, material);
    return material;
  }

  private resolveBlockId(intersection: THREE.Intersection): string | null {
    if (
      intersection.object.userData["pickType"] === "instances" &&
      intersection.instanceId !== undefined
    ) {
      const blockIds = intersection.object.userData["blockIds"] as
        | string[]
        | undefined;
      return blockIds?.[intersection.instanceId] ?? null;
    }

    if (
      intersection.object.userData["pickType"] === "cube-chunk" &&
      typeof intersection.faceIndex === "number"
    ) {
      const blockIds = intersection.object.userData["triangleBlockIds"] as
        | string[]
        | undefined;
      return blockIds?.[intersection.faceIndex] ?? null;
    }

    return null;
  }

  private refreshInteractionObjects(): void {
    this.interactionObjects.length = 0;
    for (const group of this.chunkGroups.values()) {
      for (const child of group.children) {
        if (child.userData["pickType"]) {
          this.interactionObjects.push(child);
        }
      }
    }
    this.interactionObjects.push(...this.missionInteractionObjects);
  }

  private syncLoadedChunks(): void {
    const center = parseChunkKey(this.lastCenterChunk);
    if (!center) {
      this.refreshInteractionObjects();
      return;
    }

    const desiredKeys = new Set(
      chunkKeysAround(center, this.visibleRadius, ACTIVE_VERTICAL_CHUNK_RADIUS),
    );
    const { load, unload } = diffChunkWindow(
      this.chunkGroups.keys(),
      desiredKeys,
    );
    for (const key of unload) {
      const group = this.chunkGroups.get(key);
      if (!group) {
        continue;
      }
      this.disposeChunkGroup(group);
      this.worldRoot.remove(group);
      this.chunkGroups.delete(key);
    }
    for (const key of load) {
      if (this.blocksByChunk.has(key)) {
        this.rebuildChunk(key);
      }
    }
    this.refreshInteractionObjects();
  }

  private disposeChunkGroup(group: THREE.Group): void {
    for (const child of group.children) {
      if (child instanceof THREE.InstancedMesh) {
        // Stair/light geometry and materials are shared caches; dispose only
        // the mesh's per-instance GPU state here.
        disposeInstancedMeshState(child);
      } else if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    }
  }
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const ACTIVE_VERTICAL_CHUNK_RADIUS = 2;
const LUMEN_ATLAS_TILES_PER_AXIS = 2;

export function rendererVisualBudget(
  touchPreferred: boolean,
): RendererVisualBudget {
  return touchPreferred
    ? {
        atlasSize: 64,
        atlasTilesPerAxis: LUMEN_ATLAS_TILES_PER_AXIS,
        starCount: 150,
        anisotropyCap: 2,
        skyWidthSegments: 16,
        skyHeightSegments: 10,
      }
    : {
        atlasSize: 128,
        atlasTilesPerAxis: LUMEN_ATLAS_TILES_PER_AXIS,
        starCount: 280,
        anisotropyCap: 4,
        skyWidthSegments: 24,
        skyHeightSegments: 14,
      };
}

export function createGuideInstanceBatches(
  guides: readonly GuideCell[],
): GuideInstanceBatch[] {
  const grouped = new Map<
    string,
    { kind: GuideCell["kind"]; group: GuideGroup; guides: GuideCell[] }
  >();
  for (const guide of guides) {
    const key = `${guide.group}:${guide.kind}`;
    const batch = grouped.get(key) ?? {
      kind: guide.kind,
      group: guide.group,
      guides: [],
    };
    batch.guides.push(guide);
    grouped.set(key, batch);
  }
  return [...grouped.entries()].map(([key, batch]) => ({
    key,
    kind: batch.kind,
    group: batch.group,
    guides: batch.guides,
  }));
}

export function lumenAtlasTileIndex(
  position: Readonly<GridPosition>,
  faceIndex: number,
): number {
  const hash = integerNoise(
    position.x * 31 + position.y * 47 + position.z * 71 + faceIndex * 13,
  );
  return hash % (LUMEN_ATLAS_TILES_PER_AXIS ** 2);
}

export function lumenAtlasUv(
  tileIndex: number,
  u: number,
  v: number,
): { u: number; v: number } {
  const tile = Math.abs(Math.floor(tileIndex)) % 4;
  const tileX = tile % LUMEN_ATLAS_TILES_PER_AXIS;
  const tileY = Math.floor(tile / LUMEN_ATLAS_TILES_PER_AXIS);
  const inset = 0.018;
  const localU = inset + clamp01(u) * (1 - inset * 2);
  const localV = inset + clamp01(v) * (1 - inset * 2);
  return {
    u: (tileX + localU) / LUMEN_ATLAS_TILES_PER_AXIS,
    v: (tileY + localV) / LUMEN_ATLAS_TILES_PER_AXIS,
  };
}

export function createLumenSurfaceAtlasData(
  requestedSize: number,
): LumenSurfaceAtlasData {
  const size = Math.max(32, Math.min(256, nearestPowerOfTwo(requestedSize)));
  const albedo = new Uint8Array(size * size * 4);
  const surface = new Uint8Array(size * size * 4);
  const emissive = new Uint8Array(size * size * 4);
  const tileSize = size / LUMEN_ATLAS_TILES_PER_AXIS;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const tileX = Math.floor(x / tileSize);
      const tileY = Math.floor(y / tileSize);
      const tile = tileY * LUMEN_ATLAS_TILES_PER_AXIS + tileX;
      const localX = x % tileSize;
      const localY = y % tileSize;
      const broad = integerNoise(x * 13 + y * 29 + tile * 101) / 255;
      const fine = integerNoise(x * 73 + y * 37 + tile * 19) / 255;
      const veinDistance = lumenVeinDistance(localX, localY, tileSize, tile);
      const vein = Math.max(0, 1 - veinDistance / Math.max(1, tileSize * 0.075));
      const speck = fine > 0.94 ? (fine - 0.94) * 5.5 : 0;
      const base = 206 + Math.round((broad - 0.5) * 22 - vein * 32 + speck * 15);
      const offset = (y * size + x) * 4;
      albedo[offset] = clampByte(base - 8);
      albedo[offset + 1] = clampByte(base + 1);
      albedo[offset + 2] = clampByte(base + 13);
      albedo[offset + 3] = 255;

      const roughness = clampByte(196 + (fine - 0.5) * 34 - vein * 48);
      surface[offset] = roughness;
      surface[offset + 1] = roughness;
      surface[offset + 2] = roughness;
      surface[offset + 3] = 255;

      const rune = lumenRuneIntensity(localX, localY, tileSize, tile);
      emissive[offset] = clampByte(90 * rune);
      emissive[offset + 1] = clampByte(205 * rune);
      emissive[offset + 2] = clampByte(238 * rune);
      emissive[offset + 3] = 255;
    }
  }

  return { size, albedo, surface, emissive };
}

export function configureLumenSurfaceTexture(
  texture: THREE.Texture,
  anisotropy: number,
  colorTexture: boolean,
): void {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(LUMEN_ATLAS_TILES_PER_AXIS, LUMEN_ATLAS_TILES_PER_AXIS);
  texture.anisotropy = Math.max(1, Math.min(4, Math.floor(anisotropy)));
  texture.colorSpace = colorTexture ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
}

export function canonicalPlacementNormal(
  normal: Readonly<Vector3Like>,
): GridPosition {
  const values = [normal.x, normal.y, normal.z].map((value) =>
    Number.isFinite(value) ? value : 0,
  );
  let dominantIndex = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (Math.abs(values[index]!) > Math.abs(values[dominantIndex]!)) {
      dominantIndex = index;
    }
  }

  const dominantValue = values[dominantIndex]!;
  if (dominantValue === 0) {
    return { x: 0, y: 1, z: 0 };
  }
  const sign = dominantValue < 0 ? -1 : 1;
  return {
    x: dominantIndex === 0 ? sign : 0,
    y: dominantIndex === 1 ? sign : 0,
    z: dominantIndex === 2 ? sign : 0,
  };
}

export function cappedDevicePixelRatio(
  devicePixelRatio: number | undefined,
  touchPreferred: boolean,
): number {
  const safeRatio =
    typeof devicePixelRatio === "number" &&
    Number.isFinite(devicePixelRatio) &&
    devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  return Math.min(safeRatio, touchPreferred ? 1.25 : 1.6);
}

export function disposeInstancedMeshState(mesh: THREE.InstancedMesh): void {
  mesh.dispose();
}

export function missionParticleLimit(touchPreferred: boolean): number {
  return touchPreferred ? 18 : 36;
}

export function chunkKeysAround(
  center: ChunkCoordinate,
  horizontalRadius: number,
  verticalRadius: number,
): string[] {
  const horizontal = Math.max(0, Math.floor(horizontalRadius));
  const vertical = Math.max(0, Math.floor(verticalRadius));
  const keys: string[] = [];
  for (let y = center.y - vertical; y <= center.y + vertical; y += 1) {
    for (let z = center.z - horizontal; z <= center.z + horizontal; z += 1) {
      for (let x = center.x - horizontal; x <= center.x + horizontal; x += 1) {
        keys.push(chunkKey({ x, y, z }));
      }
    }
  }
  return keys;
}

export function diffChunkWindow(
  activeKeys: Iterable<string>,
  desiredKeys: Iterable<string>,
): { load: string[]; unload: string[] } {
  const active = new Set(activeKeys);
  const desired = new Set(desiredKeys);
  return {
    load: [...desired].filter((key) => !active.has(key)),
    unload: [...active].filter((key) => !desired.has(key)),
  };
}

export function deduplicateMissionVisualBlocks(
  blocks: readonly MissionVisualBlock[],
): MissionVisualBlock[] {
  const unique = new Map<string, MissionVisualBlock>();
  for (const block of blocks) {
    const key = [
      canonicalCoordinate(block.position.x),
      canonicalCoordinate(block.position.y),
      canonicalCoordinate(block.position.z),
    ].join(":");
    const previous = unique.get(key);
    if (!previous || (previous.isReplica && !block.isReplica)) {
      unique.set(key, block);
    }
  }
  return [...unique.values()];
}

export function missionDisplayBlocksToVisuals(
  blocks: readonly MissionDisplayBlock[],
  stage: MissionVisualStage = 0,
): MissionVisualBlock[] {
  const canonicalBySource = new Map<string, MissionDisplayBlock>();
  for (const block of blocks) {
    if (!block.mission.isReplica) {
      canonicalBySource.set(block.mission.canonicalBlockId, block);
    }
  }
  return blocks.map((block) => {
    const sourceBlock =
      canonicalBySource.get(block.mission.canonicalBlockId) ?? block;
    return {
      visualId: block.id,
      sourceId: block.mission.canonicalBlockId,
      sourceBlock,
      position: { ...block.position },
      kind: block.kind,
      rotation: block.rotation,
      colorIndex: block.colorIndex,
      stage,
      isReplica: block.mission.isReplica,
      symmetryQuarter: block.mission.replicaQuarterTurns,
      instanceId: block.mission.missionId,
      missionName: block.mission.missionName,
      layer: block.mission.missionLayer,
      canonicalContributionId: block.mission.canonicalBlockId,
    };
  });
}

export function missionEmissiveIntensity(stage: MissionVisualStage): number {
  const normalized = stage / 100;
  return 0.16 + Math.pow(normalized, 1.18) * 1.29;
}

const GUIDE_CUBE_GEOMETRY = new THREE.BoxGeometry(1.025, 1.025, 1.025);

function canonicalCoordinate(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function missionVisualPickBlock(visual: MissionVisualBlock): VoxelBlock {
  return {
    ...visual.sourceBlock,
    id: visual.visualId,
    position: { ...visual.position },
    kind: visual.kind,
    rotation: visual.rotation,
    colorIndex: visual.colorIndex,
    zone: "mission",
  };
}

function createLumenSurfaceTextures(
  size: number,
  anisotropy: number,
): LumenSurfaceTextures {
  const data = createLumenSurfaceAtlasData(size);
  const albedo = createLumenDataTexture(data.albedo, data.size, true, anisotropy);
  const surface = createLumenDataTexture(data.surface, data.size, false, anisotropy);
  const emissive = createLumenDataTexture(data.emissive, data.size, true, anisotropy);
  return { albedo, surface, emissive };
}

function createLumenDataTexture(
  data: Uint8Array,
  size: number,
  colorTexture: boolean,
  anisotropy: number,
): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    data,
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = colorTexture ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

function createLumenStoneMaterial(
  textures: LumenSurfaceTextures,
  vertexColors: boolean,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors,
    map: textures.albedo,
    roughnessMap: textures.surface,
    bumpMap: textures.surface,
    bumpScale: 0.025,
    emissive: 0x75bed0,
    emissiveMap: textures.emissive,
    emissiveIntensity: 0.12,
    roughness: 0.78,
    metalness: 0.035,
    flatShading: true,
  });
}

function applyLumenSurfaceMaps(
  material: THREE.MeshStandardMaterial,
  albedo: THREE.Texture,
  normal: THREE.Texture | null,
  fallbackSurface: THREE.Texture,
): void {
  material.map = albedo;
  material.normalMap = normal;
  material.normalScale.setScalar(normal ? 0.72 : 1);
  material.bumpMap = normal ? null : fallbackSurface;
  material.bumpScale = normal ? 0 : 0.025;
  material.needsUpdate = true;
}

function createLumenLanternGeometry(): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    [
      new THREE.Vector2(0, -0.38),
      new THREE.Vector2(0.13, -0.38),
      new THREE.Vector2(0.27, -0.31),
      new THREE.Vector2(0.22, -0.22),
      new THREE.Vector2(0.2, 0.2),
      new THREE.Vector2(0.25, 0.29),
      new THREE.Vector2(0.12, 0.38),
      new THREE.Vector2(0, 0.38),
    ],
    8,
  );
}

export function createLumenMoonMaterial(
  map: THREE.Texture,
): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({
    map,
    color: 0xddeaff,
    transparent: true,
    opacity: 0.92,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
}

export function createLumenSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    vertexShader: `
      varying vec3 vSkyDirection;
      void main() {
        vSkyDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vSkyDirection;
      void main() {
        float height = clamp(vSkyDirection.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 horizon = vec3(0.105, 0.145, 0.285);
        vec3 zenith = vec3(0.018, 0.028, 0.105);
        vec3 color = mix(horizon, zenith, smoothstep(0.2, 0.94, height));
        float horizonGlow = pow(1.0 - abs(vSkyDirection.y), 8.0);
        color += vec3(0.10, 0.12, 0.22) * horizonGlow;
        float lunarVeil = pow(max(0.0, dot(normalize(vSkyDirection), normalize(vec3(-0.38, 0.42, -0.82)))), 18.0);
        color += vec3(0.14, 0.19, 0.30) * lunarVeil;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
}

function createLumenStarField(count: number): THREE.Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const u = deterministicUnit(index * 37 + 11);
    const v = deterministicUnit(index * 61 + 23);
    const theta = u * Math.PI * 2;
    const y = 0.05 + v * 0.92;
    const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
    positions[index * 3] = Math.cos(theta) * horizontal * 92;
    positions[index * 3 + 1] = y * 92;
    positions[index * 3 + 2] = Math.sin(theta) * horizontal * 92;
    const warmth = deterministicUnit(index * 43 + 7);
    colors[index * 3] = 0.72 + warmth * 0.28;
    colors[index * 3 + 1] = 0.8 + warmth * 0.16;
    colors[index * 3 + 2] = 1;
    sizes[index] = 1.1 + deterministicUnit(index * 89 + 5) * 1.65;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("starSize", new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    vertexColors: true,
    fog: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float starSize;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = starSize;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float distanceToCenter = length(gl_PointCoord - vec2(0.5));
        float alpha = 1.0 - smoothstep(0.05, 0.5, distanceToCenter);
        if (alpha <= 0.01) discard;
        gl_FragColor = vec4(vColor, alpha * 0.82);
      }
    `,
  });
  const stars = new THREE.Points(geometry, material);
  stars.frustumCulled = false;
  return stars;
}

function createLumenMoonTexture(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const halo = Math.max(0, 1 - radius);
      const outerDisc = 1 - smoothstep(0.54, 0.65, radius);
      const cutoutRadius = Math.sqrt(
        (dx - 0.22) * (dx - 0.22) + (dy + 0.015) * (dy + 0.015),
      );
      const cutout = 1 - smoothstep(0.39, 0.55, cutoutRadius);
      const crescent = Math.max(0, outerDisc - cutout);
      const crater = 0.9 + deterministicUnit(x * 17 + y * 41) * 0.1;
      const offset = (y * size + x) * 4;
      data[offset] = clampByte(215 * crescent * crater + 25 * halo * halo);
      data[offset + 1] = clampByte(235 * crescent * crater + 42 * halo * halo);
      data[offset + 2] = clampByte(255 * crescent * crater + 82 * halo * halo);
      data[offset + 3] = clampByte(
        Math.max(crescent * 0.96, halo * halo * 0.31) * 255,
      );
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function lumenFaceTone(
  normal: Readonly<GridPosition>,
  position: Readonly<GridPosition>,
): number {
  const directional = normal.y > 0 ? 1.08 : normal.y < 0 ? 0.73 : normal.x > 0 ? 0.92 : 0.84;
  const variation = (integerNoise(position.x * 11 + position.y * 23 + position.z * 43) / 255 - 0.5) * 0.07;
  return directional + variation;
}

function lumenVeinDistance(
  x: number,
  y: number,
  size: number,
  tile: number,
): number {
  const wave = Math.sin((x / size) * Math.PI * (2 + tile)) * size * 0.08;
  const target = size * (0.28 + tile * 0.12) + wave;
  return Math.abs(y - target);
}

function lumenRuneIntensity(
  x: number,
  y: number,
  size: number,
  tile: number,
): number {
  const center = size * 0.5;
  const dx = x - center;
  const dy = y - center;
  const ringRadius = size * (0.23 + tile * 0.025);
  const ring = Math.max(0, 1 - Math.abs(Math.sqrt(dx * dx + dy * dy) - ringRadius) / 0.85);
  const spoke = tile % 2 === 0
    ? Math.max(0, 1 - Math.min(Math.abs(dx), Math.abs(dy)) / 0.72)
    : Math.max(0, 1 - Math.min(Math.abs(dx - dy), Math.abs(dx + dy)) / 1.05);
  const edgeFade = smoothstep(0, size * 0.14, Math.min(x, y, size - 1 - x, size - 1 - y));
  return Math.max(ring * 0.62, spoke * 0.42) * edgeFade;
}

function deterministicUnit(seed: number): number {
  return integerNoise(seed) / 255;
}

function integerNoise(seed: number): number {
  let value = Math.imul(Math.trunc(seed) ^ 0x45d9f3b, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) & 255;
}

function nearestPowerOfTwo(value: number): number {
  if (!Number.isFinite(value)) return 32;
  return 2 ** Math.round(Math.log2(Math.max(1, value)));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const progress = clamp01((value - edge0) / Math.max(0.00001, edge1 - edge0));
  return progress * progress * (3 - 2 * progress);
}

function createMissionEffectMaterial(
  color: number,
  intensity: number,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    roughness: 0.32,
    blending: THREE.AdditiveBlending,
  });
}

function createCreatorCrestTexture(
  identity: Readonly<CreatorCrestIdentity>,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context) {
    const crest = missionContributorCrestDesign(identity);
    const gradient = context.createRadialGradient(64, 64, 8, 64, 64, 60);
    gradient.addColorStop(0, `${crest.ringColor}d9`);
    gradient.addColorStop(0.62, `${crest.ringColor}52`);
    gradient.addColorStop(1, `${crest.ringColor}00`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    drawCreatorCrest(context, crest);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function drawCreatorCrest(
  context: CanvasRenderingContext2D,
  crest: Readonly<CreatorCrestDesign>,
): void {
  context.save();
  context.translate(64, 64);

  context.beginPath();
  context.arc(0, 0, 54, 0, Math.PI * 2);
  context.fillStyle = crest.baseColor;
  context.fill();

  context.beginPath();
  context.arc(0, 0, 45.5, 0, Math.PI * 2);
  context.fillStyle = crest.innerColor;
  context.fill();
  context.strokeStyle = crest.ringColor;
  context.lineWidth = 5.8;
  context.setLineDash(crest.ringDash.map((value) => value * 5.3));
  context.stroke();
  context.setLineDash([]);

  crest.signatureAngles.forEach((degrees, index) => {
    const point = polarCanvasPoint(47, degrees);
    context.beginPath();
    context.arc(point.x, point.y, index === 0 ? 3.7 : 2.55, 0, Math.PI * 2);
    context.fillStyle = crest.accentColor;
    context.fill();
  });

  const accent = polarCanvasPoint(38, crest.accentAngle);
  context.beginPath();
  context.arc(accent.x, accent.y, 5.2, 0, Math.PI * 2);
  context.fillStyle = crest.accentColor;
  context.fill();
  context.strokeStyle = crest.baseColor;
  context.lineWidth = 2.6;
  context.stroke();
  context.restore();

  drawEmblemShape(context, crest.icon, crest.symbolColor);
}

function drawEmblemShape(
  context: CanvasRenderingContext2D,
  icon: UiIconName,
  color = "#ffffff",
): void {
  context.save();
  context.translate(64, 64);
  context.fillStyle = color;
  context.strokeStyle = color;
  context.lineWidth = 7;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowColor = "rgba(255, 244, 190, 0.85)";
  context.shadowBlur = 12;
  context.beginPath();

  switch (icon) {
    case "emblem-diamond":
      context.moveTo(0, -32);
      context.lineTo(28, 0);
      context.lineTo(0, 32);
      context.lineTo(-28, 0);
      context.closePath();
      context.fill();
      break;
    case "emblem-orb":
      context.arc(0, 0, 28, 0, Math.PI * 2);
      context.fill();
      break;
    case "emblem-spire":
      context.moveTo(0, -34);
      context.lineTo(31, 29);
      context.lineTo(-31, 29);
      context.closePath();
      context.fill();
      break;
    case "emblem-square":
      context.rect(-27, -27, 54, 54);
      context.fill();
      break;
    case "emblem-pentagon":
      drawRegularPolygon(context, 5, 31, -Math.PI / 2);
      context.fill();
      break;
    case "emblem-sun":
      context.arc(0, 0, 17, 0, Math.PI * 2);
      context.fill();
      context.shadowBlur = 7;
      for (let index = 0; index < 8; index += 1) {
        const angle = (Math.PI * 2 * index) / 8;
        context.beginPath();
        context.moveTo(Math.cos(angle) * 24, Math.sin(angle) * 24);
        context.lineTo(Math.cos(angle) * 34, Math.sin(angle) * 34);
        context.stroke();
      }
      break;
    default:
      drawStar(context, 5, 33, 15);
      context.fill();
      break;
  }
  context.restore();
}

function polarCanvasPoint(
  radius: number,
  degrees: number,
): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: Math.cos(radians) * radius,
    y: Math.sin(radians) * radius,
  };
}

function drawRegularPolygon(
  context: CanvasRenderingContext2D,
  sides: number,
  radius: number,
  rotation: number,
): void {
  for (let index = 0; index < sides; index += 1) {
    const angle = rotation + (Math.PI * 2 * index) / sides;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
}

function drawStar(
  context: CanvasRenderingContext2D,
  points: number,
  outerRadius: number,
  innerRadius: number,
): void {
  for (let index = 0; index < points * 2; index += 1) {
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    const angle = -Math.PI / 2 + (Math.PI * index) / points;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
}

function createGuideMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    wireframe: true,
  });
}

function createStairGeometry(): THREE.BufferGeometry {
  const bottom = new THREE.BoxGeometry(1, 0.5, 1);
  bottom.translate(0, -0.25, 0);
  const top = new THREE.BoxGeometry(1, 0.5, 0.5);
  top.translate(0, 0.25, 0.25);
  const merged = mergeGeometries([bottom, top], false);
  bottom.dispose();
  top.dispose();
  if (!merged) {
    throw new Error("계단 지오메트리를 만들 수 없습니다.");
  }
  return merged;
}
