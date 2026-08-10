import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { openCommandPalette } from "./nav";
import { hydratedClick, settledClick } from "./helpers";
import { workerDbPath } from "./worker-env";

// Per-hit command-palette actions (issue #662): a FOUND entity offers contextual
// actions routed through the EXISTING gated Server Actions — med → Log dose /
// Refill, appointment → Mark complete, biomarker → Add result. These drive the
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
  // A biomarker hit offers "Add result": a navigate to the Biomarkers add form,
  // name-prefilled with the canonical analyte. Non-mutating, so it runs on the
  // shared seed (LDL Cholesterol is a seeded canonical biomarker).
  test("a biomarker hit's 'Add result' opens the add form name-prefilled", async ({
    page,
  }) => {
    await page.goto("/");
    const input = await openCommandPalette(page);
    await input.fill("LDL Cholesterol");

    const results = page.getByRole("listbox", { name: "Results" });
    // The first palette search on a worker also warms the search route; on a
    // loaded runner that first fetch can outlast the default 5s. A named ceiling,
    // not a sleep — this still fails if the hit never arrives.
    await expect(results.getByText("Biomarkers", { exact: true })).toBeVisible({
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
      /\/results\/biomarkers\?.*name=LDL(\+|%20)Cholesterol/
    );

    // The add form's Name field is prefilled with the analyte the user searched.
    await expect(page.locator("#rec-new-name")).toHaveValue("LDL Cholesterol");
  });

  // A medication hit (an intake_items row with kind='medication') offers "Log dose"
  // always and "Refill" when it tracks supply. Seed's Sertraline is a supply-tracked
  // medication, so BOTH chips render. Non-mutating — asserts the chips are present
  // (proving searchAll attaches the write actions and the palette renders them for
  // the medication kind); the write dispatch itself is exercised below.
  test("a medication hit renders Log dose and Refill chips", async ({
    page,
  }) => {
    await page.goto("/");
    const input = await openCommandPalette(page);
    await input.fill("Sertraline");

    const results = page.getByRole("listbox", { name: "Results" });
    const row = results
      .getByRole("listitem")
      .filter({ hasText: "Sertraline" })
      .first(); // first-ok: filtered to the Sertraline palette result — one match for the searched med
    // Same first-search warm-up ceiling as the biomarker hit above.
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByTestId("palette-hit-action-log-dose")).toBeVisible();
    await expect(row.getByTestId("palette-hit-action-refill")).toBeVisible();
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
      await visitDialog.getByLabel("Reason / title").fill(APPT_MARKER);
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
      // Same first-search warm-up ceiling as the medication/biomarker hits above —
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
