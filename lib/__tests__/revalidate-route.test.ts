// THE REVALIDATE TARGET IS A TYPE, NOT A SWEEP (issue #2149, item 1).
//
// `revalidatePath` takes a plain string, so `typedRoutes` could never see a
// revalidation target and a route merge left Server Actions refreshing URLs that no
// longer served anything (#1636). `revalidateRoute` narrows that argument to Next's
// generated route union, which moves the guarantee from a regex over app/ sources to
// the compiler.
//
// This file pins BOTH halves of the wrapper:
//
//  1. The narrowing, as deliberate `@ts-expect-error` cases in the idiom of
//     lib/__tests__/reconcile-close-contract.test.ts (#2275) — if the parameter ever
//     stops refusing these, the directive goes unused and `tsc --noEmit` fails.
//
//     BOTH halves of the narrowing are pinned, which they could not be before #2293.
//     The SHAPE half: a target is a ROOTED PATH, never a bare `?query`/`#hash`
//     (Next's `Route` admits those for `<Link>`, where they are relative to the
//     current page and meaningless to `revalidatePath`), never a relative string, and
//     never a widened `string`. The ROUTE-UNION half: a rooted path that names no
//     page — the #1636 dead-target class — is refused too.
//
//     The route-union pin is the one that used to be unwritable. `npm run typecheck`
//     was a bare `tsc --noEmit` over a tree with no `.next/types`, where Next's
//     fallback `Route` is `string & {}`, so "/no-such-page" type-checked fine and a
//     directive pinning its refusal went UNUSED — itself an error. #2293 made the
//     script `next typegen && tsc --noEmit`, so the generated union is present
//     wherever this file is checked and the interesting refusal can be asserted.
//
//  2. The fan-out, as behavior: the array form must call through once per element,
//     with the scope carried to each. `next/cache` is mocked because a pure test has
//     no request store for the real `revalidatePath` to write into.

import { describe, expect, it, vi, beforeEach } from "vitest";

// The mock records raw arguments rather than exposing a `vi.fn()` this file would
// have to IMPORT back from "next/cache" — which is exactly what the demoted
// assertion in nav-routes.test.ts forbids outside the wrapper. Standing in for the
// module the wrapper calls is fine; naming its export here would not be.
const calls = vi.hoisted(() => [] as unknown[][]);
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => {
    calls.push(args);
  },
}));

import {
  revalidateRoute,
  revalidateTarget,
  type RevalidateTarget,
} from "../revalidate";

// ---- What the parameter ACCEPTS -------------------------------------------------

// A rooted static path, with and without the scope argument.
revalidateRoute("/data");
revalidateRoute("/", "layout");
revalidateRoute("/biomarkers/view", "page");

// An array fan-out. Every element is checked, and a list declared elsewhere keeps
// its literals when it is annotated with the target type.
revalidateRoute(["/data", "/results", "/"]);
const DECLARED: readonly RevalidateTarget[] = ["/trends", "/"];
revalidateRoute(DECLARED);

// A dynamic route, both ways it is legitimately written: the `[param]` literal that
// Next expands with the "page" scope, and an interpolated one.
revalidateRoute("/medical/episodes/[id]", "page");
const id = 7;
revalidateRoute(`/medications/${id}`);

// …and the same `[param]` literal widened for STORAGE in a declared list, which is
// the one place the literal cannot be inferred per element.
const STORED: readonly RevalidateTarget[] = [
  "/results",
  revalidateTarget("/import/[id]"),
];

// ---- What it REFUSES ------------------------------------------------------------

// A relative path. `revalidatePath` resolves nothing from one, so the refresh would
// be a silent no-op — the exact failure mode #1636 was about.
// @ts-expect-error a revalidation target is a rooted path
revalidateRoute("nutrition");

// A bare query/hash. `Route` admits these because `<Link href="?tab=food">` is
// meaningful; a revalidation target has no current page to be relative to.
// @ts-expect-error a revalidation target is a rooted path, not a bare query
revalidateRoute("?tab=supplements");

// A widened `string` — the shape every pre-#2149 call site had, and the reason a
// dead target could reach production in the first place.
const computed: string = "/whatever";
// @ts-expect-error an unchecked string is not a revalidation target
revalidateRoute(computed);

// The array form narrows per element, not just at the array.
// @ts-expect-error every element of a fan-out is a rooted path
revalidateRoute(["/data", "nutrition"]);

// A rooted path that names NO PAGE — the #1636 class this wrapper exists for, and
// (per the header) the refusal that only became assertable once `npm run typecheck`
// generated the route types. If `.next/types/routes.d.ts` ever goes missing again,
// `Route` collapses to `string & {}`, this directive goes unused, and `tsc --noEmit`
// fails HERE rather than silently accepting dead targets everywhere.
// @ts-expect-error a revalidation target names a route that exists
revalidateRoute("/no-such-page");

// …including inside a fan-out, and behind the storage widener — `revalidateTarget`
// checks before it widens, so it is not an escape hatch from the union.
// @ts-expect-error every element of a fan-out names a route that exists
revalidateRoute(["/data", "/goals"]);
// @ts-expect-error widening for storage still checks the route first
revalidateTarget("/medical");

// ---- What it DOES ---------------------------------------------------------------

describe("revalidateRoute", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("passes a single target straight through, at the arity the caller wrote", () => {
    revalidateRoute("/trends");
    revalidateRoute("/", "layout");
    // An omitted scope stays OMITTED rather than becoming a trailing `undefined`:
    // the wrapper has to be invisible to the action tier's call-shape assertions.
    expect(calls).toEqual([["/trends"], ["/", "layout"]]);
  });

  it("fans an array out one call per element, carrying the scope to each", () => {
    revalidateRoute(["/data", "/results", "/"], "page");
    expect(calls).toEqual([
      ["/data", "page"],
      ["/results", "page"],
      ["/", "page"],
    ]);
  });

  it("revalidates nothing for an empty fan-out", () => {
    revalidateRoute(DECLARED.slice(0, 0));
    expect(calls).toEqual([]);
  });

  it("widens a checked dynamic literal without changing it", () => {
    expect(STORED).toEqual(["/results", "/import/[id]"]);
  });
});
