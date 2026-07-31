// Tiny count-aware copy helpers. Pure, domain-free, and deliberately shared: the
// census (#1447) found "1 errors" on Settings → Errors, and the only exported
// `plural` in the tree lived in `lib/family-ui.ts` — a Family-admin module no
// other surface should be importing for a word. It moved here; family-ui
// re-exports it so its own callers and tests are unchanged.
//
// Scope note: this is English count agreement for UI labels, not an i18n layer.
// A caller with an irregular plural passes both forms.

// Pick the singular or plural word for a count.
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// The common case: the count and its noun together ("1 error" / "0 errors").
// `many` defaults to the regular `<one>s` form.
export function countLabel(n: number, one: string, many = `${one}s`): string {
  return `${n} ${plural(n, one, many)}`;
}
