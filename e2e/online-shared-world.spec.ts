import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  createClient,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import type {
  PlayerBootstrap,
  WorldAction,
} from "../src/data/CollaborativeWorldRepository";
import { SupabaseRepository } from "../src/data/SupabaseRepository";
import { expandMissionBlocks } from "../src/domain/mission";
import { createStarterBayLayout } from "../src/domain/starterBay";

const WORLD_ID = "00000000-0000-4000-8000-000000000001";
const SUPABASE_URL =
  process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
const ANALYTICS_CONSENT_KEY = "one-more-block:analytics-consent:v1";
const AUTH_STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
const SCREENSHOT_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

interface Actor {
  client: SupabaseClient;
  repository: SupabaseRepository;
  bootstrap: PlayerBootstrap;
  session: Session;
}

test.describe("두 익명 사용자의 비동기 공동 월드", () => {
  test.skip(
    !SUPABASE_ANON_KEY,
    "SUPABASE_TEST_ANON_KEY가 없어 로컬 Supabase 온라인 E2E를 대기합니다.",
  );

  test("A 온보딩부터 B의 제작자 확인, 재접속, 다음 미션까지 이어진다", async ({
    browser,
  }) => {
    await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });

    const [actorA, actorB] = await Promise.all([
      createActor(requiredAnonKey()),
      createActor(requiredAnonKey()),
    ]);

    expect(actorA.bootstrap.baySlotIndex).not.toBe(
      actorB.bootstrap.baySlotIndex,
    );
    expect(actorA.bootstrap.progress.inventory).toBe(24);
    expect(actorB.bootstrap.progress.inventory).toBe(24);

    const [onboardedA, onboardedB] = await Promise.all([
      completeOnboarding(actorA),
      completeOnboarding(actorB),
    ]);
    expect(onboardedA.progress).toMatchObject({
      inventory: 2,
      baseCompleted: true,
      producerCompleted: true,
      trialRewardClaimed: true,
    });
    expect(onboardedB.progress).toMatchObject({
      inventory: 2,
      baseCompleted: true,
      producerCompleted: true,
      trialRewardClaimed: true,
    });

    const aContext = await createMobileContext(browser, actorA.session);
    const aPage = await aContext.newPage();
    const aErrors = observePageErrors(aPage);
    await openPlayableWorld(aPage);
    await expectOnboardingHud(aPage, 2);

    const selectedSlot = await firstRecommendedSlot(aPage);
    await aPage.locator("#mission-contribute-button").click();
    await expect(aPage.locator("#inventory-count")).toHaveText("1");
    await expect(aPage.locator("#mission-my-contribution")).toHaveText("1");
    await expect(aPage.locator("#mission-recent-list")).toContainText(
      actorA.bootstrap.player.publicId,
    );

    const missionAfterA = (
      await actorA.repository.getMissionOverview(WORLD_ID)
    ).activeMission;
    expect(missionAfterA.filledSlots).toBe(1);
    expect(
      missionAfterA.canonicalBlocks.find(
        ({ slotIndex }) => slotIndex === selectedSlot,
      )?.creator,
    ).toEqual({
      publicId: actorA.bootstrap.player.publicId,
      nickname: actorA.bootstrap.player.nickname,
      emblem: actorA.bootstrap.player.emblem,
    });
    const aDisplayBlocks = expandMissionBlocks(missionAfterA).filter(
      ({ owner }) => owner.publicId === actorA.bootstrap.player.publicId,
    );
    expect(aDisplayBlocks.filter(({ mission }) => !mission.isReplica)).toHaveLength(
      1,
    );
    expect(aDisplayBlocks.some(({ mission }) => mission.isReplica)).toBe(true);

    const aReconnectState = await aContext.storageState();
    await aContext.close();

    const bContext = await createMobileContext(browser, actorB.session);
    const bPage = await bContext.newPage();
    const bErrors = observePageErrors(bPage);
    await openPlayableWorld(bPage);
    await expectOnboardingHud(bPage, 2);
    await exerciseConcurrentMobileControls(bContext, bPage);
    await verifyCreatorDiscovery(bPage, actorA.bootstrap);
    await assertMobileLayout(bPage);
    const mobilePerformance = await readPerformanceSnapshot(bPage);
    await hideDevelopmentPerformanceHud(bPage);
    await bPage.screenshot({
      path: resolve(SCREENSHOT_DIRECTORY, "shared-world-mobile-844x390.png"),
      fullPage: true,
    });

    const bStorageState = await bContext.storageState();
    const portraitContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      storageState: bStorageState,
    });
    const portraitPage = await portraitContext.newPage();
    const portraitErrors = observePageErrors(portraitPage);
    await openPlayableWorld(portraitPage);
    await expectOnboardingHud(portraitPage, 2);
    await verifyCreatorDiscovery(portraitPage, actorA.bootstrap);
    await assertMobileLayout(portraitPage);
    await hideDevelopmentPerformanceHud(portraitPage);
    await portraitPage.screenshot({
      path: resolve(SCREENSHOT_DIRECTORY, "shared-world-mobile-390x844.png"),
      fullPage: true,
    });
    await portraitContext.close();

    const shortPortraitContext = await browser.newContext({
      viewport: { width: 390, height: 667 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      storageState: bStorageState,
    });
    const shortPortraitPage = await shortPortraitContext.newPage();
    const shortPortraitErrors = observePageErrors(shortPortraitPage);
    await openPlayableWorld(shortPortraitPage);
    await expectOnboardingHud(shortPortraitPage, 2);
    await verifyCreatorDiscovery(shortPortraitPage, actorA.bootstrap);
    await assertMobileLayout(shortPortraitPage);
    await shortPortraitContext.close();

    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: bStorageState,
    });
    const desktopPage = await desktopContext.newPage();
    const desktopErrors = observePageErrors(desktopPage);
    await openPlayableWorld(desktopPage);
    const desktopLight = desktopPage.locator(
      `[data-contributor-id="${actorA.bootstrap.player.publicId}"]`,
    );
    await expect(desktopLight).toBeVisible();
    await desktopLight.evaluate((button) => {
      (button as HTMLButtonElement).click();
    });
    // 데스크톱에서는 찾아가기 버튼을 숨기지만, 같은 상태·카메라를 캡처하기
    // 위해 이미 연결된 동작을 호출한다. 실제 데스크톱 사용자는 직접 조준한다.
    await desktopPage.locator("#highlight-find-button").evaluate((button) => {
      (button as HTMLButtonElement).click();
    });
    await expectCreatorCard(desktopPage, actorA.bootstrap);
    await assertDesktopLayout(desktopPage);
    const desktopPerformance = await readPerformanceSnapshot(desktopPage);
    await hideDevelopmentPerformanceHud(desktopPage);
    await desktopPage.screenshot({
      path: resolve(SCREENSHOT_DIRECTORY, "shared-world-desktop-1440x900.png"),
      fullPage: true,
    });
    await writeFile(
      resolve(SCREENSHOT_DIRECTORY, "performance-snapshot.json"),
      JSON.stringify(
        {
          measurement: "Playwright headless Edge on the development server; not a physical-device benchmark",
          mobile: mobilePerformance,
          desktop: desktopPerformance,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await assertContextLossRecovery(desktopPage);
    await desktopContext.close();

    await fillMissionUntilLastSlot(missionAfterA.id, 23);
    const beforeFinal = await actorB.repository.getMissionOverview(WORLD_ID);
    expect(beforeFinal.activeMission.id).toBe(missionAfterA.id);
    expect(beforeFinal.activeMission.filledSlots).toBe(23);
    const finalSlot = beforeFinal.activeMission.recommendedSlotIndexes[0];
    expect(typeof finalSlot).toBe("number");

    const [finisherA, finisherB] = await Promise.all([
      createReadyActor(requiredAnonKey()),
      createReadyActor(requiredAnonKey()),
    ]);
    const finalRequestA = {
      worldId: WORLD_ID,
      missionInstanceId: missionAfterA.id,
      slotIndex: finalSlot!,
      paletteIndex: 0,
      idempotencyKey: crypto.randomUUID(),
    };
    const finalRequestB = {
      ...finalRequestA,
      idempotencyKey: crypto.randomUUID(),
    };
    const finalRace = await Promise.allSettled([
      finisherA.repository.contributeToMission(finalRequestA),
      finisherB.repository.contributeToMission(finalRequestB),
    ]);
    expect(finalRace.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(finalRace.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    const winnerIndex = finalRace.findIndex(
      ({ status }) => status === "fulfilled",
    );
    const winningResult = finalRace[winnerIndex];
    if (!winningResult || winningResult.status !== "fulfilled") {
      throw new Error("마지막 슬롯 경쟁의 성공 응답을 찾지 못했습니다.");
    }
    const winner = winnerIndex === 0 ? finisherA : finisherB;
    const winningRequest = winnerIndex === 0 ? finalRequestA : finalRequestB;
    expect(winningResult.value.mission.status).toBe("completed");
    expect(winningResult.value.mission.filledSlots).toBe(24);
    expect(winningResult.value.nextMission?.layer).toBe(
      missionAfterA.layer + 1,
    );

    const replay = await winner.repository.contributeToMission(winningRequest);
    expect(replay.replayed).toBe(true);
    expect(replay.nextMission?.id).toBe(winningResult.value.nextMission?.id);

    const [nextOverview, archive] = await Promise.all([
      actorB.repository.getMissionOverview(WORLD_ID),
      actorB.repository.listCompletedMissions(WORLD_ID),
    ]);
    expect(nextOverview.activeMission.layer).toBe(missionAfterA.layer + 1);
    expect(nextOverview.activeMission.id).toBe(winningResult.value.nextMission?.id);
    expect(
      archive.missions.filter(({ id }) => id === missionAfterA.id),
    ).toHaveLength(1);

    await bPage.reload({ waitUntil: "domcontentloaded" });
    await openPlayableWorld(bPage, false);
    await bPage.locator("#mission-archive-button").click();
    await expect(bPage.locator("#mission-archive-overlay")).toBeVisible();
    const archiveCard = bPage.locator(".mission-archive-card").filter({
      hasText: actorA.bootstrap.player.publicId,
    });
    await expect(archiveCard).toContainText(actorA.bootstrap.player.nickname);
    await expect(archiveCard).toContainText(actorA.bootstrap.player.emblem);
    await expect(archiveCard).toContainText("1칸");
    await bPage.screenshot({
      path: resolve(SCREENSHOT_DIRECTORY, "archive-mobile-844x390.png"),
      fullPage: true,
    });
    const archiveItems = bPage.locator("#mission-archive-list > *");
    expect(await archiveItems.count()).toBeGreaterThan(0);
    await bPage.locator("#mission-archive-close").click();
    await expect(bPage.locator("#mission-archive-overlay")).toBeHidden();
    await expect(archiveItems).toHaveCount(0);
    await bPage.locator("#mission-archive-button").click();
    await expect(bPage.locator("#mission-archive-overlay")).toBeVisible();
    await expect(
      bPage.locator(".mission-archive-card").filter({
        hasText: actorA.bootstrap.player.publicId,
      }),
    ).toContainText(actorA.bootstrap.player.nickname);

    const reconnectedAContext = await browser.newContext({
      viewport: { width: 844, height: 390 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      storageState: aReconnectState,
    });
    const reconnectedAPage = await reconnectedAContext.newPage();
    const reconnectedErrors = observePageErrors(reconnectedAPage);
    await openPlayableWorld(reconnectedAPage);
    await expectOnboardingHud(reconnectedAPage, 1);
    await expect(reconnectedAPage.locator("#storage-description")).toContainText(
      actorA.bootstrap.player.publicId,
    );
    await reconnectedAPage.locator("#mission-archive-button").click();
    await expect(
      reconnectedAPage.locator(".mission-archive-card").filter({
        hasText: actorA.bootstrap.player.publicId,
      }),
    ).toContainText("1칸");

    const reconnectedBootstrap = await actorA.repository.bootstrapPlayer(WORLD_ID);
    expect(reconnectedBootstrap.baySlotIndex).toBe(
      actorA.bootstrap.baySlotIndex,
    );
    expect(reconnectedBootstrap.progress.inventory).toBe(1);
    expect(reconnectedBootstrap.progress.lastSettledAt).toBeGreaterThanOrEqual(
      onboardedA.progress.lastSettledAt,
    );

    for (const [label, errors] of [
      ["A", aErrors],
      ["B", bErrors],
      ["portrait B", portraitErrors],
      ["short portrait B", shortPortraitErrors],
      ["desktop B", desktopErrors],
      ["reconnected A", reconnectedErrors],
    ] as const) {
      expect(errors, `${label} 브라우저 오류`).toEqual([]);
    }
    const bBody = await bPage.locator("body").innerText();
    expect(bBody).not.toContain(actorB.session.user.id);
    expect(bBody).not.toContain(actorB.session.access_token);

    await reconnectedAContext.close();
    await bContext.close();
  });
});

async function createActor(anonKey: string): Promise<Actor> {
  const client = createClient(SUPABASE_URL, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const repository = new SupabaseRepository(client, { worldId: WORLD_ID });
  const bootstrap = await repository.bootstrapPlayer(WORLD_ID);
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    throw new Error("익명 사용자 세션을 가져오지 못했습니다.", {
      cause: error ?? undefined,
    });
  }
  return { client, repository, bootstrap, session: data.session };
}

async function createReadyActor(anonKey: string): Promise<Actor> {
  const actor = await createActor(anonKey);
  await completeOnboarding(actor);
  return actor;
}

async function completeOnboarding(actor: Actor) {
  const layout = createStarterBayLayout(actor.bootstrap.baySlotIndex);
  const actions: WorldAction[] = [
    ...layout.baseGuides,
    ...layout.producerGuides,
  ].map((guide) => ({
    type: "place",
    blockId: crypto.randomUUID(),
    position: { ...guide.position },
    kind: guide.kind,
    rotation: guide.rotation,
    colorIndex: 1,
  }));
  expect(actions).toHaveLength(24);
  const result = await actor.repository.commitWorldActions({
    worldId: WORLD_ID,
    idempotencyKey: crypto.randomUUID(),
    actions,
  });
  const replayBootstrap = await actor.repository.bootstrapPlayer(WORLD_ID);
  expect(replayBootstrap.progress.inventory).toBe(result.progress.inventory);
  expect(replayBootstrap.progress.trialRewardClaimed).toBe(true);
  return result;
}

async function fillMissionUntilLastSlot(
  missionInstanceId: string,
  targetFilledSlots: number,
): Promise<void> {
  while (true) {
    const actor = await createReadyActor(requiredAnonKey());
    for (let inventory = 2; inventory > 0; inventory -= 1) {
      const overview = await actor.repository.getMissionOverview(WORLD_ID);
      if (
        overview.activeMission.id !== missionInstanceId ||
        overview.activeMission.filledSlots >= targetFilledSlots
      ) {
        return;
      }
      const slotIndex = overview.activeMission.recommendedSlotIndexes[0];
      if (slotIndex === undefined) {
        throw new Error("미션 완료 전 추천 슬롯이 사라졌습니다.");
      }
      await actor.repository.contributeToMission({
        worldId: WORLD_ID,
        missionInstanceId,
        slotIndex,
        paletteIndex: inventory % 5,
        idempotencyKey: crypto.randomUUID(),
      });
    }
  }
}

async function createMobileContext(
  browser: Browser,
  session: Session,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  await context.addInitScript(
    ({ authStorageKey, analyticsConsentKey, authSession }) => {
      localStorage.setItem(authStorageKey, JSON.stringify(authSession));
      localStorage.setItem(analyticsConsentKey, "essential_only");
    },
    {
      authStorageKey: AUTH_STORAGE_KEY,
      analyticsConsentKey: ANALYTICS_CONSENT_KEY,
      authSession: session,
    },
  );
  return context;
}

async function openPlayableWorld(
  page: Page,
  navigate = true,
): Promise<void> {
  if (navigate) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
  }
  await expect(page.locator("#world-mode")).toHaveText("ONLINE WORLD · 01");
  await expect(page.locator("#start-button")).toBeVisible();
  await page.locator("#start-button").click();
  await expect(page.locator(".start-overlay")).toHaveClass(/is-hidden/u);
  await expect(page.locator("#mission-panel")).toBeVisible();
}

async function expectOnboardingHud(page: Page, inventory: number): Promise<void> {
  await expect(page.locator("#inventory-count")).toHaveText(String(inventory));
  await expect(page.locator("#base-progress")).toHaveText("16/16");
  await expect(page.locator("#producer-progress")).toHaveText("8/8");
}

async function firstRecommendedSlot(page: Page): Promise<number> {
  const first = page.locator("[data-mission-slot]").first();
  await expect(first).toBeVisible();
  await first.click();
  await page.locator("[data-mission-palette]").first().click();
  await expect(page.locator("#mission-contribute-button")).toBeEnabled();
  return Number(await first.getAttribute("data-mission-slot"));
}

async function verifyCreatorDiscovery(
  page: Page,
  creator: PlayerBootstrap,
): Promise<void> {
  const light = page.locator(
    `[data-contributor-id="${creator.player.publicId}"]`,
  );
  await expect(light).toBeVisible();
  await expect(light).toContainText(creator.player.nickname);
  await expect(light).toContainText(creator.player.publicId);
  await expect(light).toContainText("1칸");
  await expect(light.locator("span").first()).toHaveText(creator.player.emblem);
  await light.click();
  await expect(page.locator("#highlight-label")).toContainText(
    creator.player.publicId,
  );
  await expect(page.locator("#highlight-find-button")).toBeVisible();
  await page.locator("#highlight-find-button").click();
  await expectCreatorCard(page, creator);
}

async function expectCreatorCard(
  page: Page,
  creator: PlayerBootstrap,
): Promise<void> {
  await expect(page.locator("#owner-card")).toBeVisible();
  await expect(page.locator("#owner-name")).toHaveText(creator.player.nickname);
  await expect(page.locator("#owner-id")).toHaveText(creator.player.publicId);
  await expect(page.locator("#owner-emblem")).toHaveText(creator.player.emblem);
  await expect(page.locator("#owner-mission-meta")).toContainText("루멘문");
}

async function assertMobileLayout(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const rect = (selector: string): DOMRect => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`${selector} 요소가 없습니다.`);
      return element.getBoundingClientRect();
    };
    const overlaps = (left: DOMRect, right: DOMRect): boolean =>
      left.left < right.right &&
      left.right > right.left &&
      left.top < right.bottom &&
      left.bottom > right.top;
    const protectedElements = [
      ["crosshair", ".crosshair"],
      ["joystick", "#joystick"],
      ["mobile-actions", ".mobile-actions"],
      ["mission-panel", "#mission-panel"],
      ["owner-card", "#owner-card"],
      ["highlight-banner", "#highlight-banner"],
    ] as const;
    const protectedRects = protectedElements.map(([name, selector]) => ({
      name,
      rect: rect(selector),
    }));
    const overlapPairs: string[] = [];
    for (let leftIndex = 0; leftIndex < protectedRects.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < protectedRects.length;
        rightIndex += 1
      ) {
        const left = protectedRects[leftIndex];
        const right = protectedRects[rightIndex];
        if (left && right && overlaps(left.rect, right.rect)) {
          overlapPairs.push(`${left.name}:${right.name}`);
        }
      }
    }
    const touchSelectors = [
      "#joystick",
      "#jump-button",
      "#rotate-button",
      "#remove-button",
      "#place-button",
      "#mission-contribute-button",
    ];
    const undersized = touchSelectors.filter((selector) => {
      const target = rect(selector);
      return target.width < 44 || target.height < 44;
    });
    return {
      horizontalOverflow:
        document.documentElement.scrollWidth > window.innerWidth,
      overlapPairs,
      undersized,
    };
  });
  expect(result).toEqual({
    horizontalOverflow: false,
    overlapPairs: [],
    undersized: [],
  });
}

