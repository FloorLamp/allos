import { expect, type Locator, type Page } from "@playwright/test";

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
//      needs the row committed) can race the write. Waiting for commit is a SETTLE that
//      differs by surface: on the dashboard `networkidle` drains the POST + refresh, but
//      on the episode page networkidle never settles (its requests keep the connection
//      busy) and stacks into the test timeout. So the settle is a PARAMETER — the
//      dashboard passes idleSettle(page); the episode page passes noSettle (its item 11
//      has no dependent step, so optimistic is enough).

const STEP = 2_500; // per-attempt inner assertion timeout
const OUTER = 25_000; // overall retry budget

// A post-tap wait for the write to commit. `noSettle` is optimistic-only (episode page);
// `idleSettle` drains the network so the write is committed before the next step
// (dashboard).
export type Settle = () => Promise<void>;
export const noSettle: Settle = async () => {};
export function idleSettle(page: Page): Settle {
  return async () => {
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
  };
}

// Clear a symptom-day if it's logged, so the symptom starts in the picker (repeat-safe: a
// prior run's leftover can't hide the picker chip).
export async function ensureUnlogged(
  bar: Locator,
  key: string,
  settle: Settle = noSettle
): Promise<void> {
  await expect(async () => {
    const clear = bar.getByTestId(`symptom-${key}-clear`);
    if ((await clear.count()) > 0) {
      await clear.click();
      await settle();
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
  settle: Settle = noSettle
): Promise<void> {
  const row = bar.getByTestId(`symptom-${key}`);
  await expect(async () => {
    if ((await row.count()) === 0) {
      if ((await bar.getByTestId("symptom-add-picker").count()) === 0) {
        await bar.getByTestId("symptom-add-picker-toggle").click();
      }
      const pick = bar.getByTestId(`symptom-pick-${key}`);
      if ((await pick.count()) > 0) {
        await pick.click();
        await settle();
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
  settle: Settle = noSettle
): Promise<void> {
  const chip = bar.getByTestId(`symptom-${key}-sev-${level}`);
  await expect(async () => {
    await chip.click();
    await settle();
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
  settle: Settle = noSettle
): Promise<void> {
  const chip = bar.getByTestId(`symptom-${key}-sev-${level}`);
  await expect(async () => {
    await chip.click();
    await settle();
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

// Open the one-line note input on a logged symptom (idempotent — clicks the toggle only
// when the input isn't already showing, so a retry never toggles it back shut).
export async function openNoteInput(bar: Locator, key: string): Promise<void> {
  const input = bar.getByTestId(`symptom-${key}-note-input`);
  await expect(async () => {
    if ((await input.count()) === 0) {
      await bar.getByTestId(`symptom-${key}-note-toggle`).click();
    }
    await expect(input).toBeVisible({ timeout: STEP });
  }).toPass({ timeout: OUTER });
}
