import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { shiftDateStr } from "@/lib/date";
import {
  appContent,
  hydratedClick,
  settledClick,
  settledFill,
} from "./helpers";
import { frozenNow, workerDbPath, workerDir } from "./worker-env";
import {
  closeVisitFact,
  openVisitFact,
  withVisitFact,
} from "./visit-form-helpers";

// The dirty-form registry, end to end (issue #1878).
//
// THE FAILURE THIS PINS. A background chrome refresh — here the extraction
// toaster's poll noticing a document finish, exactly the class named in the
// issue — re-renders the Server Components under whatever record form the user
// happens to have open. The observed casualty (#1552 → #1877) was the Add-visit
// form: the appointment saved TITLELESS, the write "succeeding" with a hollow
// row. So this drives the real form, takes a real chrome refresh mid-edit, and
// asserts the two things that actually matter to a person: the typed text is
// still there, and the row that gets created carries it.
//
// It also pins the contract underneath, because "the text survived" alone cannot
// distinguish a deferral from a refresh that happened to be harmless:
//   • while the form holds unsaved input the repaint is OWED, not run, and
//   • the moment the form releases (its own submit) the owed repaint LANDS —
//     deferred is never dropped.
// Those counters are the registry's observable contract, the same reason
// PullToRefresh carries `data-refreshes`.
//
// THE POLL ITSELF (the #1878 ruling that closed #1925's residual). `router.refresh()`
// is not the only way a chrome tick repaints: a Server Action's response carries a
// freshly rendered tree the client applies, and the toasters used to poll one. The
// third test below drives that directly — it writes a row BEHIND the page, lets the
// poll observe a finished extraction, and asserts the row is absent from the tree
// while `data-owed` is 1. That assertion failed before the poll moved onto a route
// handler, and it is what separates "deferred" from "merely slow".
//
// The complementary half — a USER-initiated refresh must never defer — is
// e2e/dirty-form-refresh.mobile.spec.ts, which needs the standalone PWA context
// that pull-to-refresh only exists in.
//
// Spec-owned fixture: one medical document it inserts and deletes, and one
// appointment identified by a unique marker.

const DB_PATH = workerDbPath();
const MARKER = "E2E dirty-form dermatology follow-up";
// A row written BEHIND the page, so "did the tree repaint?" is answerable from
// the outside: it can only be on screen if the server re-rendered the list.
const BEHIND = "E2E dirty-form poll-behind cardiology review";
const DOC = "e2e-dirty-form-extraction.pdf";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare("DELETE FROM appointments WHERE title IN (?, ?)")
      .run(MARKER, BEHIND);
    handle.prepare("DELETE FROM medical_documents WHERE filename = ?").run(DOC);
  } finally {
    handle.close();
  }
}

/**
 * Write an appointment straight into the worker DB — the "new server data" a
 * repaint would deliver. Dated from the FROZEN clock so it lands in the upcoming
 * list the page renders.
 */
function seedAppointmentBehindThePage() {
  const when = new Date(frozenNow().getTime() + 3 * 24 * 3600 * 1000);
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `INSERT INTO appointments (profile_id, date, time_of_day, title, status)
         VALUES (1, ?, ?, ?, 'scheduled')`
      )
      .run(
        when.toISOString().slice(0, 10),
        when.toISOString().slice(11, 16),
        BEHIND
      );
  } finally {
    handle.close();
  }
}

/** A separate process commits through the same owner used by app writers. */
function commitAppointmentBehindThePage() {
  const when = new Date(frozenNow().getTime() + 3 * 24 * 3600 * 1000);
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      `process.chdir(process.env.ALLOS_E2E_WRITER_DIR);
       const { db, rawDb, writeTx } = require(process.env.ALLOS_E2E_WRITER_MODULE);
       const [date, time, title] = JSON.parse(process.env.ALLOS_E2E_WRITER_VALUES);
       try {
         const revision = () => db.prepare("SELECT revision FROM data_write_revision WHERE singleton = 1").get().revision;
         const before = revision();
         writeTx(() => db.prepare(
           "INSERT INTO appointments (profile_id, date, time_of_day, title, status) VALUES (1, ?, ?, ?, 'scheduled')"
         ).run(date, time, title));
         if (revision() <= before) throw new Error("Appointment commit did not advance the write revision");
       } finally { rawDb.close(); }`,
    ],
    {
      cwd: process.cwd(),
      timeout: 20_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        ALLOS_E2E_TEST_HARNESS: "1",
        ALLOS_TEST_NOW: frozenNow().toISOString(),
        ALLOS_DB_PATH: workerDbPath(),
        TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
        ALLOS_E2E_WRITER_DIR: workerDir(),
        ALLOS_E2E_WRITER_MODULE: path.resolve("lib/db.ts"),
        ALLOS_E2E_WRITER_VALUES: JSON.stringify([
          when.toISOString().slice(0, 10),
          when.toISOString().slice(11, 16),
          BEHIND,
        ]),
      },
    }
  );
}

