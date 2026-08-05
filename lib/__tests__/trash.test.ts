import { describe, it, expect } from "vitest";
import {
  TRASH_EXCLUDED_KIND,
  parseSqliteUtc,
  trashEntry,
  trashEntryHeadline,
  type TrashCapture,
} from "@/lib/trash";
import { BULK_CORRECTION_KIND } from "@/lib/bulk-correction";
import { serializePayload } from "@/lib/undo-delete";

// Pure Trash read model (issue #2013). The DB list and the purges are covered in the
// DB tier (lib/__db_tests__/trash.test.ts); this file owns the derivation that turns
// one holding row into something a person can CHOOSE from — which is the whole reason
// the feature is more than a row count.

const NOW = new Date("2026-08-05T12:00:00.000Z");

function capture(over: Partial<TrashCapture> = {}): TrashCapture {
  return {
    id: 7,
    kind: "activity",
    label: "activity",
    payload: serializePayload("activity", {
      activity: [
        {
          id: 41,
          profile_id: 1,
          date: "2026-08-01",
          title: "Evening walk",
          notes: "felt easy",
        },
      ],
      sets: [
        { id: 90, activity_id: 41, exercise: "Squat", set_number: 1 },
        { id: 91, activity_id: 41, exercise: "Squat", set_number: 2 },
      ],
    }),
    deletedAt: "2026-08-04 09:30:00",
    ...over,
  };
}

describe("trashEntry derivation", () => {
  it("reads the identifying content out of the captured ROOT row", () => {
    const e = trashEntry(capture(), 30, NOW);
    // The label column alone would say "activity" for every one of them; the payload
    // is what makes two deleted walks distinguishable.
    expect(e.title).toBe("Evening walk");
    expect(e.date).toBe("2026-08-01");
    expect(e.notes).toBe("felt easy");
    expect(e.label).toBe("activity");
  });

  it("counts captured children so Restore visibly means the whole cascade", () => {
    expect(trashEntry(capture(), 30, NOW).childCount).toBe(2);
  });

  it("carries the HOLDING row id, never the deleted row's (restore mints a new one)", () => {
    const e = trashEntry(capture(), 30, NOW);
    expect(e.id).toBe(7);
    expect(e.id).not.toBe(41);
  });

  it("falls back to the raw kind when the label column is blank", () => {
    expect(trashEntry(capture({ label: null }), 30, NOW).label).toBe(
      "activity"
    );
    expect(trashEntry(capture({ label: "  " }), 30, NOW).label).toBe(
      "activity"
    );
  });

  it("derives a title for each registry root's own title column", () => {
    const rooted = (
      kind: string,
      entity: string,
      row: Record<string, unknown>
    ) =>
      trashEntry(
        capture({
          kind,
          label: kind,
          payload: serializePayload(kind, { [entity]: [row] }),
        }),
        30,
        NOW
      );

    expect(
      rooted("biomarker-record", "record", {
        id: 1,
        date: "2026-05-02",
        name: "Ferritin",
      }).title
    ).toBe("Ferritin");
    expect(
      rooted("practice-session", "session", {
        id: 2,
        date: "2026-05-03",
        practice: "Meditation",
      }).title
    ).toBe("Meditation");
    expect(
      rooted("substance-history", "entry", {
        id: 3,
        date: "2026-05-04",
        substance: "nicotine",
      }).title
    ).toBe("nicotine");
    expect(
      rooted("food-serving", "event", {
        id: 4,
        date: "2026-05-05",
        group_key: "vegetables",
      }).title
    ).toBe("vegetables");
  });

  it("leaves the title null for a root with no human title, keeping the date", () => {
    // body_metrics is a date and some numbers; its own surfaces read the same way.
    const e = trashEntry(
      capture({
        kind: "body-metric",
        label: "body metric",
        payload: serializePayload("body-metric", {
          metric: [{ id: 5, date: "2026-07-30", weight_kg: 71.2 }],
        }),
      }),
      30,
      NOW
    );
    expect(e.title).toBeNull();
    expect(e.date).toBe("2026-07-30");
  });
});

