import { describe, expect, it } from "vitest";
import { pinnedTimezone } from "../../e2e/pinned-timezone";
import { isValidTimezone } from "../timezone";

// The e2e timezone pin (e2e/pinned-timezone.ts): for ANY frozen run-start
// instant, the chosen zone must read 13:mm local on the SAME calendar date as
// the instant's UTC date — deterministic Midday at every possible CI start
// hour, with no today()/SQL-date divergence. Verified against the real Intl
// database, since the whole scheme rests on Etc/GMT±N being valid, DST-free
// zones.

function localParts(iso: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    // Intl can render midnight as "24" with hour12:false — normalize.
    hour: Number(get("hour")) % 24,
    minute: get("minute"),
  };
}

describe("pinnedTimezone (e2e frozen-clock timezone pin)", () => {
  it("maps every UTC start hour to 13:mm local on the same UTC date", () => {
    for (let h = 0; h < 24; h++) {
      const iso = `2026-07-21T${String(h).padStart(2, "0")}:37:00.000Z`;
      const { zone, offsetHours } = pinnedTimezone(iso);
      expect(isValidTimezone(zone), `${zone} must be a valid IANA zone`).toBe(
        true
      );
      expect(offsetHours).toBe(13 - h);
      const local = localParts(iso, zone);
      expect(local.hour, `utc hour ${h} → ${zone}`).toBe(13);
      expect(local.minute).toBe("37");
      expect(local.date, `utc hour ${h} → ${zone} keeps the UTC date`).toBe(
        "2026-07-21"
      );
    }
  });

  it("uses plain UTC when the instant is already 13:xx UTC", () => {
    expect(pinnedTimezone("2026-07-21T13:05:00.000Z").zone).toBe("UTC");
  });

  it("falls back to UTC on an unparseable instant", () => {
    expect(pinnedTimezone("not-a-date")).toEqual({
      zone: "UTC",
      offsetHours: 0,
    });
  });
});
