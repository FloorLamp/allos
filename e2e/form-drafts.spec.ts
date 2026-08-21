import { test, expect } from "./fixtures";
import { closeEditor, openFact } from "./intake-form-helpers";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledFill } from "./helpers";
import { workerDbPath } from "./worker-env";

// Local form drafts (issue #1699), driven end-to-end — because "survives a reload"
// is a claim only a browser can settle. Two things are proved here:
//
//   1. a half-entered WORKOUT (the motivating case: nothing savable yet, so the
//      server auto-save has nothing to hold) survives a reload and comes back
//      through an explicit Resume — never silently applied;
//   2. a long record form (the supplement add form, with its state-only dose rows)
//      round-trips the same way, submits, and leaves NO draft behind — a stale draft
//      resurrecting a submitted record would be #1699 inverted.
//
// The live-session fallback belongs to e2e/stale-build-save.spec.ts. Its successful
// save uses the same draft-clearing path proved by the two forms here, so repeating
// that assertion through the live editor only adds another stateful workout teardown.
//
// Fixture discipline (#868): every row this spec creates is deleted by value in a
// finally, keyed on names nothing else uses.

const DB_PATH = workerDbPath();
const WORKOUT_TITLE = "Draft net session";
const SUPPLEMENT_NAME = "Draftnet Zinc";

// The debounced draft write (600ms) has no UI of its own, so the honest wait is on
// the store itself. Named ceiling per the e2e-hygiene census.
const DRAFT_SETTLE_MS = 20_000;

type DraftRow = { key: string; extra: Record<string, unknown> | null };

/** Every draft row currently in the browser's allos-offline database. */
async function draftRows(page: Page): Promise<DraftRow[]> {
  return page.evaluate(
    () =>
      new Promise<DraftRow[]>((resolve) => {
        const req = indexedDB.open("allos-offline");
        req.onerror = () => resolve([]);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("drafts")) {
            db.close();
            resolve([]);
            return;
          }
          const all = db
            .transaction("drafts", "readonly")
            .objectStore("drafts")
            .getAll();
          all.onerror = () => {
            db.close();
            resolve([]);
          };
          all.onsuccess = () => {
            const rows = (all.result ?? []).map(
              (r: { key: string; extra: Record<string, unknown> | null }) => ({
                key: String(r.key),
                extra: r.extra ?? null,
              })
            );
            db.close();
            resolve(rows);
          };
        };
      })
  );
}

function activityDrafts(rows: DraftRow[]): DraftRow[] {
  return rows.filter((r) => r.key.includes(":activity:"));
}

function deleteActivitiesTitled(...titles: string[]) {
  const h = new Database(DB_PATH);
  try {
    for (const title of titles) {
      // Child rows (exercise components, routes, videos) cascade off the activity —
      // the same one-statement cleanup the other activity-owning specs use.
      h.prepare("DELETE FROM activities WHERE title = ?").run(title);
    }
  } finally {
    h.close();
  }
}

function deleteIntakeItem(name: string) {
  const h = new Database(DB_PATH);
  try {
    const rows = h
      .prepare("SELECT id FROM intake_items WHERE name = ?")
      .all(name) as { id: number }[];
    for (const { id } of rows) {
      h.prepare("DELETE FROM intake_item_doses WHERE item_id = ?").run(id);
      h.prepare("DELETE FROM intake_items WHERE id = ?").run(id);
    }
  } finally {
    h.close();
  }
}

// `hydratedClick`, not a bare click, because this runs immediately after a
// `goto("/training?tab=log")` and the button opens a form rather than following a
// link. A click dispatched inside the hydration window is SWALLOWED — no handler
// yet — and the swallow is invisible: the failure surfaces 5 s later as
// `activity-form` "element(s) not found", which reads like the form is broken
// rather than like the click never happened. `/training` widens that window by
// writing its own URL at hydration (`/training#day-…`), which docs/internals/
// e2e-hygiene.md already names as a live swallow race on this exact page.
//
// `hydratedClick` polls React's hydration markers and clicks ONCE outside the
// loop, which is what this control needs: opening the form is not idempotent, so
// a retrying click could toggle it back shut.
async function openNewActivity(page: Page) {
  await hydratedClick(
    page,
    page.getByRole("main").getByRole("button", { name: "New activity" })
  );
  await expect(page.getByTestId("activity-form")).toBeVisible();
}

