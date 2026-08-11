import {
  PALETTE,
  type BlockKind,
  type BlockRotation,
  type VoxelBlock,
} from "../domain/types";
import type { AnalyticsConsentChoice } from "../analytics/types";

export interface BuildSelection {
  kind: BlockKind;
  colorIndex: number;
  rotation: BlockRotation;
}

export interface ProgressHudState {
  inventory: number;
  baseBuilt: number;
  producerBuilt: number;
  nextAutomaticLabel: string;
  manualRemaining: number;
  producerLevel: 1 | 2;
  resetAvailable: boolean;
}

export interface PerformanceHudState {
  fps: number;
  drawCalls: number;
  visibleBlocks: number;
  activeChunks: number;
}

export type MissionStage = 0 | 25 | 50 | 75 | 100;

export interface MissionPublicContributor {
  publicId: string;
  nickname: string;
  emblem: string;
  contributionCount: number;
}

export interface MissionRecentContribution extends MissionPublicContributor {
  contributedAt: number;
}

export interface MissionRecommendedSlot {
  slotIndex: number;
  label: string;
}

export interface MissionPaletteChoice {
  paletteIndex: number;
  colorIndex: number;
  name: string;
  value: number;
}

export interface MissionPanelState {
  instanceId: string;
  missionName: string;
  layer: number;
  confirmedSlots: number;
  totalSlots: number;
  stage: MissionStage;
  myContributionCount: number;
  contributorCount: number;
  recentContributions: readonly MissionRecentContribution[];
  recommendedSlots: readonly MissionRecommendedSlot[];
  palette: readonly MissionPaletteChoice[];
  canContribute: boolean;
  contributionDisabledReason?: string;
}

export interface MissionOwnerCardDetails {
  missionName: string;
  layer: number;
  canonicalContributionId: string;
}

export interface CompletedMissionArchiveEntry {
  instanceId: string;
  missionName: string;
  layer: number;
  completedAt: number;
  contributors: readonly MissionPublicContributor[];
}

export interface MissionContributionSelection {
  instanceId: string;
  slotIndex: number;
  paletteIndex: number;
}

export class GameUI {
  readonly canvas: HTMLCanvasElement;
  readonly joystick: HTMLElement;
  readonly joystickKnob: HTMLElement;
  readonly lookZone: HTMLElement;
  readonly placeButton: HTMLButtonElement;
  readonly removeButton: HTMLButtonElement;
  readonly jumpButton: HTMLButtonElement;
  readonly rotateButton: HTMLButtonElement;
  readonly manualProductionButton: HTMLButtonElement;
  readonly resetBayButton: HTMLButtonElement;

  private readonly startOverlay: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly pointerResumeButton: HTMLButtonElement;
  private readonly startDescription: HTMLElement;
  private readonly worldMode: HTMLElement;
  private readonly storageDescription: HTMLElement;
  private readonly ownerCard: HTMLElement;
  private readonly ownerEmblem: HTMLElement;
  private readonly ownerName: HTMLElement;
  private readonly ownerId: HTMLElement;
  private readonly ownerMeta: HTMLElement;
  private readonly ownerInstalledAt: HTMLElement;
  private readonly ownerMissionMeta: HTMLElement;
  private readonly ownerActions: HTMLElement;
  private readonly ownerHighlightButton: HTMLButtonElement;
  private readonly ownerFindButton: HTMLButtonElement;
  private readonly actionHint: HTMLElement;
  private readonly saveState: HTMLElement;
  private readonly playerState: HTMLElement;
  private readonly toastElement: HTMLElement;
  private readonly selectedLabel: HTMLElement;
  private readonly fatalOverlay: HTMLElement;
  private readonly fatalTitle: HTMLElement;
  private readonly fatalMessage: HTMLElement;
  private readonly fatalRetryButton: HTMLButtonElement;
  private readonly recoveryNotice: HTMLElement;
  private readonly recoveryTitle: HTMLElement;
  private readonly recoveryMessage: HTMLElement;
  private readonly recoveryRetryButton: HTMLButtonElement;
  private readonly performanceHud: HTMLOutputElement;
  private readonly inventoryCount: HTMLElement;
  private readonly baseProgress: HTMLElement;
  private readonly producerProgress: HTMLElement;
  private readonly producerLevel: HTMLElement;
  private readonly nextAutomatic: HTMLElement;
  private readonly manualRemaining: HTMLElement;
  private readonly manualStage: HTMLElement;
  private readonly removalHold: HTMLElement;
  private readonly removalHoldBar: HTMLElement;
  private readonly missionPanel: HTMLElement;
  private readonly missionFloor: HTMLElement;
  private readonly missionTitle: HTMLElement;
  private readonly missionStage: HTMLElement;
  private readonly missionProgressBar: HTMLElement;
  private readonly missionProgressLabel: HTMLElement;
  private readonly missionMyContribution: HTMLElement;
  private readonly missionContributorCount: HTMLElement;
  private readonly missionRecentList: HTMLElement;
  private readonly missionSlotChoices: HTMLElement;
  private readonly missionPaletteChoices: HTMLElement;
  private readonly missionContributionStatus: HTMLElement;
  private readonly missionContributeButton: HTMLButtonElement;
  private readonly missionHighlightMineButton: HTMLButtonElement;
  private readonly missionArchiveButton: HTMLButtonElement;
  private readonly contributorLights: HTMLElement;
  private readonly contributorLightList: HTMLElement;
  private readonly archiveOverlay: HTMLElement;
  private readonly archiveList: HTMLElement;
  private readonly archiveCloseButton: HTMLButtonElement;
  private readonly highlightBanner: HTMLElement;
  private readonly highlightLabel: HTMLElement;
  private readonly highlightClearButton: HTMLButtonElement;
  private readonly highlightFindButton: HTMLButtonElement;
  private readonly cinematicSkipButton: HTMLButtonElement;
  private readonly analyticsSettingsButton: HTMLButtonElement;
  private readonly analyticsStartSettingsButton: HTMLButtonElement;
  private readonly analyticsSettingsOverlay: HTMLElement;
  private readonly analyticsSettingsCloseButton: HTMLButtonElement;
  private readonly analyticsConsentStatus: HTMLElement;
  private readonly analyticsAllowedButton: HTMLButtonElement;
  private readonly analyticsEssentialButton: HTMLButtonElement;
  private toastTimer: number | null = null;
  private missionState: MissionPanelState | null = null;
  private selectedMissionSlot: number | null = null;
  private selectedMissionColor: number | null = null;
  private missionContributionPending = false;
  private ownerPublicId: string | null = null;
  private archiveEntries: readonly CompletedMissionArchiveEntry[] = [];
  private archiveReturnFocus: HTMLElement | null = null;
  private analyticsReturnFocus: HTMLElement | null = null;
  private analyticsConsentChoice: AnalyticsConsentChoice = "undecided";
  private fatalRetryAction: () => void = () => window.location.reload();
  private recoveryRetryAction: (() => void) | null = null;
  private hasEnteredWorld = false;
  private selection: BuildSelection = {
    kind: "cube",
    colorIndex: 6,
    rotation: 0,
  };

