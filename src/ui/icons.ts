export type UiIconName =
  | "brand"
  | "settings"
  | "inventory"
  | "cube"
  | "base"
  | "producer"
  | "glow"
  | "mission"
  | "chevron"
  | "stair"
  | "lamp"
  | "jump"
  | "rotate"
  | "remove"
  | "place"
  | "enter"
  | "check"
  | "close"
  | "alert"
  | "emblem-diamond"
  | "emblem-orb"
  | "emblem-spire"
  | "emblem-square"
  | "emblem-star"
  | "emblem-pentagon"
  | "emblem-sun";

export interface CreatorCrestIdentity {
  publicId: string;
  nickname: string;
  emblem: string;
}

export interface CreatorCrestDesign {
  key: string;
  icon: UiIconName;
  emblemLabel: string;
  baseColor: string;
  innerColor: string;
  ringColor: string;
  symbolColor: string;
  accentColor: string;
  ringDash: readonly number[];
  accentAngle: number;
  signatureAngles: readonly number[];
}

const ICON_PATHS: Readonly<Record<UiIconName, string>> = {
  brand:
    '<path class="icon-fill" fill-rule="evenodd" d="M3 21v-9C3 5.8 6.6 2 12 2s9 3.8 9 10v9h-4v-9c0-3.8-1.8-6-5-6s-5 2.2-5 6v9H3Z"/>' +
    '<path class="icon-fill icon-accent" d="M10.7 8.1a4.4 4.4 0 1 0 4 6.4 3.6 3.6 0 0 1-4-6.4Z"/>',
  settings:
    '<path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"/>' +
    '<circle cx="14" cy="7" r="2"/><circle cx="6" cy="17" r="2"/>',
  inventory:
    '<path d="M7 8V6a5 5 0 0 1 10 0v2M5 8h14v12H5Z"/>' +
    '<rect x="8" y="11" width="3" height="3" rx=".5"/><rect x="13" y="11" width="3" height="3" rx=".5"/><path d="M8 17h8"/>',
  cube:
    '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/>' +
    '<path d="m4.4 7.7 7.6 4.2 7.6-4.2M12 12v9"/>',
  base:
    '<path d="m3.5 11 8.5-7 8.5 7M5.5 9.5V20h13V9.5"/>' +
    '<path d="M9.5 20v-6h5v6"/>',
  producer:
    '<path d="M4 20V9l5 3V9l5 3V6h5v14H4Z"/>' +
    '<path d="M8 16h2M14 16h2M16 6V3h3v3"/>',
  glow:
    '<path class="icon-fill" d="m12 2.8 1.65 5.55L19.2 10l-5.55 1.65L12 17.2l-1.65-5.55L4.8 10l5.55-1.65L12 2.8Z"/>' +
    '<path d="m18.2 15 .65 2.15L21 17.8l-2.15.65-.65 2.15-.65-2.15-2.15-.65 2.15-.65.65-2.15Z"/>',
  mission:
    '<path d="M5 21V11a7 7 0 0 1 14 0v10M9 21V11a3 3 0 0 1 6 0v10"/>' +
    '<path class="icon-fill icon-accent" d="m12 5 .6 1.4L14 7l-1.4.6L12 9l-.6-1.4L10 7l1.4-.6L12 5Z"/>',
  chevron: '<path d="m7 9 5 5 5-5"/>',
  stair: '<path d="M4 19h5v-5h5V9h6V4M4 19h16"/>',
  lamp:
    '<path d="M8.5 14.5A6 6 0 1 1 15.5 14.5L15 17H9l-.5-2.5Z"/>' +
    '<path d="M9 20h6M12 1v2M3 10H1M23 10h-2M5 3l1.5 1.5M19 3l-1.5 1.5"/>',
  jump: '<path d="M12 19V5M7 10l5-5 5 5M5 21h14"/>',
  rotate:
    '<path d="M19 8V3l-2 2a8 8 0 1 0 2.3 8"/><path d="M19 3h-5"/>',
  remove:
    '<path d="m12 3 7 4v8l-7 4-7-4V7l7-4Z"/><path d="M8.5 11h7"/>',
  place:
    '<path d="m11 3 6 3.5v7L11 17l-6-3.5v-7L11 3Z"/>' +
    '<path d="m5.3 6.7 5.7 3.2 5.7-3.2M11 10v7M19 14v7M15.5 17.5h7"/>',
  enter: '<path d="M4 12h15M14 7l5 5-5 5"/>',
  check: '<path d="m5 12.5 4.2 4.2L19 7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  alert:
    '<path d="M12 3 22 20H2L12 3Z"/><path d="M12 9v5M12 17.5v.2"/>',
  "emblem-diamond": '<path class="icon-fill" d="m12 3 7 9-7 9-7-9 7-9Z"/>',
  "emblem-orb": '<circle class="icon-fill" cx="12" cy="12" r="7"/>',
  "emblem-spire": '<path class="icon-fill" d="m12 3 8 16H4L12 3Z"/>',
  "emblem-square": '<rect class="icon-fill" x="5" y="5" width="14" height="14" rx="2"/>',
  "emblem-star":
    '<path class="icon-fill" d="m12 3 2.1 5.3 5.7.35-4.4 3.65 1.45 5.55L12 14.8l-4.85 3.05L8.6 12.3 4.2 8.65l5.7-.35L12 3Z"/>',
  "emblem-pentagon": '<path class="icon-fill" d="m12 3 9 6.6-3.45 10.6H6.45L3 9.6 12 3Z"/>',
  "emblem-sun":
    '<circle class="icon-fill" cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
};

