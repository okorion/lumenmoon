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
import { createCreatorCrest } from "../src/ui/icons";

const WORLD_ID = "00000000-0000-4000-8000-000000000001";
const SUPABASE_URL =
  process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY;
const ANALYTICS_CONSENT_KEY = "lumenmoon:analytics-consent:v1";
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

interface IdentityActor {
  repository: SupabaseRepository;
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
    test.setTimeout(600_000);
    await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
    await waitForSupabaseReady(requiredAnonKey());

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
    let bPage = await bContext.newPage();
    const bErrors: string[] = [];
    observePageErrors(bPage, bErrors);
    await openPlayableWorld(bPage);
    await expectOnboardingHud(bPage, 2);
    await assertProfileStatusComposition(bPage, actorB.bootstrap);
    await assertMinimalMobileHud(bPage);
    await assertMobileLayout(bPage);
    await exerciseWorldPanelDisclosure(bPage);
    await exercisePaletteDisclosure(bPage);
    await exercisePaletteDismissal(bPage);
    await exerciseMissionPanelDisclosure(bPage);
    await exerciseOrientationDisclosureReset(bPage);
    await exerciseConcurrentMobileControls(bContext, bPage);
    const mobilePerformance = await readPerformanceSnapshot(bPage);
    await hideDevelopmentPerformanceHud(bPage);
    await bPage.screenshot({
      path: resolve(SCREENSHOT_DIRECTORY, "minimal-hud-mobile-844x390.png"),
      fullPage: true,
    });

    // 같은 모바일 문서를 회전·축소하며 검사한다. 각 크기마다 WebGL 월드를
    // 다시 부팅하면 저성능 CI에서 레이아웃 검증보다 초기화 비용이 커진다.
    await setMobileViewport(bPage, 390, 844);
    await expectOnboardingHud(bPage, 2);
    await assertProfileStatusComposition(bPage, actorB.bootstrap);
    await assertMinimalMobileHud(bPage);
    await assertMobileLayout(bPage);
    await hideDevelopmentPerformanceHud(bPage);
    await exerciseWorldPanelDisclosure(
      bPage,
      "profile-expanded-mobile-390x844.png",
    );
    await exercisePaletteDisclosure(bPage);
    await exerciseMissionPanelDisclosure(bPage);
    await bPage.screenshot({
      path: resolve(SCREENSHOT_DIRECTORY, "minimal-hud-mobile-390x844.png"),
      fullPage: true,
    });

    await setMobileViewport(bPage, 390, 667);
    await expectOnboardingHud(bPage, 2);
    await assertMinimalMobileHud(bPage);
    await assertMobileLayout(bPage);
    await exerciseWorldPanelDisclosure(bPage);
    await exercisePaletteDisclosure(bPage);
    await exerciseMissionPanelDisclosure(bPage);

    await setMobileViewport(bPage, 360, 640);
    await expectOnboardingHud(bPage, 2);
    await assertMinimalMobileHud(bPage);
    await assertMobileLayout(bPage);
    await exerciseWorldPanelDisclosure(bPage);
    await exercisePaletteDisclosure(bPage);
    await exerciseMissionPanelDisclosure(bPage);
    // 각 크기의 중립 HUD 캡처를 먼저 고정한 뒤 제작자 상세을 검증한다.
    // 작은 화면부터 가로로 돌아오므로 다음 기록관 흐름도 844×390을 유지한다.
    for (const [width, height] of [
      [360, 640],
      [390, 667],
      [390, 844],
      [844, 390],
    ] as const) {
      await setMobileViewport(bPage, width, height);
      await verifyCreatorDiscovery(bPage, actorA.bootstrap);
      await assertMobileLayout(bPage);
      const screenshotName =
        width === 360
          ? "shared-world-mobile-360x640.png"
          : height === 844
            ? "shared-world-mobile-390x844.png"
            : width === 844
              ? "shared-world-mobile-844x390.png"
              : null;
      if (screenshotName) {
        await hideDevelopmentPerformanceHud(bPage);
        await bPage.screenshot({
          path: resolve(SCREENSHOT_DIRECTORY, screenshotName),
          fullPage: true,
        });
      }
    }

