// TYPED CACHE REVALIDATION (issue #2149, item 1).
//
// `revalidatePath` takes a PLAIN STRING, so `typedRoutes` — the thing that makes a
// dead `<Link href>` a build error (#285) — could never see a revalidate target.
// That gap produced a real defect class: after the #1042/#1079 route merges several
// Server Actions kept revalidating URLs that no longer served anything
// (`/encounters`, a retired training path, `/body`), so the refresh became a silent no-op and the
// moved surface stayed stale. It was closed by a TEXT SWEEP over app/ sources
// (lib/__tests__/nav-routes.test.ts, #1636) whose own comment apologized for
// existing.
//
// `revalidateRoute` closes it with a TYPE instead. Every target — single or
// fan-out array — is checked against Next's generated route union, so a retired
// route is a compile error at the call site rather than a regex's discovery.
// The sweep it replaces is demoted to one assertion: no raw `revalidatePath`
// outside this module.
//
// Behavior is identical to calling `revalidatePath` directly; this module adds no
// logic beyond the array fan-out that the call sites were already writing by hand.

import type { Route } from "next";
import { revalidatePath } from "next/cache";

// Next's own second argument: which cached level to invalidate. A dynamic route
// written in its `[param]` literal form REQUIRES "page" (Next cannot expand the
// segment otherwise); everything else uses the default, and "layout" is the
// deliberate wide invalidation used by the profile switcher and the app shell.
export type RevalidateScope = "layout" | "page";

/**
 * A cache-revalidation target: an internal route PATH.
 *
 * `Route<T>` is Next's generated union, so it carries the same teeth as an
 * `AppRoute`-typed href. Two differences, both deliberate:
 *
 *  - The `` `/${string}` `` intersection drops the arms `Route` only has because
 *    `<Link>` needs them — a bare `?query`/`#hash` (relative to the CURRENT page,
 *    meaningless to `revalidatePath`) and `${string}:${string}` external URLs. A
 *    revalidation target is always a rooted path. This tooth holds even when the
 *    generated route types are absent, i.e. when Next's fallback `Route` is
 *    `string & {}` — the state `npm run typecheck` used to run in before #2293 made
 *    it `next typegen && tsc --noEmit`. Both teeth are pinned by
 *    lib/__tests__/revalidate-route.test.ts's `@ts-expect-error` cases now; the
 *    route-union half is only assertable because the types are generated first.
 *  - `T` is inferred PER CALL, which is what admits a dynamic route in its literal
 *    `[param]` form (`"/import/[id]"` matches Next's `` `/import/${SafeSlug<T>}` ``)
 *    and an interpolated one (`` `/medications/${id}` ``). `Route<string>` — the
 *    default, used for a DECLARED list whose elements can't each infer — admits
 *    static routes only, exactly like `AppRoute`.
 */
export type RevalidateTarget<T extends string = string> = Route<T> &
  `/${string}`;

/**
 * Purge the Next cache for one route, or fan out over several.
 *
 * The array form is the shape most Server Actions already used (`for (const p of
 * PATHS) revalidatePath(p)`); passing the list directly keeps every element
 * compile-checked. A list declared away from its call site is annotated
 * `readonly RevalidateTarget[]` (or `as const`) so it is checked where it is
 * WRITTEN rather than widened to `string[]` on the way to the call.
 */
export function revalidateRoute<T extends string>(
  target: RevalidateTarget<T>,
  scope?: RevalidateScope
): void;
export function revalidateRoute<T extends string>(
  targets: readonly RevalidateTarget<T>[],
  scope?: RevalidateScope
): void;
export function revalidateRoute(
  target: string | readonly string[],
  scope?: RevalidateScope
): void {
  // Forward the ARITY the call site wrote, not a normalized two-argument form: an
  // omitted scope stays omitted. Next treats a trailing `undefined` the same as an
  // absent argument, but the action tier asserts on the mocked call shape, and this
  // wrapper is meant to be invisible to it.
  const one = (path: string) =>
    scope === undefined ? revalidatePath(path) : revalidatePath(path, scope);
  if (typeof target === "string") {
    one(target);
    return;
  }
  for (const path of target) one(path);
}

/**
 * Widen a per-call-checked target so it can be STORED in a declared list.
 *
 * This is lib/hrefs.ts's dynamic-route helper pattern (`importHref`,
 * `encounterHref`): a dynamic route's `[param]` form is not assignable to the
 * generic-default `RevalidateTarget`, because that default cannot infer the literal
 * — so annotate to CHECK it against the real route tree, then widen to STORE it. A
 * removed `/x/[id]` page fails the build here, which is the whole point.
 *
 * Static targets never need this: they are assignable to `RevalidateTarget`
 * directly.
 */
export function revalidateTarget<T extends string>(
  path: RevalidateTarget<T>
): RevalidateTarget {
  return path as RevalidateTarget;
}
