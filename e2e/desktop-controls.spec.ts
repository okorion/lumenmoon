import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

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

    // 시작 지점에서 아래를 바라보면 결정적 지면 블록이 조준 범위에 들어온다.
    await page.keyboard.down("KeyK");
    await page.waitForTimeout(500);
    await page.keyboard.up("KeyK");
    await expect(page.locator("#action-hint")).not.toHaveText(
      "블록을 조준해 보세요",
    );
    await expect(page.locator("#owner-tooltip")).toBeHidden();
    await page.keyboard.press("KeyC");
    await expect(page.locator("#owner-card")).toBeHidden();

    await page.mouse.click(720, 450, { button: "right" });
    const notice = page.locator("#owner-notice");
    await expect(notice).toBeVisible();
    await expect(page.locator("#owner-notice-name")).not.toHaveText("");
    await expect(page.locator("#owner-notice-date")).not.toHaveText("");
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
    await expect(page.locator("#owner-tooltip")).toBeVisible();
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
