// DB INTEGRATION TIER — the digest time suggestion end to end (#2217).
//
// The pure side (lib/__tests__/digest-time-suggestion.test.ts) proves the decision.
// This side proves the PATH: that the 13 measured nights, read through the real
// gather, raise the suggestion for a configured 07:00 Static digest; that its key is
// registered and guardable (#448); that the ONE resolver behind the Settings row is
// the same one the digest line reads, so a dismissal on either surface silences both;
// and that a ±5-minute drift in the statistic does not re-raise a dismissed episode.
//
// Only the raw Telegram transport is stubbed (the #454 guarded boundary), so the
// keyboard and the message body asserted here are the genuine rendered output.

import { vi, describe, it, expect } from "vitest";

vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return {
    ...actual,
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageTextRaw: vi.fn(async () => {}),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
    sendMessageRaw: vi.fn(async () => 1),
  };
});

import { db, today } from "@/lib/db";
import { shiftDateStr, utcInstant, zonedWallTimeToUtc } from "@/lib/date";
import {
  getNotifySchedule,
  getProfileSetting,
  setProfileSetting,
  setSetting,
  setTimezone,
} from "@/lib/settings";
import { DIGEST_MODE_KEY } from "@/lib/settings/notifications";
import { buildDigest } from "@/lib/notifications/digest";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { getDigestTimeSuggestion } from "@/lib/queries/digest-time-suggestion";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  answerCallbackQuery,
  editMessageReplyMarkupRaw,
  sendMessageRaw,
} from "@/lib/notifications/telegram-api";
import { arrivalStatistics } from "@/lib/notifications/digest-schedule";
import { getSleepArrivals } from "@/lib/queries/metrics";
import {
  digestTimeSuggestion,
  DIGEST_TIME_PREFIX,
  DIGEST_TIME_SECTION_HEADING,
  digestTimeDismissToken,
  digestTimeUseToken,
} from "@/lib/digest-time-suggestion";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { resolveSuppressedKeyDisplay } from "@/lib/suppression-display";
import { seedLoginTelegram } from "./fixtures";

const editKeyboardMock = vi.mocked(editMessageReplyMarkupRaw);
const answerMock = vi.mocked(answerCallbackQuery);
const sendMock = vi.mocked(sendMessageRaw);

const PROVIDER = "health-connect";
const TZ = "UTC";
const FLOOR = 7 * 60;

const clock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// #2217's measured 13 nights, profile 1, 2026-08-06: the clock time last night's row
// landed at, and how far behind the session's end that was. 7 of 13 land after 07:00.
const MEASURED: { date: string; arrival: number; lag: number }[] = [
  { date: "2026-07-24", arrival: 6 * 60 + 2, lag: 30 },
  { date: "2026-07-25", arrival: 6 * 60 + 6, lag: 35 },
  { date: "2026-07-26", arrival: 6 * 60 + 14, lag: 40 },
  { date: "2026-07-27", arrival: 6 * 60 + 26, lag: 45 },
  { date: "2026-07-28", arrival: 6 * 60 + 47, lag: 64 },
  { date: "2026-07-29", arrival: 6 * 60 + 50, lag: 55 },
  { date: "2026-07-30", arrival: 7 * 60 + 4, lag: 86 },
  { date: "2026-07-31", arrival: 7 * 60 + 11, lag: 86 },
  { date: "2026-08-01", arrival: 7 * 60 + 26, lag: 105 },
  { date: "2026-08-02", arrival: 7 * 60 + 26, lag: 80 },
  { date: "2026-08-03", arrival: 7 * 60 + 30, lag: 70 },
  { date: "2026-08-04", arrival: 7 * 60 + 42, lag: 65 },
  { date: "2026-08-05", arrival: 7 * 60 + 48, lag: 50 },
];

let seq = 0;

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`${name}${++seq}`)
      .lastInsertRowid
  );
  setTimezone(id, TZ);
  return id;
}

