import { describe, it, expect } from "vitest";
import {
  POST_VISIT_WINDOW_DAYS,
  STALENESS_CADENCE_DAYS,
  SYNC_REQUEST_PREFIX,
  SYNC_REQUEST_REASONS,
  SYNC_REQUEST_TTL_DAYS,
  daysUntilExpiry,
  isStalenessDue,
  isSyncRequestAnswered,
  isSyncRequestExpired,
  isSyncRequestOpen,
  isSyncRequestReason,
  mayAutoRequestSync,
  shouldWriteSyncRequest,
  syncRequestCardLine,
  syncRequestCopy,
  syncRequestDedupeKey,
  syncRequestExpiresAt,
  syncRequestExpiryPhrase,
  syncRequestSalience,
  type SyncRequestFacts,
} from "@/lib/sync-requests";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";

// PURE TIER — the sync-request decision layer (#1757). No DB, no network.
//
// The three things the issue asks this layer to guarantee: staleness never fires for a
// portal login with no mapped patients and respects the cadence constant; a request
// EXPIRES rather than hangs; and the next run report ANSWERS it — including a failed one,
// because the person acted.

function facts(
  reason: SyncRequestFacts["reason"],
  createdAt: string,
  ttlDays = SYNC_REQUEST_TTL_DAYS
): SyncRequestFacts {
  return {
    reason,
    createdAt,
    expiresAt: syncRequestExpiresAt(createdAt, ttlDays),
  };
}

describe("sync-request vocabulary", () => {
  it("is the closed three-reason set the migration's CHECK enumerates", () => {
    expect([...SYNC_REQUEST_REASONS]).toEqual([
      "staleness",
      "post-visit",
      "manual",
    ]);
    expect(isSyncRequestReason("manual")).toBe(true);
    expect(isSyncRequestReason("scheduled")).toBe(false);
    expect(isSyncRequestReason("")).toBe(false);
  });

  it("keys under a registered, coaching-tier dedupe prefix", () => {
    const key = syncRequestDedupeKey(
      "ochsner-mychart",
      "mom",
      "2026-03-04 09:00:00"
    );
    expect(key).toBe(`${SYNC_REQUEST_PREFIX}ochsner-mychart/mom:2026-03-04`);
    expect(dedupeKeyHasKnownPrefix(key)).toBe(true);
    // Portal hygiene is never a safety signal: calm, hideable, no dedicated send.
    expect(tierForDedupeKey(key)).toBe("coaching");
  });

  it("anchors the key on the request's DAY, so a dismissal is per-ask", () => {
    const a = syncRequestDedupeKey("p", "a", "2026-03-04 09:00:00");
    const b = syncRequestDedupeKey("p", "a", "2026-03-04 23:59:59");
    const later = syncRequestDedupeKey("p", "a", "2026-04-10 09:00:00");
    // Same day, same ask — one key, so re-raising within a day cannot re-nag.
    expect(a).toBe(b);
    // A later ask is a NEW key: dismissing today's nudge must not silence portal
    // hygiene for this login forever.
    expect(later).not.toBe(a);
  });

  it("separates portals and logins in the key", () => {
    expect(syncRequestDedupeKey("p1", "mom", "2026-03-04")).not.toBe(
      syncRequestDedupeKey("p1", "dad", "2026-03-04")
    );
    expect(syncRequestDedupeKey("p1", "mom", "2026-03-04")).not.toBe(
      syncRequestDedupeKey("p2", "mom", "2026-03-04")
    );
  });
});