  constructor(root: HTMLElement) {
    root.innerHTML = [
      '<section class="game-shell" aria-label="루멘문 게임">',
      '<canvas id="game-canvas" tabindex="0" aria-label="3D 공동 건축 월드"></canvas>',
      '<div class="sky-vignette" aria-hidden="true"></div>',
      '<header class="brand-panel glass">',
      '<span class="brand-mark" aria-hidden="true">✦</span>',
      '<div><strong>루멘문</strong><small id="world-mode">LOCAL WORLD · 01</small></div>',
      '<button id="analytics-settings-button" class="analytics-settings-button" type="button" aria-label="개인정보와 익명 통계 설정 열기" title="개인정보와 통계 설정">',
      '<span aria-hidden="true">⚙</span><i aria-hidden="true"></i></button>',
      '</header>',
      '<aside class="world-panel glass" aria-label="현재 상태">',
      '<div class="world-status-row"><span id="save-state" class="status-dot">저장 준비</span>',
      '<span id="player-state">베이 01</span></div>',
      '<div class="progress-grid">',
      '<span><small>재고</small><strong id="inventory-count">24</strong></span>',
      '<span><small>거점</small><strong id="base-progress">0/16</strong></span>',
      '<span><small>시설</small><strong id="producer-progress">0/8</strong></span>',
      '<span><small>단계</small><strong id="producer-level">Lv.1</strong></span>',
      '</div>',
      '<div class="production-status"><span id="next-automatic">자동 생산 준비 중</span>',
      '<span id="manual-remaining">수동 3회 남음</span></div>',
      '<div class="hud-actions">',
      '<button id="manual-production-button" data-testid="manual-production" type="button" title="수동 생산 단축키 F">수동 생산</button>',
      '<button id="reset-bay-button" data-testid="reset-bay" type="button" title="베이 초기화 단축키 X">내 베이 다시 시작</button>',
      '</div>',
      '<div id="manual-stage" class="manual-stage" role="status" aria-live="polite" hidden></div>',
      '</aside>',
      '<div id="owner-card" class="owner-card glass" data-testid="owner-card" hidden>',
      '<span id="owner-emblem" class="owner-emblem">✦</span>',
      '<div class="owner-copy"><small>이 블록을 만든 사람</small>',
      '<strong id="owner-name">고요한 여우</strong>',
      '<span id="owner-id">#B7K2</span>',
      '<span id="owner-meta">개인 영역 · 큐브</span>',
      '<span id="owner-installed-at" class="owner-installed-at"></span>',
      '<span id="owner-mission-meta" class="owner-mission-meta" hidden></span>',
      '<div class="owner-actions" hidden>',
      '<button id="owner-highlight-button" type="button">이 제작자의 블록 강조</button>',
      '<button id="owner-find-button" type="button">찾아가기</button>',
      '</div></div>',
      '</div>',
      '<aside id="mission-panel" class="mission-panel glass" aria-label="공동 미션" hidden>',
      '<div class="mission-heading"><div><small id="mission-floor">루멘문 · 1층</small>',
      '<strong id="mission-title">루멘문</strong></div>',
      '<span id="mission-stage" class="mission-stage">시작</span></div>',
      '<div class="mission-progress" aria-label="미션 진행률"><i id="mission-progress-bar"></i></div>',
      '<div class="mission-progress-copy"><strong id="mission-progress-label">0% · 0/24</strong>',
      '<span id="mission-contribution-status">추천 위치를 선택하세요</span></div>',
      '<div class="mission-stats">',
      '<span><small>내 기여</small><strong id="mission-my-contribution">0</strong></span>',
      '<span><small>전체 참여자</small><strong id="mission-contributor-count">0명</strong></span>',
      '</div>',
      '<section class="mission-recent" aria-label="최근 참여"><small>최근 참여</small>',
      '<div id="mission-recent-list" class="mission-recent-list"><span>아직 기여가 없어요</span></div></section>',
      '<section class="mission-choice" aria-label="추천 위치"><small>추천 위치 · 최대 3개</small>',
      '<div id="mission-slot-choices" class="mission-slot-choices"></div></section>',
      '<section class="mission-choice" aria-label="미션 색상"><small>별빛 팔레트 · 5색</small>',
      '<div id="mission-palette-choices" class="mission-palette-choices"></div></section>',
      '<button id="mission-contribute-button" class="mission-contribute-button" type="button">선택한 위치에 1블록 기여</button>',
      '<section id="contributor-lights" class="contributor-lights" aria-label="기여자의 빛" hidden>',
      '<div class="contributor-lights-heading"><strong>기여자의 빛</strong><small>모든 빛은 같은 크기예요</small></div>',
      '<div id="contributor-light-list" class="contributor-light-list"></div></section>',
      '<div class="mission-panel-actions">',
      '<button id="mission-highlight-mine" type="button">내 블록 강조</button>',
      '<button id="mission-archive-button" type="button">기록관 열기</button>',
      '</div></aside>',
      '<div id="highlight-banner" class="highlight-banner glass" role="status" hidden>',
      '<span id="highlight-label">제작자 블록을 강조하고 있어요</span>',
      '<button id="highlight-find-button" class="highlight-find" type="button" hidden>찾아가기</button>',
      '<button id="highlight-clear-button" type="button">강조 해제</button></div>',
      '<button id="cinematic-skip-button" class="cinematic-skip glass" type="button" hidden>완성 연출 건너뛰기</button>',
      '<div class="crosshair" aria-hidden="true"><span></span><span></span></div>',
      '<div id="action-hint" class="action-hint glass">블록을 조준해 보세요</div>',
      '<div id="removal-hold" class="removal-hold glass" hidden><span>공용 블록 해체</span><i id="removal-hold-bar"></i></div>',
      '<section class="build-tray glass" aria-label="건축 도구">',
      '<div class="kind-row" role="group" aria-label="블록 모양">',
      '<button type="button" class="tool-button is-selected" data-kind="cube" aria-label="큐브">■</button>',
      '<button type="button" class="tool-button" data-kind="stair" aria-label="계단">◩</button>',
      '<button type="button" class="tool-button" data-kind="light" aria-label="조명">✦</button>',
      '</div>',
      '<div id="palette-row" class="palette-row" role="group" aria-label="색상"></div>',
      '<span id="selected-label" class="selected-label">민트 · 큐브 · 0° · 1/2/3 모양 · Q/E 색 · R 회전</span>',
      '</section>',
      '<div id="look-zone" class="look-zone" aria-hidden="true"></div>',
      '<div class="mobile-controls" aria-label="모바일 조작">',
      '<div id="joystick" class="joystick" aria-label="이동 조이스틱"><span id="joystick-knob"></span></div>',
      '<div class="mobile-actions">',
      '<button id="jump-button" type="button" aria-label="점프">↑</button>',
      '<button id="rotate-button" type="button" aria-label="블록 회전">↻</button>',
      '<button id="remove-button" class="danger" type="button" aria-label="내 블록 제거">−</button>',
      '<button id="place-button" class="primary" type="button" aria-label="블록 배치">＋</button>',
      '</div></div>',
      '<div id="toast" class="toast glass" role="status" aria-live="polite" hidden></div>',
      '<section id="recovery-notice" class="recovery-notice glass" role="alert" hidden>',
      '<div><strong id="recovery-title">연결을 확인해 주세요</strong><span id="recovery-message"></span></div>',
      '<button id="recovery-retry-button" type="button">다시 시도</button></section>',
      '<output id="performance-hud" class="performance-hud" aria-label="개발 성능 정보" hidden></output>',
      '<section id="start-overlay" class="start-overlay">',
      '<div class="start-card glass">',
      '<span class="eyebrow">비동기 공동 건축 실험</span>',
      '<h1>누군가 만든 세계에<br><em>한 칸을 더하세요.</em></h1>',
      '<p id="start-description">WASD 이동 · 클릭 배치 · 우클릭 제거 · 1/2/3 모양 · Q/E 색 · R 회전 · F 생산 · X 초기화</p>',
      '<button id="start-button" data-testid="start-button" type="button">월드 들어가기 <span>→</span></button>',
      '<button id="analytics-start-settings-button" class="analytics-start-settings-button" type="button">개인정보 · 통계 설정</button>',
      '<small id="storage-description">저장 위치: 이 브라우저의 IndexedDB</small>',
      '</div></section>',
      '<button id="pointer-resume-button" class="pointer-resume glass" type="button" hidden>캔버스를 클릭해 시점 계속</button>',
      '<section id="fatal-overlay" class="fatal-overlay" hidden>',
      '<div class="fatal-card glass"><span>!</span><h2 id="fatal-title">화면을 열 수 없습니다</h2>',
      '<p id="fatal-message"></p><button id="fatal-retry-button" type="button">다시 시도</button></div>',
      '</section>',
      '<section id="mission-archive-overlay" class="mission-archive-overlay" role="dialog" aria-modal="true" aria-labelledby="mission-archive-title" hidden>',
      '<div class="mission-archive-shell glass">',
      '<header><div><span class="eyebrow">완성된 공동 건축</span><h2 id="mission-archive-title">별빛 기록관</h2>',
      '<p>점수 순위 없이, 완성 당시 모든 참여자의 빛을 보존합니다.</p></div>',
      '<button id="mission-archive-close" type="button" aria-label="기록관 닫기">닫기</button></header>',
      '<div id="mission-archive-list" class="mission-archive-list"></div>',
      '</div></section>',
      '<section id="analytics-settings-overlay" class="analytics-settings-overlay" role="dialog" aria-modal="true" aria-labelledby="analytics-settings-title" aria-describedby="analytics-settings-description" hidden>',
      '<div class="analytics-settings-shell glass">',
      '<header><div><span class="eyebrow">개인정보 선택</span>',
      '<h2 id="analytics-settings-title">익명 이용 통계</h2>',
      '<p id="analytics-settings-description">게임 개선을 위한 최소 통계만 선택적으로 보냅니다. 선택하지 않아도 모든 게임 기능을 이용할 수 있어요.</p></div>',
      '<button id="analytics-settings-close" type="button" aria-label="통계 설정 닫기">닫기</button></header>',
      '<div class="analytics-settings-content">',
      '<section class="analytics-consent-section" aria-labelledby="analytics-consent-heading">',
      '<div class="analytics-consent-heading"><div><h3 id="analytics-consent-heading">현재 선택</h3>',
      '<p id="analytics-consent-status" role="status" aria-live="polite">선택 전 · 통계를 보내지 않아요</p></div></div>',
      '<div class="analytics-consent-choices">',
      '<button id="analytics-allowed-button" class="analytics-consent-choice" type="button" aria-pressed="false">',
      '<span aria-hidden="true">✓</span><span><strong>익명 이용 통계 허용</strong>',
      '<small>세션 시작·최초 이정표·5분 단위 집계·허용된 오류 코드만 보냅니다.</small></span></button>',
      '<button id="analytics-essential-button" class="analytics-consent-choice" type="button" aria-pressed="false">',
      '<span aria-hidden="true">×</span><span><strong>필수 데이터만</strong>',
      '<small>PostHog에 보내지 않습니다. 월드 저장에 필요한 게임 데이터만 유지합니다.</small></span></button>',
      '</div></section>',
      '<section id="analytics-privacy-notice" class="analytics-privacy-notice" aria-labelledby="analytics-privacy-title">',
      '<h3 id="analytics-privacy-title">개인정보 안내</h3>',
      '<dl>',
      '<div><dt>공급자</dt><dd>PostHog Cloud</dd></div>',
      '<div><dt>목적</dt><dd>첫 플레이 흐름, 재방문, 성능과 저장 품질 개선</dd></div>',
      '<div><dt>수집 범주</dt><dd>기기 범주, 거친 진행 단계·구역 체류, 집계된 건축 행동, FPS·준비 시간 구간</dd></div>',
      '<div><dt>끄는 방법</dt><dd>이 설정에서 언제든 <strong>필수 데이터만</strong>을 선택하세요.</dd></div>',
      '</dl>',
      '<p><strong>세션 리플레이는 항상 꺼져 있습니다.</strong> 앱은 Supabase UID, 공개 ID·닉네임, IP 속성, 정확한 좌표·블록 ID, 자유 텍스트, 전체 URL, 원본 오류·브라우저 정보 또는 인증 정보를 분석에 보내지 않습니다.</p>',
      '<p>앱이 IP를 분석 속성으로 보내지는 않지만, 공급자는 서비스 제공과 보안을 위해 네트워크 요청의 IP를 처리할 수 있습니다.</p>',
      '<p><strong>익명 계정 안내:</strong> 온라인 계정은 이 브라우저 저장소에만 연결됩니다. 브라우저 데이터나 사이트 저장소를 삭제하면 같은 공개 ID·베이·기여 기록의 소유권을 복구할 수 없습니다.</p>',
      '</section></div>',
      '</div></section>',
      '<div class="sr-only" aria-live="polite" id="live-region"></div>',
      '</section>',
    ].join("");

    this.canvas = requiredElement(root, "#game-canvas", HTMLCanvasElement);
    this.joystick = requiredElement(root, "#joystick", HTMLElement);
    this.joystickKnob = requiredElement(root, "#joystick-knob", HTMLElement);
    this.lookZone = requiredElement(root, "#look-zone", HTMLElement);
    this.placeButton = requiredElement(root, "#place-button", HTMLButtonElement);
    this.removeButton = requiredElement(root, "#remove-button", HTMLButtonElement);
    this.jumpButton = requiredElement(root, "#jump-button", HTMLButtonElement);
    this.rotateButton = requiredElement(root, "#rotate-button", HTMLButtonElement);
    this.manualProductionButton = requiredElement(
      root,
      "#manual-production-button",
      HTMLButtonElement,
    );
    this.resetBayButton = requiredElement(
      root,
      "#reset-bay-button",
      HTMLButtonElement,
    );
    this.startOverlay = requiredElement(root, "#start-overlay", HTMLElement);
    this.startButton = requiredElement(root, "#start-button", HTMLButtonElement);
    this.pointerResumeButton = requiredElement(
      root,
      "#pointer-resume-button",
      HTMLButtonElement,
    );
    this.startDescription = requiredElement(root, "#start-description", HTMLElement);
    this.worldMode = requiredElement(root, "#world-mode", HTMLElement);
    this.storageDescription = requiredElement(
      root,
      "#storage-description",
      HTMLElement,
    );
    this.ownerCard = requiredElement(root, "#owner-card", HTMLElement);
    this.ownerEmblem = requiredElement(root, "#owner-emblem", HTMLElement);
    this.ownerName = requiredElement(root, "#owner-name", HTMLElement);
    this.ownerId = requiredElement(root, "#owner-id", HTMLElement);
    this.ownerMeta = requiredElement(root, "#owner-meta", HTMLElement);
    this.ownerInstalledAt = requiredElement(
      root,
      "#owner-installed-at",
      HTMLElement,
    );
    this.ownerMissionMeta = requiredElement(
      root,
      "#owner-mission-meta",
      HTMLElement,
    );
    this.ownerActions = requiredElement(root, ".owner-actions", HTMLElement);
    this.ownerHighlightButton = requiredElement(
      root,
      "#owner-highlight-button",
      HTMLButtonElement,
    );
    this.ownerFindButton = requiredElement(
      root,
      "#owner-find-button",
      HTMLButtonElement,
    );
    this.actionHint = requiredElement(root, "#action-hint", HTMLElement);
    this.saveState = requiredElement(root, "#save-state", HTMLElement);
    this.playerState = requiredElement(root, "#player-state", HTMLElement);
    this.toastElement = requiredElement(root, "#toast", HTMLElement);
    this.selectedLabel = requiredElement(root, "#selected-label", HTMLElement);
    this.fatalOverlay = requiredElement(root, "#fatal-overlay", HTMLElement);
    this.fatalTitle = requiredElement(root, "#fatal-title", HTMLElement);
    this.fatalMessage = requiredElement(root, "#fatal-message", HTMLElement);
    this.fatalRetryButton = requiredElement(
      root,
      "#fatal-retry-button",
      HTMLButtonElement,
    );
    this.recoveryNotice = requiredElement(root, "#recovery-notice", HTMLElement);
    this.recoveryTitle = requiredElement(root, "#recovery-title", HTMLElement);
    this.recoveryMessage = requiredElement(root, "#recovery-message", HTMLElement);
    this.recoveryRetryButton = requiredElement(
      root,
      "#recovery-retry-button",
      HTMLButtonElement,
    );
    this.performanceHud = requiredElement(
      root,
      "#performance-hud",
      HTMLOutputElement,
    );
    this.inventoryCount = requiredElement(root, "#inventory-count", HTMLElement);
    this.baseProgress = requiredElement(root, "#base-progress", HTMLElement);
    this.producerProgress = requiredElement(
      root,
      "#producer-progress",
      HTMLElement,
    );
    this.producerLevel = requiredElement(root, "#producer-level", HTMLElement);
    this.nextAutomatic = requiredElement(root, "#next-automatic", HTMLElement);
    this.manualRemaining = requiredElement(root, "#manual-remaining", HTMLElement);
    this.manualStage = requiredElement(root, "#manual-stage", HTMLElement);
    this.removalHold = requiredElement(root, "#removal-hold", HTMLElement);
    this.removalHoldBar = requiredElement(root, "#removal-hold-bar", HTMLElement);
    this.missionPanel = requiredElement(root, "#mission-panel", HTMLElement);
    this.missionFloor = requiredElement(root, "#mission-floor", HTMLElement);
    this.missionTitle = requiredElement(root, "#mission-title", HTMLElement);
    this.missionStage = requiredElement(root, "#mission-stage", HTMLElement);
    this.missionProgressBar = requiredElement(
      root,
      "#mission-progress-bar",
      HTMLElement,
    );
    this.missionProgressLabel = requiredElement(
      root,
      "#mission-progress-label",
      HTMLElement,
    );
    this.missionMyContribution = requiredElement(
      root,
      "#mission-my-contribution",
      HTMLElement,
    );
    this.missionContributorCount = requiredElement(
      root,
      "#mission-contributor-count",
      HTMLElement,
    );
    this.missionRecentList = requiredElement(
      root,
      "#mission-recent-list",
      HTMLElement,
    );
    this.missionSlotChoices = requiredElement(
      root,
      "#mission-slot-choices",
      HTMLElement,
    );
    this.missionPaletteChoices = requiredElement(
      root,
      "#mission-palette-choices",
      HTMLElement,
    );
    this.missionContributionStatus = requiredElement(
      root,
      "#mission-contribution-status",
      HTMLElement,
    );
    this.missionContributeButton = requiredElement(
      root,
      "#mission-contribute-button",
      HTMLButtonElement,
    );
    this.missionHighlightMineButton = requiredElement(
      root,
      "#mission-highlight-mine",
      HTMLButtonElement,
    );
    this.missionArchiveButton = requiredElement(
      root,
      "#mission-archive-button",
      HTMLButtonElement,
    );
    this.contributorLights = requiredElement(
      root,
      "#contributor-lights",
      HTMLElement,
    );
    this.contributorLightList = requiredElement(
      root,
      "#contributor-light-list",
      HTMLElement,
    );
    this.archiveOverlay = requiredElement(
      root,
      "#mission-archive-overlay",
      HTMLElement,
    );
    this.archiveList = requiredElement(root, "#mission-archive-list", HTMLElement);
    this.archiveCloseButton = requiredElement(
      root,
      "#mission-archive-close",
      HTMLButtonElement,
    );
    this.highlightBanner = requiredElement(root, "#highlight-banner", HTMLElement);
    this.highlightLabel = requiredElement(root, "#highlight-label", HTMLElement);
    this.highlightClearButton = requiredElement(
      root,
      "#highlight-clear-button",
      HTMLButtonElement,
    );
    this.highlightFindButton = requiredElement(
      root,
      "#highlight-find-button",
      HTMLButtonElement,
    );
    this.cinematicSkipButton = requiredElement(
      root,
      "#cinematic-skip-button",
      HTMLButtonElement,
    );
    this.analyticsSettingsButton = requiredElement(
      root,
      "#analytics-settings-button",
      HTMLButtonElement,
    );
    this.analyticsStartSettingsButton = requiredElement(
      root,
      "#analytics-start-settings-button",
      HTMLButtonElement,
    );
    this.analyticsSettingsOverlay = requiredElement(
      root,
      "#analytics-settings-overlay",
      HTMLElement,
    );
    this.analyticsSettingsCloseButton = requiredElement(
      root,
      "#analytics-settings-close",
      HTMLButtonElement,
    );
    this.analyticsConsentStatus = requiredElement(
      root,
      "#analytics-consent-status",
      HTMLElement,
    );
    this.analyticsAllowedButton = requiredElement(
      root,
      "#analytics-allowed-button",
      HTMLButtonElement,
    );
    this.analyticsEssentialButton = requiredElement(
      root,
      "#analytics-essential-button",
      HTMLButtonElement,
    );

    this.buildPalette(requiredElement(root, "#palette-row", HTMLElement));
    this.updateSelectedLabel();
    this.updateTouchCopy();
    this.setAnalyticsConsent("undecided");
    window.addEventListener("resize", () => this.updateTouchCopy());
    this.archiveCloseButton.addEventListener("click", () => {
      this.closeMissionArchive();
    });
    this.archiveOverlay.addEventListener("click", (event) => {
      if (event.target === this.archiveOverlay) {
        this.closeMissionArchive();
      }
    });
    this.analyticsSettingsButton.addEventListener("click", () => {
      this.openAnalyticsSettings();
    });
    this.analyticsStartSettingsButton.addEventListener("click", () => {
      this.openAnalyticsSettings();
    });
    this.analyticsSettingsCloseButton.addEventListener("click", () => {
      this.closeAnalyticsSettings();
    });
    this.analyticsSettingsOverlay.addEventListener("click", (event) => {
      if (event.target === this.analyticsSettingsOverlay) {
        this.closeAnalyticsSettings();
      }
    });
    this.fatalRetryButton.addEventListener("click", () => {
      this.fatalRetryAction();
    });
    this.recoveryRetryButton.addEventListener("click", () => {
      this.recoveryRetryAction?.();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.analyticsSettingsOverlay.hidden) {
        event.stopImmediatePropagation();
        this.closeAnalyticsSettings();
        return;
      }
      if (event.key === "Escape" && !this.archiveOverlay.hidden) {
        event.stopPropagation();
        this.closeMissionArchive();
      }
    });
  }

  get currentSelection(): Readonly<BuildSelection> {
    return this.selection;
  }

  bindStart(handler: () => void): void {
    this.startButton.addEventListener("click", handler);
    this.pointerResumeButton.addEventListener("click", handler);
  }

  bindAnalyticsConsentChange(
    handler: (choice: AnalyticsConsentChoice) => void,
  ): void {
    this.analyticsAllowedButton.addEventListener("click", () => {
      this.setAnalyticsConsent("allowed");
      handler("allowed");
    });
    this.analyticsEssentialButton.addEventListener("click", () => {
      this.setAnalyticsConsent("essential_only");
      handler("essential_only");
    });
  }

  setAnalyticsConsent(choice: AnalyticsConsentChoice): void {
    this.analyticsConsentChoice = choice;
    const allowed = choice === "allowed";
    const essentialOnly = choice === "essential_only";
    this.analyticsAllowedButton.classList.toggle("is-selected", allowed);
    this.analyticsAllowedButton.setAttribute("aria-pressed", String(allowed));
    this.analyticsEssentialButton.classList.toggle(
      "is-selected",
      essentialOnly,
    );
    this.analyticsEssentialButton.setAttribute(
      "aria-pressed",
      String(essentialOnly),
    );
    this.analyticsConsentStatus.textContent = analyticsConsentLabel(choice);
    this.analyticsConsentStatus.dataset["choice"] = choice;
    this.analyticsSettingsButton.dataset["consent"] = choice;
    this.analyticsSettingsButton.title =
      choice === "allowed"
        ? "익명 이용 통계 허용됨 · 설정 열기"
        : choice === "essential_only"
          ? "필수 데이터만 · 설정 열기"
          : "익명 이용 통계 선택 필요 · 설정 열기";
  }

  openAnalyticsSettings(): void {
    if (!this.analyticsSettingsOverlay.hidden) {
      return;
    }
    this.closeMissionArchive();
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
    this.analyticsReturnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : this.analyticsSettingsButton;
    this.analyticsSettingsOverlay.hidden = false;
    window.requestAnimationFrame(() => {
      const target =
        this.analyticsConsentChoice === "undecided"
          ? this.analyticsAllowedButton
          : this.analyticsSettingsCloseButton;
      target.focus();
    });
  }

  closeAnalyticsSettings(): void {
    if (this.analyticsSettingsOverlay.hidden) {
      return;
    }
    this.analyticsSettingsOverlay.hidden = true;
    this.analyticsReturnFocus?.focus();
    this.analyticsReturnFocus = null;
  }

  get isAnalyticsSettingsOpen(): boolean {
    return !this.analyticsSettingsOverlay.hidden;
  }

  bindResetBay(handler: () => void): void {
    this.resetBayButton.addEventListener("click", handler);
  }

  bindManualProduction(handler: () => void): void {
    this.manualProductionButton.addEventListener("click", handler);
  }

  bindSelection(handler: (selection: Readonly<BuildSelection>) => void): void {
    document.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((button) => {
      button.addEventListener("click", () => {
        const kind = button.dataset["kind"] as BlockKind | undefined;
        if (!kind) {
          return;
        }
        this.selectKind(kind);
        handler(this.selection);
      });
    });

    document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) => {
      button.addEventListener("click", () => {
        const colorIndex = Number(button.dataset["color"]);
        if (!Number.isSafeInteger(colorIndex)) {
          return;
        }
        this.selectColor(colorIndex);
        handler(this.selection);
      });
    });
  }

  rotateSelection(): Readonly<BuildSelection> {
    const rotation = ((this.selection.rotation + 1) % 4) as BlockRotation;
    this.selection = { ...this.selection, rotation };
    this.updateSelectedLabel();
    return this.selection;
  }

  selectKind(kind: BlockKind): Readonly<BuildSelection> {
    this.selection = { ...this.selection, kind };
    document.querySelectorAll<HTMLElement>("[data-kind]").forEach((item) => {
      item.classList.toggle("is-selected", item.dataset["kind"] === kind);
    });
    this.updateSelectedLabel();
    return this.selection;
  }

  cycleColor(delta: number): Readonly<BuildSelection> {
    const colorIndex =
      (this.selection.colorIndex + delta + PALETTE.length) % PALETTE.length;
    return this.selectColor(colorIndex);
  }

  enterWorld(): void {
    this.hasEnteredWorld = true;
    this.startOverlay.classList.add("is-hidden");
    this.pointerResumeButton.hidden = true;
    this.canvas.focus();
  }

  showPointerLockPrompt(): void {
    if (isTouchLayout()) {
      return;
    }
    if (this.hasEnteredWorld) {
      this.pointerResumeButton.hidden = false;
      return;
    }
    this.startDescription.textContent =
      "화면을 클릭해 시점을 다시 연결하세요. 잠금 중 F는 수동 생산, X는 베이 초기화입니다.";
    this.startButton.textContent = "시점 다시 연결 →";
    this.startOverlay.classList.remove("is-hidden");
  }

  setOwnerBlock(
    block: VoxelBlock | null,
    removable: boolean,
    placeable = false,
    removalLabel?: string,
    missionDetails?: MissionOwnerCardDetails,
  ): void {
    if (!block) {
      this.ownerCard.hidden = true;
      this.ownerPublicId = null;
      this.ownerActions.hidden = true;
      this.ownerMissionMeta.hidden = true;
      this.actionHint.textContent = "블록을 조준해 보세요";
      return;
    }

    this.ownerPublicId = block.owner.publicId;
    this.ownerCard.hidden = false;
    this.ownerEmblem.textContent = block.owner.emblem;
    this.ownerName.textContent = block.owner.nickname;
    this.ownerId.textContent = block.owner.publicId;
    this.ownerMeta.textContent =
      [zoneLabel(block.zone), kindLabel(block.kind)].join(" · ");
    this.ownerInstalledAt.textContent =
      "설치 " + formatMissionTimestamp(block.createdAt);
    const isMissionBlock = block.zone === "mission";
    this.ownerActions.hidden = !isMissionBlock;
    this.ownerFindButton.hidden = !isTouchLayout();
    this.ownerHighlightButton.setAttribute("aria-pressed", "false");
    this.ownerMissionMeta.hidden = !isMissionBlock;
    this.ownerMissionMeta.textContent = missionDetails
      ? missionDetails.missionName + " · " + String(missionDetails.layer) + "층"
      : isMissionBlock
        ? "루멘문"
        : "";
    if (missionDetails) {
      this.ownerCard.dataset["missionContributionId"] =
        missionDetails.canonicalContributionId;
    } else {
      delete this.ownerCard.dataset["missionContributionId"];
    }
    const placementLabel = placeable ? "배치 가능" : "배치 불가";
    const resolvedRemovalLabel =
      removalLabel ??
      (removable
        ? "이 블록은 제거할 수 있어요"
        : "이 블록은 보호돼요");
    this.actionHint.textContent = placementLabel + " · " + resolvedRemovalLabel;
  }

  bindOwnerHighlight(handler: (publicId: string) => void): void {
    this.ownerHighlightButton.addEventListener("click", () => {
      if (this.ownerPublicId) {
        handler(this.ownerPublicId);
      }
    });
  }

  bindOwnerFind(
    handler: (publicId: string, canonicalContributionId?: string) => void,
  ): void {
    this.ownerFindButton.addEventListener("click", () => {
      if (this.ownerPublicId) {
        handler(
          this.ownerPublicId,
          this.ownerCard.dataset["missionContributionId"],
        );
      }
    });
  }

  bindMissionContribution(
    handler: (selection: MissionContributionSelection) => void,
  ): void {
    this.missionContributeButton.addEventListener("click", () => {
      const state = this.missionState;
      if (
        !state ||
        !state.canContribute ||
        this.selectedMissionSlot === null ||
        this.selectedMissionColor === null
      ) {
        return;
      }
      handler({
        instanceId: state.instanceId,
        slotIndex: this.selectedMissionSlot,
        paletteIndex: this.selectedMissionColor,
      });
    });
  }

  bindMissionHighlightMine(handler: () => void): void {
    this.missionHighlightMineButton.addEventListener("click", handler);
  }

  bindMissionArchiveOpen(handler: () => void): void {
    this.missionArchiveButton.addEventListener("click", () => {
      this.openMissionArchive();
      handler();
    });
  }

  bindContributorLightSelect(handler: (publicId: string) => void): void {
    this.contributorLightList.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const button = target.closest<HTMLButtonElement>("[data-contributor-id]");
      const publicId = button?.dataset["contributorId"];
      if (publicId) {
        handler(publicId);
      }
    });
  }

  bindArchiveVisit(handler: (instanceId: string) => void): void {
    this.archiveList.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const button = target.closest<HTMLButtonElement>("[data-archive-visit]");
      const instanceId = button?.dataset["archiveVisit"];
      if (!instanceId) {
        return;
      }
      this.closeMissionArchive();
      handler(instanceId);
    });
  }

  bindHighlightClear(handler: () => void): void {
    this.highlightClearButton.addEventListener("click", handler);
  }

  bindHighlightFind(handler: () => void): void {
    this.highlightFindButton.addEventListener("click", handler);
  }

  bindCinematicSkip(handler: () => void): void {
    this.cinematicSkipButton.addEventListener("click", handler);
  }

  setMissionPanel(state: MissionPanelState | null): void {
    this.missionState = state;
    this.missionPanel.hidden = state === null;
    if (!state) {
      this.selectedMissionSlot = null;
      this.selectedMissionColor = null;
      return;
    }

    const total = Math.max(1, state.totalSlots);
    const confirmed = Math.max(0, Math.min(total, state.confirmedSlots));
    const percentage = Math.round((confirmed / total) * 100);
    this.missionTitle.textContent = state.missionName;
    this.missionFloor.textContent =
      state.missionName + " · " + String(state.layer) + "층";
    this.missionStage.textContent = missionStageLabel(state.stage);
    this.missionStage.dataset["stage"] = String(state.stage);
    this.missionProgressBar.style.width = String(percentage) + "%";
    this.missionProgressLabel.textContent =
      String(percentage) + "% · " + String(confirmed) + "/" + String(total);
    this.missionMyContribution.textContent = String(state.myContributionCount);
    this.missionContributorCount.textContent =
      String(state.contributorCount) + "명";

    this.renderMissionRecent(state.recentContributions);
    this.renderMissionSlots(state.recommendedSlots.slice(0, 3));
    this.renderMissionPalette(state.palette.slice(0, 5));

    const hasChoices =
      this.selectedMissionSlot !== null && this.selectedMissionColor !== null;
    this.missionContributeButton.disabled =
      this.missionContributionPending || !state.canContribute || !hasChoices;
    this.missionContributionStatus.textContent = state.canContribute
      ? hasChoices
        ? "추천 위치와 색을 선택했어요"
        : "선택 가능한 미션 슬롯이 없어요"
      : state.contributionDisabledReason ??
        "거점 16칸과 생산시설 8칸을 먼저 완성하세요";
  }

  setMissionContributionPending(pending: boolean): void {
    this.missionContributionPending = pending;
    this.missionContributeButton.disabled =
      pending ||
      !this.missionState?.canContribute ||
      this.selectedMissionSlot === null ||
      this.selectedMissionColor === null;
    this.missionContributeButton.textContent = pending
      ? "서버에서 기여 확인 중…"
      : "선택한 위치에 1블록 기여";
    this.missionPanel.toggleAttribute("aria-busy", pending);
  }

  setContributorLights(
    contributors: readonly MissionPublicContributor[],
  ): void {
    this.contributorLightList.replaceChildren();
    this.contributorLights.hidden = contributors.length === 0;
    for (const contributor of contributors) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "contributor-light";
      button.dataset["contributorId"] = contributor.publicId;
      button.title =
        contributor.nickname +
        " " +
        contributor.publicId +
        " · " +
        String(contributor.contributionCount) +
        "칸 기여";
      button.setAttribute(
        "aria-label",
        contributor.nickname +
          " " +
          contributor.publicId +
          ", " +
          String(contributor.contributionCount) +
          "칸 기여",
      );

      const emblem = document.createElement("span");
      emblem.textContent = contributor.emblem;
      const identity = document.createElement("span");
      identity.className = "contributor-light-identity";
      const nickname = document.createElement("strong");
      nickname.textContent = contributor.nickname;
      const publicId = document.createElement("small");
      publicId.textContent =
        contributor.publicId + " · " + String(contributor.contributionCount) + "칸";
      identity.append(nickname, publicId);
      button.append(emblem, identity);
      this.contributorLightList.append(button);
    }
  }

  setMissionArchive(entries: readonly CompletedMissionArchiveEntry[]): void {
    this.archiveEntries = entries;
    if (this.isMissionArchiveOpen) {
      this.renderMissionArchive();
    } else {
      // 닫힌 기록관의 카드 DOM은 만들지 않는다. 열 때 최대 50개만 렌더한다.
      this.archiveList.replaceChildren();
    }
  }

  openMissionArchive(): void {
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
    this.archiveReturnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.renderMissionArchive();
    this.archiveOverlay.hidden = false;
    window.requestAnimationFrame(() => this.archiveCloseButton.focus());
  }

  closeMissionArchive(): void {
    if (this.archiveOverlay.hidden) {
      return;
    }
    this.archiveOverlay.hidden = true;
    // 완료 카드·기여자 DOM은 기록관을 닫은 동안 유지하지 않는다.
    // 데이터는 archiveEntries에 남아 다음 open에서 필요한 만큼만 다시 만든다.
    this.archiveList.replaceChildren();
    this.archiveReturnFocus?.focus();
    this.archiveReturnFocus = null;
  }

  get isMissionArchiveOpen(): boolean {
    return !this.archiveOverlay.hidden;
  }

  setHighlightState(
    highlighted: { publicId: string; nickname: string } | null,
  ): void {
    this.highlightBanner.hidden = highlighted === null;
    this.highlightFindButton.hidden = highlighted === null || !isTouchLayout();
    this.highlightLabel.textContent = highlighted
      ? highlighted.nickname + " " + highlighted.publicId + "의 별빛을 강조 중"
      : "제작자 블록 강조 해제";
    this.ownerHighlightButton.setAttribute(
      "aria-pressed",
      String(
        highlighted !== null && highlighted.publicId === this.ownerPublicId,
      ),
    );
    this.missionHighlightMineButton.textContent = highlighted
      ? "다른 내 블록 찾기"
      : "내 블록 강조";
  }

  setCompletionCinematicActive(active: boolean): void {
    this.cinematicSkipButton.hidden = !active;
  }

  setSaveState(label: string, state: "ready" | "saving" | "warning"): void {
    this.saveState.textContent = label;
    this.saveState.dataset["state"] = state;
  }

  setPlayerState(label: string): void {
    this.playerState.textContent = label;
  }

  setRepositoryMode(mode: "local" | "online", publicId?: string): void {
    this.worldMode.textContent =
      mode === "online" ? "ONLINE WORLD · 01" : "LOCAL WORLD · 01";
    this.storageDescription.textContent =
      mode === "online"
        ? "저장 위치: Supabase 공동 월드" + (publicId ? " · " + publicId : "")
        : "저장 위치: 이 브라우저의 IndexedDB";
  }

  setProgressHud(state: ProgressHudState): void {
    this.inventoryCount.textContent = String(state.inventory);
    this.baseProgress.textContent = String(state.baseBuilt) + "/16";
    this.producerProgress.textContent = String(state.producerBuilt) + "/8";
    this.producerLevel.textContent = "Lv." + String(state.producerLevel);
    this.nextAutomatic.textContent = state.nextAutomaticLabel;
    this.manualRemaining.textContent =
      "수동 " + String(state.manualRemaining) + "회 남음";
    this.resetBayButton.hidden = !state.resetAvailable;
  }

  setManualProductionState(label: string | null, enabled: boolean): void {
    this.manualProductionButton.disabled = !enabled;
    this.manualStage.hidden = label === null;
    this.manualStage.textContent = label ?? "";
  }

  setRemovalHold(progress: number | null): void {
    if (progress === null) {
      this.removalHold.hidden = true;
      this.removalHoldBar.style.width = "0%";
      return;
    }
    this.removalHold.hidden = false;
    this.removalHoldBar.style.width =
      String(Math.round(Math.max(0, Math.min(1, progress)) * 100)) + "%";
  }

  toast(message: string): void {
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
    }
    this.toastElement.textContent = message;
    this.toastElement.hidden = false;
    this.toastTimer = window.setTimeout(() => {
      this.toastElement.hidden = true;
      this.toastTimer = null;
    }, 2200);
  }

  showFatal(
    title: string,
    message: string,
    retry: () => void = () => window.location.reload(),
  ): void {
    this.pointerResumeButton.hidden = true;
    releasePointerLockForDialog();
    this.fatalTitle.textContent = title;
    this.fatalMessage.textContent = message;
    this.fatalRetryAction = retry;
    this.fatalOverlay.hidden = false;
  }

  hideFatal(): void {
    this.fatalOverlay.hidden = true;
  }

  setRecoveryNotice(
    title: string | null,
    message = "",
    retry: (() => void) | null = null,
  ): void {
    if (title !== null && retry !== null) {
      this.pointerResumeButton.hidden = true;
      releasePointerLockForDialog();
    }
    this.recoveryRetryAction = retry;
    this.recoveryNotice.hidden = title === null;
    this.recoveryTitle.textContent = title ?? "";
    this.recoveryMessage.textContent = title === null ? "" : message;
    this.recoveryRetryButton.hidden = retry === null;
    if (
      title === null &&
      this.hasEnteredWorld &&
      !isTouchLayout() &&
      document.pointerLockElement === null
    ) {
      this.pointerResumeButton.hidden = false;
    }
  }

  get isRecoveryNoticeVisible(): boolean {
    return !this.recoveryNotice.hidden;
  }

  setPerformanceHud(state: PerformanceHudState | null): void {
    this.performanceHud.hidden = state === null;
    this.performanceHud.textContent = state
      ? [
          `FPS ${Math.round(state.fps)}`,
          `DRAW ${state.drawCalls}`,
          `BLOCK ${state.visibleBlocks}`,
          `CHUNK ${state.activeChunks}`,
        ].join("  ·  ")
      : "";
  }

  private renderMissionRecent(
    contributions: readonly MissionRecentContribution[],
  ): void {
    this.missionRecentList.replaceChildren();
    const recent = [...contributions]
      .sort((left, right) => right.contributedAt - left.contributedAt)
      .slice(0, 3);
    if (recent.length === 0) {
      const empty = document.createElement("span");
      empty.textContent = "아직 기여가 없어요";
      this.missionRecentList.append(empty);
      return;
    }

    for (const contribution of recent) {
      const item = document.createElement("span");
      item.className = "mission-recent-item";
      const emblem = document.createElement("i");
      emblem.textContent = contribution.emblem;
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = contribution.nickname;
      const meta = document.createElement("small");
      meta.textContent =
        contribution.publicId +
        " · " +
        formatRelativeMissionTime(contribution.contributedAt);
      copy.append(name, meta);
      item.append(emblem, copy);
      this.missionRecentList.append(item);
    }
  }

  private renderMissionSlots(slots: readonly MissionRecommendedSlot[]): void {
    const available = new Set(slots.map((slot) => slot.slotIndex));
    if (
      this.selectedMissionSlot === null ||
      !available.has(this.selectedMissionSlot)
    ) {
      this.selectedMissionSlot = slots[0]?.slotIndex ?? null;
    }
    this.missionSlotChoices.replaceChildren();

    for (const slot of slots) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset["missionSlot"] = String(slot.slotIndex);
      button.textContent = slot.label;
      const selected = slot.slotIndex === this.selectedMissionSlot;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener("click", () => {
        this.selectedMissionSlot = slot.slotIndex;
        this.updateMissionChoiceButtons();
      });
      this.missionSlotChoices.append(button);
    }
  }

  private renderMissionPalette(palette: readonly MissionPaletteChoice[]): void {
    const available = new Set(palette.map((color) => color.paletteIndex));
    if (
      this.selectedMissionColor === null ||
      !available.has(this.selectedMissionColor)
    ) {
      this.selectedMissionColor = palette[0]?.paletteIndex ?? null;
    }
    this.missionPaletteChoices.replaceChildren();

    for (const color of palette) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset["missionPalette"] = String(color.paletteIndex);
      button.dataset["missionColor"] = String(color.colorIndex);
      button.title = color.name;
      button.setAttribute("aria-label", "별빛 색상 " + color.name);
      button.style.setProperty(
        "--mission-swatch",
        "#" + color.value.toString(16).padStart(6, "0"),
      );
      const selected = color.paletteIndex === this.selectedMissionColor;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener("click", () => {
        this.selectedMissionColor = color.paletteIndex;
        this.updateMissionChoiceButtons();
      });
      this.missionPaletteChoices.append(button);
    }
  }

  private updateMissionChoiceButtons(): void {
    for (const button of this.missionSlotChoices.querySelectorAll<HTMLElement>(
      "[data-mission-slot]",
    )) {
      const selected =
        Number(button.dataset["missionSlot"]) === this.selectedMissionSlot;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    for (const button of this.missionPaletteChoices.querySelectorAll<HTMLElement>(
      "[data-mission-palette]",
    )) {
      const selected =
        Number(button.dataset["missionPalette"]) === this.selectedMissionColor;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }

    const enabled =
      !this.missionContributionPending &&
      this.missionState?.canContribute === true &&
      this.selectedMissionSlot !== null &&
      this.selectedMissionColor !== null;
    this.missionContributeButton.disabled = !enabled;
    this.missionContributionStatus.textContent = enabled
      ? "추천 위치와 색을 선택했어요"
      : this.missionState?.contributionDisabledReason ??
        "선택 가능한 미션 슬롯이 없어요";
  }

  private renderMissionArchive(): void {
    this.archiveList.replaceChildren();
    if (this.archiveEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mission-archive-empty";
      const emblem = document.createElement("span");
      emblem.textContent = "✦";
      const title = document.createElement("strong");
      title.textContent = "아직 완성된 관문이 없어요";
      const copy = document.createElement("p");
      copy.textContent = "24개의 정규 설계 슬롯이 채워지면 이곳에 기록됩니다.";
      empty.append(emblem, title, copy);
      this.archiveList.append(empty);
      return;
    }

    for (const entry of this.archiveEntries) {
      const article = document.createElement("article");
      article.className = "mission-archive-card";
      const header = document.createElement("header");
      const titleGroup = document.createElement("div");
      const floor = document.createElement("small");
      floor.textContent = String(entry.layer) + "층 기념물";
      const title = document.createElement("h3");
      title.textContent = entry.missionName;
      titleGroup.append(floor, title);
      const date = document.createElement("time");
      date.dateTime = new Date(entry.completedAt).toISOString();
      date.textContent = formatMissionTimestamp(entry.completedAt);
      header.append(titleGroup, date);

      const participantLabel = document.createElement("p");
      participantLabel.textContent =
        "완성 당시 참여자 " + String(entry.contributors.length) + "명";
      const people = document.createElement("div");
      people.className = "archive-contributors";
      for (const contributor of entry.contributors) {
        const person = document.createElement("div");
        person.className = "archive-contributor";
        person.title = String(contributor.contributionCount) + "칸 기여";
        const emblem = document.createElement("span");
        emblem.textContent = contributor.emblem;
        const identity = document.createElement("span");
        const nickname = document.createElement("strong");
        nickname.textContent = contributor.nickname;
        const meta = document.createElement("small");
        meta.textContent =
          contributor.publicId +
          " · " +
          String(contributor.contributionCount) +
          "칸";
        identity.append(nickname, meta);
        person.append(emblem, identity);
        people.append(person);
      }

      const visit = document.createElement("button");
      visit.type = "button";
      visit.className = "archive-visit";
      visit.dataset["archiveVisit"] = entry.instanceId;
      visit.textContent = "기념물 보러 가기";
      article.append(header, participantLabel, people, visit);
      this.archiveList.append(article);
    }
  }

  private buildPalette(container: HTMLElement): void {
    PALETTE.forEach((color, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "color-button";
      button.dataset["color"] = String(index);
      button.setAttribute("aria-label", color.name);
      button.title = color.name;
      button.style.setProperty(
        "--swatch",
        "#" + color.value.toString(16).padStart(6, "0"),
      );
      button.classList.toggle("is-selected", index === this.selection.colorIndex);
      container.append(button);
    });
  }

  private updateSelectedLabel(): void {
    const color = PALETTE[this.selection.colorIndex] ?? PALETTE[0]!;
    const selectionLabel = [
      color.name,
      kindLabel(this.selection.kind),
      String(this.selection.rotation * 90) + "°",
    ].join(" · ");
    this.selectedLabel.textContent = isTouchLayout()
      ? selectionLabel
      : selectionLabel + " · 1/2/3 모양 · Q/E 색 · R 회전";
  }

  private selectColor(colorIndex: number): Readonly<BuildSelection> {
    this.selection = { ...this.selection, colorIndex };
    document.querySelectorAll<HTMLElement>("[data-color]").forEach((item) => {
      item.classList.toggle(
        "is-selected",
        Number(item.dataset["color"]) === colorIndex,
      );
    });
    this.updateSelectedLabel();
    return this.selection;
  }

  private updateTouchCopy(): void {
    if (!isTouchLayout()) {
      return;
    }
    this.startDescription.textContent =
      "왼쪽 스틱으로 이동하고 오른쪽 화면을 밀어 둘러보세요. 큰 ＋ 버튼으로 블록을 놓습니다.";
  }
}