    const bStorageState = await bContext.storageState();
    // 동일 이용자의 모바일 월드가 계속 frame/동기화를 수행한 채 데스크톱
    // 컨텍스트를 부팅하면 저성능 CI에서 시작 RPC가 불필요하게 경합한다.
    // 저장 상태는 context에 남기고 page만 닫아 데스크톱 흐름을 독립시킨다.
    await bPage.close();

    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: bStorageState,
    });
    configureContextTimeouts(desktopContext);
    const desktopPage = await desktopContext.newPage();
    const desktopErrors = observePageErrors(desktopPage);
    await openPlayableWorld(desktopPage);
    await desktopPage.keyboard.press("KeyM");
    await expect(desktopPage.locator("#mission-panel-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await desktopPage.keyboard.press("Escape");
    await expect
      .poll(() =>
        desktopPage.evaluate(() => document.pointerLockElement === null),
      )
      .toBe(true);
    // pointerlockchange가 UI 상태에 반영된 뒤에만 단축키를 검증한다. 브라우저의
    // 실제 lock 해제와 GameUI 이벤트 사이에는 한 프레임 정도 차이가 날 수 있다.
    await expect(desktopPage.locator("#pointer-resume-button")).toBeVisible();
    await desktopPage.keyboard.press("KeyM");
    await expect(desktopPage.locator("#mission-panel-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await desktopPage.locator("#world-panel-toggle").click();
    await expect(desktopPage.locator("#world-panel-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(desktopPage.locator("#mission-panel-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(desktopPage.locator("#mission-panel")).toBeHidden();
    await desktopPage.locator("#world-panel-toggle").click();
    await expect(desktopPage.locator("#mission-panel")).toBeVisible();
    await ensureMissionPanelExpanded(desktopPage);
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

    bPage = await bContext.newPage();
    observePageErrors(bPage, bErrors);
    await openPlayableWorld(bPage);
    await ensureMissionPanelExpanded(bPage);
    await bPage.locator("#mission-archive-button").click();
    await expect(bPage.locator("#mission-archive-overlay")).toBeVisible();
    const archiveCard = bPage.locator(".mission-archive-card").filter({
      hasText: actorA.bootstrap.player.publicId,
    });
    await expect(archiveCard).toContainText(actorA.bootstrap.player.nickname);
    const archivedActor = archiveCard.locator(".archive-contributor").filter({
      hasText: actorA.bootstrap.player.publicId,
    });
    await expect(
      archivedActor.locator("[data-creator-crest]").first(),
    ).toHaveAttribute(
      "data-creator-crest",
      createCreatorCrest(actorA.bootstrap.player).key,
    );
    await expect(archivedActor.locator("[data-emblem]")).toHaveAttribute(
      "data-emblem",
      actorA.bootstrap.player.emblem,
    );
    await expect(archiveCard).toContainText("1개");
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
    configureContextTimeouts(reconnectedAContext);
    const reconnectedAPage = await reconnectedAContext.newPage();
    const reconnectedErrors = observePageErrors(reconnectedAPage);
    await openPlayableWorld(reconnectedAPage);
    await expectOnboardingHud(reconnectedAPage, 1);
    await expect(reconnectedAPage.locator("#storage-description")).toContainText(
      actorA.bootstrap.player.publicId,
    );
    await ensureMissionPanelExpanded(reconnectedAPage);
    await reconnectedAPage.locator("#mission-archive-button").click();
    await expect(
      reconnectedAPage.locator(".mission-archive-card").filter({
        hasText: actorA.bootstrap.player.publicId,
      }),
    ).toContainText("1개");

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
      ["B mobile", bErrors],
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

  test("자유 건축은 첫 30개와 설치·회수·재접속 상태를 유지한다", async ({
    browser,
  }) => {
    await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
    await waitForSupabaseReady(requiredAnonKey());
    const actor = await createIdentityActor(requiredAnonKey());
    const context = await createMobileContext(browser, actor.session);
    const page = await context.newPage();
    const errors = observePageErrors(page);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('input[name="game-mode"][value="free"]'),
    ).toBeChecked();
    await page.locator("#start-button").click();
    await expect(page.locator(".start-overlay")).toBeHidden();
    await expect(page.locator("#mission-panel")).toBeHidden();
    await expect(page.locator("#build-inventory-count")).toHaveText("30");

    await aimMobileCameraAtGround(context, page);
    await page.locator("#place-button").click();
    await expect(page.locator("#build-inventory-count")).toHaveText("30");
    await expect(page.locator(".toast")).toContainText(
      "시작 지점과 광장으로 가는 길은 비워 두고",
    );

    // 슬롯 0의 발판 위에서 대각선으로 이동하되, 고정 시간에 기대지 않고
    // 실제 배치 가능 판정이 바뀌는 순간 입력을 놓아 CI 프레임 차이를 흡수한다.
    await moveMobilePlayerUntilPlaceable(
      context,
      page,
      { x: -0.25, y: -0.18 },
      31,
    );
    await page.locator("#place-button").click();
    await expect(page.locator("#build-inventory-count")).toHaveText("29");
    const placed = await actor.repository.getFreeModeOverview(WORLD_ID);
    expect(placed.progress.inventory).toBe(29);

    await page.locator("#remove-button").click();
    await expect(page.locator("#build-inventory-count")).toHaveText("30");
    expect(
      (await actor.repository.getFreeModeOverview(WORLD_ID)).progress.inventory,
    ).toBe(30);

    await page.locator("#place-button").click();
    await expect(page.locator("#build-inventory-count")).toHaveText("29");

    const [ownerIdentity, visitor] = await Promise.all([
      actor.repository.getPlayerIdentity(WORLD_ID),
      createIdentityActor(requiredAnonKey()),
    ]);
    await visitor.repository.getFreeModeOverview(WORLD_ID);
    const spawn = createStarterBayLayout(0).safeSpawn;
    const nearbyForVisitor = await visitor.repository.loadNearbyFreeModeBlocks({
      worldId: WORLD_ID,
      chunkX: Math.floor(spawn.x / 16),
      chunkY: Math.floor(spawn.y / 16),
      chunkZ: Math.floor(spawn.z / 16),
      radius: 2,
      verticalRadius: 1,
    });
    const sharedBlock = nearbyForVisitor.blocks.find(
      ({ owner }) => owner.publicId === ownerIdentity.player.publicId,
    );
    expect(sharedBlock).toBeDefined();
    await expect(
      visitor.repository.commitFreeModeActions({
        worldId: WORLD_ID,
        idempotencyKey: crypto.randomUUID(),
        actions: [{ type: "remove", blockId: sharedBlock!.id }],
      }),
    ).rejects.toMatchObject({ code: "P0004" });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.locator('input[name="game-mode"][value="free"]'),
    ).toBeChecked();
    await page.locator("#start-button").click();
    await expect(page.locator(".start-overlay")).toBeHidden();
    await expect(page.locator("#build-inventory-count")).toHaveText("29");
    await expect(page.locator("#mission-panel")).toBeHidden();
    await assertMinimalMobileHud(page);
    await assertMobileLayout(page);
    await hideDevelopmentPerformanceHud(page);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIRECTORY, "free-mode-mobile-844x390.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.matchMedia("(orientation: portrait)").matches,
        ),
      )
      .toBe(true);
    await page.waitForTimeout(100);
    await expect(page.locator("#mission-panel")).toBeHidden();
    await expect(page.locator("#build-inventory-count")).toHaveText("29");
    await expect(page.locator("#world-panel-toggle")).toBeVisible();
    await expect(page.locator("#analytics-settings-button")).toBeVisible();
    await expect(page.locator(".build-tray")).toBeVisible();
    await assertMinimalMobileHud(page);
    await assertMobileLayout(page);
    await page.screenshot({
      path: resolve(SCREENSHOT_DIRECTORY, "free-mode-mobile-390x844.png"),
      fullPage: true,
    });

    expect(errors).toEqual([]);
    await context.close();
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

async function createIdentityActor(anonKey: string): Promise<IdentityActor> {
  const client = createClient(SUPABASE_URL, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const repository = new SupabaseRepository(client, { worldId: WORLD_ID });
  await repository.getPlayerIdentity(WORLD_ID);
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    throw new Error("익명 사용자 세션을 가져오지 못했습니다.", {
      cause: error ?? undefined,
    });
  }
  return { repository, session: data.session };
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
  configureContextTimeouts(context);
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

function configureContextTimeouts(context: BrowserContext): void {
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(30_000);
}

async function openPlayableWorld(
  page: Page,
  navigate = true,
): Promise<void> {
  if (navigate) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
  }
  await expect(page.locator("#world-mode")).toHaveText("함께");
  await page
    .locator('.game-mode-choice:has(input[value="mission"])')
    .click();
  await expect(
    page.locator('input[name="game-mode"][value="mission"]'),
  ).toBeChecked();
  await expect(page.locator("#start-button")).toBeVisible();
  await page.locator("#start-button").click();
  // 온라인 미션 진입은 bootstrap/nearby/production/mission/archive 읽기를
  // 순서대로 마친다. 일반 UI action의 15초 제한은 유지하되 이 권위 초기화
  // 완료만 별도 상한을 둬 느린 CI를 click 실패로 오판하지 않는다.
  await expect(page.locator(".start-overlay")).toHaveClass(/is-hidden/u, {
    timeout: 45_000,
  });
  await expect(page.locator(".start-overlay")).toBeHidden();
  await expect(page.locator("#mission-panel")).toBeVisible();
}

async function expectOnboardingHud(page: Page, inventory: number): Promise<void> {
  await expect(page.locator("#inventory-count")).toHaveText(String(inventory));
  await expect(page.locator("#base-progress")).toHaveText("16/16");
  await expect(page.locator("#producer-progress")).toHaveText("8/8");
}

async function firstRecommendedSlot(page: Page): Promise<number> {
  await ensureMissionPanelExpanded(page);
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
  const expectedCrestKey = createCreatorCrest(creator.player).key;
  await ensureMissionPanelExpanded(page);
  const light = page.locator(
    `[data-contributor-id="${creator.player.publicId}"]`,
  );
  await expect(light).toBeVisible();
  await expect(light).toContainText(creator.player.nickname);
  await expect(light).toContainText(creator.player.publicId);
  await expect(light).toContainText("1개");
  await expect(light.locator("[data-emblem]").first()).toHaveAttribute(
    "data-emblem",
    creator.player.emblem,
  );
  await expect(light.locator("[data-creator-crest]").first()).toHaveAttribute(
    "data-creator-crest",
    expectedCrestKey,
  );
  await light.click();
  await expect(page.locator("#highlight-label")).toContainText(
    creator.player.publicId,
  );
  await expect(page.locator("#highlight-find-button")).toBeVisible();
  await page.locator("#highlight-find-button").click();
  await expectCreatorCard(page, creator, expectedCrestKey);
}

async function ensureMissionPanelExpanded(page: Page): Promise<void> {
  const toggle = page.locator("#mission-panel-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    const touchLayout = await page.evaluate(
      () => matchMedia("(pointer: coarse)").matches || innerWidth <= 760,
    );
    if (touchLayout) {
      await toggle.click();
    } else {
      await page.keyboard.press("KeyM");
    }
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function expectCreatorCard(
  page: Page,
  creator: PlayerBootstrap,
  expectedCrestKey: string,
): Promise<void> {
  const tooltip = page.locator("#owner-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(page.locator("#owner-tooltip-name")).toHaveText(
    creator.player.nickname,
  );
  await expect(page.locator("#owner-tooltip-date")).not.toHaveText(
    "놓은 날짜 정보 없음",
  );
  await expect(page.locator("#owner-tooltip-date")).toHaveAttribute(
    "datetime",
    /\d{4}-\d{2}-\d{2}T/u,
  );
  await expect(tooltip).not.toContainText(creator.player.publicId);
  await expect(page.locator("#owner-tooltip-crest")).toHaveAttribute(
    "data-creator-crest",
    expectedCrestKey,
  );
  await expect(page.locator("#owner-tooltip-crest .creator-crest")).toHaveAttribute(
    "viewBox",
    "0 0 24 24",
  );
  await expect(page.locator("#action-hint")).toBeHidden();
  const ownerMore = page.locator("#owner-tooltip-more");
  await expect(ownerMore).toHaveAttribute("aria-controls", "owner-card");
  await expect(ownerMore).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#owner-card")).toBeHidden();
  const touchLayout = await page.evaluate(
    () => matchMedia("(pointer: coarse)").matches || innerWidth <= 760,
  );
  if (touchLayout) {
    const tooltipGeometry = await page.evaluate(() => {
      const ownerTooltip = document.querySelector<HTMLElement>("#owner-tooltip");
      const crosshair = document.querySelector<HTMLElement>(".crosshair");
      if (!ownerTooltip || !crosshair) {
        throw new Error("제작자 툴팁 또는 조준점이 없습니다.");
      }
      const tooltipRect = ownerTooltip.getBoundingClientRect();
      const crosshairRect = crosshair.getBoundingClientRect();
      return {
        centerDelta: Math.abs(
          tooltipRect.left + tooltipRect.width / 2 -
            (crosshairRect.left + crosshairRect.width / 2),
        ),
        gap: tooltipRect.top - crosshairRect.bottom,
        insideViewport:
          tooltipRect.left >= 0 &&
          tooltipRect.right <= innerWidth &&
          tooltipRect.top >= 0 &&
          tooltipRect.bottom <= innerHeight,
      };
    });
    expect(tooltipGeometry.centerDelta).toBeLessThanOrEqual(2);
    expect(tooltipGeometry.gap).toBeGreaterThanOrEqual(4);
    expect(tooltipGeometry.insideViewport).toBe(true);
    await ownerMore.click();
  } else {
    const resume = page.locator("#pointer-resume-button");
    if (
      await page.evaluate(
        () => document.pointerLockElement?.id === "game-canvas",
      )
    ) {
      await page.keyboard.press("Escape");
    }
    await expect
      .poll(() => page.evaluate(() => document.pointerLockElement === null))
      .toBe(true);
    await expect(resume).toBeVisible();
    await page.keyboard.press("KeyC");
    await expect
      .poll(() => page.evaluate(() => document.pointerLockElement === null))
      .toBe(true);
  }
  const ownerCard = page.locator("#owner-card");
  await expect(ownerCard).toBeVisible();
  await expect(ownerCard).toHaveAttribute("role", "dialog");
  await expect(ownerCard).toHaveAttribute("aria-modal", "true");
  await expect(ownerCard).toHaveAttribute("aria-labelledby", "owner-name");
  await expect(page.locator("#owner-name")).toHaveText(creator.player.nickname);
  await expect(page.locator("#owner-id")).toHaveText(creator.player.publicId);
  await expect(page.locator("#owner-emblem")).toHaveAttribute(
    "data-emblem",
    creator.player.emblem,
  );
  await expect(page.locator("#owner-emblem")).toHaveAttribute(
    "data-creator-crest",
    expectedCrestKey,
  );
  await expect(page.locator("#owner-mission-meta")).toContainText("별빛 관문");
  const ownerToggle = page.locator("#owner-card-toggle");
  await expect(ownerToggle).toBeVisible();
  await expect(ownerToggle).toBeFocused();
  await expect(ownerToggle).toHaveAttribute("aria-expanded", "true");
  await expect(ownerMore).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#owner-highlight-button")).toBeVisible();
  await expect(tooltip).toBeHidden();
  if (touchLayout) {
    await expect(page.locator("#look-zone")).toBeHidden();
    await assertMobileLayout(page);
  } else {
    await page.keyboard.press("Tab");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest("#owner-card")?.id ?? null,
        ),
      )
      .toBe("owner-card");
    await page.keyboard.press("Shift+Tab");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.closest("#owner-card")?.id ?? null,
        ),
      )
      .toBe("owner-card");
    await page.keyboard.press("KeyI");
    await page.keyboard.press("KeyM");
    await expect(page.locator(".world-panel")).not.toHaveClass(/is-expanded/u);
    await expect(page.locator("#mission-panel")).toHaveClass(/is-collapsed/u);
    const isolated = await page.evaluate(() => {
      const card = document.querySelector("#owner-card");
      const parent = card?.parentElement;
      return parent
        ? [...parent.children]
            .filter((element) => element !== card)
            .every((element) => (element as HTMLElement).inert)
        : false;
    });
    expect(isolated).toBe(true);
  }
  if (touchLayout) {
    await ownerToggle.click();
  } else {
    await page.keyboard.press("Escape");
    await expect(page.locator("#pointer-resume-button")).toBeVisible();
  }
  await expect(ownerCard).toBeHidden();
  await expect(ownerMore).toHaveAttribute("aria-expanded", "false");
  await expect(tooltip).toBeVisible();
}

async function assertMinimalMobileHud(page: Page): Promise<void> {
  await expect(page.locator("#world-panel-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const result = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".world-panel");
    const count = document.querySelector<HTMLElement>("#build-inventory-count");
    const mission = document.querySelector<HTMLElement>(
      ".mission-panel.is-collapsed",
    );
    if (!panel || !count || !mission) {
      throw new Error("모바일 최소 HUD 요소가 없습니다.");
    }
    const visible = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        !element.hidden &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const details = [
      ".world-status-row",
      ".progress-grid",
      ".production-status",
      ".hud-actions",
      ".manual-stage",
      ".shortcut-guide",
    ].map((selector) => {
      const element = panel.querySelector<HTMLElement>(selector);
      return element ? visible(element) : true;
    });
    const panelRect = panel.getBoundingClientRect();
    const missionRect = mission.getBoundingClientRect();
    const profileCopy = document.querySelector<HTMLElement>(".profile-copy");
    const mobileLabels = [
      ...document.querySelectorAll<HTMLElement>(".mobile-actions button small"),
    ];
    return {
      panelWidth: panelRect.width,
      panelHeight: panelRect.height,
      visibleDetails: details.filter(Boolean).length,
      inventoryVisible: visible(count) && Boolean(count.textContent?.trim()),
      missionHeight: missionRect.height,
      profileCopyVisible: profileCopy ? visible(profileCopy) : false,
      visibleActionLabels: mobileLabels.filter(visible).length,
    };
  });
  expect(result.panelWidth).toBeLessThanOrEqual(208);
  expect(result.panelHeight).toBeLessThanOrEqual(54);
  expect(result.visibleDetails).toBe(0);
  expect(result.inventoryVisible).toBe(true);
  expect(result.missionHeight).toBeLessThanOrEqual(52);
  expect(result.profileCopyVisible).toBe(true);
  expect(result.visibleActionLabels).toBe(0);
}

async function exerciseWorldPanelDisclosure(
  page: Page,
  screenshotName?: string,
): Promise<void> {
  const toggle = page.locator("#world-panel-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".world-panel .progress-grid")).toBeVisible();
  await expect(page.locator(".world-panel .production-status")).toBeVisible();
  await expect(page.locator("#manual-production-button")).toBeVisible();
  await expect(page.locator("#look-zone")).toBeHidden();
  await assertMobileLayout(page);
  if (screenshotName) {
    await page.screenshot({
      path: resolve(SCREENSHOT_DIRECTORY, screenshotName),
      fullPage: true,
    });
  }
  await toggle.click();
  await assertMinimalMobileHud(page);
}

async function exercisePaletteDisclosure(page: Page): Promise<void> {
  const toggle = page.locator("#palette-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const palette = page.locator("#palette-row");
  await expect(palette).toBeVisible();
  await expect(palette.locator(".color-button")).toHaveCount(12);
  await expect(page.locator("#look-zone")).toBeHidden();
  const colors = await palette.locator(".color-button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        inside:
          rect.left >= -1 &&
          rect.top >= -1 &&
          rect.right <= innerWidth + 1 &&
          rect.bottom <= innerHeight + 1,
      };
    }),
  );
  expect(colors.every(({ width, height }) => width >= 44 && height >= 44)).toBe(
    true,
  );
  expect(colors.every(({ inside }) => inside)).toBe(true);
  await assertMobileLayout(page);
  await palette.locator(".color-button").nth(2).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#toast")).toBeHidden({ timeout: 5_000 });
  await assertMinimalMobileHud(page);
}

