import { RepositoryRequestError } from "../data/CollaborativeWorldRepository";
import { IndexedDbUpgradeBlockedError } from "../data/IndexedDbWorldRepository";

export interface BootFailureDescription {
  title: string;
  message: string;
}

/**
 * 초기화 오류는 공개 화면에 원문을 그대로 쓰지 않는다. 네트워크 SDK나
 * 환경 설정 오류에 URL·토큰 같은 값이 섞여도 사용자에게 노출되지 않게 한다.
 */
export function describeBootFailure(error: unknown): BootFailureDescription {
  if (error instanceof IndexedDbUpgradeBlockedError) {
    return {
      title: "다른 게임 탭을 닫아 주세요",
      message:
        "저장 형식을 안전하게 갱신하려면 열려 있는 루멘문 탭을 모두 닫은 뒤 다시 시도해 주세요.",
    };
  }

  if (error instanceof RepositoryRequestError) {
    if (error.code === "request-timeout" || error.retryable) {
      return {
        title: "연결이 늦어지고 있어요",
        message: "인터넷 연결을 확인하고 잠시 후 다시 시도해 주세요.",
      };
    }
    if (error.code === "anonymous-auth-required") {
      return {
        title: "온라인 플레이 정보를 준비하지 못했어요",
        message: "잠시 후 다시 시도해 주세요.",
      };
    }
    return {
      title: "온라인 플레이를 시작하지 못했어요",
      message: "잠시 후 다시 이용해 주세요.",
    };
  }

  const message = error instanceof Error ? error.message : "";
  if (
    /VITE_REPOSITORY_MODE|VITE_SUPABASE_|service-role|service role|온라인 모드/u.test(
      message,
    )
  ) {
    return {
      title: "온라인 월드가 준비되지 않았어요",
      message:
        "잠시 후 다시 시도해 주세요.",
    };
  }

  if (/IndexedDB|로컬 월드|저장소/u.test(message)) {
    return {
      title: "게임을 저장할 수 없어요",
      message:
        "브라우저의 사이트 저장 권한을 확인해 주세요. 다시 열리지 않으면 이번 플레이는 저장되지 않습니다.",
    };
  }

  return {
    title: "게임을 시작하지 못했어요",
    message:
      "인터넷 연결과 브라우저의 사이트 저장 권한을 확인한 뒤 다시 시도해 주세요.",
  };
}

export function renderBootFailure(
  root: HTMLElement,
  description: BootFailureDescription,
  retry: () => void = () => window.location.reload(),
): void {
  const section = document.createElement("section");
  section.className = "boot-error";
  section.setAttribute("role", "alert");
  const title = document.createElement("h1");
  title.textContent = description.title;
  const message = document.createElement("p");
  message.textContent = description.message;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ui-button ui-button--primary";
  button.textContent = "다시 시도";
  button.addEventListener("click", retry);
  section.append(title, message, button);
  root.replaceChildren(section);
}
