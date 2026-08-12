import "./style.css";
import { GameApp } from "./app/GameApp";
import { DeferredGameAnalytics } from "./app/DeferredGameAnalytics";

const root = document.querySelector<HTMLElement>("#app");
if (!root) {
  throw new Error("게임 루트 요소를 찾을 수 없습니다.");
}

const analytics = DeferredGameAnalytics.create();

void GameApp.boot(root, { analytics }).catch((error: unknown) => {
  analytics.failure("repository_bootstrap_failed", "boot", false, false);
  void import("./app/bootFailure")
    .then(({ describeBootFailure, renderBootFailure }) => {
      renderBootFailure(root, describeBootFailure(error));
    })
    .catch(() => renderMinimalBootFailure(root));
});

function renderMinimalBootFailure(target: HTMLElement): void {
  const section = document.createElement("section");
  section.className = "boot-error";
  section.setAttribute("role", "alert");
  const title = document.createElement("h1");
  title.textContent = "게임을 시작하지 못했어요";
  const message = document.createElement("p");
  message.textContent = "연결을 확인한 뒤 다시 시도해 주세요.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ui-button ui-button--primary";
  retry.textContent = "다시 시도";
  retry.addEventListener("click", () => window.location.reload());
  section.append(title, message, retry);
  target.replaceChildren(section);
  retry.focus();
}
