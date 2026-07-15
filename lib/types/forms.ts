// Shared Server-Action result contract (issue #474). A FormData write action that
// used to `return;` on a failed validation guard resolved as `undefined`, which
// the consuming form read as success — it toasted "Saved ✓" and reset, silently
// losing the entry. Following the #332 SaveActivityOutcome precedent and the
// settings/family `{ ok:false, error }` pattern, every migrated passport CRUD
// action now answers with this typed union: a validation failure returns an
// explicit `{ ok:false, error }` the form routes to its inline error, never a bare
// resolve. The scanner in lib/__tests__/action-return-contract.test.ts fails the
// build if a listed action module regresses to a bare `return;` after its
// requireWriteAccess gate — so new actions in these modules inherit the contract.
export type FormResult = { ok: true } | { ok: false; error: string };

// A tiny helper so an action's failure guards read as one call. `err` is the
// human-facing message the form renders; `ok()` marks the persisted-success path.
// Narrow return so a failure literal fits both `FormResult` and any richer
// success-shaped union (e.g. nutrition's `{ ok: true; servings }`) whose error arm is
// the same `{ ok: false; error }` — the ok arm carries no extra fields on failure.
export function formError(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function formOk(): FormResult {
  return { ok: true };
}
