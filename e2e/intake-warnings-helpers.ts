import { type Locator, type Page } from "@playwright/test";

// Shared driver for the IntakeWarnings CARD anatomy (#868 class-2 migration:
// "cross-ownership anatomy assertions"). components/IntakeWarnings.tsx renders the SAME
// "Safety notices" disclosure on BOTH /medications and /nutrition?tab=supplements (the
// #144 interaction / #710 PGx / #717 ototoxic / #1029 drug-allergy shared surface), and
// the #1032 empty-state renders a quiet `safety-scope` footer instead. Before this module
// every safety spec (drug-interactions, pgx-crosscheck, drug-allergy, hearing,
// safety-coverage) hand-rolled the SAME locators — the `intake-warnings` card + its
// disclosure `summary`, the per-class sections (`interaction-warnings` / `pgx-warnings` /
// `ototoxic-warnings` / `allergy-med-warnings`), the dedupeKey-prefixed finding rows
// (`interaction-warning-interaction:` …), and the empty-state `safety-scope-*` footer — so
// any rework of the card broke a fistful of neighbor specs the author never knew pinned it.
//
// This driver OWNS those selectors; specs call the semantic locator helpers and keep only
// their own value assertions (severity text, cited framing, gene/reaction copy, the scope
// line's coverage counts). Same split as e2e/med-card-helpers.ts and e2e/symptom-helpers.ts:
// the helpers return Locators (or perform the one client disclosure toggle); the semantic
// assertions stay in the specs.
//
// `scope` is a Page or a narrower container (specs scope to `page.getByRole("main")` so a
// second copy in a sidebar/nav can't match), and every helper accepts either.

// The whole "Safety notices" disclosure card (`intake-warnings`). Absent (count 0) when
// there are no findings — the empty state renders `safety-scope-footer` instead.
export function intakeWarnings(scope: Locator | Page): Locator {
  return scope.getByTestId("intake-warnings");
}

// Open the disclosure so the individual finding sections are inspectable. The card is a
// native <details> (auto-open only when ≤2 findings), so this is a pure client toggle —
// a plain click on its summary, no Server-Action POST to await.
export async function expandIntakeWarnings(scope: Locator | Page): Promise<void> {
  await intakeWarnings(scope).locator("summary").click();
}

// The per-class finding sections inside the card.
export function interactionWarnings(scope: Locator | Page): Locator {
  return scope.getByTestId("interaction-warnings");
}
export function pgxWarnings(scope: Locator | Page): Locator {
  return scope.getByTestId("pgx-warnings");
}
export function ototoxicWarnings(scope: Locator | Page): Locator {
  return scope.getByTestId("ototoxic-warnings");
}
export function allergyWarnings(scope: Locator | Page): Locator {
  return scope.getByTestId("allergy-med-warnings");
}

// The individual finding rows, keyed by their `<class>-warning-<dedupeKey>` testid prefix.
// The seed shares the DB across specs, so callers narrow the returned locator to a specific
// finding by its text (`.filter({ hasText })`) rather than positionally.
export function interactionWarningRows(scope: Locator | Page): Locator {
  return scope.locator('[data-testid^="interaction-warning-interaction:"]');
}
export function pgxWarningRows(scope: Locator | Page): Locator {
  return scope.locator('[data-testid^="pgx-warning-pgx:"]');
}
export function ototoxicWarningRows(scope: Locator | Page): Locator {
  return scope.locator('[data-testid^="ototoxic-warning-ototoxic:"]');
}
export function allergyWarningRows(scope: Locator | Page): Locator {
  return scope.locator('[data-testid^="allergy-med-warning-allergy-med:"]');
}

// The #1032 empty-state scope disclosure (rendered in place of the active-warning card when
// screening found nothing): its collapsed footer, the clickable summary, and the expanded
// coverage line.
export function safetyScopeFooter(scope: Locator | Page): Locator {
  return scope.getByTestId("safety-scope-footer");
}
export function safetyScopeSummary(scope: Locator | Page): Locator {
  return scope.getByTestId("safety-scope-summary");
}
export function safetyScopeLine(scope: Locator | Page): Locator {
  return scope.getByTestId("safety-scope-line");
}
