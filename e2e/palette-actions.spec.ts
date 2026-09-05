import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { openCommandPalette } from "./nav";
import { hydratedClick, settledClick } from "./helpers";
import { workerDbPath } from "./worker-env";
import { withVisitFact } from "./visit-form-helpers";

// Per-hit command-palette actions (issue #662): a FOUND entity offers contextual
// actions routed through the EXISTING gated Server Actions — med → Log dose /
// Refill, appointment → Mark complete, clinical result → Add result. These drive the
// palette end-to-end (query → server action → ranked hit → rendered action chip →
// gated write / prefilled navigate).
//
// The completing-an-appointment case MUTATES, so it owns a uniquely-titled
// appointment it creates and deletes (the visits-lifecycle #288 self-cleaning
// pattern) — never a shared-seed row a neighbor exact-counts.
const DB_PATH = workerDbPath();
const APPT_MARKER = "E2E palette complete visit";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle.prepare("DELETE FROM appointments WHERE title = ?").run(APPT_MARKER);
  } finally {
    handle.close();
  }
}

// Palette create actions open the quick-entry overlay IN PLACE (#2184). "Log
// weight" / "Log vitals" predate the #1486 measurements merge and used to
// hard-navigate to `/trends?new=…#body` — landing mid-Trends while the quick-log
// sheet opened the same merged form as a drawer where you stood. Both surfaces
// now resolve to the ONE overlay form; the palette pick's context picks the
// GROUP (#2014), overriding the form's last-written-group memory (#2068).
test.describe("command palette — create actions open the overlay in place (#2184)", () => {
  test("'Log weight' opens the measurements overlay on the Body group and saves in place", async ({
    page,
  }) => {
    // Deliberately NOT /trends: the bug was being yanked there.
    await page.goto("/upcoming");
    const startUrl = page.url();

    const input = await openCommandPalette(page);
    await input.fill("log weight");
    await page.getByTestId("palette-action-log-weight").click();

    // The SAME overlay + form the quick-log sheet's "Log measurements" row
    // mounts — same testids because it is the same component, not a copy.
    const overlay = page.getByTestId("quick-entry-sheet");
    await expect(overlay).toBeVisible();
    await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
      "data-form",
      "measurements"
    );
    const form = overlay.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    // The pick's context opens Body (m-weight's home) — NOT the Vitals default a
    // context-free open falls back to — proving the prefill override.
    await expect(
      form.getByTestId("measurements-group-body-toggle")
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      form.getByTestId("measurements-group-vitals-toggle")
    ).toHaveAttribute("aria-expanded", "false");
    expect(page.url()).toBe(startUrl);

    // Submitting writes through the same shared form the sheet path posts —
    // one assertion, not a parallel suite: save, toast, still where we were.
    await overlay.locator("#m-weight").fill("72.5");
    await settledClick(
      page,
      overlay.getByRole("button", { name: "Save measurements" })
    );
    await expect(page.getByText("Measurements saved")).toBeVisible();
    await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);
    expect(page.url()).toBe(startUrl);
  });

  // #2130: the palette's own header promised "everything the sheet has a drawer
  // form for" (#2184) while food, dose and mood had no entry. Non-mutating on
  // purpose — each pick proves it opens the SAME overlay form the sheet mounts
  // (same testids because it is the same component), in place; the write paths
  // are already covered by the sheet specs over those very forms.
  test("'Log food', 'Log dose' and 'Log mood' open their sheet forms in place (#2130)", async ({
    page,
  }) => {
    await page.goto("/upcoming");
    const startUrl = page.url();

    const cases = [
      { query: "log food", action: "log-food", form: "food" },
      { query: "log dose", action: "log-dose", form: "dose" },
      { query: "log mood", action: "log-mood", form: "mood" },
    ] as const;
    for (const c of cases) {
      const input = await openCommandPalette(page);
      await input.fill(c.query);
      await page.getByTestId(`palette-action-${c.action}`).click();
      await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
      await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
        "data-form",
        c.form
      );
      expect(page.url()).toBe(startUrl);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("quick-entry-sheet")).toHaveCount(0);
    }
  });

  test("'Log vitals' opens the same form on the Vitals group, in place", async ({
    page,
  }) => {
    await page.goto("/upcoming");
    const startUrl = page.url();

    const input = await openCommandPalette(page);
    await input.fill("log vitals");
    await page.getByTestId("palette-action-log-vitals").click();

    const overlay = page.getByTestId("quick-entry-sheet");
    await expect(overlay).toBeVisible();
    await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
      "data-form",
      "measurements"
    );
    const form = overlay.getByTestId("measurements-quick-add");
    await expect(
      form.getByTestId("measurements-group-vitals-toggle")
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      form.getByTestId("measurements-group-body-toggle")
    ).toHaveAttribute("aria-expanded", "false");
    expect(page.url()).toBe(startUrl);
  });
});