/** Park a document mid-extraction so the toaster polls at its fast cadence. */
function seedProcessingDocument() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, extracted_count)
         VALUES (1, ?, ?, 'processing', 0)`
      )
      .run(DOC, `data/uploads/${DOC}`);
  } finally {
    handle.close();
  }
}

/** Finish it, from outside the browser — the background event the chrome reacts to. */
function finishDocument() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `UPDATE medical_documents
            SET extraction_status = 'done', extracted_count = 3
          WHERE filename = ?`
      )
      .run(DOC);
  } finally {
    handle.close();
  }
}

test.describe("Chrome refreshes wait for a half-typed record form (#1878)", () => {
  // Per-test, not per-file: both tests seed the same document filename, and a
  // leftover row would make the completion toast ambiguous.
  test.beforeEach(cleanup);
  test.afterAll(cleanup);

  test("an external commit waits for the form, while the acting save needs no extra refresh (#3075)", async ({
    page,
  }) => {
    // Natural poll intervals establish observation and its completed
    // continuation. No accelerated clock or synthetic refresh signal is used.
    test.setTimeout(120_000);
    const nextFreshness = () =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/freshness" &&
          response.request().method() === "GET",
        { timeout: 40_000 }
      );
    const [mounted] = await Promise.all([
      nextFreshness(),
      page.goto("/records/history/visits"),
    ]);
    const upcoming = appContent(page).getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();
    const main = page.getByRole("main");
    const registry = page.getByTestId("dirty-form-registry"); // testid-scope-ok: the provider's single hidden counter is outside streamed app content
    const behind = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: BEHIND });
    await expect(main).toHaveAttribute("data-write-revision", /^\d+$/);
    await expect(main).toHaveAttribute("data-rendered-at", /^\d+$/);
    expect(mounted.status()).toBe(200);
    const mountedPayload = (await mounted.json()) as {
      profileId: number;
      revision: string;
    };
    expect(mountedPayload.profileId).toBe(1);
    // The route handler's first boot can commit its canonical seed after the
    // initial page render. Let that real startup refresh land before editing.
    await expect(main).toHaveAttribute(
      "data-write-revision",
      mountedPayload.revision
    );
    const settled = await nextFreshness();
    expect(settled.status()).toBe(200);
    expect(await settled.json()).toEqual(mountedPayload);
    const initialRevision = mountedPayload.revision;
    const initialRender = await main.getAttribute("data-rendered-at");
    const initialRefreshes = Number(
      await registry.getAttribute("data-refreshes")
    );
    await expect(registry).toHaveAttribute("data-owed", "0");
    await expect(behind).toHaveCount(0);

    await hydratedClick(
      page,
      appContent(page).getByTestId("add-visit-panel-toggle")
    );
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    await openVisitFact(dialog, "reason");
    const title = dialog.getByLabel("Reason / title");
    await title.fill(MARKER);
    await expect(registry).toHaveAttribute("data-dirty", "1");

    commitAppointmentBehindThePage();
    const observation = await nextFreshness();
    expect(observation.status()).toBe(200);
    const external = (await observation.json()) as {
      profileId: number;
      revision: string;
    };
    expect(external.profileId).toBe(1);
    expect(BigInt(external.revision)).toBeGreaterThan(BigInt(initialRevision));
    await expect(registry).toHaveAttribute("data-owed", "1");
    await expect(registry).toHaveAttribute(
      "data-refreshes",
      String(initialRefreshes)
    );
    await expect(behind).toHaveCount(0);
    await expect(title).toHaveValue(MARKER);

    await title.fill("");
    await title.blur();
    await expect(registry).toHaveAttribute(
      "data-refreshes",
      String(initialRefreshes + 1)
    );
    await expect(registry).toHaveAttribute("data-owed", "0");
    await expect(behind).toBeVisible();
    await expect(main).toHaveAttribute(
      "data-write-revision",
      external.revision
    );
    await expect(main).not.toHaveAttribute("data-rendered-at", initialRender!);

    const beforeActionRender = await main.getAttribute("data-rendered-at");
    await title.fill(MARKER);
    await settledClick(
      page,
      dialog.getByRole("button", { name: "Add", exact: true })
    );
    await expect(
      page.getByText("Appointment saved", { exact: true })
    ).toBeVisible();
    await expect(
      upcoming.getByTestId("appointment-row").filter({ hasText: MARKER })
    ).toBeVisible();
    await expect(main).not.toHaveAttribute(
      "data-write-revision",
      external.revision
    );
    await expect(main).not.toHaveAttribute(
      "data-rendered-at",
      beforeActionRender!
    );
    await expect(main).toHaveAttribute("data-write-revision", /^\d+$/);
    await expect(main).toHaveAttribute("data-rendered-at", /^\d+$/);
    const actionRevision = (await main.getAttribute("data-write-revision"))!;
    const actionRender = (await main.getAttribute("data-rendered-at"))!;
    expect(BigInt(actionRevision)).toBeGreaterThan(BigInt(external.revision));

    let first = await nextFreshness();
    expect(first.status()).toBe(200);
    let firstPayload = (await first.json()) as {
      profileId: number;
      revision: string;
    };
    if (firstPayload.revision === external.revision) {
      // A check started before the action may finish after its returned tree.
      expect(firstPayload.profileId).toBe(1);
      first = await nextFreshness();
      expect(first.status()).toBe(200);
      firstPayload = (await first.json()) as {
        profileId: number;
        revision: string;
      };
    }
    expect(firstPayload).toEqual({ profileId: 1, revision: actionRevision });
    // A network response alone can precede the watcher's continuation. Its
    // next single-flight request proves the previous response was handled.
    const following = await nextFreshness();
    expect(following.status()).toBe(200);
    expect(await following.json()).toEqual({
      profileId: 1,
      revision: actionRevision,
    });
    await expect(registry).toHaveAttribute("data-owed", "0");
    await expect(registry).toHaveAttribute(
      "data-refreshes",
      String(initialRefreshes + 1)
    );
    await expect(main).toHaveAttribute("data-write-revision", actionRevision);
    await expect(main).toHaveAttribute("data-rendered-at", actionRender);
  });

  test("a background extraction finishing mid-edit cannot empty the Add-visit form", async ({
    page,
  }) => {
    test.slow();
    seedProcessingDocument();

    await page.goto("/records/history/visits");
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();

    const registry = page.getByTestId("dirty-form-registry");
    // Nothing is dirty on a freshly loaded page: the registry keys on genuinely
    // unsaved input, never on mount. A form that registered at mount would
    // suppress every background refresh for the life of the page.
    await expect(registry).toHaveAttribute("data-dirty", "0");
    await expect(registry).toHaveAttribute("data-refreshes", "0");

    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    // The fields sit behind fact chips since #3223. Opening a disclosure and focusing
    // the field inside it is still not unsaved input.
    await openVisitFact(dialog, "reason");
    const title = dialog.getByLabel("Reason / title");
    await expect(title).toBeVisible();
    await title.click();
    await expect(registry).toHaveAttribute("data-dirty", "0");

    // Typed, and then each panel CLOSED again. By the time the registry is asked, both
    // values are behind shut panels — the state a summary-first conversion loses in two
    // different ways, and neither shows on screen.
    await title.fill(MARKER);
    await withVisitFact(dialog, "provider", async () => {
      await dialog.getByLabel("Provider").fill("E2E Dirty Form Clinic");
      // Its listbox is still open and floats over the Done button behind it. Escape
      // closes the LISTBOX and not the editor — the primitive yields the first Escape
      // to an expanded combobox on purpose, so that one key does not throw the whole
      // fact away (FactEditorHost's `onKeyDown`).
      await page.keyboard.press("Escape");
    });
    // WHY THE TITLE IS NOT A CONTROLLED FIELD, asserted rather than commented, because
    // the failure it prevents is silent and this is what makes the line above
    // self-describing.
    //
    // The registry ends its decision at `current !== serverValue`, and `serverValue` is
    // the DOM `defaultValue` — which React KEEPS IN SYNC with `value` on a controlled
    // field. So binding this input to React state to feed its chip would make it report
    // current === serverValue forever, and `data-dirty` would stay "0" however mounted
    // it is. Without this line that regression reads as "the deferral broke", which
    // sends the reader to the registry rather than to the form.
    //
    // `live` covers the other half: a panel that UNMOUNTED on close would be skipped by
    // `recordIsDirty`'s `!field.isConnected` guard. Two mechanisms, opposite fixes, one
    // symptom — so both are named here.
    const titleOwnership = await page.evaluate(() => {
      const el = document.querySelector(
        'input[name="title"]'
      ) as HTMLInputElement | null;
      return (
        el && { value: el.value, def: el.defaultValue, live: el.isConnected }
      );
    });
    expect(
      titleOwnership,
      "the title field must still be in the document with its panel closed"
    ).toMatchObject({ live: true, value: MARKER });
    expect(
      titleOwnership?.def,
      "the title field must stay DOM-owned: React syncs defaultValue onto a controlled field, and the dirty registry reads defaultValue as the saved value"
    ).toBe("");

    await expect(registry).toHaveAttribute("data-dirty", "1");

    // The background event: the document the user uploaded earlier finishes
    // extracting. The toaster notices by polling and asks for a repaint.
    finishDocument();
    await expect(page.getByText(`${DOC}: imported 3 records.`)).toBeVisible({
      timeout: 20_000,
    });

    // THE FIX: that repaint is owed, not taken. It cannot land on the form.
    await expect(registry).toHaveAttribute("data-owed", "1");
    await expect(registry).toHaveAttribute("data-refreshes", "0");

    // THE POINT: what the user typed is still what the form holds. Read back through
    // the chips first — a value that survived but stopped being STATED would be just as
    // lost to the person about to press Add.
    await expect(dialog.getByTestId("visit-fact-reason")).toContainText(MARKER);
    await expect(dialog.getByTestId("visit-fact-provider")).toContainText(
      "E2E Dirty Form Clinic"
    );
    await openVisitFact(dialog, "reason");
    await expect(title).toHaveValue(MARKER);
    await withVisitFact(dialog, "provider", async () => {
      await expect(dialog.getByLabel("Provider")).toHaveValue(
        "E2E Dirty Form Clinic"
      );
    });

    // And it is what gets saved — the row is created WITH its title, not hollow.
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Appointment saved")).toBeVisible();

    const row = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: MARKER });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // The submit released the form, so the owed repaint DRAINED. A deferral that
    // forgot its debt would leave the page quietly stale forever.
    await expect(registry).toHaveAttribute("data-owed", "0");
    await expect(registry).toHaveAttribute("data-dirty", "0");
    await expect(registry).toHaveAttribute("data-refreshes", "1");

    // The persisted row carries the title. This is the assertion the CI artifact
    // in #1552 would have failed.
    const handle = new Database(DB_PATH);
    try {
      const saved = handle
        .prepare("SELECT title FROM appointments WHERE title = ?")
        .get(MARKER) as { title: string } | undefined;
      expect(saved?.title).toBe(MARKER);
    } finally {
      handle.close();
    }
  });

  // TimeField's hidden input is a NAMED field the registry has to see (#4976),
  // and every existing test above types into "Reason / title" — which is why a
  // regression here would be invisible. TIME ONLY, nothing else touched: the
  // visible input a person actually types into carries no `name` at all (it
  // shows a formatted clock, not the "HH:MM" the hidden sibling posts), so a
  // fix that only reached the visible input would leave this red.
  test("typing only the appointment time makes the Add-visit form dirty (#4976)", async ({
    page,
  }) => {
    await page.goto("/records/history/visits");
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();

    const registry = page.getByTestId("dirty-form-registry");
    await expect(registry).toHaveAttribute("data-dirty", "0");

    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    await openVisitFact(dialog, "when");
    const time = dialog.getByLabel("Time (optional)");
    await expect(time).toBeVisible();
    await expect(registry).toHaveAttribute("data-dirty", "0");

    await settledFill(page, time, "14:30");
    await expect(registry).toHaveAttribute("data-dirty", "1");

    // Read back: it is what the visible field and the chip both say — proof this
    // asserts the real edit path, not a registry side effect divorced from it.
    await expect(time).toHaveValue("14:30");
    await closeVisitFact(dialog);
    await expect(dialog.getByTestId("visit-fact-when")).toContainText("14:30");
  });

  test("a poll that observes a finished job waits for a date-only edit (#4986)", async ({
    page,
  }) => {
    test.slow();
    seedProcessingDocument();

    await page.goto("/records/history/visits");
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();
    const registry = page.getByTestId("dirty-form-registry");
    const behind = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: BEHIND });
    await expect(behind).toHaveCount(0);

    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    // Only the date changes; touching a named text field would hide a missing
    // DateField bridge. Its visible input formats the canonical hidden value.
    await openVisitFact(dialog, "when");
    const date = dialog.getByLabel("Date", { exact: true });
    const canonicalDate = dialog.locator('input[name="date"]');
    const originalDate = await canonicalDate.inputValue();
    const editedDate = shiftDateStr(frozenNow().toISOString().slice(0, 10), 2);
    await hydratedClick(page, date);
    await expect(registry).toHaveAttribute("data-dirty", "0");
    await date.fill(editedDate);
    await page.keyboard.press("Escape");
    await expect(registry).toHaveAttribute("data-dirty", "1");

    // Two background events at once, which is the realistic shape: the extraction
    // the user kicked off earlier finishes, and the data behind the page has moved
    // on meanwhile.
    seedAppointmentBehindThePage();
    finishDocument();

    // OBSERVATION IS NOT DEFERRED. The toast is proof the poll ran, saw the
    // transition and reported it — while the form was dirty. That is the half of
    // the ruling that says a deferred poll must not stall the poll loop: the user
    // still learns their extraction finished at the moment it does.
    await expect(page.getByText(`${DOC}: imported 3 records.`)).toBeVisible({
      timeout: 20_000,
    });

    // THE REPAINT IS DEFERRED. Owed, not run — so the appointment written behind
    // the page is NOT in the rendered tree. This assertion is the whole point:
    // before the poll observed over a route handler it FAILED, because the poll's
    // own Server Action response carried a freshly rendered tree that the client
    // applied with `data-refreshes` still 0.
    await expect(registry).toHaveAttribute("data-owed", "1");
    await expect(registry).toHaveAttribute("data-refreshes", "0");
    await expect(behind).toHaveCount(0);
    await expect(canonicalDate).toHaveValue(editedDate);

    // The user finishes with the field (undone, not submitted — this test never
    // writes through the UI). The owed repaint lands, once, CARRYING the new row:
    // deferred was never dropped, and what finally arrives is current data rather
    // than a replay of the moment that asked for it.
    await date.fill(originalDate);
    await date.blur();
    await expect(registry).toHaveAttribute("data-dirty", "0");
    await expect(registry).toHaveAttribute("data-refreshes", "1");
    await expect(registry).toHaveAttribute("data-owed", "0");
    await expect(behind).toHaveCount(1, { timeout: 15_000 });
  });

  test("a form the user empties again stops holding refreshes back", async ({
    page,
  }) => {
    test.slow();
    seedProcessingDocument();

    await page.goto("/records/history/visits");
    await expect(page.getByTestId("visits-upcoming")).toBeVisible();
    const registry = page.getByTestId("dirty-form-registry");

    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    await openVisitFact(dialog, "reason");
    const title = dialog.getByLabel("Reason / title");
    await expect(title).toBeVisible();

    await title.fill("typed, then thought better of it");
    await expect(registry).toHaveAttribute("data-dirty", "1");

    // Cleared and blurred: there is no unsaved input left to protect, so the
    // registry must let go. This is the release-on-blur-empty rule — without it
    // one abandoned form would suppress background refreshes forever.
    await title.fill("");
    await title.blur();
    await expect(registry).toHaveAttribute("data-dirty", "0");

    // With nothing dirty, a chrome refresh behaves exactly as it always did.
    finishDocument();
    await expect(page.getByText(`${DOC}: imported 3 records.`)).toBeVisible({
      timeout: 20_000,
    });
    await expect(registry).toHaveAttribute("data-refreshes", "1");
    await expect(registry).toHaveAttribute("data-owed", "0");
  });
});
