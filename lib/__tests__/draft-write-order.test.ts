// THE DRAFT MUTATION ORDER (#2908), and only that.
//
// `lib/offline/draft-db.ts` serialises one draft's writes so a `putDraft` cannot overtake
// the `deleteDraft` that follows it — the callers in components/useFormDraft fire both
// WITHOUT awaiting either, so the pair otherwise races on how long each takes, and a put
// that wins leaves a draft on the device for work that saved perfectly well.
//
// WHY THIS FILE EXISTS AT ALL: that ordering was a real change to shipped behaviour and
// NOTHING HELD IT. Deleting `inOrder` from both mutators left the entire suite green,
// `form-drafts` and `stale-build-save` included. It is the same shape as
// `whenSessionOpened` a round earlier — a mechanism whose only evidence was its own
// comment — and it is worse here, because this one is what changed how every form's
// drafts are written.
//
// HOW IT IS OBSERVED WITHOUT A DATABASE. There is no `indexedDB` in the pure tier, and
// the real thing is not needed: both mutators reach the database through exactly one call
// (`indexedDB.open`), so COUNTING OPENS answers the ordering question outright. A stub
// whose `open` never settles freezes the first mutation, and whether the second one has
// opened the database yet is the whole property:
//
//   • same key   → the second must NOT have opened. That is the chain.
//   • other key  → the second MUST have opened. That is the chain being PER KEY, which
//     is the part a single global chain got wrong: it made every form's draft write wait
//     behind every other's, far beyond the ordering its callers actually assume.
//
// A GLOBAL STUB, NOT A MODULE MOCK — a mock marker would route this spec to the tier's
// isolated project (lib/__tests__/vitest-isolation-budget.test.ts), and one global is all
// lib/offline/idb reads.

import { describe, it, expect, afterEach } from "vitest";
import { deleteDraft, putDraft } from "@/lib/offline/draft-db";
import type { FormDraft } from "@/lib/offline/drafts";

let opens = 0;

function holdTheDatabaseOpen(): void {
  opens = 0;
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      opens += 1;
      // Never settles: every handler stays null, so whichever mutation got here is
      // frozen mid-flight and the next one's behaviour is the measurement.
      return {
        error: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
        onsuccess: null,
      };
    },
  };
}

afterEach(() => {
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

// A FRESH KEY PER TEST, and it is not hygiene — it is forced. Each test leaves its
// first mutation frozen mid-open on purpose, so that key's chain never completes, and a
// later test reusing it would queue behind the earlier freeze and measure that instead.
// (This is the per-key chain proving itself before a single assertion runs.) The shape is
// what `draftKey()` produces: profile, form, record.
let n = 0;
function keys(): { activity: string; weight: string } {
  n += 1;
  return { activity: `1:activity:new${n}`, weight: `1:body-metric:new${n}` };
}

function draft(key: string): FormDraft {
  return {
    key,
    profileId: 1,
    formKey: "activity",
    recordId: null,
    savedAt: 1,
    fields: {},
    extra: {},
  } as FormDraft;
}

// Let the microtask queue drain so an unchained call has every chance to have opened.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("one draft's mutations run in call order", () => {
  it("a delete does NOT touch the database until the put before it has finished", async () => {
    const { activity } = keys();
    holdTheDatabaseOpen();
    void putDraft(draft(activity));
    await settle();
    expect(opens, "the put should be the one in flight").toBe(1);

    void deleteDraft(activity);
    await settle();
    // The finding, stated as a number: an unchained delete opens immediately and can
    // therefore land BEFORE the put it was written after.
    expect(
      opens,
      "the delete reached the database while its own put was still in flight"
    ).toBe(1);
  });

  it("a put does NOT overtake the delete before it either", async () => {
    const { activity } = keys();
    holdTheDatabaseOpen();
    void deleteDraft(activity);
    await settle();
    expect(opens).toBe(1);

    void putDraft(draft(activity));
    await settle();
    expect(opens).toBe(1);
  });
});

describe("the chain is PER KEY, so one form cannot stall another", () => {
  it("another form's draft writes while this one is still in flight", async () => {
    const { activity, weight } = keys();
    holdTheDatabaseOpen();
    void putDraft(draft(activity));
    await settle();
    expect(opens).toBe(1);

    // A single global chain — the version this replaced — makes this wait, which is a
    // behaviour change well past the ordering the callers assume. They assume it within
    // ONE draft; two forms have no ordering relationship at all.
    void putDraft(draft(weight));
    await settle();
    expect(
      opens,
      "a second form's draft was made to queue behind an unrelated form's"
    ).toBe(2);
  });

  it("and a delete of another key is not held either", async () => {
    const { activity, weight } = keys();
    holdTheDatabaseOpen();
    void putDraft(draft(activity));
    await settle();
    void deleteDraft(weight);
    await settle();
    expect(opens).toBe(2);
  });
});
