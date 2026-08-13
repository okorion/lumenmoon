import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

async function expectNoWcagAaViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map(({ target }) => target),
    })),
  ).toEqual([]);
}

test.describe("핵심 UI 접근성", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "lumenmoon:analytics-consent:v1",
        "essential_only",
      );
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#start-button")).toBeVisible();
  });

  test("시작 전에는 배경을 제외하고 확대를 허용한다", async ({ page }) => {
    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport).not.toContain("maximum-scale");
    expect(viewport).not.toContain("user-scalable=no");
    const touchActions = await page.locator("#start-overlay").evaluate((element) => ({
        overlay: getComputedStyle(element).touchAction,
        shell: getComputedStyle(element.parentElement!).touchAction,
        app: getComputedStyle(document.querySelector("#app")!).touchAction,
      }));
    // Chromium normalizes `pan-x pan-y pinch-zoom` to its equivalent alias,
    // `manipulation`. Either value allows native pinch zoom.
    expect(Object.values(touchActions)).toEqual([
      expect.stringMatching(/^(?:manipulation|.*pinch-zoom.*)$/u),
      expect.stringMatching(/^(?:manipulation|.*pinch-zoom.*)$/u),
      expect.stringMatching(/^(?:manipulation|.*pinch-zoom.*)$/u),
    ]);
    await expect(page.locator("#game-canvas")).toHaveCSS("touch-action", "none");
    expect(
      await page.locator("#game-shell > :not(#start-overlay)").evaluateAll(
        (elements) => elements.every((element) => (element as HTMLElement).inert),
      ),
    ).toBe(true);
    await expectNoWcagAaViolations(page);
  });

  test("설정은 포커스를 가두고 닫은 뒤 시작 화면으로 복원한다", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const opener = page.locator("#analytics-start-settings-button");
    await opener.focus();
    await opener.press("Enter");
    const dialog = page.locator("#analytics-settings-overlay");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(
      await page.locator("#game-shell > :not(#analytics-settings-overlay)").evaluateAll(
        (elements) => elements.every((element) => (element as HTMLElement).inert),
      ),
    ).toBe(true);

    for (let index = 0; index < 16; index += 1) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() =>
          Boolean(document.activeElement?.closest("#analytics-settings-overlay")),
        ),
      ).toBe(true);
    }
    await expectNoWcagAaViolations(page);
    await page.screenshot({
      path: resolve(
        process.cwd(),
        "e2e/screenshots/sound-settings-mobile-390x844.png",
      ),
      fullPage: true,
    });

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("240 CSS px에서도 설정이 가로로 잘리지 않고 내부에서 세로 탐색된다", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 240, height: 422 });
    await page.locator("#analytics-start-settings-button").click();
    const layout = await page.locator("#analytics-settings-overlay").evaluate(
      (overlay) => {
        const viewportWidth = document.documentElement.clientWidth;
        const visibleElements = [...overlay.querySelectorAll<HTMLElement>("*")].filter(
          (element) => {
            const style = getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden";
          },
        );
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth,
          overflowTargets: visibleElements
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.left < -0.5 || rect.right > viewportWidth + 0.5;
            })
            .map((element) => element.id || element.className)
            .slice(0, 10),
        };
      },
    );
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.overflowTargets).toEqual([]);
    await expectNoWcagAaViolations(page);
  });
});