export function isTouchLayout(): boolean {
  return (
    window.matchMedia("(pointer: coarse)").matches ||
    window.innerWidth <= 760
  );
}

export function missionStageLabel(stage: MissionStage): string {
  switch (stage) {
    case 0:
      return "별빛 모으는 중";
    case 25:
      return "바닥 문양 점등";
    case 50:
      return "좌우 기둥 활성화";
    case 75:
      return "상단 고리 · 빛줄기";
    case 100:
      return "불변 기념물 완성";
  }
}

export function analyticsConsentLabel(
  choice: AnalyticsConsentChoice,
): string {
  switch (choice) {
    case "undecided":
      return "선택 전 · 통계를 보내지 않아요";
    case "allowed":
      return "익명 이용 통계 허용됨";
    case "essential_only":
      return "필수 데이터만 · 익명 통계 꺼짐";
  }
}

export function releasePointerLockForDialog(): void {
  if (
    document.pointerLockElement !== null &&
    typeof document.exitPointerLock === "function"
  ) {
    document.exitPointerLock();
  }
}

function formatMissionTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    return "시각 미상";
  }
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatRelativeMissionTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return "방금";
  }
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) {
    return "방금";
  }
  if (minutes < 60) {
    return String(minutes) + "분 전";
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return String(hours) + "시간 전";
  }
  return formatMissionTimestamp(timestamp);
}

function requiredElement<T extends Element>(
  root: ParentNode,
  selector: string,
  constructor: { new (): T },
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error("필수 UI 요소를 찾을 수 없습니다: " + selector);
  }
  return element;
}

function kindLabel(kind: BlockKind): string {
  switch (kind) {
    case "cube":
      return "큐브";
    case "stair":
      return "계단";
    case "light":
      return "조명";
  }
}

function zoneLabel(zone: VoxelBlock["zone"]): string {
  switch (zone) {
    case "system":
      return "시스템";
    case "personal":
      return "개인 영역";
    case "producer":
      return "생산시설";
    case "public":
      return "공용 확장부";
    case "mission":
      return "루멘문";
  }
}

