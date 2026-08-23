import { describe, it, expect } from "vitest";
import {
  DATE_COLUMNS,
  TRASH_EXCLUDED_KIND,
  parseSqliteUtc,
  trashEntry,
  trashEntryCopy,
  trashEntryHeadline,
  type TrashCapture,
} from "@/lib/trash";
import { UNDO_KINDS, serializePayload } from "@/lib/undo-delete";
import { machineDateHits } from "@/lib/machine-date-census";
import { DEFAULT_FORMAT_PREFS, formatDateWithYear } from "@/lib/format-date";
import { BULK_CORRECTION_KIND } from "@/lib/bulk-correction";

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
      rooted("clinical-observation", "record", {
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
  // The date the surface hands in is ALREADY through the display boundary — the
  // headline never sees `entry.date` (#3491 item 3). These labels are what
  // formatDateWithYear emits under the default prefs.
  const head = (over: Partial<TrashCapture>, dateLabel: string | null) =>
    trashEntryHeadline(trashEntry(capture(over), 30, NOW), dateLabel);

  it("leads with the identifying content when the capture has any", () => {
    expect(head({}, "Aug 1, 2026")).toBe("Evening walk · Aug 1, 2026");
  });

  it("falls back to the non-PHI kind label plus the date", () => {
    expect(
      head(
        {
          kind: "body-metric",
          label: "body metric",
          payload: serializePayload("body-metric", {
            metric: [{ id: 5, date: "2026-07-30" }],
          }),
        },
        "Jul 30, 2026"
      )
    ).toBe("body metric · Jul 30, 2026");
  });

  it("falls back to the label alone when nothing could be derived", () => {
    expect(head({ payload: "{not json" }, null)).toBe("activity");
  });

  it("drops the date half when the caller has no display label for it", () => {
    // The honest reading of "we have no formatted date": say less, never reach
    // past the boundary for the storage value.
    expect(head({}, null)).toBe("Evening walk");
  });
});