describe("expiry — a request expires rather than hangs", () => {
  it("stamps expires_at one TTL past created_at", () => {
    expect(syncRequestExpiresAt("2026-03-04 09:00:00")).toBe(
      "2026-03-11 09:00:00"
    );
    expect(SYNC_REQUEST_TTL_DAYS).toBe(7);
  });

  it("treats the boundary second as expired, so nothing outlives its deadline", () => {
    const r = facts("manual", "2026-03-04 09:00:00");
    expect(isSyncRequestExpired(r.expiresAt, "2026-03-11 08:59:59")).toBe(
      false
    );
    expect(isSyncRequestExpired(r.expiresAt, "2026-03-11 09:00:00")).toBe(true);
    expect(isSyncRequestExpired(r.expiresAt, "2026-03-12 00:00:00")).toBe(true);
  });

  it("an expired request is not open, however unanswered it is", () => {
    const r = facts("staleness", "2026-03-04 09:00:00");
    expect(isSyncRequestOpen(r, null, "2026-03-10 09:00:00")).toBe(true);
    expect(isSyncRequestOpen(r, null, "2026-03-12 09:00:00")).toBe(false);
  });

  it("counts the days a card and a nudge both quote", () => {
    const r = facts("manual", "2026-03-04 09:00:00");
    expect(daysUntilExpiry(r.expiresAt, "2026-03-05")).toBe(6);
    expect(daysUntilExpiry(r.expiresAt, "2026-03-11")).toBe(0);
    expect(daysUntilExpiry(r.expiresAt, "2026-03-13")).toBe(-2);
  });
});

describe("answering — the next run report satisfies the request", () => {
  it("is answered by a report at or after the request", () => {
    expect(
      isSyncRequestAnswered("2026-03-04 09:00:00", "2026-03-04 09:00:00")
    ).toBe(true);
    expect(
      isSyncRequestAnswered("2026-03-04 09:00:00", "2026-03-05 10:00:00")
    ).toBe(true);
  });

  it("is NOT answered by a report that predates it", () => {
    expect(
      isSyncRequestAnswered("2026-03-04 09:00:00", "2026-03-03 23:59:59")
    ).toBe(false);
    expect(isSyncRequestAnswered("2026-03-04 09:00:00", null)).toBe(false);
  });

  it("counts a FAILED run as answered — the person acted", () => {
    // The outcome is deliberately not a parameter of this decision. A failed run, a
    // refusal-path report and a nothing-new run are one fact here: somebody went to the
    // machine. Whether it then worked is the sync STATUS's story, not the request's.
    const r = facts("post-visit", "2026-03-04 09:00:00");
    // There is no `ok` to pass — the shape itself is the guarantee.
    expect(
      isSyncRequestOpen(r, "2026-03-04 18:00:00", "2026-03-05 09:00:00")
    ).toBe(false);
  });

  it("is open while nothing has reported and nothing has expired", () => {
    const r = facts("staleness", "2026-03-04 09:00:00");
    expect(
      isSyncRequestOpen(r, "2026-03-01 09:00:00", "2026-03-06 09:00:00")
    ).toBe(true);
  });
});

describe("the setup carve-out (#2010)", () => {
  it("lets an automatic ask through ONLY once the tool has reported a run", () => {
    expect(mayAutoRequestSync({ everRan: false })).toBe(false);
    expect(mayAutoRequestSync({ everRan: true })).toBe(true);
  });

  it("keeps staleness silent before the first run, whatever else is true", () => {
    // The hand pre-bind case: a portal added, one label bound by hand, the tool never
    // installed. Mapped patients, a null clock and a decade of elapsed days used to add
    // up to "you are overdue"; the household actually owes the FIRST run, which the
    // page's own checklist already asks for.
    for (const mappedPatients of [1, 5]) {
      for (const lastCheckedAt of [null, "2020-01-01 00:00:00"]) {
        expect(
          isStalenessDue({
            everRan: false,
            mappedPatients,
            lastCheckedAt,
            today: "2026-03-04",
          })
        ).toBe(false);
      }
    }
    // Even with the cadence knob wound down to a day.
    expect(
      isStalenessDue({
        everRan: false,
        mappedPatients: 1,
        lastCheckedAt: "2026-03-01 09:00:00",
        today: "2026-03-31",
        cadenceDays: 1,
      })
    ).toBe(false);
  });

  it("counts a DELIVERY-ONLY push as having run while leaving the clock null", () => {
    // A push that never contacted the portal stamps no check clock (#1888) — but it
    // proves the tool is installed and pointed at this login, which is the only thing
    // the carve-out is about. So the never-checked clause takes over from here.
    expect(
      isStalenessDue({
        everRan: true,
        mappedPatients: 1,
        lastCheckedAt: null,
        today: "2026-03-04",
      })
    ).toBe(true);
  });
});

