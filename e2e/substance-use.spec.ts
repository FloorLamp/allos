import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import {
  appContent,
  hydratedClick,
  settledClick,
  settledFill,
} from "./helpers";
import { frozenNow } from "./worker-env";
import {
  E2E_LOGIN_SUBSTANCE,
  E2E_LOGIN_CHILD,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Substance-use domain (issues #998, #1078, #1085): the Records › Specialty ›
// Substance use section (#1175, formerly the standalone /medical/substance-use
// page) — in-app AUDIT-C and DAST-10 tap-throughs (banded scores; DAST-10 since
// #1085, incl. its reverse-scored item), outside total-only entry for the AUDIT
// (its item text isn't shipped), one-tap consumption logging per substance
// (alcohol on the shared food-log ledger; nicotine/cannabis on the dedicated
// substance_daily_totals ledger, #1078), and per-substance weekly-cap reduction targets
// with their calm progress lines. No streaks, no celebration anywhere.
// LIFE-STAGE gated (#1174): adult-validated instruments, so the section + its
// jump-link hide for a known minor and the route re-gates a direct URL.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_SUBSTANCE in its OWN
// cookie context on a dedicated, substance-data-free adult profile. Every
// assertion is RELATIVE (before/after counts, idempotent cap upserts), so
// --repeat-each stays clean without reseeding. Interactions settle via
// settledClick.

async function weekCount(page: Page, substance: string): Promise<number> {
  const text = await page
    .getByTestId(`substance-week-count-${substance}`)
    .innerText();
  return Number(text.trim().split(/\s+/)[0]);
}

async function openScreening(page: Page) {
  const form = page.getByTestId("substance-instruments-form");
  if (!(await form.isVisible().catch(() => false))) {
    await hydratedClick(
      page,
      page.getByTestId("add-substance-screening-panel-toggle")
    );
  }
  await expect(form).toBeVisible();
}

test.describe("substance use (#998/#1078/#1085)", () => {
  // Serial: every test mutates the ONE shared fixture profile and asserts
  // relative before/after counts. CI runs workers=1 anyway; this pins the same
  // ordering for multi-worker local runs (the sibling-spec precedent).
  test.describe.configure({ mode: "serial" });

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_SUBSTANCE,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("adult: the section renders as a Records › Specialty pane with a jump-link (#1175)", async () => {
    // Landing on a sibling specialty pane, the sub-tab strip carries the
    // Substance use jump-link (the section-visibility predicate is true for an
    // adult), and it points at the folded section route — no standalone page.
    await page.goto("/records/specialty/skin");
    const subTab = page
      .getByTestId("records-sub-tabs")
      .getByRole("link", { name: "Substance use" });
    await expect(subTab).toBeVisible();
    await expect(subTab).toHaveAttribute(
      "href",
      "/records/specialty/substance-use"
    );

    // The screening form is available on request without occupying the page.
    await page.goto("/records/specialty/substance-use");
    await expect(page.getByTestId("records-substance-use")).toBeVisible();
    await expect(
      page.getByTestId("add-substance-screening-panel-toggle")
    ).toBeVisible();
    await expect(page.getByTestId("substance-instruments-form")).toBeHidden();

    // The old standalone route is gone with NO redirect (#1175 standing
    // preference) — a stale bookmark 404s.
    const res = await page.goto("/medical/substance-use");
    expect(res?.status()).toBe(404);
  });

  test("in-app AUDIT-C computes a banded total and records a score", async () => {
    await page.goto("/records/specialty/substance-use");
    await openScreening(page);

    const rows = page.getByTestId(/^substance-reading-\d+$/);
    const before = await rows.count();

    // AUDIT-C is the default selection; 3 items × option 1 = total 3 → Lower risk.
    for (let i = 0; i < 3; i++) {
      await page.getByTestId(`substance-option-${i}-1`).click();
    }
    await expect(page.getByTestId("substance-total")).toHaveText("3");
    await expect(page.getByTestId("substance-band")).toContainText(
      "Lower risk"
    );

    await settledClick(page, page.getByTestId("substance-instrument-submit"));
    await expect(rows).toHaveCount(before + 1, { timeout: 15_000 });
  });

  test("in-app DAST-10 (#1085): 10-item tap-through with the reverse-scored item, banded total", async () => {
    await page.goto("/records/specialty/substance-use");
    await openScreening(page);
    const rows = page.getByTestId(/^substance-reading-\d+$/);
    const before = await rows.count();

    await hydratedClick(
      page,
      page.getByTestId("substance-instrument-select-DAST-10")
    );
    // The in-app tap-through renders (no total-only note), with the instrument's
    // past-12-months framing and all 10 items.
    await expect(page.getByTestId("substance-total-only-note")).toHaveCount(0);
    await expect(
      page.getByTestId("substance-instrument-instructions")
    ).toContainText("past 12 months");
    await expect(page.getByTestId("substance-item-9")).toBeVisible();

    // The reverse-scored item 3 flips its options: its 1-point answer is "No",
    // while a normal item's 1-point answer is "Yes" (pins the #1085 encoding in
    // the rendered UI).
    await expect(page.getByTestId("substance-option-2-1")).toHaveText("No");
    await expect(page.getByTestId("substance-option-0-1")).toHaveText("Yes");

    // Lowest-risk answer everywhere (option value 0 — "No" on normal items,
    // "Yes" on the reverse item) → total 0 → "None reported".
    for (let i = 0; i < 10; i++) {
      await page.getByTestId(`substance-option-${i}-0`).click();
    }
    await expect(page.getByTestId("substance-total")).toHaveText("0");
    await expect(page.getByTestId("substance-band")).toContainText(
      "None reported"
    );

    await settledClick(page, page.getByTestId("substance-instrument-submit"));
    await expect(rows).toHaveCount(before + 1, { timeout: 15_000 });
  });

  test("AUDIT stays total-only (no reproduced items) and records an outside total", async () => {
    await page.goto("/records/specialty/substance-use");
    await openScreening(page);
    const rows = page.getByTestId(/^substance-reading-\d+$/);
    const before = await rows.count();

    await hydratedClick(
      page,
      page.getByTestId("substance-instrument-select-AUDIT")
    );
    // No item tap-through renders — only the total-only note + total input.
    await expect(page.getByTestId("substance-total-only-note")).toBeVisible();
    await expect(page.getByTestId("substance-item-0")).toHaveCount(0);

    await page.getByTestId("substance-outside-total").fill("2");
    await settledClick(
      page,
      page.getByTestId("substance-instrument-submit-outside")
    );
    await expect(rows).toHaveCount(before + 1, { timeout: 15_000 });
  });

  test("one tap logs a standard drink into this week's alcohol count", async () => {
    await page.goto("/records/specialty/substance-use");
    const before = await weekCount(page, "alcohol");

    await settledClick(page, page.getByTestId("substance-log-alcohol"));
    // The count is server-rendered and lands with the router refresh that follows
    // the settled action POST — a plain retrying web-first assertion covers it.
    const after = before + 1;
    await expect(page.getByTestId("substance-week-count-alcohol")).toHaveText(
      `${after} standard ${after === 1 ? "drink" : "drinks"} logged this week.`,
      { timeout: 15_000 }
    );
  });

  test("nicotine (#1078): its own section logs uses one tap at a time, and undo reverses", async () => {
    await page.goto("/records/specialty/substance-use");
    const before = await weekCount(page, "nicotine");

    await settledClick(page, page.getByTestId("substance-log-nicotine"));
    const after = before + 1;
    await expect(page.getByTestId("substance-week-count-nicotine")).toHaveText(
      `${after} ${after === 1 ? "use" : "uses"} logged this week.`,
      { timeout: 15_000 }
    );

    await settledClick(page, page.getByTestId("substance-undo-nicotine"));
    await expect(page.getByTestId("substance-week-count-nicotine")).toHaveText(
      `${before} ${before === 1 ? "use" : "uses"} logged this week.`,
      { timeout: 15_000 }
    );

    // The cannabis section renders independently alongside (#1078).
    await expect(page.getByTestId("substance-log-cannabis")).toBeVisible();
  });

  test("history adds an earlier day in order, exposes row actions, and repeated substance taps never confirm (#2009)", async () => {
    await page.goto("/records/specialty/substance-use");
    const card = page.getByTestId("substance-card-cannabis");
    const before = await weekCount(page, "cannabis");
    const earlier = new Date(frozenNow().getTime() - 10 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const marker = "E2E earlier cannabis entry";

    await hydratedClick(
      page,
      page.getByTestId("substance-history-add-cannabis")
    );
    const addForm = page.getByTestId("substance-history-add-form-cannabis");
    // THE DAY AND THE MINUTE, through the shared control (#5026 phase 2). Every
    // substance's add door offers a time now — until phase 2 this was a bare date,
    // because `substance_daily_totals` had nowhere to put an instant.
    await addForm.getByTestId("substance-when-date").fill(earlier);
    await addForm.getByTestId("substance-when-time").fill("21:30");
    await addForm.locator('input[name="amount"]').fill("2");
    await addForm.locator('textarea[name="notes"]').fill(marker);
    // The shared form's own submit (#4424): the modal, the row correction and the
    // record's add door all draw this one button, so the label is the domain form's
    // and not this card's.
    await settledClick(page, addForm.getByRole("button", { name: "Add" }));
    await expect(card.getByText(marker)).toBeVisible();

    // Today remains the one-tap fast path. Reloading clears only the two-second
    // accidental-double-tap cooldown; a deliberate second same-day tap is still
    // accepted without ever opening a re-log confirmation.
    await settledClick(page, page.getByTestId("substance-log-cannabis"));
    await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
    await page.reload();
    await settledClick(page, page.getByTestId("substance-log-cannabis"));
    await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
    await expect(page.getByTestId("substance-week-count-cannabis")).toHaveText(
      `${before + 2} uses logged this week.`
    );

    const rows = card.locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("2 uses");
    await expect(rows.nth(1)).toContainText(marker);

    // THE DAY'S ⋯ OFFERS DELETE ALONE (#5026). A use is an event, so the day is a
    // rollup and not the editable thing on any ledger — the card says where one use
    // corrects, and this asserts the whole menu rather than "Edit is absent", because
    // an empty menu would satisfy the second and not the first.
    const pastRow = rows.nth(1);
    await pastRow
      .getByRole("button", { name: "Cannabis entry actions" })
      .click();
    await expect(page.getByRole("menuitem")).toHaveText(["Delete"]);
    await expect(
      card
        .getByTestId("substance-history-correct-elsewhere-cannabis")
        .getByRole("link")
    ).toHaveAttribute("href", "/history?kind=substance&item=cannabis");
    await page.keyboard.press("Escape");

    // …AND THE RECORD IS WHERE IT LEADS. Two uses were filed at 21:30 in one
    // submission, so each is its own row with its own clock; correcting ONE moves that
    // one, which is the whole of what the day form could not do.
    // NARROWED TO THE DAY THE ENTRY WAS FILED ON. The record is a feed of every use
    // in its window, and this test taps twice more on today, so the day is what makes
    // "these two rows are that submission" a true claim rather than a lucky count.
    await page.goto(`/history?day=${earlier}&kind=substance&item=cannabis`);
    const useRows = page.locator(
      '[data-testid="history-row"][data-history-kind="substance"]'
    );
    await expect(useRows).toHaveCount(2);
    const firstUse = useRows.nth(0);
    await hydratedClick(page, firstUse.getByTestId("overflow-menu-trigger"));
    await page.getByRole("menuitem", { name: "Edit" }).click();
    // The form opens in the row's SIBLING `<li>`, not inside the row, so it is
    // addressed off the list rather than off the row it belongs to.
    const editor = appContent(page).getByTestId("history-row-editing");
    await editor.getByTestId("substance-when-time").fill("20:15");
    await settledClick(page, editor.getByRole("button", { name: "Save" }));
    await expect(useRows.nth(0)).toContainText("21:30");
    await expect(useRows.nth(1)).toContainText("20:15");

    // Back to the card, where the DAY delete takes them both.
    await page.goto("/records/specialty/substance-use");
    const backRow = card.locator("tbody tr").nth(1);
    await backRow
      .getByRole("button", { name: "Cannabis entry actions" })
      .click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await settledClick(
      page,
      page.getByRole("button", { name: "Delete entry" })
    );
    await expect(card.getByText(marker)).toHaveCount(0);

    await settledClick(page, page.getByTestId("substance-undo-cannabis"));
    await page.reload();
    await settledClick(page, page.getByTestId("substance-undo-cannabis"));
    await expect(page.getByTestId("substance-week-count-cannabis")).toHaveText(
      `${before} ${before === 1 ? "use" : "uses"} logged this week.`
    );
  });

  // #3326 — the entry point. #3323 shipped the whole custom vocabulary and nothing in
  // the app could reach it; this drives the door that reaches it.
  //
  // The name is a low-entropy fixture word (#868), and the test is RELATIVE like every
  // other in this file: it reads the card's count before and after, and undoes what it
  // logged, so --repeat-each stays clean without reseeding.
  test("name a substance and log a use in one step — no create step, and the card is a full card (#3326)", async () => {
    const NAME = "Kava 1";
    await page.goto("/records/specialty/substance-use");

    const card = page.getByTestId(`substance-card-${NAME}`);
    const before = (await card.count()) > 0 ? await weekCount(page, NAME) : 0;

    await hydratedClick(page, page.getByTestId("track-substance-panel-toggle"));
    const form = page.getByTestId("track-substance-form");
    await expect(form).toBeVisible();
    await settledFill(page, page.getByTestId("track-substance-name"), NAME);
    await settledClick(page, page.getByTestId("track-substance-save"));

    // The card exists because the USE does — there was no create step in between.
    await expect(card).toBeVisible({ timeout: 15_000 });
    expect(await weekCount(page, NAME)).toBe(before + 1);

    // Case is the person's own spelling, not a folded key. #3325 folded case for
    // MATCHING in this vocabulary and the symptom one at once, and deliberately not
    // for DISPLAY — the heading is still exactly what was typed.
    await expect(card.getByRole("heading", { name: NAME })).toBeVisible();

    // A FULL card, not a lesser one: the same one-tap log/undo the curated three get.
    await expect(page.getByTestId(`substance-log-${NAME}`)).toBeVisible();
    await expect(page.getByTestId(`substance-undo-${NAME}`)).toBeVisible();

    // And NO cap or screener framing, because nobody opted into a target — the
    // absence of a SubstanceCapStatus is the mechanism, so there is nothing to render
    // (docs/internals/substances.md).
    await expect(
      page.getByTestId(`substance-cap-progress-${NAME}`)
    ).toHaveCount(0);

    // Undo what this test logged, so the fixture is where it started.
    await settledClick(page, page.getByTestId(`substance-undo-${NAME}`));
  });

  test("share, emergency card, and print exclude curated and custom substance data (#3331)", async ({
    browser,
  }) => {
    test.slow();
    const custom = "Kava reach";
    await page.goto("/records/specialty/substance-use");
    const alcoholBefore = await weekCount(page, "alcohol");
    const customCard = page.getByTestId(`substance-card-${custom}`);
    const customBefore = (await customCard.count())
      ? await weekCount(page, custom)
      : 0;

    await settledClick(page, page.getByTestId("substance-log-alcohol"));
    await hydratedClick(page, page.getByTestId("track-substance-panel-toggle"));
    await settledFill(page, page.getByTestId("track-substance-name"), custom);
    await settledClick(page, page.getByTestId("track-substance-save"));
    expect(await weekCount(page, "alcohol")).toBe(alcoholBefore + 1);
    expect(await weekCount(page, custom)).toBe(customBefore + 1);

    let emergencyWasEnabled = false;
    try {
      await page.goto("/profile");
      const passport = page.locator('[data-print-region="passport"]');
      await expect(passport.getByRole("heading", { level: 1 })).toBeVisible();
      for (const name of ["Alcohol", custom]) {
        await expect(passport.getByText(name, { exact: true })).toHaveCount(0);
      }

      await page.emulateMedia({ media: "print" });
      await expect(passport).toBeVisible();
      for (const name of ["Alcohol", custom]) {
        await expect(passport.getByText(name, { exact: true })).toHaveCount(0);
      }
      await page.emulateMedia({ media: "screen" });

      const toggle = page.getByTestId("emergency-toggle");
      emergencyWasEnabled = await toggle.isChecked();
      if (!emergencyWasEnabled) {
        await toggle.check();
        await expect(page.getByLabel("Saved")).toBeVisible();
      }
      const emergency = page.getByTestId("emergency-card");
      await expect(emergency).toBeVisible();
      for (const name of ["Alcohol", custom]) {
        await expect(emergency.getByText(name, { exact: true })).toHaveCount(0);
      }

      await page.getByRole("button", { name: "Share" }).click();
      await page.getByRole("button", { name: "Create link" }).click();
      const shareUrl = await page.getByLabel("Created share link").inputValue();
      const anonContext = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      try {
        const anon = await anonContext.newPage();
        expect((await anon.goto(shareUrl))?.status()).toBe(200);
        await expect(anon.getByText(/Shared read-only copy/i)).toBeVisible();
        for (const name of ["Alcohol", custom]) {
          await expect(anon.getByText(name, { exact: true })).toHaveCount(0);
        }
      } finally {
        await anonContext.close();
      }
      // eslint-disable-next-line no-restricted-properties -- first-ok: newest-first; this test just created the newest link
      await page
        .locator("li")
        .filter({ has: page.getByRole("button", { name: "Revoke" }) })
        .first()
        .getByRole("button", { name: "Revoke" })
        .click();
    } finally {
      await page.emulateMedia({ media: "screen" });
      await page.goto("/profile#emergency");
      await page.reload(); // same-page hash navigation leaves the Share dialog mounted
      const toggle = page.getByTestId("emergency-toggle");
      if (!emergencyWasEnabled && (await toggle.isChecked())) {
        await toggle.uncheck();
        await expect(page.getByLabel("Saved")).toBeVisible();
      }
      await page.goto("/records/specialty/substance-use");
      await settledClick(page, page.getByTestId(`substance-undo-${custom}`));
      await settledClick(page, page.getByTestId("substance-undo-alcohol"));
    }
  });

  // A LOST CLICK ON THIS BUTTON IS RESCUED, AND STILL LOGS EXACTLY ONE USE (#3359).
  //
  // THIS IS A TEST OF `e2e/helpers.ts` AND IT LIVES HERE ON PURPOSE — do not move it
  // to a spec of its own. It needs a profile it may write to and then undo, and this
  // file already OWNS one (#868) and runs serially against it; a standalone spec
  // would either duplicate that fixture or write into a shared profile, which is
  // exactly the hazard the ownership rule exists to prevent.
  //
  // `settledClick` re-dispatches a click it can prove was never delivered to its
  // control. That is a retry on a WRITE — logging a use — so the thing that has to
  // be true is not "it recovers" but "it recovers without logging twice", and a
  // double-logged use is a wrong number in somebody's record rather than a red test.
  // This pins that, on the one control the defect was seen on.
  //
  // The forge is the real mechanism, not an approximation of it: disabling the
  // button between mousedown and mouseup is what Chromium needs to drop the click
  // entirely (it dispatches no mouse events at all to a disabled form control), so
  // the page reaches exactly the state #3359's CI annotation described — a click
  // Playwright reports as done, an idle enabled control, and no POST ever issued.
  // Re-enabling after 30 ms leaves the second dispatch a control to land on; a
  // rescue that could not be re-clicked would prove nothing about double-writing.
  test("a click the browser never delivers is re-dispatched, and still logs exactly one use (#3359)", async () => {
    const NAME = "Kava 6";
    await page.goto("/records/specialty/substance-use");

    const card = page.getByTestId(`substance-card-${NAME}`);
    const before = (await card.count()) > 0 ? await weekCount(page, NAME) : 0;

    await hydratedClick(page, page.getByTestId("track-substance-panel-toggle"));
    await expect(page.getByTestId("track-substance-form")).toBeVisible();
    await settledFill(page, page.getByTestId("track-substance-name"), NAME);

    await page.evaluate(() => {
      const btn = document.querySelector(
        '[data-testid="track-substance-save"]'
      ) as HTMLButtonElement | null;
      if (!btn) throw new Error("no save button to forge a lost click against");
      // Declare the forgery ON THE PAGE, so the rescue's own log line can say this
      // loss was deliberate. Without it this test prints three per run that are
      // indistinguishable from a real recurrence on the same control (e2e/helpers.ts).
      //
      // A LOCAL FLAG ON PURPOSE: one setter here, one reader in `redispatchLostSubmit`,
      // documented at both ends. Do not promote it to a shared export yet — a shared
      // primitive with a single caller invites a second caller that does not quite
      // fit. THE PROMOTION CONDITION IS A SECOND FORGING SITE: when some other spec
      // needs to forge a lost click, give this key a named export and a type, and
      // change both ends together.
      (
        window as unknown as { __allosForgedLostSubmit?: boolean }
      ).__allosForgedLostSubmit = true;
      const once = () => {
        btn.disabled = true;
        setTimeout(() => {
          btn.disabled = false;
        }, 30);
        btn.removeEventListener("mousedown", once, true);
      };
      btn.addEventListener("mousedown", once, true);
    });

    // Resolves rather than times out: the helper proved the first click never
    // activated the form and sent a second one.
    await settledClick(page, page.getByTestId("track-substance-save"));

    await expect(card).toBeVisible({ timeout: 15_000 });
    // THE CLAIM. Two clicks were dispatched and exactly one use exists.
    expect(await weekCount(page, NAME)).toBe(before + 1);

    // Undo what this test logged, so the fixture is where it started.
    await settledClick(page, page.getByTestId(`substance-undo-${NAME}`));
  });

  test("a substance name over the cap is refused with a readable message, never trimmed to fit (#3326)", async () => {
    await page.goto("/records/specialty/substance-use");
    await hydratedClick(page, page.getByTestId("track-substance-panel-toggle"));
    await expect(page.getByTestId("track-substance-form")).toBeVisible();

    // 61 characters — one over. The old normalizer would have stored the first 60
    // and said nothing, which is a different substance than the one typed.
    const tooLong = "kava".repeat(15) + "x";
    expect(tooLong.length).toBe(61);
    await settledFill(page, page.getByTestId("track-substance-name"), tooLong);

    // THE SUBMIT IS RETRIED, AND THE REASON IS NOT LATENCY — read this before
    // "simplifying" it to a bare `.click()`, which is what it was when it went red.
    //
    // This refusal is computed ENTIRELY on the client: TrackSubstanceControl's
    // handler calls validateSubstanceName, calls setError, and RETURNS — it never
    // reaches the Server Action. So the error paragraph appears on the very next
    // React commit or it never appears at all, and a bigger ceiling on the assertion
    // below would be a budget spent waiting for something that was never produced.
    // The inner ceiling is deliberately SHORT for that reason.
    //
    // What actually went wrong in CI (run 32349915874, e2e-changed, repeat 2 of 3)
    // was a LOST submit: repeat 1 of this same test passed in 537 ms and repeat 2
    // spent the whole 5 s ceiling with `track-substance-error` absent from the DOM,
    // which is only reachable if the handler never ran. It did not reproduce here —
    // ~100 local trials, including the full CI shape (both changed specs together,
    // --repeat-each=3, 2 workers) and a CDP `Emulation.setCPUThrottlingRate` probe at
    // rate 20 both with and without the hydration waits, 10/10 green — so the trigger
    // is not pinned and the conservative shape is the honest one.
    //
    // A RETRY IS SAFE HERE, WHICH IS NOT TRUE OF MOST CLICKS. `hydratedClick` is the
    // usual answer to a lost tap, but it cannot help this one: the panel's form is
    // CREATED by the toggle interaction, so it is client-rendered and carries React's
    // fibers from birth — the hydration probe passes instantly and the click it then
    // makes is the same bare click. And unlike the toggle it sits behind
    // (`setOpen(v => !v)`, where a second tap undoes the first), re-submitting a
    // refused name is IDEMPOTENT: the handler returns before any write, so every
    // extra attempt can only set the same error string. Nothing accumulates.
    const error = page.getByTestId("track-substance-error");
    // eslint-disable-next-line no-restricted-properties -- topass-ok: a client-only submit with no POST and no navigation to await, so there is no single awaitable event; safe to re-dispatch because the refusal path writes nothing and can only re-set the same error
    await expect(async () => {
      await page.getByTestId("track-substance-save").click();
      await expect(
        error,
        "the submit did not render a refusal — handler never ran"
      ).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000, intervals: [200, 500, 1000] });
    await expect(error).toContainText("60");

    // Nothing was created under any name — not the full one, and not a 60-character
    // near-miss of it. This is an ABSENCE assertion, and it is deliberately made
    // AFTER the presence assertion above: that error rendering is proof the handler
    // ran and refused BEFORE reaching the Server Action, so there is no in-flight
    // write this could race. A bigger ceiling here could only hide a real write,
    // never reveal one.
    await expect(page.getByTestId(`substance-card-${tooLong}`)).toHaveCount(0);
    await expect(
      page.getByTestId(`substance-card-${tooLong.slice(0, 60)}`)
    ).toHaveCount(0);
  });

  test("an alcohol weekly cap shows the calm progress line; removing it clears the line", async () => {
    await page.goto("/records/specialty/substance-use");

    const alcoholCard = page.getByTestId("substance-card-alcohol");
    await hydratedClick(
      page,
      alcoholCard.getByRole("button", { name: "Actions for Alcohol" })
    );
    await page.getByTestId("substance-cap-open-alcohol").click();
    await page.getByTestId("substance-cap-input-alcohol").fill("7");
    await settledClick(page, page.getByTestId("substance-cap-save-alcohol"));
    const progress = page.getByTestId("substance-cap-progress-alcohol");
    await expect(progress).toBeVisible();
    await expect(progress).toContainText(/of 7 this week|7-drink weekly cap/);
    await expect(progress).not.toContainText("streak");

    await hydratedClick(
      page,
      alcoholCard.getByRole("button", { name: "Actions for Alcohol" })
    );
    await page.getByTestId("substance-cap-clear-alcohol").click();
    await settledClick(page, page.getByRole("button", { name: "Remove cap" }));
    await expect(progress).toHaveCount(0, { timeout: 15_000 });
  });

  test("a count at its ceiling is explicitly at-cap, never met or on pace (#2009)", async () => {
    await page.goto("/records/specialty/substance-use");
    const count = await weekCount(page, "alcohol");
    const card = page.getByTestId("substance-card-alcohol");
    await hydratedClick(
      page,
      card.getByRole("button", { name: "Actions for Alcohol" })
    );
    await page.getByTestId("substance-cap-open-alcohol").click();
    await page.getByTestId("substance-cap-input-alcohol").fill(String(count));
    await settledClick(page, page.getByTestId("substance-cap-save-alcohol"));
    const progress = page.getByTestId("substance-cap-progress-alcohol");
    await expect(progress).toContainText("at your");
    await expect(progress).not.toContainText(/met|on pace/i);

    await hydratedClick(
      page,
      card.getByRole("button", { name: "Actions for Alcohol" })
    );
    await page.getByTestId("substance-cap-clear-alcohol").click();
    await settledClick(page, page.getByRole("button", { name: "Remove cap" }));
  });

  test("a nicotine weekly cap (#1078) speaks use-wording and clears cleanly", async () => {
    await page.goto("/records/specialty/substance-use");

    const nicotineCard = page.getByTestId("substance-card-nicotine");
    await hydratedClick(
      page,
      nicotineCard.getByRole("button", { name: "Actions for Nicotine" })
    );
    await page.getByTestId("substance-cap-open-nicotine").click();
    await page.getByTestId("substance-cap-input-nicotine").fill("7");
    await settledClick(page, page.getByTestId("substance-cap-save-nicotine"));
    const progress = page.getByTestId("substance-cap-progress-nicotine");
    await expect(progress).toBeVisible();
    await expect(progress).toContainText(/of 7 this week|7-use weekly cap/);
    await expect(progress).not.toContainText("streak");

    await hydratedClick(
      page,
      nicotineCard.getByRole("button", { name: "Actions for Nicotine" })
    );
    await page.getByTestId("substance-cap-clear-nicotine").click();
    await settledClick(page, page.getByRole("button", { name: "Remove cap" }));
    await expect(progress).toHaveCount(0, { timeout: 15_000 });
  });
});

// The #1174 life-stage gate: a KNOWN minor (the seeded "Riley (child)" profile, an
// infant) never sees the adult-validated substance-use section. Defense in depth —
// the specialty jump-link is absent AND a direct route hit re-gates to the first
// visible specialty pane (Skin), never rendering the section. Read-only: reuses the
// E2E_LOGIN_CHILD fixture (Riley is its sole/active profile), mutates nothing.
test("known-minor: the substance-use section + its jump-link are absent, and the route re-gates (#1174)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_CHILD,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // On a sibling specialty pane, the sub-tab strip drops the Substance use
    // jump-link. Since #2807 it drops Mental health too — Riley is an INFANT, below
    // the adolescent line PHQ-9/GAD-7 are validated to. The two gates are separate
    // lines, not one rule: an adolescent keeps Mental health while still losing this
    // pane (pinned in lib/__tests__/records-specialty-nav.test.ts).
    await page.goto("/records/specialty/skin");
    const subTabs = page.getByTestId("records-sub-tabs");
    await expect(
      subTabs.getByRole("link", { name: "Substance use" })
    ).toHaveCount(0);
    await expect(
      subTabs.getByRole("link", { name: "Mental health" })
    ).toHaveCount(0);
    // Hearing and Skin never gate, so the strip is never empty — which is what makes
    // the bounce target below well-defined.
    await expect(subTabs.getByRole("link", { name: "Hearing" })).toBeVisible();

    // A direct URL re-gates server-side to the FIRST VISIBLE pane — the section never
    // renders for a minor. That pane is Hearing since #1600 (ungated, ahead of Skin);
    // the route computes it from the shared gated list rather than naming a sibling.
    await page.goto("/records/specialty/substance-use");
    await expect(page).toHaveURL(/\/records\/specialty\/hearing$/);
    await expect(page.getByTestId("records-substance-use")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
