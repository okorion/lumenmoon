import type { AudioSettingsChange } from "../ui/GameUI";
import type {
  AudioChannel,
  AudioPreferences,
} from "./preferences";

const AUDIO_CHANNELS = ["master", "music", "interface", "effects"] as const;

export class SoundSettingsPanel {
  private readonly status: HTMLElement;
  private readonly allOn: HTMLButtonElement;
  private readonly allOff: HTMLButtonElement;
  private readonly inputs: Readonly<Record<AudioChannel, HTMLInputElement>>;
  private readonly outputs: Readonly<Record<AudioChannel, HTMLOutputElement>>;

  constructor(root: HTMLElement) {
    const mount = required(root, "#sound-settings-mount", HTMLElement);
    mount.innerHTML = [
      '<div class="sound-settings-heading"><div><h3>소리</h3>',
      '<p id="sound-status" role="status" aria-live="polite">모든 소리 켜짐</p></div>',
      '<div class="sound-toggle-actions" role="group" aria-label="모든 소리">',
      '<button id="sound-all-on" class="ui-button ui-button--secondary ui-button--compact ui-button--toggle" type="button" aria-pressed="true">모두 켜기</button>',
      '<button id="sound-all-off" class="ui-button ui-button--quiet ui-button--compact ui-button--toggle" data-audio="none" type="button" aria-pressed="false">모두 끄기</button></div></div>',
      '<div class="sound-levels">',
      soundRange("master", "전체 음량", 52),
      soundRange("music", "배경 음악", 32),
      soundRange("interface", "메뉴와 버튼", 38),
      soundRange("effects", "움직임과 블록", 44),
      '</div><p class="sound-settings-note">설정은 이 브라우저에 저장됩니다. 소리는 화면을 한 번 누른 뒤 재생돼요.</p>',
    ].join("");
    this.status = required(root, "#sound-status", HTMLElement);
    this.allOn = required(root, "#sound-all-on", HTMLButtonElement);
    this.allOff = required(root, "#sound-all-off", HTMLButtonElement);
    this.inputs = {
      master: required(root, "#sound-master", HTMLInputElement),
      music: required(root, "#sound-music", HTMLInputElement),
      interface: required(root, "#sound-interface", HTMLInputElement),
      effects: required(root, "#sound-effects", HTMLInputElement),
    };
    this.outputs = {
      master: required(root, "#sound-master-output", HTMLOutputElement),
      music: required(root, "#sound-music-output", HTMLOutputElement),
      interface: required(root, "#sound-interface-output", HTMLOutputElement),
      effects: required(root, "#sound-effects-output", HTMLOutputElement),
    };
  }

  bind(handler: (change: AudioSettingsChange) => void): void {
    this.allOn.onclick = () => handler({ type: "enable-all" });
    this.allOff.onclick = () => handler({ type: "disable-all" });
    for (const channel of AUDIO_CHANNELS) {
      this.inputs[channel].oninput = () => {
        const value = Number(this.inputs[channel].value);
        if (Number.isFinite(value)) {
          handler({
            type: "channel",
            channel,
            level: Math.min(1, Math.max(0, value / 100)),
          });
        }
      };
    }
  }

  render(preferences: Readonly<AudioPreferences>): void {
    this.allOn.classList.toggle("is-selected", preferences.enabled);
    this.allOff.classList.toggle("is-selected", !preferences.enabled);
    this.allOn.setAttribute("aria-pressed", String(preferences.enabled));
    this.allOff.setAttribute("aria-pressed", String(!preferences.enabled));
    this.status.textContent = preferences.enabled
      ? `모든 소리 켜짐 · 전체 ${Math.round(preferences.master * 100)}%`
      : "모든 소리 꺼짐";
    this.status.dataset["enabled"] = String(preferences.enabled);
    this.status.closest(".sound-settings-section")?.classList.toggle(
      "is-muted",
      !preferences.enabled,
    );
    for (const channel of AUDIO_CHANNELS) {
      const percent = Math.round(preferences[channel] * 100);
      this.inputs[channel].value = String(percent);
      this.inputs[channel].setAttribute("aria-valuetext", `${percent}%`);
      this.outputs[channel].value = `${percent}%`;
      this.outputs[channel].textContent = `${percent}%`;
    }
  }
}

function soundRange(
  channel: AudioChannel,
  label: string,
  initialPercent: number,
): string {
  const id = `sound-${channel}`;
  return `<div class="sound-level"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="range" min="0" max="100" step="1" value="${initialPercent}" aria-valuetext="${initialPercent}%"><output id="${id}-output" for="${id}" aria-hidden="true">${initialPercent}%</output></div>`;
}

function required<T extends Element>(
  root: ParentNode,
  selector: string,
  constructor: { new (): T },
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`필수 사운드 설정 요소를 찾을 수 없습니다: ${selector}`);
  }
  return element;
}