/** A synced overnight session ending `lagMin` before its provenance row landed. */
function night(
  profileId: number,
  date: string,
  arrivalMinute: number,
  lagMin: number,
  minutes = 420
): void {
  // The helper builds the clock itself, so it always resolves (#2245 made
  // zonedWallTimeToUtc refuse a malformed one).
  const arrivedAt = zonedWallTimeToUtc(TZ, date, clock(arrivalMinute))!;
  const end = new Date(arrivedAt.getTime() - lagMin * 60_000);
  const start = new Date(end.getTime() - minutes * 60_000);
  const sampleId = Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, start_time, end_time, value)
         VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, ?)`
      )
      .run(
        profileId,
        PROVIDER,
        date,
        utcInstant(start),
        utcInstant(end),
        minutes
      ).lastInsertRowid
  );
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
         VALUES (?, ?, ?, 1, 1)`
      )
      .run(profileId, PROVIDER, utcInstant(arrivedAt)).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO integration_sync_rows
       (event_id, target_table, target_id, disposition, created_at)
     VALUES (?, 'metric_samples', ?, 'inserted', ?)`
  ).run(eventId, sampleId, utcInstant(arrivedAt));
}

/**
 * The measured profile: the 13 arrival-carrying nights, a configured 07:00 digest in
 * `mode`, and one ordinary yesterday so the digest has content of its own to sit
 * above the suggestion's line.
 */
function seedProfile(
  name: string,
  mode: "static" | "dynamic" = "static",
  tickMinutes = 5
): number {
  setSetting("notify_tick_interval_min", String(tickMinutes));
  const p = newProfile(name);
  for (const n of MEASURED) night(p, n.date, n.arrival, n.lag);
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, 'strength', 'Session', 45)`
  ).run(p, shiftDateStr(today(p), -1));
  setProfileSetting(p, "notify_digest_hour", clock(FLOOR));
  setProfileSetting(p, DIGEST_MODE_KEY, mode);
  return p;
}

function digestLines(profileId: number, name = "Fixture Fiona"): string[] {
  const model = buildDigest(gatherDigestInput(profileId, name));
  return (model?.sections ?? []).flatMap((s) => s.lines);
}

function cq(chatId: string, data: string) {
  return {
    id: `cq-${data}`,
    data,
    message: {
      chat: { id: Number(chatId) },
      message_id: 7373,
      text: "☀️ Morning digest",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🕘 Use 07:40", callback_data: data }],
          [{ text: "keep me", callback_data: "offer:1:x" }],
        ],
      },
    },
  };
}

describe("the 13-night fixture raises the suggestion (#2217)", () => {
  it("fires for a 07:00 Static digest and proposes the grid-snapped p90", () => {
    const p = seedProfile("Static Sam");
    const s = getDigestTimeSuggestion(p);
    expect(s).not.toBeNull();
    // The MEDIAN fired it; the P90 is what it proposes. Two statistics, one sample.
    expect(s!.medianMinute).toBe(7 * 60 + 4);
    expect(s!.p90Minute).toBe(7 * 60 + 40);
    expect(s!.proposedMinute).toBe(7 * 60 + 40);
    expect(s!.nights).toBe(13);
  });

  it("proposes 07:45 on the 15-minute sidecar cadence", () => {
    const p = seedProfile("Quarter Hour Quinn", "static", 15);
    expect(getDigestTimeSuggestion(p)!.proposedMinute).toBe(7 * 60 + 45);
  });

  it("registers its dedupe-key prefix, in the COACHING tier (#448/#449)", () => {
    const p = seedProfile("Registered Rhea");
    const key = getDigestTimeSuggestion(p)!.dedupeKey;
    expect(key.startsWith(DIGEST_TIME_PREFIX)).toBe(true);
    expect(dedupeKeyHasKnownPrefix(key)).toBe(true);
    expect(tierForDedupeKey(key)).toBe("coaching");
    // And a dismissal under it is nameable in Upcoming's "Snoozed & dismissed",
    // so declining never leaves an unrestorable orphan row.
    expect(resolveSuppressedKeyDisplay(key)).toEqual({
      domain: "Coaching",
      label: "Digest time suggestion — 07:00 → 07:40",
    });
  });

  it("is SILENT in Dynamic mode on the very same distribution", () => {
    const p = seedProfile("Dynamic Dana", "dynamic");
    expect(getDigestTimeSuggestion(p)).toBeNull();
    expect(digestLines(p).join("\n")).not.toContain("usually lands by");
  });

  it("is silent for a digest that is off, and for a time that already wins", () => {
    const off = seedProfile("Off Odell");
    setProfileSetting(off, "notify_digest_hour", "");
    expect(getDigestTimeSuggestion(off)).toBeNull();

    const late = seedProfile("Late Lior");
    setProfileSetting(late, "notify_digest_hour", "08:00");
    expect(getDigestTimeSuggestion(late)).toBeNull();
  });

  it("is silent for a profile with no measured arrivals at all", () => {
    setSetting("notify_tick_interval_min", "5");
    const p = newProfile("Bare Bo");
    setProfileSetting(p, "notify_digest_hour", clock(FLOOR));
    setProfileSetting(p, DIGEST_MODE_KEY, "static");
    expect(getDigestTimeSuggestion(p)).toBeNull();
  });
});

