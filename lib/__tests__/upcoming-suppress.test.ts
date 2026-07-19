import { describe, it, expect } from "vitest";
import {
  signalKey,
  findingKey,
  isSuppressed,
  isItemHiddenBySuppression,
} from "../upcoming-suppress";
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

describe("findingKey", () => {
  it("is the finding's dedupeKey — the generalized suppression identity", () => {
    expect(findingKey({ dedupeKey: "coaching:rest-sleep" })).toBe(
      "coaching:rest-sleep"
    );
    expect(findingKey({ dedupeKey: "digest:bio:LDL:up" })).toBe(
      "digest:bio:LDL:up"
    );
  });

  it("matches signalKey for an upcoming item's key (old rows keep working)", () => {
    // An UpcomingItem's key IS the dedupeKey upcomingToFinding produces, so a
    // pre-#39 upcoming_dismissals row still resolves the same finding.
    expect(findingKey({ dedupeKey: signalKey(item("dose:12")) })).toBe(
      "dose:12"
    );
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

// The #716 safety-ungated override: a crisis finding declaring
// suppressionPolicy "safety-ungated" is NON-DISMISSIBLE and NON-SNOOZABLE — the bus
// can never hide it, mirroring a safety dose reminder (#449/#942).
describe("isItemHiddenBySuppression — safety-ungated override (#716)", () => {
  const today = "2026-07-15";
  const dismissed = { snooze_until: null, dismissed_at: "2026-07-10" };
  const liveSnooze = { snooze_until: "2026-08-01", dismissed_at: null };

  it("a safety-ungated item is never hidden by a dismiss", () => {
    expect(
      isItemHiddenBySuppression(
        { suppressionPolicy: "safety-ungated" },
        dismissed,
        today
      )
    ).toBe(false);
  });

  it("a safety-ungated item is never hidden by a live snooze either", () => {
    expect(
      isItemHiddenBySuppression(
        { suppressionPolicy: "safety-ungated" },
        liveSnooze,
        today
      )
    ).toBe(false);
  });

  it("the explicit policy wins over carePersistent", () => {
    expect(
      isItemHiddenBySuppression(
        { suppressionPolicy: "safety-ungated", carePersistent: true },
        liveSnooze,
        today
      )
    ).toBe(false);
  });

  it("without the override, an ordinary item still honors a dismiss", () => {
    expect(isItemHiddenBySuppression({}, dismissed, today)).toBe(true);
  });
});
