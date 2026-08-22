import { describe, expect, it } from "vitest";
import {
  DRAFT_TTL_MS,
  draftAgeLabel,
  draftConflictsWithInput,
  draftKey,
  draftSig,
  fieldMultimap,
  isDraftExpired,
  shouldOfferDraft,
  shouldPersistDraft,
  type DraftField,
  type FormDraft,
} from "@/lib/offline/drafts";
import {
  captureUnsavedWork,
  hasUnsavedWork,
  markUnsavedWork,
  resetUnsavedWork,
  subscribeUnsavedWork,
  type ResumePointer,
} from "@/lib/offline/unsaved-work";

// Local form drafts (issue #1699) — the pure half: key derivation, expiry, and the
// offer/persist/conflict rules. The IndexedDB round-trip and the DOM restore are
// browser behavior and belong to the Playwright tier (e2e/form-drafts.spec.ts), the
// same split lib/offline/queue-db.ts already lives under.

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

function draft(over: Partial<FormDraft> = {}): FormDraft {
  const fields: DraftField[] = [["name", "Creatine"]];
  return {
    key: draftKey({ profileId: 1, formKey: "supplement", recordId: null }),
    profileId: 1,
    formKey: "supplement",
    recordId: null,
    savedAt: NOW - 60_000,
    fields,
    extra: null,
    ...over,
  };
}

describe("draftKey", () => {
  it("scopes by profile, so a switch cannot surface another subject's draft", () => {
    expect(
      draftKey({ profileId: 1, formKey: "activity", recordId: null })
    ).not.toBe(draftKey({ profileId: 2, formKey: "activity", recordId: null }));
  });

  it("keys create and edit separately", () => {
    expect(
      draftKey({ profileId: 1, formKey: "activity", recordId: null })
    ).toBe("1:activity:new");
    expect(draftKey({ profileId: 1, formKey: "activity", recordId: 42 })).toBe(
      "1:activity:42"
    );
  });

  it("keys each form separately, so two open forms never share a draft", () => {
    expect(
      draftKey({ profileId: 1, formKey: "supplement", recordId: 7 })
    ).not.toBe(draftKey({ profileId: 1, formKey: "medication", recordId: 7 }));
  });
});

describe("expiry", () => {
  it("keeps a draft inside the TTL and drops one past it", () => {
    expect(
      isDraftExpired(draft({ savedAt: NOW - DRAFT_TTL_MS + 1000 }), NOW)
    ).toBe(false);
    expect(isDraftExpired(draft({ savedAt: NOW - DRAFT_TTL_MS }), NOW)).toBe(
      true
    );
  });

  it("never offers an expired draft — a forgotten one cannot resurface", () => {
    expect(
      shouldOfferDraft({
        draft: draft({ savedAt: NOW - DRAFT_TTL_MS - 1 }),
        profileId: 1,
        formKey: "supplement",
        recordId: null,
        currentSig: draftSig([], null),
        now: NOW,
      })
    ).toBe(false);
  });
});

describe("shouldOfferDraft", () => {
  const base = {
    profileId: 1,
    formKey: "supplement" as const,
    recordId: null,
    now: NOW,
  };

  it("offers a stored draft that differs from the form on screen", () => {
    expect(
      shouldOfferDraft({
        ...base,
        draft: draft(),
        currentSig: draftSig([], null),
      })
    ).toBe(true);
  });

  it("offers nothing when there is no draft", () => {
    expect(
      shouldOfferDraft({ ...base, draft: null, currentSig: draftSig([], null) })
    ).toBe(false);
  });

  it("stays quiet when the draft is what is already on screen", () => {
    const d = draft();
    expect(
      shouldOfferDraft({
        ...base,
        draft: d,
        currentSig: draftSig(d.fields, d.extra),
      })
    ).toBe(false);
  });

  it("refuses a draft belonging to another profile even if it was handed over", () => {
    expect(
      shouldOfferDraft({
        ...base,
        profileId: 2,
        draft: draft(),
        currentSig: draftSig([], null),
      })
    ).toBe(false);
  });

  it("refuses a create-form draft on the edit form of a record (no duplicate restore)", () => {
    expect(
      shouldOfferDraft({
        ...base,
        recordId: 42,
        draft: draft(),
        currentSig: draftSig([], null),
      })
    ).toBe(false);
  });
});

