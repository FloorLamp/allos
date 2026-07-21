import { test, expect, type Page, type Locator } from "@playwright/test";

// The unified "How are you today?" daily check-in card (issue #992): the one-tap
// mood log composed with the illness front door in ONE shell. Covered states:
//   1. no-episode — mood tap leads, the quiet "Not feeling well?" branch shows;
//   2. one tap logs the day, persists, and a same-day re-tap UPDATES (idempotent
//      per profile+date — one row, never a duplicate);
//   3. expand — energy/anxiety + factor chips + note save and persist, and the
//      mood series reaches the Trends → Body chart;
//   4. active-episode — the illness cockpit takes the hero, the card defers with
//      a quiet note, and the mood tap STILL works (the two coexist).
//
// SETTLE DISCIPLINE: the dashboard carries steady background action-POST traffic
// (watchers/pollers), so settledClick's any-POST wait can resolve on a bystander
// request while the mood write is still in flight — and a follow-up reload would
// abort it. Instead the card renders a SERVER-truth marker (`mood-server-logged`,
// built from the server prop, not client state) that appears/updates only once
// the write committed and the refresh round-tripped; every mood mutation here
// settles on that marker (see the note in e2e/helpers.ts).
//
// Fixture hygiene (#868): the shared seed makes profile 1 already sick (and
// already mood-logged), so each test creates a FRESH profile via Settings →
// Family and switches to it — every mutation lands on a profile this spec owns.
// afterEach switches the shared session back to the admin profile.

let profileSeq = 0;
const ADMIN_PROFILE = "admin";