async function exercisePaletteDismissal(page: Page): Promise<void> {
  const toggle = page.locator("#palette-toggle");
  const palette = page.locator("#palette-row");
  const tray = page.locator(".build-tray");

  await toggle.click();
  await expect(palette).toBeVisible();
  await page.locator('.tool-button[data-kind="stair"]').click();
  await expect(palette).toBeHidden();
  await expect(tray).not.toHaveClass(/is-palette-open/u);
  await expect(page.locator('.tool-button[data-kind="stair"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await toggle.click();
  await page.locator("#analytics-settings-button").click();
  await expect(palette).toBeHidden();
  await expect(page.locator("#analytics-settings-overlay")).toBeVisible();
  await page.locator("#analytics-settings-close").click();

  await toggle.click();
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
}

async function exerciseOrientationDisclosureReset(page: Page): Promise<void> {
  const profile = page.getByTestId("profile-status-panel");
  const profileToggle = page.locator("#world-panel-toggle");
  const missionToggle = page.locator("#mission-panel-toggle");
  const paletteToggle = page.locator("#palette-toggle");

  await page.setViewportSize({ width: 844, height: 390 });
  await profileToggle.click();
  await expect(profile).toHaveClass(/is-expanded/u);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(profile).not.toHaveClass(/is-expanded/u);
  await expect(profileToggle).toHaveAttribute("aria-expanded", "false");

  await page.setViewportSize({ width: 844, height: 390 });
  await missionToggle.click();
  await expect(page.locator("#mission-panel")).not.toHaveClass(/is-collapsed/u);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#mission-panel")).toHaveClass(/is-collapsed/u);

  await page.setViewportSize({ width: 844, height: 390 });
  await paletteToggle.click();
  await expect(page.locator("#palette-row")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#palette-row")).toBeHidden();
  await expect(page.locator("#look-zone")).toBeVisible();
  await assertMinimalMobileHud(page);
  await assertMobileLayout(page);
  await page.setViewportSize({ width: 844, height: 390 });
}

async function setMobileViewport(
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await expect
    .poll(() =>
      page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        portrait: matchMedia("(orientation: portrait)").matches,
      })),
    )
    .toEqual({ width, height, portrait: height > width });
  await expect(page.locator("#fatal-overlay")).toBeHidden();
  await expect(page.locator(".world-panel")).not.toHaveClass(/is-expanded/u);
  await expect(page.locator("#mission-panel")).toHaveClass(/is-collapsed/u);
  await expect(page.locator("#palette-row")).toBeHidden();
  await expect(page.locator("#owner-card")).toBeHidden();
}