describe("the merge/refuse rule", () => {
  it("flags a resume that would replace input the user has already typed", () => {
    expect(
      draftConflictsWithInput({
        currentSig: draftSig([["name", "Magnesium"]], null),
        initialSig: draftSig([["name", ""]], null),
      })
    ).toBe(true);
  });

  it("does not flag a form still sitting on its seed", () => {
    const seed = draftSig([["name", ""]], null);
    expect(
      draftConflictsWithInput({ currentSig: seed, initialSig: seed })
    ).toBe(false);
  });

  it("still OFFERS over a touched form — hiding recoverable work would be worse", () => {
    expect(
      shouldOfferDraft({
        draft: draft(),
        profileId: 1,
        formKey: "supplement",
        recordId: null,
        currentSig: draftSig([["name", "Magnesium"]], null),
        now: NOW,
      })
    ).toBe(true);
  });
});

describe("shouldPersistDraft", () => {
  it("writes nothing for a form still on its seed", () => {
    const seed = draftSig([["name", ""]], null);
    expect(shouldPersistDraft({ currentSig: seed, initialSig: seed })).toBe(
      false
    );
  });

  it("writes once the form has moved", () => {
    expect(
      shouldPersistDraft({
        currentSig: draftSig([["name", "Zinc"]], null),
        initialSig: draftSig([["name", ""]], null),
      })
    ).toBe(true);
  });

  it("treats `extra` state as content too (a dose row added, no field typed)", () => {
    expect(
      shouldPersistDraft({
        currentSig: draftSig([], { doses: [{ amount: "5 mg" }] }),
        initialSig: draftSig([], { doses: [{ amount: "" }] }),
      })
    ).toBe(true);
  });
});

describe("fieldMultimap", () => {
  it("groups repeated names in document order", () => {
    expect(
      fieldMultimap([
        ["weekday", "1"],
        ["name", "Zinc"],
        ["weekday", "3"],
      ])
    ).toEqual(
      new Map([
        ["weekday", ["1", "3"]],
        ["name", ["Zinc"]],
      ])
    );
  });
});

describe("draftAgeLabel", () => {
  it("reads as relative time, through the app's one relative-time formatter", () => {
    expect(draftAgeLabel(NOW - 12 * 60_000, NOW)).toBe("12 minutes ago");
    expect(draftAgeLabel(NOW - 5_000, NOW)).toBe("just now");
    expect(draftAgeLabel(NOW - 3 * 24 * 60 * 60 * 1000, NOW)).toBe(
      "3 days ago"
    );
  });
});

describe("unsaved-work registry (#1700 reads what #1699 writes)", () => {
  it("tracks per-form keys and reports the aggregate", () => {
    resetUnsavedWork();
    expect(hasUnsavedWork()).toBe(false);
    markUnsavedWork("1:activity:new", true);
    markUnsavedWork("1:supplement:new", true);
    expect(hasUnsavedWork()).toBe(true);
    markUnsavedWork("1:activity:new", false);
    expect(hasUnsavedWork()).toBe(true); // the supplement form is still dirty
    markUnsavedWork("1:supplement:new", false);
    expect(hasUnsavedWork()).toBe(false);
  });

  it("notifies subscribers only on a real transition", () => {
    resetUnsavedWork();
    const seen: boolean[] = [];
    const off = subscribeUnsavedWork((d) => seen.push(d));
    markUnsavedWork("1:activity:new", true);
    markUnsavedWork("1:activity:new", true); // no-op
    markUnsavedWork("1:activity:new", false);
    off();
    markUnsavedWork("1:activity:new", true); // nobody listening
    expect(seen).toEqual([true, false]);
    resetUnsavedWork();
  });

  it("holds no content — only keys", () => {
    resetUnsavedWork();
    markUnsavedWork(
      draftKey({ profileId: 1, formKey: "activity", recordId: 9 }),
      true
    );
    expect(hasUnsavedWork()).toBe(true);
    resetUnsavedWork();
  });
});