describe("staleness evaluation", () => {
  it("NEVER fires for a portal login with no mapped patients", () => {
    // Checked unconditionally: there is no profile whose Upcoming could carry the nudge,
    // and first contact is the card's job, not this one's.
    expect(
      isStalenessDue({
        everRan: true,
        mappedPatients: 0,
        lastCheckedAt: null,
        today: "2026-03-04",
      })
    ).toBe(false);
    expect(
      isStalenessDue({
        everRan: true,
        mappedPatients: 0,
        lastCheckedAt: "2020-01-01 00:00:00",
        today: "2026-03-04",
      })
    ).toBe(false);
  });

  it("respects the cadence constant at its exact boundary", () => {
    expect(STALENESS_CADENCE_DAYS).toBe(30);
    const base = {
      everRan: true,
      mappedPatients: 2,
      today: "2026-03-31",
    };
    // 29 days — not yet.
    expect(
      isStalenessDue({ ...base, lastCheckedAt: "2026-03-02 09:00:00" })
    ).toBe(false);
    // 30 days — due.
    expect(
      isStalenessDue({ ...base, lastCheckedAt: "2026-03-01 09:00:00" })
    ).toBe(true);
    expect(
      isStalenessDue({ ...base, lastCheckedAt: "2026-01-01 09:00:00" })
    ).toBe(true);
  });

  it("honors an explicit cadence override (the per-portal knob's seam)", () => {
    expect(
      isStalenessDue({
        everRan: true,
        mappedPatients: 1,
        lastCheckedAt: "2026-03-25 09:00:00",
        today: "2026-03-31",
        cadenceDays: 5,
      })
    ).toBe(true);
    expect(
      isStalenessDue({
        everRan: true,
        mappedPatients: 1,
        lastCheckedAt: "2026-03-25 09:00:00",
        today: "2026-03-31",
        cadenceDays: 30,
      })
    ).toBe(false);
  });

  it("treats a mapped login whose RUNS never succeed as stale", () => {
    // Pinned against the carve-out above: the tool runs here and keeps failing, so the
    // clock is null forever and this is the household that most needs the nudge.
    expect(
      isStalenessDue({
        everRan: true,
        mappedPatients: 1,
        lastCheckedAt: null,
        today: "2026-03-04",
      })
    ).toBe(true);
  });
});

describe("supersession — one open request per portal login", () => {
  const open = facts("staleness", "2026-03-04 09:00:00");

  it("writes when there is no request at all", () => {
    expect(shouldWriteSyncRequest(null, false, "staleness")).toBe(true);
  });

  it("writes when the existing request is closed (answered or expired)", () => {
    expect(shouldWriteSyncRequest(open, false, "staleness")).toBe(true);
  });

  it("lets a MORE salient reason replace an open one", () => {
    expect(shouldWriteSyncRequest(open, true, "post-visit")).toBe(true);
    expect(shouldWriteSyncRequest(open, true, "manual")).toBe(true);
    expect(
      shouldWriteSyncRequest(facts("post-visit", "2026-03-04"), true, "manual")
    ).toBe(true);
  });

  it("no-ops a weaker or equal reason while a request is open", () => {
    // The person has already been asked to run the tool for this login. A second row
    // would ask twice, and re-stamping would resurrect a nudge they dismissed.
    expect(shouldWriteSyncRequest(open, true, "staleness")).toBe(false);
    expect(
      shouldWriteSyncRequest(facts("manual", "2026-03-04"), true, "post-visit")
    ).toBe(false);
    expect(
      shouldWriteSyncRequest(facts("manual", "2026-03-04"), true, "manual")
    ).toBe(false);
  });

  it("ranks manual over post-visit over staleness", () => {
    expect(syncRequestSalience("manual")).toBeGreaterThan(
      syncRequestSalience("post-visit")
    );
    expect(syncRequestSalience("post-visit")).toBeGreaterThan(
      syncRequestSalience("staleness")
    );
  });
});

