import { RepositoryRequestError } from "../data/CollaborativeWorldRepository";

export interface BootFailureDescription {
  title: string;
  message: string;
}

/**
 * 초기화 오류는 공개 화면에 원문을 그대로 쓰지 않는다. 네트워크 SDK나
 * 환경 설정 오류에 URL·토큰 같은 값이 섞여도 사용자에게 노출되지 않게 한다.
 */
export function describeBootFailure(error: unknown): BootFailureDescription {
  if (error instanceof RepositoryRequestError) {
    if (error.code === "request-timeout" || error.retryable) {
      return {
        title: "공동 월드 응답이 늦어지고 있습니다",
        message:
          "네트워크 또는 Supabase 상태를 확인한 뒤 다시 시도해 주세요. 이미 보낸 변경은 같은 요청 키로만 재확인되어 중복되지 않습니다.",
      };
    }
    if (error.code === "anonymous-auth-required") {
      return {
        title: "익명 계정을 시작할 수 없습니다",
        message:
          "이 사이트의 저장소와 익명 로그인을 허용한 뒤 다시 시도해 주세요.",
      };
    }
    return {
      title: "공동 월드에 연결할 수 없습니다",
      message:
        "Supabase 프로젝트가 일시 중지됐거나 온라인 요청이 거절됐습니다. 프로젝트 상태를 확인한 뒤 다시 시도해 주세요.",
    };
  }

  const message = error instanceof Error ? error.message : "";
  if (
    /VITE_REPOSITORY_MODE|VITE_SUPABASE_|service-role|service role|온라인 모드/u.test(
      message,
    )
  ) {
    return {
      title: "온라인 설정을 확인해 주세요",
      message:
        "저장소 모드와 Supabase URL·공개 anon 키·월드 ID가 올바른지 .env.local을 확인하세요. 브라우저에는 service-role 키를 넣을 수 없습니다.",
    };
  }

  if (/IndexedDB|로컬 월드|저장소/u.test(message)) {
    return {
      title: "브라우저 저장소를 열 수 없습니다",
      message:
        "사이트 저장 권한과 사생활 보호 설정을 확인해 주세요. 재시도해도 열리지 않으면 이번 접속 데이터는 보존할 수 없습니다.",
    };
  }

  return {
    title: "게임을 시작하지 못했습니다",
    message:
      "일시적인 초기화 오류가 발생했습니다. 연결과 브라우저 저장 설정을 확인한 뒤 다시 시도해 주세요.",
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
  button.textContent = "다시 시도";
  button.addEventListener("click", retry);
  section.append(title, message, button);
  root.replaceChildren(section);
}