// ── ONE LIVE EDITOR OWES THIS REGISTRY EXACTLY ONE KEY (#3443) ───────────────
//
// The registry is keyed, and `components/useFormDraft.ts` re-keys a create form onto
// the row its auto-save produced — `ActivityForm` passes
// `recordId: editData?.id ?? createdId`, so this is reached on every activity create.
// What made it a defect is that the hook's three release paths (`clear`, `discard`,
// the unmount cleanup) all release `keyRef.current`, which by then is the NEW key: the
// old one had no owner left.
//
// These two tests state what that costs, at the registry, in the terms the hook has to
// honour. They are the CONTRACT, not a guard on the hook — `vitest.config.ts` includes
// `lib/**/*.test.ts` only, so `components/**` has no unit tier at all.
//
// NOTHING IN THE TREE GUARDS THAT ONE LINE, and it is worth knowing which way round
// that is. Deleting the hook's `markUnsavedWork(prev, false)` and rebuilding leaves
// both of these green (they drive the registry directly) AND leaves
// `e2e/update-notice.spec.ts`'s #3443 case green (measured 2026-08-22): on the shipped
// activity path `ActivityForm`'s `savedAt > 0 && !dirty` → `clear()` releases the
// create key ~1 ms before the re-key effect runs, so the two-key state these tests
// describe is not one the browser reaches. They document what the registry owes a
// re-keying caller; they are not evidence that a caller strands a key today.
describe("a re-keyed editor and the unsaved-work registry (#3443)", () => {
  const CREATE_KEY = draftKey({
    profileId: 1,
    formKey: "activity",
    recordId: null,
  });
  const ROW_KEY = draftKey({ profileId: 1, formKey: "activity", recordId: 5 });

  // ONE editor mount registers ONE capture callback under whatever key it currently
  // holds: `entryRef` is created once per mount and never reassigned (see the note on
  // `syncUnsavedWork`), so a stranded key hands back a SECOND pointer from the same
  // form rather than from a second form.
  function oneEditor() {
    let calls = 0;
    const entry = {
      capture: async (): Promise<ResumePointer> => {
        calls += 1;
        return { formKey: "activity", recordId: 5, live: false };
      },
    };
    return { entry, captures: () => calls };
  }

  it("leaving the old key behind keeps hasUnsavedWork() true after the editor closes", () => {
    resetUnsavedWork();
    const { entry } = oneEditor();

    // Typing marks the create key (since #3371 this happens per keystroke, not after
    // the 600ms debounce).
    markUnsavedWork(CREATE_KEY, true, entry);

    // The auto-save returns an id and the form re-keys. RELEASING THE OLD KEY IS THE
    // FIX: drop this line and every assertion below still describes a closed editor
    // the registry insists is mid-composition.
    markUnsavedWork(CREATE_KEY, false);
    markUnsavedWork(ROW_KEY, true, entry);

    // The editor closes — `clear()` and the unmount cleanup both release the key the
    // hook is holding NOW, which is the row key.
    markUnsavedWork(ROW_KEY, false);

    expect(hasUnsavedWork()).toBe(false);
    resetUnsavedWork();
  });

  it("hands back a resume pointer only while the re-key left one key standing", async () => {
    resetUnsavedWork();
    const { entry, captures } = oneEditor();

    // The stranded state: one editor, two keys, one capture callback under both.
    markUnsavedWork(CREATE_KEY, true, entry);
    markUnsavedWork(ROW_KEY, true, entry);
    const stranded = await captureUnsavedWork();
    expect(captures()).toBe(2);
    // `captureUnsavedWork` returns a pointer only when EXACTLY ONE form asked for one,
    // so one editor counted twice suppresses #2471's reopen-after-reload outright.
    expect(stranded).toEqual({ ok: true, resume: null });

    // The re-key done properly: the same editor, one key.
    resetUnsavedWork();
    const { entry: entry2, captures: captures2 } = oneEditor();
    markUnsavedWork(CREATE_KEY, true, entry2);
    markUnsavedWork(CREATE_KEY, false);
    markUnsavedWork(ROW_KEY, true, entry2);
    const moved = await captureUnsavedWork();
    expect(captures2()).toBe(1);
    expect(moved).toEqual({
      ok: true,
      resume: { formKey: "activity", recordId: 5, live: false },
    });
    resetUnsavedWork();
  });
});