async function assertContextLossRecovery(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => document.pointerLockElement?.id ?? null),
    )
    .toBe("game-canvas");
  await page.locator("#game-canvas").evaluate((canvas) => {
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  });
  await expect(page.locator("#fatal-overlay")).toBeVisible();
  await expect(page.locator("#fatal-title")).toHaveText(
    "3D 화면 연결이 끊겼습니다",
  );
  await expect
    .poll(() => page.evaluate(() => document.pointerLockElement === null))
    .toBe(true);
  const retry = await requiredBox(page, "#fatal-retry-button");
  expect(retry.width).toBeGreaterThanOrEqual(44);
  expect(retry.height).toBeGreaterThanOrEqual(44);
}

async function assertDesktopLayout(page: Page): Promise<void> {
  const result = await page.evaluate(() => ({
    horizontalOverflow:
      document.documentElement.scrollWidth > window.innerWidth,
    bodyHeight: document.body.getBoundingClientRect().height,
    viewportHeight: window.innerHeight,
  }));
  expect(result.horizontalOverflow).toBe(false);
  expect(result.bodyHeight).toBeLessThanOrEqual(result.viewportHeight + 1);
}

function observePageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(
        `http:${response.status()}:${new URL(response.url()).pathname.slice(0, 120)}`,
      );
    }
  });
  page.on("console", (message) => {
    // Chromium's generic resource line has no URL. The response listener above
    // records the exact failing path and status without weakening this check.
    if (
      message.type() === "error" &&
      !/^Failed to load resource: the server responded with a status of \d+/u.test(
        message.text(),
      )
    ) {
      errors.push(`console:${message.text().slice(0, 120)}`);
    }
  });
  return errors;
}