async function assertProfileStatusComposition(
  page: Page,
  bootstrap: PlayerBootstrap,
): Promise<void> {
  const profile = page.getByTestId("profile-status-panel");
  await expect(profile.locator("#player-profile-nickname")).toHaveText(
    bootstrap.player.nickname,
  );
  await expect(profile.locator("#player-profile-public-id")).toHaveText(
    bootstrap.player.publicId,
  );
  await expect(profile.locator("#inventory-count")).toHaveCount(1);
  await expect(profile.locator("#base-progress")).toHaveCount(1);
  await expect(profile.locator("#producer-progress")).toHaveCount(1);
  await expect(profile.locator("#world-panel-toggle")).toHaveCount(1);
  await expect(profile.locator("#analytics-settings-button")).toHaveCount(0);
  await expect(page.locator("#analytics-settings-button")).toBeVisible();

  const placement = await page.evaluate(() => {
    const settings = document.querySelector<HTMLElement>(
      "#analytics-settings-button",
    );
    const panel = document.querySelector<HTMLElement>(
      '[data-testid="profile-status-panel"]',
    );
    if (!settings || !panel) throw new Error("프로필 또는 설정 버튼이 없습니다.");
    const settingsRect = settings.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return {
      topRight:
        settingsRect.top <= 20 && settingsRect.right >= window.innerWidth - 20,
      touchSize: settingsRect.width >= 44 && settingsRect.height >= 44,
      overlaps:
        settingsRect.left < panelRect.right &&
        settingsRect.right > panelRect.left &&
        settingsRect.top < panelRect.bottom &&
        settingsRect.bottom > panelRect.top,
    };
  });
  expect(placement).toEqual({ topRight: true, touchSize: true, overlaps: false });
}

