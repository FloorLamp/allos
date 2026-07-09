import { describe, it, expect } from "vitest";
import { signalKey, isSuppressed } from "../upcoming-suppress";
import type { UpcomingItem } from "../upcoming";

const item = (key: string): UpcomingItem => ({
  key,
  domain: "dose",
  title: "x",
  href: "/",
  dueDate: null,
});

describe("signalKey", () => {
  it("is the item's stable domain-prefixed key", () => {
    expect(signalKey(item("dose:12"))).toBe("dose:12");
    expect(signalKey(item("biomarker:ldl"))).toBe("biomarker:ldl");
    expect(signalKey(item("appointment:5"))).toBe("appointment:5");
    expect(signalKey(item("immunization:mmr"))).toBe("immunization:mmr");
  });
});

describe("isSuppressed", () => {
  const today = "2026-07-08";

  it("hides a snooze while today is before snooze_until", () => {
    expect(
      isSuppressed({ snooze_until: "2026-07-15", dismissed_at: null }, today)
    ).toBe(true);
  });

  it("reveals a snooze on the snooze_until date (reappears)", () => {
    // today === snooze_until → no longer before it → shows again.
    expect(
      isSuppressed({ snooze_until: today, dismissed_at: null }, today)
    ).toBe(false);
  });

  it("reveals a snooze after snooze_until", () => {
    expect(
      isSuppressed({ snooze_until: "2026-07-01", dismissed_at: null }, today)
    ).toBe(false);
  });

  it("hides a dismissal indefinitely regardless of today", () => {
    const rec = { snooze_until: null, dismissed_at: "2026-01-01 00:00:00" };
    expect(isSuppressed(rec, today)).toBe(true);
    expect(isSuppressed(rec, "2099-12-31")).toBe(true);
  });

  it("lets a dismiss win over an expired snooze on the same row", () => {
    expect(
      isSuppressed(
        { snooze_until: "2026-07-01", dismissed_at: "2026-07-02" },
        today
      )
    ).toBe(true);
  });

  it("does not hide when neither field is set", () => {
    expect(
      isSuppressed({ snooze_until: null, dismissed_at: null }, today)
    ).toBe(false);
  });
});