describe("trashEntry expiry math", () => {
  it("expires one retention window after the delete", () => {
    const e = trashEntry(capture(), 30, NOW);
    expect(e.expiresAt).toBe("2026-09-03 09:30:00");
    // Deleted 2026-08-04 09:30Z, now 2026-08-05 12:00Z → 28.9 days left, ceiled.
    expect(e.expiresInDays).toBe(29);
  });

  it("tracks a shorter configured window", () => {
    expect(trashEntry(capture(), 1, NOW).expiresInDays).toBe(0);
    expect(trashEntry(capture(), 7, NOW).expiresInDays).toBe(6);
  });

  it("never reports a negative remainder for a capture the tick hasn't reached", () => {
    // The sweep runs hourly, so an expired capture is visible for up to an hour. It
    // reads as "expires today", not "expires in -3 days".
    const e = trashEntry(
      capture({ deletedAt: "2026-06-01 00:00:00" }),
      30,
      NOW
    );
    expect(e.expiresInDays).toBe(0);
  });

  it("reads deleted_at as UTC, not as local time", () => {
    // SQLite writes datetime('now') with no zone marker; Date.parse would read the
    // bare form as local and shift every expiry by the host's offset.
    expect(parseSqliteUtc("2026-08-04 09:30:00").toISOString()).toBe(
      "2026-08-04T09:30:00.000Z"
    );
  });
});

describe("trashEntry on payloads it cannot fully read", () => {
  it("degrades an off-registry capture to its label instead of throwing", () => {
    // The bespoke `administration` capture (#851 item 11) is a real, restorable
    // holding row whose payload is not a registry payload. A Trash that threw on it
    // would hide a row the user can still restore.
    const e = trashEntry(
      capture({
        kind: "administration",
        label: "administration",
        payload: JSON.stringify({
          v: 1,
          kind: "administration",
          rows: { log: [{ id: 12, dose_id: 3, date: "2026-08-02" }] },
        }),
      }),
      30,
      NOW
    );
    expect(e.label).toBe("administration");
    expect(e.date).toBe("2026-08-02");
    expect(e.childCount).toBe(0);
  });

  it("degrades unparseable JSON to the label with no derived content", () => {
    const e = trashEntry(capture({ payload: "{not json" }), 30, NOW);
    expect(e.title).toBeNull();
    expect(e.date).toBeNull();
    expect(e.notes).toBeNull();
    expect(e.childCount).toBe(0);
    expect(e.label).toBe("activity");
  });
});

describe("trashEntryHeadline", () => {
  const head = (over: Partial<TrashCapture>) =>
    trashEntryHeadline(trashEntry(capture(over), 30, NOW));

  it("leads with the identifying content when the capture has any", () => {
    expect(head({})).toBe("Evening walk · 2026-08-01");
  });

  it("falls back to the non-PHI kind label plus the date", () => {
    expect(
      head({
        kind: "body-metric",
        label: "body metric",
        payload: serializePayload("body-metric", {
          metric: [{ id: 5, date: "2026-07-30" }],
        }),
      })
    ).toBe("body metric · 2026-07-30");
  });

  it("falls back to the label alone when nothing could be derived", () => {
    expect(head({ payload: "{not json" })).toBe("activity");
  });
});

describe("TRASH_EXCLUDED_KIND", () => {
  it("is the bulk-correction kind — an inverted EDIT, not a deleted row", () => {
    // It shares deleted_rows to reuse the purge timer, but its undo is
    // undoBulkCorrection (guarded, partial, reported), not restoreDeletedRow — so
    // listing it would offer a Restore button that cannot work.
    expect(TRASH_EXCLUDED_KIND).toBe(BULK_CORRECTION_KIND);
  });
});