async function exerciseMissionPanelDisclosure(page: Page): Promise<void> {
  const toggle = page.locator("#mission-panel-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#mission-contribute-button")).toBeVisible();
  await expect(page.locator("#look-zone")).toBeHidden();
  await assertMobileLayout(page);
  await toggle.click();
  await assertMinimalMobileHud(page);
}

async function assertMobileLayout(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const visibleRect = (selector: string): DOMRect | null => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`${selector} 요소가 없습니다.`);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return !element.hidden &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        rect.width > 0 &&
        rect.height > 0
        ? rect
        : null;
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
      ["owner-tooltip", "#owner-tooltip"],
      ["owner-card", "#owner-card"],
      ["highlight-banner", "#highlight-banner"],
      ["profile-status-panel", '[data-testid="profile-status-panel"]'],
      ["settings-button", "#analytics-settings-button"],
      ["build-tray", ".build-tray"],
      ["palette", "#palette-row"],
    ] as const;
    const protectedRects = protectedElements.flatMap(([name, selector]) => {
      const rect = visibleRect(selector);
      return rect ? [{ name, rect }] : [];
    });
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
      "#analytics-settings-button",
      "#world-panel-toggle",
      "#mission-panel-toggle",
      "#owner-tooltip-more",
      "#owner-card-toggle",
      ".tool-button",
      ".color-button",
      "#palette-toggle",
      "#jump-button",
      "#rotate-button",
      "#remove-button",
      "#place-button",
      "#mission-contribute-button",
    ];
    const undersized = touchSelectors.filter((selector) => {
      const target = visibleRect(selector);
      return target !== null && (target.width < 44 || target.height < 44);
    });
    const outsideViewport = protectedRects
      .filter(
        ({ rect }) =>
          rect.left < -1 ||
          rect.top < -1 ||
          rect.right > window.innerWidth + 1 ||
          rect.bottom > window.innerHeight + 1,
      )
      .map(({ name }) => name);
    const clippedButtons = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".brand-panel button, .world-panel button, .mission-panel button, .owner-tooltip button, .owner-card button, .build-tray button, .highlight-banner button, .mobile-actions button",
      ),
    ]
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return !button.hidden &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0;
      })
      .filter(
        (button) =>
          button.scrollWidth > button.clientWidth + 1 ||
          button.scrollHeight > button.clientHeight + 1,
      )
      .map((button) => button.id || button.getAttribute("aria-label") || "button");
    const clippedUiChildren = [
      ...document.querySelectorAll<HTMLElement>(
        ".brand-panel strong, .brand-panel small, .world-panel strong, .world-panel span, .mission-heading strong, .mission-heading small, .mission-progress-copy strong, .owner-tooltip strong, .owner-tooltip time, .owner-copy strong, .owner-copy span, .build-tray .ui-icon, .mobile-actions .ui-icon",
      ),
    ]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .filter((element) => {
        const parent = element.parentElement;
        if (!parent) return false;
        const rect = element.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        return (
          rect.left < parentRect.left - 1 ||
          rect.right > parentRect.right + 1 ||
          rect.top < parentRect.top - 1 ||
          rect.bottom > parentRect.bottom + 1 ||
          element.scrollWidth > element.clientWidth + 1
        );
      })
      .map((element) => element.id || element.className || element.tagName);
    const invalidIcons = [
      ...document.querySelectorAll<SVGSVGElement>(".ui-icon"),
    ]
      .filter(
        (icon) =>
          icon.getAttribute("viewBox") !== "0 0 24 24" ||
          icon.getBoundingClientRect().width >
            (icon.parentElement?.getBoundingClientRect().width ?? 0) + 1 ||
          icon.getBoundingClientRect().height >
            (icon.parentElement?.getBoundingClientRect().height ?? 0) + 1,
      )
      .map((icon) => icon.dataset["icon"] ?? "icon");
    const invalidCrests = [
      ...document.querySelectorAll<SVGSVGElement>(".creator-crest"),
    ]
      .filter((crest) => {
        const rect = crest.getBoundingClientRect();
        const parentRect = crest.parentElement?.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || !parentRect) return false;
        return (
          crest.getAttribute("viewBox") !== "0 0 24 24" ||
          rect.width > parentRect.width + 1 ||
          rect.height > parentRect.height + 1
        );
      })
      .map((crest) => crest.dataset["creatorCrest"] ?? "crest");
    const hierarchyClasses = [
      "ui-button--primary",
      "ui-button--secondary",
      "ui-button--danger",
      "ui-button--quiet",
    ];
    const semanticButtonProblems = [
      ...document.querySelectorAll<HTMLButtonElement>(".game-shell button"),
    ]
      .filter(
        (button) =>
          !button.classList.contains("ui-button") ||
          hierarchyClasses.filter((className) =>
            button.classList.contains(className),
          ).length !== 1,
      )
      .map((button) => button.id || button.getAttribute("aria-label") || "button");
    const undersizedSemanticButtons = [
      ...document.querySelectorAll<HTMLButtonElement>(".game-shell .ui-button"),
    ]
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return (
          !button.hidden &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          (rect.width < 44 || rect.height < 44)
        );
      })
      .map((button) => button.id || button.getAttribute("aria-label") || "button");
    const collapsedMission = document.querySelector<HTMLElement>(
      "#mission-panel.is-collapsed",
    );
    const collapsedMissionClips = collapsedMission
      ? collapsedMission.scrollHeight > collapsedMission.clientHeight + 1
      : false;
    const quickbarVisible = visibleRect(".build-tray") !== null;
    const worldMenuExpanded = document
      .querySelector(".world-panel")
      ?.classList.contains("is-expanded") ?? false;
    const ownerDetailsExpanded = document
      .querySelector(".owner-card")
      ?.classList.contains("is-expanded") ?? false;
    const missionDetailsExpanded = !document
      .querySelector(".mission-panel")
      ?.classList.contains("is-collapsed");
    const paletteExpanded = document
      .querySelector(".build-tray")
      ?.classList.contains("is-palette-open") ?? false;
    const inventoryCount = document.querySelector<HTMLElement>(
      "#build-inventory-count",
    );
    const inventoryCountRect = inventoryCount?.getBoundingClientRect();
    const inventoryCountVisible = Boolean(
      inventoryCount &&
        inventoryCount.textContent?.trim() &&
        inventoryCountRect &&
        inventoryCountRect.width > 0 &&
        inventoryCountRect.height > 0 &&
        getComputedStyle(inventoryCount).visibility !== "hidden",
    );
    return {
      horizontalOverflow:
        document.documentElement.scrollWidth > window.innerWidth,
      verticalOverflow:
        document.documentElement.scrollHeight > window.innerHeight,
      overlapPairs,
      undersized,
      outsideViewport,
      clippedButtons,
      clippedUiChildren,
      invalidIcons,
      invalidCrests,
      semanticButtonProblems,
      undersizedSemanticButtons,
      collapsedMissionClips,
      quickbarVisible,
      inventoryCountVisible,
      worldMenuExpanded,
      ownerDetailsExpanded,
      missionDetailsExpanded,
      paletteExpanded,
    };
  });
  const quickbarExpected =
    !result.worldMenuExpanded &&
    !result.ownerDetailsExpanded &&
    !result.missionDetailsExpanded;
  expect(result).toEqual({
    horizontalOverflow: false,
    verticalOverflow: false,
    overlapPairs: [],
    undersized: [],
    outsideViewport: [],
    clippedButtons: [],
    clippedUiChildren: [],
    invalidIcons: [],
    invalidCrests: [],
    semanticButtonProblems: [],
    undersizedSemanticButtons: [],
    collapsedMissionClips: false,
    quickbarVisible: quickbarExpected,
    inventoryCountVisible: quickbarExpected,
    worldMenuExpanded: result.worldMenuExpanded,
    ownerDetailsExpanded: result.ownerDetailsExpanded,
    missionDetailsExpanded: result.missionDetailsExpanded,
    paletteExpanded: result.paletteExpanded,
  });
}