describe("the in-digest line (owner decision, 2026-08-06)", () => {
  it("appears only while the suggestion is firing, and BELOW the content", () => {
    const p = seedProfile("Digest Dev");
    const model = buildDigest(gatherDigestInput(p, "Digest Dev"))!;
    const headings = model.sections.map((s) => s.heading);
    expect(headings).toContain(DIGEST_TIME_SECTION_HEADING);
    // Last section, and the only line in it: the digest is about the person's health
    // first, and when it arrives is a footnote to that.
    expect(headings.at(-1)).toBe(DIGEST_TIME_SECTION_HEADING);
    expect(headings.length).toBeGreaterThan(1);
    expect(model.sections.at(-1)!.lines).toEqual([
      "🕘 Last night’s sleep usually lands by 07:40. Your digest sends at 07:00, so it often goes out before the data arrives.",
    ]);
    // Its exits ride the keyboard, after everything else the message offers.
    expect(model.timeActions?.map((a) => a.label)).toEqual([
      "🕘 Use 07:40",
      "⏳ As soon as it’s ready",
      "🔕 Not now",
    ]);
  });

  it("is absent from a Dynamic profile's digest, keyboard included", () => {
    const p = seedProfile("Quiet Quin", "dynamic");
    const model = buildDigest(gatherDigestInput(p, "Quiet Quin"))!;
    expect(model.sections.map((s) => s.heading)).not.toContain(
      DIGEST_TIME_SECTION_HEADING
    );
    expect(model.timeActions).toEqual([]);
  });
});

describe("one finding, one episode key (constraint 5)", () => {
  it("declining from the MESSAGE clears the Settings row too", async () => {
    const p = seedProfile("Tapping Tao");
    const chat = `2217${p}`;
    seedLoginTelegram(p, chat);
    const td = today(p);
    expect(getDigestTimeSuggestion(p)).not.toBeNull();

    sendMock.mockClear();
    editKeyboardMock.mockClear();
    answerMock.mockClear();

    await handleCallbackQuery(cq(chat, digestTimeDismissToken(p, td)));

    // A decline is a keyboard edit and one suppression row — never a send.
    expect(sendMock).not.toHaveBeenCalled();
    // The SAME key silences both surfaces: the Settings resolver goes quiet…
    expect(getDigestTimeSuggestion(p)).toBeNull();
    // …and so does the digest's line, because both read the one resolver.
    expect(digestLines(p).join("\n")).not.toContain("usually lands by");
    // Nothing was written to the schedule by declining.
    expect(getNotifySchedule(p).digestMinute).toBe(FLOOR);
    expect(getNotifySchedule(p).digestMode).toBe("static");
  });

  it("a ±5-minute drift in the statistic does NOT re-raise a dismissed episode", async () => {
    const p = seedProfile("Steady Sloane");
    const chat = `2218${p}`;
    seedLoginTelegram(p, chat);
    await handleCallbackQuery(cq(chat, digestTimeDismissToken(p, today(p))));
    expect(getDigestTimeSuggestion(p)).toBeNull();

    // The tail moves later by five minutes — inside the ±11-minute leave-one-out
    // jitter #2214 measures. Someone who decided 07:00 is right for them keeps it.
    db.prepare(
      `DELETE FROM integration_sync_rows
        WHERE target_table = 'metric_samples'
          AND target_id IN (SELECT id FROM metric_samples WHERE profile_id = ?)`
    ).run(p);
    db.prepare("DELETE FROM integration_sync_events WHERE profile_id = ?").run(
      p
    );
    db.prepare("DELETE FROM metric_samples WHERE profile_id = ?").run(p);
    for (const n of MEASURED) night(p, n.date, n.arrival + 5, n.lag);

    // The STATISTIC genuinely moved — the raw decision would now propose 07:45…
    const drifted = digestTimeSuggestion({
      mode: "static",
      configuredMinute: FLOOR,
      stats: arrivalStatistics(getSleepArrivals(p)),
      tickMinutes: 5,
    });
    expect(drifted!.p90Minute).toBe(7 * 60 + 45);
    // …and the dismissal still holds, because the move is not MATERIAL.
    expect(getDigestTimeSuggestion(p)).toBeNull();
    expect(digestLines(p).join("\n")).not.toContain("usually lands by");
  });

  it("accepting from the message writes EXACTLY the time and nothing else", async () => {
    const p = seedProfile("Accepting Ari");
    const chat = `2219${p}`;
    seedLoginTelegram(p, chat);
    const before = getNotifySchedule(p);

    await handleCallbackQuery(cq(chat, digestTimeUseToken(p, today(p))));

    expect(getProfileSetting(p, "notify_digest_hour")).toBe("07:40");
    const after = getNotifySchedule(p);
    expect(after.digestMinute).toBe(7 * 60 + 40);
    // Every other field of the schedule is untouched — an accept is one write.
    expect({ ...after, digestMinute: before.digestMinute }).toEqual(before);
    // And it stops firing on its own: the configured time now clears the median.
    expect(getDigestTimeSuggestion(p)).toBeNull();
  });
});