async function exerciseConcurrentMobileControls(
  context: BrowserContext,
  page: Page,
): Promise<void> {
  await page.evaluate(() => {
    const records: Array<{
      target: string;
      type: string;
      pointerId: number;
      defaultPrevented: boolean;
      joystickTransform: string;
    }> = [];
    Object.assign(window, { __e2eMobileEvents: records });
    const joystick = document.querySelector<HTMLElement>("#joystick");
    const look = document.querySelector<HTMLElement>("#look-zone");
    const jump = document.querySelector<HTMLElement>("#jump-button");
    const knob = document.querySelector<HTMLElement>("#joystick-knob");
    if (!joystick || !look || !jump || !knob) {
      throw new Error("모바일 입력 요소가 없습니다.");
    }
    const observe = (targetName: string, element: HTMLElement, type: string) => {
      element.addEventListener(type, (event) => {
        if (!(event instanceof PointerEvent)) return;
        records.push({
          target: targetName,
          type,
          pointerId: event.pointerId,
          defaultPrevented: event.defaultPrevented,
          joystickTransform: knob.style.transform,
        });
      });
    };
    observe("joystick", joystick, "pointermove");
    observe("look", look, "pointermove");
    observe("jump", jump, "pointerdown");
  });

  const joystick = await requiredBox(page, "#joystick");
  const look = await requiredBox(page, "#look-zone");
  const jump = await requiredBox(page, "#jump-button");
  const joystickStart = {
    x: joystick.x + joystick.width / 2,
    y: joystick.y + joystick.height / 2,
    id: 1,
  };
  const joystickMoved = {
    x: joystickStart.x + joystick.width * 0.22,
    y: joystickStart.y - joystick.height * 0.24,
    id: 1,
  };
  const lookStart = {
    x: look.x + look.width * 0.48,
    y: look.y + look.height * 0.42,
    id: 2,
  };
  const lookMoved = {
    x: lookStart.x + 36,
    y: lookStart.y + 14,
    id: 2,
  };
  const jumpPoint = {
    x: jump.x + jump.width / 2,
    y: jump.y + jump.height / 2,
    id: 3,
  };
  const session = await context.newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [joystickStart, lookStart],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [joystickMoved, lookMoved],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [joystickMoved, lookMoved, jumpPoint],
    });
    await page.waitForTimeout(50);
  } finally {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await session.detach();
  }

  const records = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __e2eMobileEvents?: Array<{
            target: string;
            type: string;
            pointerId: number;
            defaultPrevented: boolean;
            joystickTransform: string;
          }>;
        }
      ).__e2eMobileEvents ?? [],
  );
  const joystickMove = records.find(
    ({ target, type }) => target === "joystick" && type === "pointermove",
  );
  const lookMove = records.find(
    ({ target, type }) => target === "look" && type === "pointermove",
  );
  const jumpDown = records.find(
    ({ target, type }) => target === "jump" && type === "pointerdown",
  );
  expect(joystickMove?.defaultPrevented).toBe(true);
  expect(lookMove?.defaultPrevented).toBe(true);
  expect(jumpDown?.defaultPrevented).toBe(true);
  expect(joystickMove?.pointerId).not.toBe(lookMove?.pointerId);
  expect(jumpDown?.joystickTransform).not.toBe("translate(0px, 0px)");
}

