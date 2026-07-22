import { expect, type Locator, type Page } from "@playwright/test";
import { settledClick } from "./helpers";

// Shared drivers for the one-tap SymptomLogBar (#799/#857), used by EVERY mount that
// hosts it — the dashboard card (symptom-log.spec), the episode page (illness-episode-
// followups.spec, #856 item 11), and future accordion mounts (#858). ONE flow, no
// per-mount drift.
//
// The bar is optimistic + reconciled: a tap writes via a Server Action and then fires
// router.refresh(), which re-renders (and on some surfaces remounts) the bar. Two hazards
// follow, handled by two composable mechanisms:
//
//   1. A trailing refresh can reset the bar's TRANSIENT client state (such as an open
//      picker) mid-interaction. Every helper wraps its tap+assert in an
//      auto-retrying expect(...).toPass(): if a refresh wiped the affordance, the retry
//      re-does the (idempotent) tap.
//   2. The tap is OPTIMISTIC, so a later DEPENDENT step (a reload, a note UPDATE that
//      needs the row committed) can race the write. Waiting for commit is a TAP-mode
//      PARAMETER: a caller with dependent steps passes settledTap(page) — the
//      settledClick idiom, which arms a waitForResponse for the action POST BEFORE
//      clicking, so the helper returns only once the write is durably applied (this
//      replaced the old dashboard-only networkidle settle, which never settled on the
//      episode page and waited for the wrong thing everywhere — #868). A caller with no
//      dependent step keeps the default plainTap (optimistic is enough).

const STEP = 2_500; // per-attempt inner assertion timeout
const OUTER = 25_000; // overall retry budget

// How a helper performs a write-firing tap. `plainTap` is optimistic-only (episode
// page — no dependent step follows); `settledTap` awaits the Server-Action POST the
// tap fires (dashboard — the next step depends on the committed row).
export type Tap = (target: Locator) => Promise<void>;
export const plainTap: Tap = (target) => target.click();
export function settledTap(page: Page): Tap {
  return (target) => settledClick(page, target);
}

// Clear a symptom-day if it's logged, so the symptom starts in the picker (repeat-safe: a
// prior run's leftover can't hide the picker chip).
export async function ensureUnlogged(
  bar: Locator,
  key: string,
  tap: Tap = plainTap
): Promise<void> {
  await expect(async () => {
    const clear = bar.getByTestId(`symptom-${key}-clear`);
    if ((await clear.count()) > 0) {
      await tap(clear);
    }
    await expect(bar.getByTestId(`symptom-${key}`)).toHaveCount(0, {
      timeout: STEP,
    });
  }).toPass({ timeout: OUTER });
}

// Add a catalog symptom via the "＋ add symptom" picker — it logs at severity 1 and
// becomes a logged row. Idempotent: a no-op if already logged; re-opens the picker if a
// refresh closed it.
export async function addFromPicker(
  bar: Locator,
  key: string,
  tap: Tap = plainTap
): Promise<void> {
  const row = bar.getByTestId(`symptom-${key}`);
  await expect(async () => {
    if ((await row.count()) === 0) {
      if ((await bar.getByTestId("symptom-add-picker").count()) === 0) {
        // Opening the picker is a pure client toggle (no write) — plain click.
        await bar.getByTestId("symptom-add-picker-toggle").click();
      }
      const pick = bar.getByTestId(`symptom-pick-${key}`);
      if ((await pick.count()) > 0) {
        await tap(pick);
      }
    }
    await expect(row).toBeVisible({ timeout: STEP });
  }).toPass({ timeout: OUTER });
}

// Raise a logged symptom to a severity level (a tap only RAISES — worst-severity).
export async function raiseSeverity(
  bar: Locator,
  key: string,
  level: number,
  tap: Tap = plainTap
): Promise<void> {
  const chip = bar.getByTestId(`symptom-${key}-sev-${level}`);
  await expect(async () => {
    await tap(chip);
    await expect(chip).toHaveAttribute("aria-pressed", "true", {
      timeout: STEP,
    });
  }).toPass({ timeout: OUTER });
}