test("a half-entered workout survives a reload and comes back on request (#1699)", async ({
  page,
}) => {
  test.slow();
  try {
    await page.goto("/training?tab=log");
    await openNewActivity(page);

    // A workout with a name but no exercise yet is NOT savable, so the server
    // auto-save (#1189) holds nothing — this is exactly the window #1699 is about,
    // and before this change a reload here lost the lot.
    await settledFill(page, page.getByLabel("Activity name"), WORKOUT_TITLE);

    await expect
      .poll(async () => activityDrafts(await draftRows(page)).length, {
        timeout: DRAFT_SETTLE_MS,
        message: "the debounced draft autosave to reach IndexedDB",
      })
      .toBe(1);

    // The interruption: a reload is every cause at once (a deploy takeover, a
    // crash, a back-swipe, an iOS tab eviction).
    await page.reload();
    await openNewActivity(page);

    // NOT silently applied — the form comes up empty and the draft announces itself.
    await expect(page.getByLabel("Activity name")).toHaveValue("");
    const banner = page.getByTestId("draft-restore-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("kept on this device");

    // The user's tap is what restores it.
    await banner.getByTestId("draft-restore-resume").click();
    await expect(page.getByLabel("Activity name")).toHaveValue(WORKOUT_TITLE);
    await expect(banner).toHaveCount(0);

    // Finish the workout for real. Picking a known activity + a duration makes it
    // savable, so the auto-save creates the row — and the Delete button appearing
    // is the proof that it persisted.
    await page.getByPlaceholder(/What did you do/).fill("Running");
    await page
      .getByRole("listbox")
      .getByRole("button", { name: "Running", exact: true })
      .click();
    await settledFill(page, page.getByTestId("cardio-duration"), "30");
    await expect(
      page.getByRole("button", { name: "Delete", exact: true })
    ).toBeVisible({ timeout: DRAFT_SETTLE_MS });

    // Saved ⇒ no draft may survive. A stale one would offer to re-enter a workout
    // that is already in the training log.
    await expect
      .poll(async () => activityDrafts(await draftRows(page)).length, {
        timeout: DRAFT_SETTLE_MS,
        message: "the draft to be cleared once the server copy is current",
      })
      .toBe(0);

    await page.keyboard.press("Escape");
    await page.reload();
    await openNewActivity(page);
    await expect(page.getByTestId("draft-restore-banner")).toHaveCount(0);
  } finally {
    deleteActivitiesTitled(WORKOUT_TITLE);
  }
});

test("Discard throws the draft away for good (#1699)", async ({ page }) => {
  try {
    await page.goto("/training?tab=log");
    await openNewActivity(page);
    await settledFill(page, page.getByLabel("Activity name"), WORKOUT_TITLE);
    await expect
      .poll(async () => activityDrafts(await draftRows(page)).length, {
        timeout: DRAFT_SETTLE_MS,
        message: "the debounced draft autosave to reach IndexedDB",
      })
      .toBe(1);

    await page.reload();
    await openNewActivity(page);
    await page.getByTestId("draft-restore-discard").click();
    await expect(page.getByTestId("draft-restore-banner")).toHaveCount(0);
    await expect(page.getByLabel("Activity name")).toHaveValue("");

    // Gone from the store too, so reopening never re-offers it.
    await expect
      .poll(async () => activityDrafts(await draftRows(page)).length, {
        timeout: DRAFT_SETTLE_MS,
        message: "the discarded draft to leave IndexedDB",
      })
      .toBe(0);
    await page.reload();
    await openNewActivity(page);
    await expect(page.getByTestId("draft-restore-banner")).toHaveCount(0);
  } finally {
    deleteActivitiesTitled(WORKOUT_TITLE);
  }
});

test("a long record form restores its state-only rows, then clears on submit (#1699)", async ({
  page,
}) => {
  test.slow();
  try {
    await page.goto("/nutrition?tab=supplements");
    await page.getByTestId("supplement-add-toggle").click();
    const addCard = page.getByRole("dialog", { name: "Add supplement" });
    await addCard.getByLabel("Name").fill(SUPPLEMENT_NAME);
    // The dose rows never exist as named inputs — they are React state serialized
    // into FormData at submit — so this is the `extra` half of the draft.
    const doseEditor1 = await openFact(page, "dose", addCard);
    await doseEditor1.getByLabel("Amount").first().fill("25 mg"); // first-ok: this form's own first dose row, one render, not a seeded list
    await doseEditor1.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: same row
    await closeEditor(page, addCard);

    // WAIT FOR THE CONTENT, NOT FOR THE ROW. Counting drafts is satisfied by the
    // write the NAME field triggered seconds earlier, so under load this reloaded
    // between the two debounces and restored a draft holding the name and no dose —
    // and the failure landed four lines below, on the dose assertion, reading as a
    // broken `extra` restore. Measured on this box: green alone, red about one run in
    // three under two workers. The race is in the wait, so the wait is where it is
    // removed (`toPass` over the stored payload rather than over its existence).
    await expect
      .poll(
        async () =>
          JSON.stringify(
            (await draftRows(page)).filter((r) =>
              r.key.includes(":supplement:")
            )
          ),
        {
          timeout: DRAFT_SETTLE_MS,
          message: "the supplement draft to reach IndexedDB WITH its dose row",
        }
      )
      .toContain("25 mg");

    await page.reload();
    await page.getByTestId("supplement-add-toggle").click();
    const reopened = page.getByRole("dialog", { name: "Add supplement" });
    await expect(reopened.getByLabel("Name")).toHaveValue("");
    await reopened.getByTestId("draft-restore-resume").click();

    await expect(reopened.getByLabel("Name")).toHaveValue(SUPPLEMENT_NAME);
    const doseEditor2 = await openFact(page, "dose", reopened);
    await expect(doseEditor2.getByLabel("Amount").first()).toHaveValue("25 mg"); // first-ok: this form's own first dose row
    await expect(
      doseEditor2.getByLabel("Time of day").first() // first-ok: this form's own first dose row, one render, not a seeded list
    ).toHaveValue("Morning");
    await closeEditor(page, reopened);

    await reopened.getByRole("button", { name: "Add", exact: true }).click();
    await expect(reopened).toHaveCount(0);
    await expect(page.getByText(SUPPLEMENT_NAME).first()).toBeVisible(); // first-ok: the row this spec just created

    // Submitted ⇒ the draft is gone, and reopening the add form offers nothing.
    await expect
      .poll(
        async () =>
          (await draftRows(page)).filter((r) => r.key.includes(":supplement:"))
            .length,
        {
          timeout: DRAFT_SETTLE_MS,
          message: "the draft to be cleared by the successful submit",
        }
      )
      .toBe(0);
    await page.getByTestId("supplement-add-toggle").click();
    await expect(
      page
        .getByRole("dialog", { name: "Add supplement" })
        .getByTestId("draft-restore-banner")
    ).toHaveCount(0);
  } finally {
    deleteIntakeItem(SUPPLEMENT_NAME);
  }
});

// ── The reactive unsaved-work signature, MEASURED (#3371) ────────────────────
//
// `components/useFormDraft.ts` publishes `data-unsaved` for every draft-backed form
// by recomputing its draft signature on every keystroke, where before #3371 it only
// snapshotted on the 600ms autosave debounce. The issue refused to let that route be
// chosen on a guess: "a per-keystroke signature over a 1770-line form is exactly
// where it would be felt. Measure before committing to it."
//
// So this measures it, on the real thing: the real `IntakeItemForm` mounted in its
// supplement modal, with the real `extra` payload its own draft carries, running the
// exact computation the hook runs (`collectFields` + `draftSig`). It stays in the
// suite because the number is only worth anything if it can be re-taken — and because
// the cost is a property of the FORM, not of the hook: a future field, or a fatter
// `extra`, moves it without touching components/useFormDraft.ts.
const SIGNATURE_ITERATIONS = 300;
// WHAT THIS BOUNDS AND IN WHAT UNIT: the mean wall-clock cost, in MILLISECONDS, of
// ONE signature recomputation — the work #3371 adds to the typing path, once per
// keystroke. One 60Hz frame is 16.7ms, and a keystroke already spends a chunk of that
// re-rendering the form, so the signature has to be a small fraction of a frame.
//
// MEASURED 2026-08-21, Chromium on this box, and both readings are why the shared
// route was taken rather than three bespoke adopters:
//   * real payload (905-byte signature, 10 form controls): 0.0133 ms — 0.08% of a
//     frame, and roughly 45,000x shorter than the 600ms debounce it runs alongside
//     (600 / 0.0133), i.e. the eager recomputation is free next to the write it
//     front-runs.
//   * the same payload 20x bigger (18 KB): 0.0600 ms. Sub-linear, because the cost is
//     mostly the FormData construction and the walk of `form.elements` rather than
//     the JSON — so this is a property of the form's SHAPE, and a form with a fatter
//     draft does not walk into trouble.
// 4ms is a quarter of a frame: ~300x headroom over the measured value, which is what
// makes it survivable on a contended CI runner while still failing on a real
// regression (an `extra` two orders of magnitude bigger, or a field census that is).
const SIGNATURE_BUDGET_MS = 4;

test("the reactive unsaved signature is cheap enough to run per keystroke (#3371)", async ({
  page,
}) => {
  test.slow();
  const NAME = "Draftnet Signature Zinc";
  try {
    await page.goto("/nutrition?tab=supplements");
    await page.getByTestId("supplement-add-toggle").click();
    const addCard = page.getByRole("dialog", { name: "Add supplement" });
    await addCard.getByLabel("Name").fill(NAME);
    // A dose row, so `extra` carries the state-only half rather than an empty object
    // — that half is what `draftSig` actually spends its time on.
    const doseEditor = await openFact(page, "dose", addCard);
    await doseEditor.getByLabel("Amount").first().fill("25 mg"); // first-ok: this form's own first dose row
    await doseEditor.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: same row
    await closeEditor(page, addCard);

    // WAIT FOR THE CONTENT BEFORE MEASURING IT. The draft reaching IndexedDB is the
    // proof that `extra` is the real, populated payload; measuring before it lands
    // would time a signature over whatever happened to be there, and empty is the
    // state that flatters.
    await expect
      .poll(
        async () =>
          (await draftRows(page)).filter((r) => r.key.includes(":supplement:"))
            .length,
        {
          timeout: DRAFT_SETTLE_MS,
          message: "the supplement draft to reach IndexedDB",
        }
      )
      .toBe(1);

    const measured = await page.evaluate(
      async ([iterations]) => {
        const form = document.querySelector<HTMLFormElement>(
          '[data-testid="intake-item-form"]'
        );
        if (!form) return null;
        const extra = await new Promise<unknown>((resolve) => {
          const req = indexedDB.open("allos-offline");
          req.onerror = () => resolve(null);
          req.onsuccess = () => {
            const db = req.result;
            const all = db
              .transaction("drafts", "readonly")
              .objectStore("drafts")
              .getAll();
            all.onerror = () => {
              db.close();
              resolve(null);
            };
            all.onsuccess = () => {
              const row = (all.result ?? []).find((r: { key: string }) =>
                String(r.key).includes(":supplement:")
              );
              db.close();
              resolve(row ? (row.extra ?? null) : null);
            };
          };
        });

        // components/useFormDraft.ts#collectFields + lib/offline/drafts.ts#draftSig,
        // transcribed. Transcribed rather than imported because the page has no
        // module loader for app source, and the two are eleven lines: if they drift,
        // the field-census assertion below is what notices.
        const signature = (payload: unknown) => {
          const excluded = new Set<string>();
          for (const el of Array.from(form.elements)) {
            if (
              el instanceof HTMLInputElement &&
              (el.type === "file" || el.type === "password") &&
              el.name
            ) {
              excluded.add(el.name);
            }
          }
          const out: [string, string][] = [];
          for (const [name, value] of new FormData(form).entries()) {
            if (typeof value !== "string") continue;
            if (excluded.has(name)) continue;
            out.push([name, value]);
          }
          return JSON.stringify([out, payload ?? null]);
        };

        const time = (payload: unknown) => {
          for (let i = 0; i < 20; i += 1) signature(payload); // warm the JIT
          const started = performance.now();
          let sink = 0;
          for (let i = 0; i < iterations; i += 1) {
            sink += signature(payload).length;
          }
          return {
            meanMs: (performance.now() - started) / iterations,
            bytes: sink / iterations,
          };
        };

        // SECOND READING, WITH THE PAYLOAD BLOWN UP 20x. One number cannot say
        // whether this cost is a property of the FORM (constant-ish: one FormData,
        // one walk of form.elements) or of the DRAFT (linear in `extra`, and so a
        // future-proofing question rather than a today question). Two readings can.
        const fat = Array.from({ length: 20 }, () => extra);
        return {
          real: time(extra),
          fat: time(fat),
          controls: form.elements.length,
        };
      },
      [SIGNATURE_ITERATIONS] as const
    );

    expect(
      measured,
      "the intake form to be on screen to measure"
    ).not.toBeNull();
    // ANTI-VACUITY, and these are what keep the number honest: a signature over an
    // empty form would also be fast. Measured 2026-08-21, this form renders TEN
    // controls the browser composes (the rest of its 1770 lines are derived fact
    // chips and state-only rows, which is exactly why the registry cannot see it and
    // why it needs the marker at all) and its draft payload is real, not `null`.
    expect(measured!.controls).toBeGreaterThan(5);
    expect(measured!.real.bytes).toBeGreaterThan(200);
    expect(measured!.fat.bytes).toBeGreaterThan(measured!.real.bytes * 10);

    // eslint-disable-next-line no-console -- the measurement IS the deliverable (#3371); a number nobody can read is not one
    console.log(
      `[#3371] draft signature over IntakeItemForm: ${measured!.real.meanMs.toFixed(4)} ms/keystroke ` +
        `over ${Math.round(measured!.real.bytes)} bytes; ` +
        `${measured!.fat.meanMs.toFixed(4)} ms with the payload 20x bigger ` +
        `(${Math.round(measured!.fat.bytes)} bytes). ` +
        `${measured!.controls} form controls, ${SIGNATURE_ITERATIONS} iterations.`
    );
    expect(
      measured!.real.meanMs,
      "the per-keystroke draft signature must stay a small fraction of a frame — this is the cost #3371 asked to be measured before useFormDraft published the marker from a hot path"
    ).toBeLessThan(SIGNATURE_BUDGET_MS);
    // And the 20x payload stays inside the same budget, which is the claim that makes
    // the route safe for forms nobody has written yet.
    expect(measured!.fat.meanMs).toBeLessThan(SIGNATURE_BUDGET_MS);
  } finally {
    deleteIntakeItem(NAME);
  }
});

test("the supplement form answers for itself, and Escape asks before discarding it (#3371, #3420)", async ({
  page,
}) => {
  test.slow();
  const NAME = "Draftnet Escape Zinc";

  // ESCAPE BELONGS TO THE INNERMOST OPEN LAYER FIRST (#3409): `useFocusTrap` yields
  // to `[data-escape-layer="true"]`, and the Name field is a combobox whose list
  // opens whenever it takes focus — including when the confirm hands focus back. So
  // each press below says which layer it is for, rather than pressing twice and
  // hoping; a test that cannot name the press it means proves nothing about either.
  const dismissAnyOpenPicker = async () => {
    const layer = page.locator('[data-escape-layer="true"]');
    if (await layer.count()) {
      await page.keyboard.press("Escape");
      await expect(layer).toHaveCount(0);
    }
  };

  try {
    await page.goto("/nutrition?tab=supplements");
    await page.getByTestId("supplement-add-toggle").click();
    const addCard = page.getByRole("dialog", { name: "Add supplement" });
    const form = addCard.getByTestId("intake-item-form");

    // THE FORM'S OWN ANSWER FIRST, and the order is load-bearing. This assertion is
    // about the FORM — `components/useFormDraft.ts` publishes it off the same "has
    // the content moved off the mount snapshot" the draft write already asks — so it
    // survives every change to the dialog's dismissal wiring, which is what lets the
    // Escape assertions below name their own cause. With Escape asserted first, a
    // missing marker reds as "the #3420 ruling regressed" and sends the next reader
    // into components/BottomSheet.tsx.
    await expect(
      form,
      "an untouched form has nothing to lose and must say so"
    ).toHaveAttribute("data-unsaved", "false");
    await addCard.getByLabel("Name").fill(NAME);
    await expect(
      form,
      "the form must publish its own unsaved state — it has one name= in 1770 lines and it lands on a hidden input, so the discard guard has nothing else to read"
    ).toHaveAttribute("data-unsaved", "true");

    // ESCAPE, not a gesture and not the Close button. Before the #3420 ruling this
    // discarded the typing outright while a scrim tap two pixels away asked first.
    await dismissAnyOpenPicker();
    await page.keyboard.press("Escape");

    // A PRESENCE assertion, so the default ceiling is honest: no amount of waiting
    // conjures this confirm if the guard cannot see the form, because the guard is
    // asked synchronously on the keypress.
    const confirm = page.getByTestId("confirm-dialog");
    await expect(
      confirm,
      "Escape over a dialog holding unsaved work must route through the discard confirm (#3420)"
    ).toBeVisible();
    await expect(confirm).toContainText("Discard your changes?");

    await hydratedClick(
      page,
      confirm.getByRole("button", { name: "Keep editing" })
    );
    // Keep editing keeps BOTH: the typing and the surface it was typed into.
    await expect(addCard).toBeVisible();
    await expect(addCard.getByLabel("Name")).toHaveValue(NAME);
    // And the confirm must LEAVE before the next press: it stays mounted through its
    // exit animation, so a `toBeVisible()` after the next Escape would pass on the one
    // already going away and assert about the wrong keypress.
    await expect(confirm).toHaveCount(0);

    // Discarding for real closes the dialog — the confirm is a question, not a veto.
    await dismissAnyOpenPicker();
    await page.keyboard.press("Escape");
    await expect(confirm).toBeVisible();
    await hydratedClick(page, confirm.getByRole("button", { name: "Discard" }));
    await expect(addCard).toHaveCount(0);

    // AND THE OTHER HALF OF THE RULING, which is what keeps the confirm from becoming
    // a click-through: a dialog holding nothing unsaved keeps today's behaviour —
    // one Escape, closed, no question.
    await page.getByTestId("supplement-add-toggle").click();
    const reopened = page.getByRole("dialog", { name: "Add supplement" });
    await expect(reopened.getByTestId("intake-item-form")).toHaveAttribute(
      "data-unsaved",
      "false"
    );
    await dismissAnyOpenPicker();
    await page.keyboard.press("Escape");
    await expect(
      reopened,
      "a dialog with nothing to lose must still close outright on Escape (#3420)"
    ).toHaveCount(0);
    await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  } finally {
    deleteIntakeItem(NAME);
  }
});