// ── THE PAIR (#3491 item 2) ───────────────────────────────────────────────────
//
// The headline and the subtitle are one derivation because they OVERLAP. Testing
// either alone is what let the surface state a capture's kind twice: each line was
// individually correct, and only the pair was wrong.
describe("trashEntryCopy — the headline and subtitle derived together", () => {
  const LABELS = { date: "Aug 1, 2026", deletedOn: "Aug 4, 2026" };
  const copy = (
    over: Partial<TrashCapture> = {},
    dates: { date: string | null; deletedOn: string } = LABELS
  ) => trashEntryCopy(trashEntry(capture(over), 30, NOW), dates);

  // An untitled capture: the payload has a date but no human title, so the
  // headline's fallback branch leads with the kind label.
  const UNTITLED: Partial<TrashCapture> = {
    kind: "body-metric",
    label: "body metric",
    payload: serializePayload("body-metric", {
      metric: [{ id: 5, date: "2026-07-30" }],
    }),
  };

  it("states an untitled capture's kind EXACTLY ONCE across the two lines", () => {
    const { headline, subtitle } = copy(UNTITLED, {
      date: "Jul 30, 2026",
      deletedOn: "Aug 4, 2026",
    });
    expect(headline).toBe("body metric · Jul 30, 2026");
    // The whole defect in one assertion: count the label over BOTH lines, because
    // one line at a time is how it shipped.
    const both = `${headline}\n${subtitle}`;
    expect(both.split("body metric").length - 1).toBe(1);
    expect(subtitle).toBe("Deleted Aug 4, 2026 · Expires in 29 days");
  });

  it("keeps the kind in the subtitle when the headline led with a title instead", () => {
    const { headline, subtitle } = copy();
    expect(headline).toBe("Evening walk · Aug 1, 2026");
    // The headline says nothing about WHAT was deleted, so the subtitle must.
    expect(subtitle).toBe(
      "activity · 2 related rows · Deleted Aug 4, 2026 · Expires in 29 days"
    );
    expect(`${headline}\n${subtitle}`.split("activity").length - 1).toBe(1);
  });

  it("states the kind once even when there is no date at all", () => {
    const { headline, subtitle } = copy(
      { payload: "{not json" },
      { date: null, deletedOn: "Aug 4, 2026" }
    );
    expect(headline).toBe("activity");
    expect(subtitle).toBe("Deleted Aug 4, 2026 · Expires in 29 days");
    expect(`${headline}\n${subtitle}`.split("activity").length - 1).toBe(1);
  });

  it("counts the cascade only when there is one", () => {
    const { subtitle } = copy({
      payload: serializePayload("activity", {
        activity: [
          { id: 41, profile_id: 1, date: "2026-08-01", title: "Solo" },
        ],
      }),
    });
    expect(subtitle).toBe(
      "activity · Deleted Aug 4, 2026 · Expires in 29 days"
    );
  });

  // ── THE DISPLAY BOUNDARY, ASKED WITH #3492's OWN RULE (#3491 item 3) ─────────
  //
  // Not a second matcher: `machineDateHits` is the shared rule from
  // lib/machine-date-census.ts, the same one e2e/machine-date-census.spec.ts runs
  // over rendered text nodes. Here it is asked of the copy at its SOURCE, where a
  // storage date could only get in by this module reaching past its parameters.
  it("cannot state a machine date, even though every input it is given is one", () => {
    const entry = trashEntry(capture(UNTITLED), 30, NOW);
    // The inputs really are storage dates — otherwise this proves nothing.
    expect(machineDateHits(entry.date ?? "")).toEqual(["2026-07-30"]);
    expect(machineDateHits(entry.deletedAt)).toEqual(["2026-08-04"]);

    const { headline, subtitle } = trashEntryCopy(entry, {
      date: formatDateWithYear(entry.date ?? "", DEFAULT_FORMAT_PREFS),
      deletedOn: formatDateWithYear(
        entry.deletedAt.slice(0, 10),
        DEFAULT_FORMAT_PREFS
      ),
    });
    expect(
      machineDateHits(`${headline}\n${subtitle}`),
      "a Trash row states a storage-format date. Both dates cross the display " +
        "boundary at the surface (lib/format-date, via useFormatPrefs) and " +
        "lib/trash.ts takes only the formatted labels — see #3492."
    ).toEqual([]);
  });

  // THE HOLE THE CENSUS FOUND, and it was found by a SHARD RE-PARTITION rather
  // than by anyone reading this file (#3495's PR, which added a spec and moved
  // e2e/intake-lifecycle.spec.ts into e2e/machine-date-census.spec.ts's shard).
  //
  // `DATE_COLUMNS` falls through to `recorded_at` / `created_at`, and SQLite writes
  // those as "YYYY-MM-DD HH:MM:SS". A capture whose root carries only one of them
  // handed a TIMESTAMP to `TrashEntry.date`, which is documented as a day — and
  // `formatDateWithYear` returns a value it cannot parse UNCHANGED, so the row read
  // "E2E Restore Fish Oil · 2026-08-22 14:03:55" on the real page. The assertion
  // above could not see it: its fixture's root carries a plain `date` column, so the
  // fall-through was never exercised.
  it("takes the calendar DAY off a captured timestamp column (#3492)", () => {
    const entry = trashEntry(
      capture({
        // The real shape, not an invented one: `intake_items` has no date column at
        // all, so DATE_COLUMNS reaches its LAST fallback — `created_at`, declared
        // `DEFAULT (datetime('now'))` in migration 124.
        kind: "intake-item",
        label: "supplement",
        payload: serializePayload("intake-item", {
          item: [
            {
              id: 77,
              profile_id: 1,
              name: "Fish Oil",
              created_at: "2026-08-22 14:03:55",
            },
          ],
        }),
      }),
      30,
      NOW
    );
    expect(
      entry.date,
      "TrashEntry.date is a storage DAY; a timestamp reaching it is a machine " +
        "date one `formatDateWithYear` away from the screen"
    ).toBe("2026-08-22");
    const { headline } = trashEntryCopy(entry, {
      date: formatDateWithYear(entry.date ?? "", DEFAULT_FORMAT_PREFS),
      deletedOn: formatDateWithYear(
        entry.deletedAt.slice(0, 10),
        DEFAULT_FORMAT_PREFS
      ),
    });
    expect(headline).toBe("Fish Oil · Aug 22, 2026");
    expect(machineDateHits(headline)).toEqual([]);
  });

  it("passes a machine date straight through when one is handed in", () => {
    // The counter-proof: this module does not sanitize, it REFUSES to source. The
    // assertion above would be worth nothing if the pair scrubbed dates on its own
    // — it would then be green no matter what the surface passed.
    const { headline } = copy(UNTITLED, {
      date: "2026-07-30",
      deletedOn: "Aug 4, 2026",
    });
    expect(machineDateHits(headline)).toEqual(["2026-07-30"]);
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

// THE CENSUS OVER `UNDO_KINDS` × `DATE_COLUMNS` (#3495's review of the #3492 fix).
//
// WHY A CENSUS AND NOT ONE MORE FIXTURE. The `intake-item` case above is the bug that
// was found — and it was found by a shard re-partition, not by anyone reading this
// file. The reason it could hide is structural: the fixture that was supposed to
// cover `TrashEntry.date` carried a plain `date` column, so the `recorded_at` /
// `created_at` fall-through was never exercised by anything. `calendarDay` is generic,
// so today all three fall-through roots (`intake_items`, `cycles`,
// `frequency_targets`) are covered BY CONSTRUCTION — but "by construction" is a claim
// about the code as it stands, and reverting `calendarDay` reds exactly one test out
// of the whole pure tier. That is the same shape of coverage the hole had.
//
// So this walks the registry itself: every undoable kind, through every column
// `DATE_COLUMNS` will read, in every spelling the storage layer produces. A kind added
// to `UNDO_KINDS` tomorrow is in the census the day it lands, without anyone
// remembering to add a fixture.
//
// AND IT ASSERTS BOTH DIRECTIONS, because only one of them is about today's schema.
// The reducible half says a date this module CAN vouch for arrives as a day. The
// refused half is the one that keeps the class closed: a future root storing
// `2026/08/22`, an epoch string, or a bare `2026-08` must reach `TrashEntry.date` as
// NULL rather than be forwarded to `formatDateWithYear`, which returns what it cannot
// parse unchanged and puts it on the screen. That is how #3492 happened, one spelling
// over.
describe("TrashEntry.date over UNDO_KINDS × DATE_COLUMNS (#3492)", () => {
  const DAY = "2026-08-22";

  // The spellings the storage layer actually produces, and where each comes from.
  // Written as literals rather than derived from anything under test.
  const REDUCIBLE = [
    {
      stored: DAY,
      from: "a clinical day column (activities.date, conditions.onset_date)",
    },
    {
      stored: `${DAY} 14:03:55`,
      from: "SQLite datetime('now') — recorded_at / created_at",
    },
    { stored: `${DAY}T14:03:55Z`, from: "an ISO instant" },
    {
      stored: `${DAY}T14:03:55.000Z`,
      from: "an ISO instant with milliseconds",
    },
  ];

  // Shapes NO root stores today. That is exactly why they are here: a census over
  // what the schema currently holds can only ever re-prove the present.
  const REFUSED = [
    "1755878635",
    "2026/08/22",
    "22-08-2026",
    "2026-08",
    "August 22, 2026",
  ];

  const KINDS = Object.keys(UNDO_KINDS);

  function entryFor(kind: string, column: string, stored: string) {
    const rootEntity = UNDO_KINDS[kind].entities[0].entity;
    return trashEntry(
      capture({
        kind,
        label: kind,
        payload: serializePayload(kind, {
          [rootEntity]: [{ id: 1, profile_id: 1, [column]: stored }],
        }),
      }),
      30,
      NOW
    );
  }

  function headlineOf(entry: ReturnType<typeof trashEntry>): string {
    return trashEntryCopy(entry, {
      date: entry.date
        ? formatDateWithYear(entry.date, DEFAULT_FORMAT_PREFS)
        : null,
      deletedOn: formatDateWithYear(
        entry.deletedAt.slice(0, 10),
        DEFAULT_FORMAT_PREFS
      ),
    }).headline;
  }

  // THE CORPUS FLOOR. An empty registry or an empty column list would make every
  // verdict below an absence over nothing (#3509's shape).
  it("walks a registry and a column list that are actually there", () => {
    expect(
      KINDS.length,
      "UNDO_KINDS is empty — the census below asserts nothing"
    ).toBeGreaterThan(10);
    expect(DATE_COLUMNS.length).toBeGreaterThanOrEqual(5);
    expect([...DATE_COLUMNS]).toContain("created_at");
  });

  it("hands every kind a DAY, through every date column, in every stored spelling", () => {
    const wrong: string[] = [];
    for (const kind of KINDS)
      for (const column of DATE_COLUMNS)
        for (const { stored, from } of REDUCIBLE) {
          const entry = entryFor(kind, column, stored);
          if (entry.date !== DAY)
            wrong.push(
              `${kind}.${column} = "${stored}" (${from}) → ${entry.date}`
            );
          const hits = machineDateHits(headlineOf(entry));
          if (hits.length > 0)
            wrong.push(
              `${kind}.${column} = "${stored}" put ${hits.join(", ")} in the headline`
            );
        }
    expect(
      wrong,
      "TrashEntry.date is documented as a storage DAY. A kind whose root reaches a " +
        "timestamp column hands the timestamp on, and formatDateWithYear returns " +
        "what it cannot parse UNCHANGED — which is a machine date on the Trash row."
    ).toEqual([]);
  });

  it("refuses a shape it cannot vouch for rather than forwarding it to the screen", () => {
    const forwarded: string[] = [];
    for (const kind of KINDS)
      for (const column of DATE_COLUMNS)
        for (const stored of REFUSED) {
          const entry = entryFor(kind, column, stored);
          if (entry.date !== null)
            forwarded.push(`${kind}.${column} = "${stored}" → ${entry.date}`);
          if (headlineOf(entry).includes(stored))
            forwarded.push(
              `${kind}.${column} = "${stored}" reached the headline verbatim`
            );
        }
    expect(
      forwarded,
      "a date column holding a spelling this module cannot reduce to a day was " +
        "forwarded instead of refused. `formatDateWithYear` passes an unparseable " +
        "value straight through, so forwarding it IS #3492: a machine date in " +
        "rendered copy. No date at all is the honest reading."
    ).toEqual([]);
  });
});