async function switchToProfile(page: Page, name: string): Promise<void> {
  const target = page
    .getByTestId("user-menu-popover")
    .getByRole("button", { name });
  await expect(async () => {
    await page.getByTestId("user-menu-trigger").click();
    await expect(target).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await target.click();
  await expect(page.getByTestId("user-menu-trigger")).toContainText(name);
}

// A profile ROW renders its name only in a rename `<input value={name}>` — the
// `getByText(name)` the create used to settle on was the transient success banner
// (`Added profile "<name>"`), which a reload/goto wipes. So the DURABLE "did the
// create land" signal is a profile-row input carrying this exact value.
// `input:not([placeholder])` excludes the "Add a profile" field (placeholder
// "Name"); the delete-confirm field isn't rendered in the resting card. Reading
// the value PROPERTY via evaluateAll (React doesn't reflect a controlled input's
// value to the DOM attribute, so a `[value="…"]` selector wouldn't match) also
// sidesteps strict-mode without a first-match locator.
async function profileRowExists(page: Page, name: string): Promise<boolean> {
  return page
    .locator("div.card")
    .filter({ hasText: "Add a profile" })
    .locator("input:not([placeholder])")
    .evaluateAll(
      (els, n) => els.some((e) => (e as HTMLInputElement).value === n),
      name
    );
}

async function freshProfile(page: Page, label: string): Promise<string> {
  const name = `${label}-${Date.now()}-${++profileSeq}`;
  // toPass, mirroring view-only-access.spec.ts's createMember (#830): the Add
  // button is an onClick Server Action (not a native form submit), so a click in
  // the hydration window is silently swallowed and no create POST fires; under
  // full-suite load the old raw click + transient-banner assert timed out (the
  // retries=0 failure this hardens). Retry the whole goto→fill→click→verify cycle
  // against the DURABLE profile row. Idempotency matters here because profile
  // names are NOT unique-constrained (createProfile does a bare INSERT — unlike
  // the NOCASE-unique login username), so a blind re-click could add a SECOND
  // same-named profile; the loop is therefore VERIFY-FIRST — it re-reads the card
  // after each goto and only clicks Add when the row is absent, so a retry after a
  // landed-but-slow create never duplicates.
  await expect(async () => {
    await page.goto("/settings/family");
    if (await profileRowExists(page, name)) return;
    const profilesCard = page
      .locator("div.card")
      .filter({ hasText: "Add a profile" });
    await profilesCard.getByPlaceholder("Name", { exact: true }).fill(name);
    await profilesCard
      .getByRole("button", { name: "Add", exact: true })
      .click();
    // Settle on the durable row, not the transient banner; give the action a
    // moment to land before forcing a full re-goto retry.
    await expect
      .poll(() => profileRowExists(page, name), { timeout: 8000 })
      .toBe(true);
  }).toPass({ timeout: 45_000 });
  await switchToProfile(page, name);
  await page.goto("/");
  if (page.url().includes("/onboarding")) {
    await page
      .getByRole("button", { name: "Set up later, take me to my dashboard" })
      .click();
    await expect(page).toHaveURL(/\/$|\/\?/);
  }
  return name;
}

// Tap one mood face and wait until the SERVER acknowledges the write (the marker
// re-renders from the refreshed server prop). toPass retries the tap through the
// hydration window — a pre-hydration click is swallowed, and no single expect can
// both re-click and await the server marker; the re-tap is safe because the write
// is an idempotent per-day upsert.
async function tapMood(page: Page, card: Locator, n: number): Promise<void> {
  await expect(async () => {
    await card.getByTestId(`mood-tap-${n}`).click({ timeout: 2_000 });
    await expect(card.getByTestId("mood-server-logged")).toHaveAttribute(
      "data-valence",
      String(n),
      { timeout: 4_000 }
    );
  }).toPass();
}

test.afterEach(async ({ page }) => {
  await page.goto("/");
  if (
    (await page.getByTestId("user-menu-trigger").textContent())?.includes(
      ADMIN_PROFILE
    )
  ) {
    return;
  }
  await switchToProfile(page, ADMIN_PROFILE);
});

test.describe("Daily wellbeing check (#992)", () => {
  test("no-episode state: mood tap logs, persists, and a same-day re-tap updates", async ({
    page,
  }) => {
    test.slow();
    await freshProfile(page, "moodwell");
    await page.goto("/");

    // State 1 — the unified shell: mood row + the quiet illness branch.
    const card = page.getByTestId("how-are-you-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("mood-status")).toHaveText(
      "Tap to log your day."
    );
    await expect(card.getByTestId("feeling-sick-activate")).toBeVisible();
    await expect(page.getByTestId("symptom-log-bar")).toHaveCount(0);
    await expect(card.getByTestId("mood-server-logged")).toHaveCount(0);

    // One tap logs the day (settled on the server-truth marker).
    await tapMood(page, card, 4);
    await expect(card.getByTestId("mood-tap-4")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(card.getByTestId("mood-status")).toContainText("Good");

    // Persisted server-side: a fresh render shows the logged state.
    await page.reload();
    await expect(card.getByTestId("mood-tap-4")).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // Idempotent per day: a re-tap UPDATES the day's one entry.
    await tapMood(page, card, 2);
    await page.reload();
    await expect(card.getByTestId("mood-tap-2")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(card.getByTestId("mood-tap-4")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  test("expand: energy/anxiety, factor chips, and note save — and reach the Trends chart", async ({
    page,
  }) => {
    test.slow();
    await freshProfile(page, "moodmore");
    await page.goto("/");

    const card = page.getByTestId("how-are-you-card");
    // Pick a valence (settled on the marker), then expand for the detail.
    await tapMood(page, card, 3);
    await card.getByTestId("mood-expand").click();
    await expect(card.getByTestId("mood-detail")).toBeVisible();
    await card.getByTestId("mood-energy-2").click();
    await card.getByTestId("mood-anxiety-4").click();
    await card.getByTestId("mood-factor-sleep").click();
    await card.getByTestId("mood-note").fill("short night");
    await card.getByTestId("mood-save").click();
    // The save settles when the server marker reflects the expanded fields.
    await expect(card.getByTestId("mood-server-logged")).toHaveAttribute(
      "data-energy",
      "2"
    );
    await expect(card.getByTestId("mood-server-logged")).toHaveAttribute(
      "data-note",
      "short night"
    );

    // Persisted: reload, re-expand, everything is still there.
    await page.reload();
    await expect(card.getByTestId("mood-tap-3")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await card.getByTestId("mood-expand").click();
    await expect(card.getByTestId("mood-energy-2")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(card.getByTestId("mood-anxiety-4")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(card.getByTestId("mood-factor-sleep")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(card.getByTestId("mood-note")).toHaveValue("short night");

    // The logged series surfaces on Trends → Body (never flag-checked — the card
    // copy says so in plain words).
    await page.goto("/trends?tab=body");
    const trend = page.getByTestId("mood-trend");
    await expect(trend).toBeVisible();
    await expect(trend).toContainText("never range-checked");
  });

  test("active-episode state: the cockpit takes the hero, and the mood tap coexists", async ({
    page,
  }) => {
    test.slow();
    await freshProfile(page, "moodsick");
    await page.goto("/");

    const card = page.getByTestId("how-are-you-card");
    // Branch into the illness flow (door A, one tap).
    await page.getByTestId("feeling-sick-activate").click();
    await expect(page.getByTestId("symptom-log-bar")).toBeVisible();

    // State 2 — the shell stays for the mood tap, the illness branch defers to
    // the hero with a quiet note, and the front-door affordance is gone.
    await expect(card).toBeVisible();
    await expect(card.getByTestId("mood-episode-note")).toBeVisible();
    await expect(card.getByTestId("feeling-sick-activate")).toHaveCount(0);

    // Mood during illness still logs (illness never hides the mood layer).
    await tapMood(page, card, 2);
    await page.reload();
    await expect(card.getByTestId("mood-tap-2")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
