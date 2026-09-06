import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isRealIsoDate,
  parseDay,
  parseInstant,
  utcInstant,
  utcSqlString,
} from "@/lib/date";
import { shareLinkStatus } from "@/lib/share-links";
import {
  detectSleepClockSkew,
  type HrMinuteSample,
} from "@/lib/sleep-clock-skew";
import type { CanonicalInstant, LocalDay } from "@/lib/temporal-types";

// The clock seam (#5338): `parseInstant` and `parseDay` answer in UTC whatever zone
// the SERVER runs in. The second half of this file sets the process zone, which the
// isolation scan routes to the forks project — on a worker THREAD the assignment
// lands and V8's timezone cache never moves, so the same rows read three times under
// three zones is one pass three times (#5387). The positive control below is what
// proves the flip is real before any claim about the seam is made.

const NOON = Date.UTC(2026, 8, 5, 12);
const noon = new Date(NOON);
const day = (s: string): LocalDay => {
  if (!isRealIsoDate(s)) throw new Error(`not a day: ${s}`);
  return s;
};

function seamAnswersInUtc() {
  it.each([
    ["canonical", utcInstant(noon)],
    ["bare", utcSqlString(noon)],
  ])("parseInstant reads a %s instant as UTC", (_shape, stamp) => {
    expect(parseInstant(stamp)).toBe(NOON);
  });
  it("parseDay anchors a day at its UTC midnight", () => {
    expect(parseDay(day("2026-09-05"))).toBe(Date.UTC(2026, 8, 5));
  });
  it("is NaN on a corrupt value a row shape asserted, so guards stay fail-closed", () => {
    const row = { at: "garbage" } as { at: CanonicalInstant };
    expect(parseInstant(row.at)).toBeNaN();
  });
}

describe("the clock seam in the process's own zone", seamAnswersInUtc);

describe("the clock seam under TZ=America/New_York", () => {
  const prev = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/New_York";
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  });

  it("the flip is real: a zoneless stamp now reads four hours late", () => {
    // EDT is UTC−4 on 2026-09-05. If this reads 12:00Z the spec is on the threads
    // pool and every assertion below is vacuous.
    expect(new Date("2026-09-05T12:00:00").getTime()).toBe(
      NOON + 4 * 3_600_000
    );
  });

  seamAnswersInUtc();

  it("a bare-shaped share-link expiry does not outlive itself", () => {
    // TIME_COLUMNS declares the column bare; read server-local, 11:00 would be 15:00Z
    // and a link expired an hour ago would still open.
    const now = new Date("2026-07-06T12:00:00Z");
    expect(
      shareLinkStatus(
        { expires_at: "2026-07-06 11:00:00", revoked_at: null },
        now
      )
    ).toBe("expired");
  });

  it("a truthful night stamped zoneless is not turned into a skew finding", () => {
    // A trough exactly where the session claims it. Read server-local the claim
    // slides four hours into the awake minutes and the detector reports the trough
    // it "disagrees" with — the #5212 shape, on the safety-tier path.
    const from = Date.UTC(2026, 7, 29, 22);
    const troughFrom = Date.UTC(2026, 7, 30, 3, 39);
    const troughTo = Date.UTC(2026, 7, 30, 8, 37);
    const hr: HrMinuteSample[] = [];
    for (let at = from; at < from + 24 * 3_600_000; at += 60_000)
      hr.push({
        ts: utcInstant(new Date(at)),
        bpm: at >= troughFrom && at < troughTo ? 58 : 74,
      });
    const zoneless = {
      start: "2026-08-30T03:39:00",
      end: "2026-08-30T08:37:00",
    };
    expect(detectSleepClockSkew(zoneless, hr)).toBeNull();
  });
});
