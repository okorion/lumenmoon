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
import type { MissionDisplayBlock } from "../domain/mission";

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

export type MissionVisualStage = 0 | 25 | 50 | 75 | 100;

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
  stage: MissionVisualStage;
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
  private readonly chunkGroups = new Map<string, THREE.Group>();
  private readonly interactionObjects: THREE.Object3D[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly center = new THREE.Vector2(0, 0);
  private readonly cubeMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
  });
  private readonly stairGeometry: THREE.BufferGeometry;
  private readonly lightGeometry = new THREE.CylinderGeometry(0.24, 0.32, 0.72, 8);
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
  private missionStage: MissionVisualStage = 0;
  private highlightedMissionOwner: string | null = null;
  private currentMissionVisuals: readonly MissionVisualBlock[] = [];
  private cinematic: MissionCinematic | null = null;
  private lastPlayerPose: PlayerPose | null = null;
  private lastRenderAt = 0;
  private smoothedFramesPerSecond = 0;

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
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(
      cappedDevicePixelRatio(window.devicePixelRatio, touchPreferred),
    );

    this.scene.background = new THREE.Color(0x7ba6c8);
    this.scene.fog = new THREE.Fog(0x7ba6c8, 28, 92);
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.worldRoot);
    this.scene.add(this.guideRoot);
    this.scene.add(
      this.missionRoot,
      this.missionEffectRoot,
      this.missionPreviewRoot,
      this.contributorLightRoot,
    );

    const hemisphere = new THREE.HemisphereLight(0xe7f4ff, 0x283144, 2.25);
    const sun = new THREE.DirectionalLight(0xfff0d0, 2.1);
    sun.position.set(-12, 20, 8);
    this.scene.add(hemisphere, sun);

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
    this.guideRoot.clear();
    for (const guide of guides) {
      const geometry =
        guide.kind === "stair"
          ? this.stairGeometry
          : guide.kind === "light"
            ? this.lightGeometry
            : GUIDE_CUBE_GEOMETRY;
      const material = this.guideMaterials.get(guide.group);
      if (!material) {
        continue;
      }
      const mesh = new THREE.Mesh(geometry, material);
      const center = worldCenter(guide.position);
      mesh.position.set(center.x, center.y, center.z);
      mesh.rotation.y = guide.rotation * (Math.PI / 2);
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
        emissive: paletteColor.value,
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
      const texture = createEmblemTexture(contributor.emblem);
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
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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

      return {
        block,
        normal: {
          x: normal.x,
          y: normal.y,
          z: normal.z,
        },
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
    this.renderer.dispose();
    this.cubeMaterial.dispose();
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
    stage: MissionVisualStage,
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
    const pulse = 0.78 + Math.sin(now * 0.004) * 0.18;
    this.missionEffectRoot.traverse((child) => {
      if (child.userData["missionPulse"] && child instanceof THREE.Mesh) {
        child.scale.setScalar(1 + Math.sin(now * 0.003) * 0.025);
        const material = child.material;
        if (material instanceof THREE.MeshStandardMaterial) {
          material.emissiveIntensity =
            (this.missionStage === 100 ? 2.25 : 1.35) * pulse;
        }
      }
      if (child.userData["missionParticles"] && child instanceof THREE.Points) {
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
    const indices: number[] = [];
    const triangleBlockIds: string[] = [];
    let vertexOffset = 0;

    for (const block of blocks) {
      const paletteColor =
        PALETTE[block.colorIndex % PALETTE.length] ?? PALETTE[0]!;
      const color = new THREE.Color(paletteColor.value);

      for (const face of CUBE_FACES) {
        const neighborPosition = addGridPositions(block.position, face.normal);
        const neighbor = this.world.getBlock(neighborPosition);
        if (neighbor?.kind === "cube") {
          continue;
        }

        for (const corner of face.corners) {
          positions.push(
            block.position.x + corner[0],
            block.position.y + corner[1],
            block.position.z + corner[2],
          );
          normals.push(face.normal.x, face.normal.y, face.normal.z);
          colors.push(color.r, color.g, color.b);
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
            emissiveIntensity: 1.35,
            roughness: 0.45,
          })
        : new THREE.MeshLambertMaterial({
            color: paletteColor.value,
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
  switch (stage) {
    case 0:
      return 0.16;
    case 25:
      return 0.32;
    case 50:
      return 0.5;
    case 75:
      return 0.82;
    case 100:
      return 1.45;
  }
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

function createEmblemTexture(emblem: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(64, 64, 8, 64, 64, 60);
    gradient.addColorStop(0, "rgba(255, 244, 190, 0.98)");
    gradient.addColorStop(0.52, "rgba(120, 240, 198, 0.74)");
    gradient.addColorStop(1, "rgba(120, 240, 198, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    context.fillStyle = "#ffffff";
    context.font = '56px "Segoe UI Emoji", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(emblem.slice(0, 4), 64, 65);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
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
