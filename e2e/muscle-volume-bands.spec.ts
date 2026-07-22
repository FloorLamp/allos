import { test, expect } from "@playwright/test";

// Issue #742 — per-muscle weekly volume bands. The Overview coverage list (#736)
// now carries a band VERDICT chip per muscle (below / within / above / untrained),
// computed ONCE by the shared bandVerdict + palette (lib/muscle-volume-bands.ts) the
// coaching-tier observation and the future SVG figure (#737) also read, so the chip,
// the finding, and the tint can never drift. Read-only — asserts rendering only, adds
// no rows, so it's safe against the shared seeded DB. The seed ships a PPL program
// whose most recent Push/Pull/Leg sessions land inside the trailing 7-day window, so
// the coverage list (and its verdict chips) have content.
//
// Value->presence (one-question-one-computation): the band THRESHOLDS + bandVerdict
// computation are pinned by lib/__tests__/muscle-volume-bands.test.ts (VOLUME_BANDS,
// bandVerdict). This spec asserts the chip renders a verdict from the known set (the
// on-element data-verdict marker) with matching human copy, never a threshold number.

const VERDICTS = ["below", "within", "above", "untrained"];

test("coverage list carries a band verdict chip per muscle (#742)", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");

  const coverage = page.getByRole("main").getByTestId("muscle-coverage");
  await expect(coverage).toBeVisible();

  // The seeded recent Leg day (Back Squat / Leg Press, daysAgo 1) credits quads, so
  // the Quads row renders — anchor on that specific row, not a positional first-match.
  const quadsRow = coverage
    .getByTestId("muscle-coverage-row")
    .filter({ hasText: "Quads" });
  await expect(quadsRow).toHaveCount(1);

  // Its verdict chip renders one of the four known verdicts (via the on-element
  // data-verdict marker) with matching human copy — never color-only.
  const chip = quadsRow.getByTestId("muscle-coverage-verdict");
  await expect(chip).toBeVisible();
  const verdict = await chip.getAttribute("data-verdict");
  expect(VERDICTS).toContain(verdict);
  await expect(chip).toContainText(/band|Untrained/);
});
