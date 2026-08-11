import "./style.css";
import { GameApp } from "./app/GameApp";
import { GameAnalytics } from "./app/GameAnalytics";
import { describeBootFailure, renderBootFailure } from "./app/bootFailure";

const root = document.querySelector<HTMLElement>("#app");
if (!root) {
  throw new Error("게임 루트 요소를 찾을 수 없습니다.");
}

const analytics = GameAnalytics.create();

void GameApp.boot(root, { analytics }).catch((error: unknown) => {
  analytics.failure("repository_bootstrap_failed", "boot", false, false);
  renderBootFailure(root, describeBootFailure(error));
});
