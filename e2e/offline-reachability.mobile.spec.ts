import { test, expect } from "./fixtures";
import { awaitHydrated, openMeasurementGroup } from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { loginAs } from "./nav";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_WEIGHT_QA } from "./fixture-logins";

// CAN YOU GET INTO THE FORM AT ALL — the question no other offline spec asks (#4091).
//
// ── THE ORDERING IS THE WHOLE TEST ───────────────────────────────────────────
//
// Every other offline spec in this repo goes online → open the form →
// `setOffline(true)` → act, and `quick-log-overlay.mobile.spec.ts` says so in its
// own comment: "here it is only the wait that lets the sheet — which loads through
// a Server Action — be reopened." That ordering proves a WRITE QUEUES once you are
// inside a form. It cannot prove you can get in, because the getting-in already
// happened on a live connection.
//
// The cost of the gap, measured on #4083: retiring the dashboard's inline weight
// widget removed the last offline-reachable weigh-in, and every guard on that PR
// stayed green — the retirement census asserts the sheet OFFERS the row, which is
// a statement about membership, and reachability is a precondition membership
// never had.
//
// So here the connection dies FIRST, after full hydration, and only then does the
// test reach for the surface. Nothing is opened on a live connection.
//
// ── WHICH SURFACES BELONG IN THIS FILE ───────────────────────────────────────
//
// The rule the app follows, now written down (docs/internals/e2e-hygiene.md):
// **a surface is offline-reachable exactly when opening it needs no Server
// Action** — server-rendered inline, or client state the shell already holds.
// One test per surface that claims offline support AND has a real opening step.
// The inline controls (the food bar, the dose rows, the mobility chips) have no
// opening step at all: you are standing on their page or you are not, and
// navigating offline is the `/offline` shell's subject, not this file's.
//
// No scanner and no ratchet: a hand-written list, which is what makes it readable
// and what makes an omission a decision rather than an oversight.

const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

// The exact matched pair the falsifying pass on #4083 measured, both directions:
// the fixed tree says the first sentence, the pre-fix tree says the second.
const QUEUED = "Saved offline — will sync when you reconnect.";
const REFUSED_TO_OPEN = "Couldn't open that form. Close this and try again.";

test("the quick logger's measurements row OPENS with no connection, and the weigh-in queues", async ({
  browser,
}) => {
  // The profile #4083's matched pair was measured on: write-granted, adult (so no
  // growth fields), and spec-owned. This test never reconnects, so the queued entry
  // never replays and no row of its own reaches the database — the owning spec's
  // reset is untouched.
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_WEIGHT_QA, password: E2E_MEMBER_PASSWORD },
    PHONE_CONTEXT
  );
  const context = page.context();
  try {
    await page.goto("/");
    // FULL HYDRATION BEFORE THE DISCONNECT, and it is load-bearing in both
    // directions. Too early and the dock puck's tap is swallowed pre-hydration
    // (#2742) and this reports a reachability failure it did not have; too late is
    // impossible, because nothing here is timed. React's fibers on the puck are the
    // repo's own hydration probe, and the puck is the first thing the test touches.
    const puck = page.getByTestId("dock-log-puck");
    await awaitHydrated(puck);

    await context.setOffline(true);

    // From here on, every step is offline. No navigation happens inside this
    // window, so no shell has to come from anywhere and `readyForOffline` is not
    // the precondition (docs/internals/e2e-hygiene.md, "Offline does not reach the
    // service worker").
    const sheet = await openLogSheet(page);
    const row = await showLogRow(sheet, "log-measurements");
    await row.click();
    await expect(sheet).toHaveCount(0);

    const overlay = page.getByTestId("quick-entry-sheet");
    await expect(overlay).toBeVisible();
    // THE ASSERTION THE WHOLE FILE EXISTS FOR. A presence, deliberately: waiting
    // longer cannot make a form appear that was never mounted, so this fails
    // honestly on the broken tree at any budget.
    const form = overlay.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    // And the refusal sentence is absent — checked only AFTER the form is visible,
    // where "ready" and "error" are mutually exclusive, so this is a settled state
    // rather than an absence racing a paint.
    await expect(page.getByText(REFUSED_TO_OPEN)).toHaveCount(0);
    await expect(overlay.getByTestId("quick-entry-error")).toHaveCount(0);

    // Reachable is not yet useful: the point of getting in is getting a weight out.
    await openMeasurementGroup(page, form, "body");
    await overlay.locator("#m-weight").fill("81.4");
    // A plain click: this submit deliberately posts NOTHING — the queue is the
    // point — so there is no Server Action response to settle on.
    await overlay.getByRole("button", { name: "Save measurements" }).click();

    await expect(page.getByText(QUEUED)).toBeVisible();
    const badge = page.getByTestId("offline-queue-badge");
    await expect(badge).toHaveText(/1 queued offline/);
  } finally {
    // Closed while still offline: the queued entry dies with the context rather
    // than replaying into a profile another spec owns.
    await context.close();
  }
});

// The worker's shared session, on the phone the ruling was reported from: the
// desktop "Add activity" button does not render at 390px, so the door here is the
// same dock puck the row above uses. Two rows of one sheet, offline-reachable for
// the same reason — which is what makes this a rule rather than one bug's guard.
test("the activity editor OPENS with no connection — the shell already holds its props", async ({
  page,
  context,
}) => {
  // ActivityEditorProvider is propped from the app shell, so `openCreate` is client
  // state and needs no round trip. offline-set-log.spec.ts drives the WRITE from
  // this editor, and opens it online first — this is the half that ordering cannot
  // see.
  await page.goto("/");
  const puck = page.getByTestId("dock-log-puck");
  await awaitHydrated(puck);

  await context.setOffline(true);

  const sheet = await openLogSheet(page);
  const row = await showLogRow(sheet, "log-activity");
  await row.click();
  await expect(page.getByTestId("activity-form")).toBeVisible();
  // Nothing is saved: the editor is opened and abandoned, so no activity row is
  // left to displace the seeded lift (offline-set-log.spec.ts's #3930 hazard).
  await context.setOffline(false);
});