// Lowering is also a direct labeled-chip action. It writes through the dedicated lower
// action, but its optimistic/reconciled browser behavior matches a raise.
export async function lowerSeverity(
  bar: Locator,
  key: string,
  level: number,
  tap: Tap = plainTap
): Promise<void> {
  const chip = bar.getByTestId(`symptom-${key}-sev-${level}`);
  await expect(async () => {
    await tap(chip);
    await expect(chip).toHaveAttribute("aria-pressed", "true", {
      timeout: STEP,
    });
  }).toPass({ timeout: OUTER });
}

// Expand the collapsed temperature entry (idempotent — a no-op if already open; re-opens
// if a refresh collapsed it). Client-only (no write), so no settle.
export async function openTempEntry(bar: Locator): Promise<void> {
  const input = bar.getByTestId("temp-quick-input");
  await expect(async () => {
    if ((await bar.getByTestId("temp-quick-entry").count()) === 0) {
      await bar.getByTestId("temp-quick-toggle").click();
    }
    await expect(input).toBeVisible({ timeout: STEP });
  }).toPass({ timeout: OUTER });
}

// Set a symptom's one-line note and confirm it PERSISTED — the logAndConfirm
// reload-retry discipline (see symptom-log.spec), because nothing weaker is
// truthful here:
//   • the client save is OPTIMISTIC (the note renders before the action lands and
//     REVERTS on failure), so asserting the on-screen text proves nothing;
//   • the note write core is UPDATE-only (a note for a not-yet-committed symptom
//     row returns `invalid`), so a save racing the prior tap's still-in-flight
//     action fails legitimately;
//   • settledClick can't pin the save POST — the dashboard toasters poll via a
//     Server Action POST that is indistinguishable from any mutation POST (the
//     same ambiguity documented in the hygiene guard's waitForTimeout allowlist).
// So: fill, blur (the input's onBlur IS the save path — no submit-button click,
// whose pre-click blur unmounts the form under the button), await THE save
// action's POST completing, THEN reload and assert the SERVER-rendered note.
//
// The POST wait is load-bearing twice over: a reload fired right after blur
// ABORTS the still-in-flight save action (every iteration kills its own write),
// and a generic any-POST wait is NOT safe here — the dashboard toasters poll via
// Server-Action POSTs, and waitForResponse also matches a response whose request
// STARTED before arming, so it can resolve on a bystander instantly and the
// reload still aborts the save. The predicate therefore pins the SAVE by its own
// multipart body (the note text rides in the action's FormData) — the one POST
// that provably is the mutation. On a timeout (the blur save didn't fire — e.g. a
// refresh remounted the input mid-fill) the reload-assert fails the iteration
// and the idempotent flow retries.
export async function saveNote(
  page: Page,
  key: string,
  text: string
): Promise<void> {
  await expect(async () => {
    let bar = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar (top of the dashboard) — order-agnostic
    const note = bar.getByTestId(`symptom-${key}-note`);
    if (!((await note.count()) > 0 && (await note.innerText()) === text)) {
      const input = bar.getByTestId(`symptom-${key}-note-input`);
      if ((await input.count()) === 0) {
        await bar.getByTestId(`symptom-${key}-note-toggle`).click();
      }
      await input.fill(text);
      const saved = page
        .waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            (r.request().postData() ?? "").includes(text),
          { timeout: 5_000 }
        )
        .catch(() => null);
      await input.blur();
      await saved;
    }
    await page.reload();
    bar = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar (re-queried after a refresh) — order-agnostic
    await expect(bar.getByTestId(`symptom-${key}-note`)).toHaveText(text, {
      timeout: 3_000,
    });
    // Budget note: the whole loop must fit inside the 30s per-test timeout, so
    // OUTER (25s) rather than a larger custom budget.
  }).toPass({ timeout: OUTER });
}