async function readPerformanceSnapshot(page: Page): Promise<{
  fps: number;
  drawCalls: number;
  visibleBlocks: number;
  activeChunks: number;
  pixelRatio: number;
  viewport: string;
}> {
  const hud = page.locator("#performance-hud");
  await expect(hud).toBeVisible();
  await expect(hud).toContainText("FPS");
  await expect
    .poll(async () => {
      const current = await hud.innerText();
      return Number(/FPS\s+(\d+)/u.exec(current)?.[1] ?? "0");
    })
    .toBeGreaterThan(0);
  const text = await hud.innerText();
  const read = (label: string): number => {
    const match = new RegExp(`${label}\\s+(\\d+)`, "u").exec(text);
    if (!match?.[1]) throw new Error(`${label} 성능 값을 읽지 못했습니다.`);
    return Number(match[1]);
  };
  const canvas = await page.locator("#game-canvas").evaluate((element) => {
    const canvasElement = element as HTMLCanvasElement;
    return {
      width: canvasElement.width,
      clientWidth: canvasElement.clientWidth,
    };
  });
  const viewport = page.viewportSize();
  const snapshot = {
    fps: read("FPS"),
    drawCalls: read("DRAW"),
    visibleBlocks: read("BLOCK"),
    activeChunks: read("CHUNK"),
    pixelRatio: Number((canvas.width / Math.max(1, canvas.clientWidth)).toFixed(2)),
    viewport: viewport ? `${viewport.width}x${viewport.height}` : "unknown",
  };
  expect(snapshot.fps).toBeGreaterThan(0);
  expect(snapshot.drawCalls).toBeGreaterThan(0);
  expect(snapshot.visibleBlocks).toBeGreaterThan(0);
  expect(snapshot.activeChunks).toBeGreaterThan(0);
  expect(snapshot.pixelRatio).toBeLessThanOrEqual(1.5);
  return snapshot;
}

async function hideDevelopmentPerformanceHud(page: Page): Promise<void> {
  await page.locator("#performance-hud").evaluate((element) => {
    (element as HTMLElement).hidden = true;
  });
}

async function requiredBox(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector}의 화면 위치를 찾지 못했습니다.`);
  return box;
}

function requiredAnonKey(): string {
  if (!SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_TEST_ANON_KEY가 필요합니다.");
  }
  return SUPABASE_ANON_KEY;
}