describe("copy — one formatter, so every surface phrases it identically", () => {
  const ochsner = {
    portalName: "Ochsner MyChart",
    accountName: "Mom",
    accountImplicit: false,
  };

  it("names the ACTION a person takes, and the machine that can take it", () => {
    const c = syncRequestCopy({
      ...ochsner,
      reason: "staleness",
      daysSinceChecked: 35,
    });
    expect(c.title).toBe("Run the portal tool for Ochsner MyChart");
    expect(c.detail).toBe(
      "Ochsner MyChart hasn't been checked in 5 weeks — run the portal tool on the computer with Mom's login."
    );
  });

  // ── THE DIGEST'S CAUSE FRAGMENT (#1913 item 6, owner ruling) ──
  //
  // `detail` is written for the CARD, where the title is a heading and this is its
  // supporting line — so it is a complete sentence that restates the portal and repeats
  // the ask. The digest CONCATENATES title and cause into one bullet, so it gets a
  // fragment from the SAME formatter. A field, not a second set of words.

  it("states the cause alone, with the subject the title already named left out", () => {
    const never = syncRequestCopy({ ...ochsner, reason: "staleness" });
    expect(never.because).toBe("never checked");
    const stale = syncRequestCopy({
      ...ochsner,
      reason: "staleness",
      daysSinceChecked: 35,
    });
    expect(stale.because).toBe("not checked in 5 weeks");
    expect(syncRequestCopy({ ...ochsner, reason: "manual" }).because).toBe(
      "a sync was requested"
    );
    expect(
      syncRequestCopy({
        ...ochsner,
        reason: "post-visit",
        visitSubject: "Riley",
      }).because
    ).toBe("Riley's visit just happened");
  });

  it("never re-contains the title, for any reason", () => {
    for (const reason of SYNC_REQUEST_REASONS) {
      const c = syncRequestCopy({
        ...ochsner,
        reason,
        daysSinceChecked: 12,
        visitSubject: "Riley",
      });
      // The joined line would otherwise read: imperative → em dash → subject restated →
      // em dash → the same imperative.
      expect(c.because).not.toContain("Ochsner MyChart");
      expect(c.because.toLowerCase()).not.toContain("run the portal tool");
      expect(c.because).not.toMatch(/[.]$/);
    }
  });

  it("prefers #1889's clause as the cause once the machine has tried", () => {
    const c = syncRequestCopy({
      ...ochsner,
      reason: "staleness",
      daysSinceChecked: 35,
      unattendedFailure: { message: "the portal asked for a code" },
    });
    // THAT is why it is the person's turn — it outranks the staleness the request was
    // originally opened on.
    expect(c.because).toBe(
      "the scheduled run couldn't finish (the portal asked for a code)"
    );
    // …and the card's sentence is untouched, so the two surfaces still share one voice.
    expect(c.detail).toContain("someone needs to go to the machine");
  });

  it("does not invent a cause for the digest either when the run gave none", () => {
    const c = syncRequestCopy({
      ...ochsner,
      reason: "manual",
      unattendedFailure: { message: null },
    });
    expect(c.because).toBe("the scheduled run couldn't finish");
  });

  it("never names a login a single-login household has not met", () => {
    const c = syncRequestCopy({
      portalName: "Baptist Health",
      accountName: "Default login",
      accountImplicit: true,
      reason: "staleness",
      daysSinceChecked: 40,
    });
    expect(c.detail).toContain("your computer");
    expect(c.detail).not.toContain("Default login");
  });

  it("says what the post-visit nudge actually knows", () => {
    const c = syncRequestCopy({
      ...ochsner,
      reason: "post-visit",
      visitSubject: "Riley",
    });
    expect(c.detail).toBe(
      "Riley's visit just happened — the portal likely has new results. Run the portal tool on the computer with Mom's login."
    );
    // "likely", never "has": allos has not seen the portal.
    expect(c.detail).toContain("likely");
  });

  it("falls back to a subject-less phrasing rather than inventing a name", () => {
    const c = syncRequestCopy({ ...ochsner, reason: "post-visit" });
    expect(c.detail).toContain("A visit just happened");
  });

  it("words a manual ask as the ask it is", () => {
    const c = syncRequestCopy({ ...ochsner, reason: "manual" });
    expect(c.detail).toBe(
      "A sync was requested for Ochsner MyChart — run the portal tool on the computer with Mom's login."
    );
  });

  it("reads a never-checked login honestly rather than as 0 days", () => {
    const c = syncRequestCopy({
      ...ochsner,
      reason: "staleness",
      daysSinceChecked: null,
    });
    expect(c.detail).toContain("has never been checked");
  });

  it("renders the card's state line the issue specifies", () => {
    const c = syncRequestCopy({ ...ochsner, reason: "manual" });
    expect(syncRequestCardLine(c, 6)).toBe(
      "Sync requested · expires in 6 days"
    );
    expect(syncRequestCardLine(c, 1)).toBe("Sync requested · expires tomorrow");
    expect(syncRequestCardLine(c, 0)).toBe("Sync requested · expires today");
  });

  it("phrases expiry once, so the card and the nudge cannot drift", () => {
    expect(syncRequestExpiryPhrase(6)).toBe("expires in 6 days");
    expect(syncRequestExpiryPhrase(2)).toBe("expires in 2 days");
    expect(syncRequestExpiryPhrase(1)).toBe("expires tomorrow");
    expect(syncRequestExpiryPhrase(0)).toBe("expires today");
    expect(syncRequestExpiryPhrase(-3)).toBe("expires today");
  });

  it("carries no address, in any wording", () => {
    for (const reason of SYNC_REQUEST_REASONS) {
      const c = syncRequestCopy({
        ...ochsner,
        reason,
        daysSinceChecked: 30,
        visitSubject: "Riley",
      });
      const text = `${c.title} ${c.detail} ${c.cardLine}`;
      expect(text).not.toMatch(/https?:\/\//i);
      expect(text).not.toContain("://");
    }
  });

  // ── ONE OPTIONAL CLAUSE, NOT A SECOND FORMATTER (#1889) ──
  //
  // A failed unattended run leaves the request open (nobody acted) and is exactly the
  // information the person-channel copy wants: the machine tried, so tell the human why
  // it is their turn. It composes onto the SAME sentence every surface already shares.

  it("says nothing extra when nothing has tried", () => {
    const plain = syncRequestCopy({ ...ochsner, reason: "manual" });
    const explicit = syncRequestCopy({
      ...ochsner,
      reason: "manual",
      unattendedFailure: null,
    });
    expect(explicit.detail).toBe(plain.detail);
  });

  it("carries the last unattended failure reason, and names the person's move", () => {
    const c = syncRequestCopy({
      ...ochsner,
      reason: "post-visit",
      visitSubject: "Riley",
      unattendedFailure: { message: "passkey prompt" },
    });
    expect(c.detail).toBe(
      "Riley's visit just happened — the portal likely has new results. Run the portal tool on the computer with Mom's login. " +
        "The scheduled run couldn't finish (passkey prompt) — someone needs to go to the machine."
    );
  });

  it("adds the clause to every reason, on the one formatter", () => {
    for (const reason of SYNC_REQUEST_REASONS) {
      const c = syncRequestCopy({
        ...ochsner,
        reason,
        daysSinceChecked: 30,
        unattendedFailure: { message: "the portal asked for a code" },
      });
      expect(c.detail).toContain("someone needs to go to the machine");
      // The base sentence is untouched — the clause composes, it does not replace.
      expect(c.detail.toLowerCase()).toContain("run the portal tool on");
    }
  });

  it("does not invent a cause when the run gave none", () => {
    const c = syncRequestCopy({
      ...ochsner,
      reason: "staleness",
      daysSinceChecked: 35,
      unattendedFailure: { message: null },
    });
    expect(c.detail).toContain(
      "The scheduled run couldn't finish — someone needs to go to the machine."
    );
    expect(c.detail).not.toContain("()");
  });

  it("leaves the card's state line alone — the login row already tells that story", () => {
    const c = syncRequestCopy({
      ...ochsner,
      reason: "manual",
      unattendedFailure: { message: "passkey prompt" },
    });
    expect(c.cardLine).toBe("Sync requested");
  });
});

describe("the post-visit window", () => {
  it("is a named constant a portal can actually satisfy", () => {
    // Portals do not publish a visit's documents the same afternoon.
    expect(POST_VISIT_WINDOW_DAYS).toBe(3);
    expect(POST_VISIT_WINDOW_DAYS).toBeLessThan(SYNC_REQUEST_TTL_DAYS);
  });
});
