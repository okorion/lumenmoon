import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

test.describe("데스크톱 건축 조작", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "lumenmoon:analytics-consent:v1",
        "essential_only",
      );
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page
      .locator('.game-mode-choice:has(input[value="free"])')
      .click();
    await page.locator("#start-button").click();
    await expect(page.locator(".start-overlay")).toBeHidden({ timeout: 30_000 });
    await expect
      .poll(() =>
        page.evaluate(() => document.pointerLockElement?.id ?? null),
      )
      .toBe("game-canvas");
  });

  test("우클릭 안내와 Esc UI, 도구 드래그를 한 흐름으로 제공한다", async ({
    page,
  }) => {
    const trayButtons = page.locator(".tool-button");
    await expect(trayButtons).toHaveCount(3);
    for (const button of await trayButtons.all()) {
      await expect(button).toHaveCSS("pointer-events", "none");
    }
    await page.keyboard.press("KeyI");
    await expect(page.locator("#world-panel-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    const actionHint = page.locator("#action-hint");
    await aimAtGroundBlock(page, actionHint);
    await expect(page.locator("#owner-tooltip")).toBeHidden();
    await page.keyboard.press("KeyC");
    await expect(page.locator("#owner-card")).toBeHidden();

    // Pointer Lock에서는 좌표 이동 없이 현재 조준점에 보조 클릭만 보낸다.
    // mouse.click(x, y)는 합성 이동 이벤트로 카메라까지 돌릴 수 있다.
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    const notice = page.locator("#owner-notice");
    await expect(notice).toBeVisible();
    await expect(page.locator("#owner-notice-name")).not.toHaveText(
      "조준한 블록이 없어요",
    );
    await expect(page.locator("#owner-notice-date")).toBeVisible();
    await expect(page.locator("#owner-notice-date")).toHaveAttribute(
      "datetime",
      /\d{4}-\d{2}-\d{2}T/u,
    );
    await expect(notice).toHaveCSS("opacity", "1");
    await page.locator(".performance-hud").evaluate((element) => {
      (element as HTMLElement).hidden = true;
    });
    await page.screenshot({
      path: resolve(
        process.cwd(),
        "e2e/screenshots/desktop-owner-notice-1440x900.png",
      ),
      fullPage: true,
    });

    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.evaluate(() => document.pointerLockElement === null))
      .toBe(true);
    await expect(page.locator("#pointer-resume-button")).toBeVisible();
    for (const button of await trayButtons.all()) {
      await expect(button).toHaveCSS("pointer-events", "auto");
    }
    await page.keyboard.press("KeyI");
    await expect(page.locator("#world-panel-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.keyboard.press("KeyI");
    await expect(page.locator("#world-panel-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    const cube = page.locator('.tool-button[data-kind="cube"]');
    const light = page.locator('.tool-button[data-kind="light"]');
    const cubeBox = await cube.boundingBox();
    const lightBox = await light.boundingBox();
    if (!cubeBox || !lightBox) {
      throw new Error("데스크톱 도구 버튼의 위치를 읽지 못했습니다.");
    }
    await page.mouse.move(
      cubeBox.x + cubeBox.width / 2,
      cubeBox.y + cubeBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      lightBox.x + lightBox.width / 2,
      lightBox.y + lightBox.height / 2,
      { steps: 6 },
    );
    await page.mouse.up();
    await expect(light).toHaveAttribute("aria-pressed", "true");
    await expect(cube).toHaveAttribute("aria-pressed", "false");

    const layout = await page.evaluate(() => {
      const visibleRect = (selector: string): DOMRect | null => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element || element.hidden) return null;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return null;
        return element.getBoundingClientRect();
      };
      const profile = visibleRect(".profile-status-panel");
      const mission = visibleRect(".mission-panel");
      const tray = visibleRect(".build-tray");
      const overlaps = (left: DOMRect | null, right: DOMRect | null): boolean =>
        Boolean(
          left &&
            right &&
            left.left < right.right &&
            left.right > right.left &&
            left.top < right.bottom &&
            left.bottom > right.top,
        );
      const textSize = (selector: string): number =>
        Number.parseFloat(
          getComputedStyle(document.querySelector<HTMLElement>(selector)!).fontSize,
        );
      return {
        horizontalOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
        profileMissionOverlap: overlaps(profile, mission),
        missionTrayOverlap: overlaps(mission, tray),
        profileTextSize: textSize(".profile-copy strong"),
        missionTitleSize: textSize(".mission-heading strong"),
        inventoryTextSize: textSize(".block-stack strong"),
      };
    });
    expect(layout).toMatchObject({
      horizontalOverflow: false,
      profileMissionOverlap: false,
      missionTrayOverlap: false,
    });
    expect(layout.profileTextSize).toBeGreaterThanOrEqual(14);
    expect(layout.missionTitleSize).toBeGreaterThanOrEqual(16);
    expect(layout.inventoryTextSize).toBeGreaterThanOrEqual(14);

    await expect(notice).toBeHidden({ timeout: 3_000 });
    await page.locator(".performance-hud").evaluate((element) => {
      (element as HTMLElement).hidden = true;
    });
    await page.screenshot({
      path: resolve(
        process.cwd(),
        "e2e/screenshots/desktop-controls-1440x900.png",
      ),
      fullPage: true,
    });
  });

  test("중간 폭 마우스 화면에서도 내 정보와 관문 패널을 겹치지 않는다", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page
      .locator('.game-mode-choice:has(input[value="mission"])')
      .click();
    await page.locator("#start-button").click();
    await expect(page.locator(".start-overlay")).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900);
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.evaluate(() => document.pointerLockElement === null))
      .toBe(true);

    const profileToggle = page.locator("#world-panel-toggle");
    const missionPanel = page.locator("#mission-panel");
    await expect(missionPanel).toBeVisible();
    await profileToggle.click();
    await expect(profileToggle).toHaveAttribute("aria-expanded", "true");
    await expect(missionPanel).toBeHidden();
    await profileToggle.click();
    await expect(profileToggle).toHaveAttribute("aria-expanded", "false");
    await expect(missionPanel).toBeVisible();
  });
});

async function aimAtGroundBlock(
  page: Page,
  actionHint: Locator,
): Promise<void> {
  // 키를 계속 누른 시간은 렌더 FPS에 따라 회전량이 달라진다. 짧은 burst마다
  // 실제 조준 상태를 확인해 저성능 CI에서도 블록을 지나쳐 버리지 않게 한다.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await page.keyboard.down("KeyK");
    await page.waitForTimeout(40);
    await page.keyboard.up("KeyK");
    if ((await actionHint.textContent()) !== "블록을 조준해 보세요") {
      // 첫 접촉 경계보다 안쪽을 바라보게 한 번 더 작게 이동한다.
      await page.keyboard.down("KeyK");
      await page.waitForTimeout(60);
      await page.keyboard.up("KeyK");
      await expect(actionHint).not.toHaveText("블록을 조준해 보세요");
      return;
    }
  }
  throw new Error("결정적 지면 블록을 조준하지 못했습니다.");
}
