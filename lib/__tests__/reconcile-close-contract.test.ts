// THE CLOSE DECLARATION IS A TYPE, NOT A SCAN (issue #2275).
//
// Nine of eleven reconcile families closed a fully-resolved message to "handled in the
// app." while holding the outcome — `mood` read the recorded mood and kept only the null
// check, `workoutDraft` knew whether the session was FINISHED or DISCARDED and rendered
// both identically. The cause was mechanical: `tally?()` was OPTIONAL, so "this family
// declares no detail" was expressed by OMISSION, which is indistinguishable from nobody
// having looked.
//
// The fix is a discriminated union on `FamilyReconciler` itself, and the guarantees it
// buys are COMPILE-TIME. This file is the pin for that: every case below is a deliberate
// `@ts-expect-error`, so if a variant ever stops being enforced the directive goes unused
// and `tsc --noEmit` fails. Nothing here runs a reconciler — the types are the assertion,
// and the behavior lives in lib/__db_tests__/message-reconcile.test.ts.
//
// The imports are TYPE-ONLY on purpose: ./reconcile is the DB half, and a pure test may
// not open a database. `import type` is erased before this file ever executes.

import { describe, expect, it } from "vitest";
import type {
  CloseContent,
  FamilyReconciler,
} from "../notifications/reconcile";
import type { CloseDetail } from "../notifications/reconcile-core";

const dead = () => new Set<string>();
const someDetail = (): CloseDetail | null => ({
  groups: [{ names: ["Vitamin D"], outcome: "taken" }],
});

// ---- What the contract ACCEPTS: the three legal answers -------------------------

const detailing: FamilyReconciler = {
  dead,
  closeStates: "outcome-detail",
  detail: someDetail,
};

const subjectOnly: FamilyReconciler = {
  dead,
  closeStates: "subject-only",
  why: "a stated reason is what keeps 'we decided against it' distinguishable from 'nobody looked'",
};

const notApplicable: FamilyReconciler = {
  dead,
  closeStates: "not-applicable",
  why: "this family never produces a resolved close at all",
};

// ---- What it REFUSES ------------------------------------------------------------

// A family cannot CLAIM detail without producing it. This is the entire defect: with
// `tally?()` optional, this object was legal and silently closed to the bare sentence.
// @ts-expect-error `outcome-detail` requires `detail()`
const claimsDetailWithoutProducing: FamilyReconciler = {
  dead,
  closeStates: "outcome-detail",
};

// A family cannot DECLINE detail without a reason, on either non-detail variant.
// @ts-expect-error `subject-only` requires `why`
const declinesWithoutReason: FamilyReconciler = {
  dead,
  closeStates: "subject-only",
};

// @ts-expect-error `not-applicable` requires `why`
const notApplicableWithoutReason: FamilyReconciler = {
  dead,
  closeStates: "not-applicable",
};

// A family cannot HALF-declare: a stated reason AND a detail producer is two answers to
// one question, and the variants are mutually exclusive by construction.
// @ts-expect-error `subject-only` may not carry `detail()`
const halfDeclared: FamilyReconciler = {
  dead,
  closeStates: "subject-only",
  why: "x",
  detail: someDetail,
};

// @ts-expect-error `outcome-detail` may not carry `why`
const detailWithReason: FamilyReconciler = {
  dead,
  closeStates: "outcome-detail",
  detail: someDetail,
  why: "x",
};

// And a family cannot decline to answer at all — which is what nine of them did.
// @ts-expect-error every reconciler must declare a `closeStates`
const undeclared: FamilyReconciler = { dead };

describe("the close declaration is enforced by the type (#2275)", () => {
  it("accepts each of the three legal answers", () => {
    // The compile-time refusals above are the assertion; these keep the accepted shapes
    // referenced so a variant cannot be deleted without this file noticing.
    const states: CloseContent["closeStates"][] = [
      detailing.closeStates,
      subjectOnly.closeStates,
      notApplicable.closeStates,
    ];
    expect(states).toEqual([
      "outcome-detail",
      "subject-only",
      "not-applicable",
    ]);
  });

  it("refuses every half-declaration", () => {
    // Referenced only so the refused shapes are not unused bindings; each carries its
    // own `@ts-expect-error`, which is what actually fails the build if it compiles.
    expect(
      [
        claimsDetailWithoutProducing,
        declinesWithoutReason,
        notApplicableWithoutReason,
        halfDeclared,
        detailWithReason,
        undeclared,
      ].every((r) => typeof r.dead === "function")
    ).toBe(true);
  });
});