test.describe("command palette — per-hit actions (#662)", () => {
  // A clinical-result hit offers "Add result": a navigate to the Clinical results form,
  // name-prefilled with the canonical analyte. Non-mutating, so it runs on the
  // shared seed (LDL Cholesterol is a seeded canonical biomarker).
  test("a clinical-result hit's 'Add result' opens the form name-prefilled", async ({
    page,
  }) => {
    await page.goto("/");
    const input = await openCommandPalette(page);
    await input.fill("LDL Cholesterol");

    const results = page.getByRole("listbox", { name: "Results" });
    // The first palette search on a worker also warms the search route; on a
    // loaded runner that first fetch can outlast the default 5s. A named ceiling,
    // not a sleep — this still fails if the hit never arrives.
    await expect(
      results.getByText("Clinical results", { exact: true })
    ).toBeVisible({
      timeout: 20_000,
    });
    const addResult = results
      .getByTestId("palette-hit-action-add-result")
      .first(); // first-ok: the add-result action in the scoped command-palette results — order-agnostic
    await expect(addResult).toBeVisible();

    // The chip drives a client navigation (router.push) — retry the URL assertion
    // past the pre-hydration window rather than a networkidle gate.
    await addResult.click();
    await expect(page).toHaveURL(
      /\/results\/clinical-results\?.*name=LDL(\+|%20)Cholesterol/
    );

    // The add form's Name field is prefilled with the analyte the user searched.
    await expect(page.locator("#rec-new-name")).toHaveValue("LDL Cholesterol");
  });

  // A medication hit (an intake_items row with kind='medication') offers "Log dose"
  // always and "Refill" when it tracks supply. Seed's Sertraline is a supply-tracked
  // medication, so BOTH chips render. Non-mutating — asserts the chips are present
  // (proving searchAll attaches the write actions and the palette renders them for
  // the medication kind); the write dispatch itself is exercised below.
  //
  // AND THE LOGGED DOSES BESIDE IT CARRY NONE — the second half of this test, and a
  // rule rather than an accident (#5245). One query renders both kinds of hit, so
  // the pair belongs in one test: a chip is for the CATALOG ENTITY, never for the
  // record row that names it.
  test("a medication hit renders Log dose and Refill chips, and the logged doses beside it carry none (#5245)", async ({
    page,
  }) => {
    await page.goto("/");
    const input = await openCommandPalette(page);
    await input.fill("Sertraline");

    // SCOPED TO THE MEDICATION'S OWN GROUP. Since #5006 the palette also indexes the
    // DOSES logged against this medication, and they rank above the catalog entity —
    // so "the first result saying Sertraline" is now a logged dose. The medication
    // hit is the subject here; that a dose carries no chips is asserted below, not
    // assumed by this locator.
    const results = page
      .getByRole("listbox", { name: "Results" })
      .getByTestId("palette-group-supplement");
    const row = results
      .getByRole("listitem")
      .filter({ hasText: "Sertraline" })
      .first(); // first-ok: one medication hit for the searched med
    // Same first-search warm-up ceiling as the clinical-result hit above.
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByTestId("palette-hit-action-log-dose")).toBeVisible();
    await expect(row.getByTestId("palette-hit-action-refill")).toBeVisible();

    // NO ACTION CHIPS ON A LOGGED ROW (owner ruling, #5245). A logged row is a PAST
    // EVENT — the thing you do with it is look at it, which is what the hit already
    // does by opening the day scrolled to that entry. "Log this again" stays where
    // the rest of the app offers it. This is asserted rather than left implicit in
    // the group scoping above, which encoded the rule only as a side effect.
    const logged = page
      .getByRole("listbox", { name: "Results" })
      .getByTestId("palette-group-logged");
    // PRESENCE BEFORE ABSENCE: "no chips in this group" is also satisfied by an
    // EMPTY group, so the doses have to be on screen first or the count below means
    // nothing. Since #5006 they are, and they rank above the medication asserted
    // above — which is what made the scoping necessary in the first place.
    await expect(
      logged.getByRole("listitem").filter({ hasText: "Sertraline" })
    ).not.toHaveCount(0);
    // Any chip kind, not the two named above: the rule is that a logged row offers
    // none at all, so this reddens whichever kind a builder starts attaching.
    await expect(logged.getByTestId(/^palette-hit-action-/)).toHaveCount(0);
  });

  // An appointment hit offers "Mark complete" while scheduled, dispatched through
  // the existing completeAppointment Server Action (its auth gate, never a bypass).
  test.describe("completing an appointment from search", () => {
    test.beforeAll(cleanup);
    test.afterAll(cleanup);

    test("the 'Mark complete' action completes the appointment", async ({
      page,
    }) => {
      test.slow();

      // Book a scheduled appointment we own (date defaults to today → scheduled).
      await page.goto("/records/history/visits");
      await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
      const visitDialog = page.getByRole("dialog", { name: "Add visit" });
      await withVisitFact(visitDialog, "reason", async () => {
        await visitDialog.getByLabel("Reason / title").fill(APPT_MARKER);
      });
      // AppointmentForm submits a Server Action; the toast below only appears once
      // it resolved, and it was being asserted on the 5s default.
      await settledClick(
        page,
        visitDialog.getByRole("button", { name: "Add", exact: true })
      );
      await expect(page.getByText("Appointment saved")).toBeVisible();

      // Find it in the palette and complete it from the hit's action chip.
      const input = await openCommandPalette(page);
      await input.fill(APPT_MARKER);
      const results = page.getByRole("listbox", { name: "Results" });
      const row = results
        .getByRole("listitem")
        .filter({ hasText: APPT_MARKER })
        .first(); // first-ok: filtered to APPT_MARKER, a unique marker THIS spec planted — one match
      // Same first-search warm-up ceiling as the medication/clinical-result hits above —
      // this test's search is its palette's first, so index warm-up + a loaded
      // shard can outrun the 5 s default (#1556 interaction-latency class,
      // observed on shard 2, 2026-08-01).
      await expect(row).toBeVisible({ timeout: 20_000 });
      const complete = row.getByTestId("palette-hit-action-complete");
      await expect(complete).toBeVisible();
      // settledClick awaits the completeAppointment POST before returning.
      await settledClick(page, complete);

      // It settled to completed: back on the Visits page it no longer carries the
      // scheduled-only Cancel control in the Upcoming feed.
      await page.goto("/records/history/visits");
      const scheduledRow = page
        .getByTestId("visits-upcoming")
        .getByTestId("appointment-row")
        .filter({ hasText: APPT_MARKER })
        .filter({
          has: page.getByRole("button", { name: "Cancel appointment" }),
        });
      await expect(scheduledRow).toHaveCount(0);
    });
  });
});