const EMBLEM_ICONS: Readonly<Record<string, UiIconName>> = {
  "◆": "emblem-diamond",
  "◇": "emblem-diamond",
  "◈": "emblem-diamond",
  "●": "emblem-orb",
  "▲": "emblem-spire",
  "■": "emblem-square",
  "✦": "emblem-star",
  "⬟": "emblem-pentagon",
  "☼": "emblem-sun",
};

const EMBLEM_LABELS: Readonly<Record<string, string>> = {
  "◆": "다이아",
  "◇": "다이아",
  "◈": "다이아",
  "●": "원",
  "▲": "첨탑",
  "■": "사각",
  "✦": "별",
  "⬟": "오각",
  "☼": "태양",
};

const CREST_PALETTES = [
  {
    baseColor: "#12263d",
    innerColor: "#1e4053",
    ringColor: "#8be7d1",
    symbolColor: "#fff3c4",
    accentColor: "#f4cf78",
  },
  {
    baseColor: "#211f43",
    innerColor: "#3a3260",
    ringColor: "#b9a8ff",
    symbolColor: "#f7efff",
    accentColor: "#80e1d0",
  },
  {
    baseColor: "#172f43",
    innerColor: "#244d64",
    ringColor: "#9bdcff",
    symbolColor: "#fff4cf",
    accentColor: "#f0b879",
  },
  {
    baseColor: "#28203d",
    innerColor: "#493654",
    ringColor: "#e2aeea",
    symbolColor: "#fff2d0",
    accentColor: "#83e2bd",
  },
  {
    baseColor: "#17342f",
    innerColor: "#285348",
    ringColor: "#9ce8bf",
    symbolColor: "#fff0bd",
    accentColor: "#d8b6ff",
  },
  {
    baseColor: "#30273a",
    innerColor: "#594152",
    ringColor: "#f0b9c5",
    symbolColor: "#fff4d4",
    accentColor: "#8edfd8",
  },
] as const;