async function assertContextLossRecovery(page: Page): Promise<void> {
  if ((await page.evaluate(() => document.pointerLockElement)) === null) {
    const resume = page.locator("#pointer-resume-button");
    await expect(resume).toBeVisible();
    await resume.click();
  }
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
    "3D 화면이 멈췄어요",
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

function observePageErrors(page: Page, errors: string[] = []): string[] {
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

async function aimMobileCameraAtGround(
  context: BrowserContext,
  page: Page,
): Promise<void> {
  const look = await requiredBox(page, "#look-zone");
  const start = {
    x: look.x + look.width * 0.55,
    y: look.y + look.height * 0.32,
    id: 21,
  };
  const moved = { ...start, y: start.y + Math.min(140, look.height * 0.35) };
  const session = await context.newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [start],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [moved],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(100);
  } finally {
    await session.detach();
  }
}

async function moveMobilePlayerUntilPlaceable(
  context: BrowserContext,
  page: Page,
  direction: { x: number; y: number },
  pointerId: number,
): Promise<void> {
  const joystick = await requiredBox(page, "#joystick");
  const start = {
    x: joystick.x + joystick.width / 2,
    y: joystick.y + joystick.height / 2,
    id: pointerId,
  };
  const moved = {
    ...start,
    x: start.x + joystick.width * direction.x,
    y: start.y + joystick.height * direction.y,
  };
  const session = await context.newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [start],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [moved],
    });
    await expect
      .poll(() =>
        page.locator("#joystick-knob").evaluate((element) => element.style.transform),
      )
      .not.toBe("translate(0px, 0px)");
    await expect
      .poll(() => page.locator("#action-hint").textContent(), {
        timeout: 10_000,
        intervals: [100, 100, 200, 200, 400],
      })
      .toContain("놓을 수 있어요");
  } finally {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await session.detach();
  }
  await page.waitForTimeout(100);
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
  await page.addStyleTag({
    content: "#performance-hud { display: none !important; }",
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

async function waitForSupabaseReady(anonKey: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const [auth, rest] = await Promise.all([
        fetch(`${SUPABASE_URL}/auth/v1/health`),
        fetch(`${SUPABASE_URL}/rest/v1/`, {
          headers: { apikey: anonKey },
        }),
      ]);
      lastStatus = Math.min(auth.status, rest.status);
      if (auth.ok && rest.ok) {
        return;
      }
    } catch {
      lastStatus = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`로컬 Supabase 준비 시간 초과 (${lastStatus})`);
}