// THE DESKTOP HALF OF THE #3423 WIDTH FORK, kept beside the palette's other
// desktop assertions rather than in the phone spec that removes these strings —
// so "the phone lost it" and "the desktop kept it" are two readings of one pair.
// The phone half is e2e/command-palette-shell.mobile.spec.ts.
//
// A keyboard EXISTS here, so the palette keeps saying so verbatim. This exists
// because the failure mode of a copy fork is not the phone: it is the desktop
// quietly losing an instruction to an over-broad `hidden` class, which nothing
// would have caught — the phone spec passes harder the more copy disappears.
test.describe("command palette — the keyboard copy survives from md up (#3423)", () => {
  test("the hint names the keys, the commit row says Enter, and the card still floats", async ({
    page,
  }) => {
    await page.goto("/upcoming");
    const input = await openCommandPalette(page);
    await input.fill("weight 82.5");

    const panel = page.getByTestId("modal-shell").locator("[data-sheet-panel]");
    await expect(panel).toBeVisible();

    // Verbatim, both halves of the sentence, in one string — a fork that split
    // the line into two spans must still read as one sentence to a person.
    await expect(panel).toContainText("arrows to move, Enter to run", {
      useInnerText: true,
    });

    const quickLog = page.getByTestId("palette-quicklog");
    await expect(quickLog).toBeVisible();
    // `useInnerText`, and it is load-bearing on BOTH halves of this pair. The
    // fork is a `hidden md:inline` twin, so `textContent` — Playwright's default
    // — reads BOTH spellings at both widths and the row's raw text really is
    // "Tap to saveEnter to save". Measured: the negative assertion below failed
    // against a correct render until it was told to read what is PAINTED.
    await expect(quickLog).toContainText("Enter to save", {
      useInnerText: true,
    });
    await expect(quickLog).not.toContainText("Tap to save", {
      useInnerText: true,
    });

    // The "↵" glyph draws where the Return key is. It hangs off the highlight,
    // which the quick-log row holds as the first item in the list.
    await expect(
      quickLog.locator(".tabler-icon-corner-down-left")
    ).toBeVisible();

    // STILL A CENTRED CARD, not the phone's full-bleed surface: inset from the
    // left edge and narrower than the viewport. This is the assertion that fails
    // if `fullScreenBelowMd`'s `md:` classes are ever written without their
    // breakpoint — a mistake the phone spec cannot see.
    const box = await panel.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.x).toBeGreaterThan(0);
    expect(box!.width).toBeLessThan(viewport.width);
    expect(box!.height).toBeLessThan(viewport.height);
  });
});