const CREST_RING_DASHES = [[], [2.4, 1.6], [0.7, 1.5], [4.2, 1.3, 0.8, 1.3]] as const;
const PUBLIC_TAG_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function uiIcon(name: UiIconName, className = ""): string {
  const classes = ["ui-icon", `ui-icon--${name}`, className]
    .filter(Boolean)
    .join(" ");
  return `<svg class="${classes}" data-icon="${name}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}

export function emblemIconName(emblem: string): UiIconName {
  return EMBLEM_ICONS[emblem] ?? "emblem-star";
}

export function emblemLabel(emblem: string): string {
  return `${EMBLEM_LABELS[emblem] ?? "별"} 문양`;
}

export function createCreatorCrest(
  identity: Readonly<CreatorCrestIdentity>,
): CreatorCrestDesign {
  const normalizedPublicId = identity.publicId.trim().toUpperCase();
  const normalizedNickname = identity.nickname.trim().normalize("NFC");
  const hash = stableHash(`${normalizedPublicId}|${normalizedNickname}`);
  const palette = CREST_PALETTES[hash % CREST_PALETTES.length]!;
  const signatureValues = publicTagSignature(normalizedPublicId, hash);

  return {
    key: hash.toString(16).padStart(8, "0"),
    icon: emblemIconName(identity.emblem),
    emblemLabel: emblemLabel(identity.emblem),
    ...palette,
    ringDash: CREST_RING_DASHES[(hash >>> 5) % CREST_RING_DASHES.length]!,
    accentAngle: (hash % 3600) / 10,
    signatureAngles: signatureValues.map(
      (value, index) => index * 90 - 40 + (value / 31) * 80,
    ),
  };
}

export function creatorCrestSvg(
  identity: Readonly<CreatorCrestIdentity>,
  className = "",
): string {
  const crest = createCreatorCrest(identity);
  const classes = ["creator-crest", className].filter(Boolean).join(" ");
  const ringDash = crest.ringDash.length
    ? ` stroke-dasharray="${crest.ringDash.join(" ")}"`
    : "";
  const signature = crest.signatureAngles
    .map((angle, index) => {
      const point = polarPoint(12, 12, 9.35, angle);
      const radius = index === 0 ? 0.72 : 0.48;
      return `<circle cx="${point.x}" cy="${point.y}" r="${radius}" fill="${crest.accentColor}"/>`;
    })
    .join("");
  const accent = polarPoint(12, 12, 7.7, crest.accentAngle);

  return `<svg class="${classes}" data-creator-crest="${crest.key}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="11" fill="${crest.baseColor}"/><circle cx="12" cy="12" r="9.25" fill="${crest.innerColor}" stroke="${crest.ringColor}" stroke-width="1.15"${ringDash}/>${signature}<circle cx="${accent.x}" cy="${accent.y}" r="1" fill="${crest.accentColor}" stroke="${crest.baseColor}" stroke-width=".55"/><g class="creator-crest-glyph" color="${crest.symbolColor}" transform="translate(6.1 6.1) scale(.492)">${ICON_PATHS[crest.icon]}</g></svg>`;
}

export function creatorCrestLabel(
  identity: Readonly<CreatorCrestIdentity>,
): string {
  return `${identity.nickname} ${identity.publicId} 제작자 표식, ${emblemLabel(identity.emblem)}`;
}

export function setCreatorCrest(
  element: HTMLElement,
  identity: Readonly<CreatorCrestIdentity>,
): void {
  const crest = createCreatorCrest(identity);
  element.dataset["emblem"] = identity.emblem;
  element.dataset["creatorCrest"] = crest.key;
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", creatorCrestLabel(identity));
  element.innerHTML = creatorCrestSvg(identity);
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function publicTagSignature(publicId: string, fallbackHash: number): number[] {
  const tag = publicId.replace(/^#/u, "").slice(0, 4);
  return Array.from({ length: 4 }, (_, index) => {
    const value = PUBLIC_TAG_ALPHABET.indexOf(tag[index] ?? "");
    return value >= 0 ? value : (fallbackHash >>> (index * 5)) & 31;
  });
}

function polarPoint(
  centerX: number,
  centerY: number,
  radius: number,
  degrees: number,
): { x: string; y: string } {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: (centerX + Math.cos(radians) * radius).toFixed(2),
    y: (centerY + Math.sin(radians) * radius).toFixed(2),
  };
}
