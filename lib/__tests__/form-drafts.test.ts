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
  hasUnsavedWork,
  markUnsavedWork,
  resetUnsavedWork,
  subscribeUnsavedWork,
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
  it("shows a time for a draft from today", () => {
    const when = new Date(NOW);
    when.setHours(14, 32, 0, 0);
    expect(draftAgeLabel(when.getTime(), NOW)).toMatch(/\d{1,2}[:.]\d{2}/);
  });

  it("names the day for an older one", () => {
    const label = draftAgeLabel(NOW - 3 * 24 * 60 * 60 * 1000, NOW);
    expect(label).toMatch(/,/);
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
