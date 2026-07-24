// SERVER-ACTION TIER — the "What's new" seen marker (issue #1421).
//
// Visiting /whats-new fires markWhatsNewSeenAction, which stores the newest bundled
// note date against the CALLING LOGIN in login_settings. The DB is real (a throwaway
// temp DB), so these assert the actual rows the action wrote: the marker is
// login-scoped (never profile-scoped), monotonic, idempotent, and clears the unread
// verdict that the sidebar dot and the page share.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { markWhatsNewSeenAction } from "@/app/(app)/whats-new/actions";
import {
  getWhatsNewSeenDate,
  setWhatsNewSeenDate,
  WHATS_NEW_SEEN_KEY,
} from "@/lib/settings";
import {
  hasUnseenNotes,
  loadReleaseNotes,
  newestNoteDate,
} from "@/lib/release-notes";
import { db } from "@/lib/db";
import { createLogin, createProfile, actAs } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

const NEWEST = newestNoteDate(loadReleaseNotes());

describe("markWhatsNewSeenAction (#1421)", () => {
  it("stores the newest bundled note date for the acting login and revalidates the shell", async () => {
    const login = createLogin();
    const profile = createProfile("whatsnew-1", login.id);
    actAs(login, profile);

    // A fresh login has seen nothing, so the dot is on.
    expect(hasUnseenNotes(NEWEST, getWhatsNewSeenDate(login.id))).toBe(true);

    const res = await markWhatsNewSeenAction();

    expect(res.ok).toBe(true);
    expect(getWhatsNewSeenDate(login.id)).toBe(NEWEST);
    // The dot lives in the app shell, so the whole layout has to revalidate.
    expect(revalidate).toHaveBeenCalledWith("/", "layout");
    expect(hasUnseenNotes(NEWEST, getWhatsNewSeenDate(login.id))).toBe(false);
  });

  it("marks the LOGIN, not the profile — a sibling login stays unread", async () => {
    const a = createLogin();
    const b = createLogin();
    // Both act on the SAME profile: the marker must still separate by login.
    const shared = createProfile("whatsnew-shared", a.id);
    db.prepare(
      "INSERT OR IGNORE INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(b.id, shared.id);

    actAs(a, shared);
    await markWhatsNewSeenAction();

    expect(getWhatsNewSeenDate(a.id)).toBe(NEWEST);
    expect(getWhatsNewSeenDate(b.id)).toBeNull();
    expect(hasUnseenNotes(NEWEST, getWhatsNewSeenDate(b.id))).toBe(true);

    // …and it is stored in the LOGIN tier, keyed by login id.
    const rows = db
      .prepare(
        "SELECT login_id FROM login_settings WHERE key = ? ORDER BY login_id"
      )
      .all(WHATS_NEW_SEEN_KEY) as { login_id: number }[];
    expect(rows.map((r) => r.login_id)).toContain(a.id);
    expect(rows.map((r) => r.login_id)).not.toContain(b.id);
  });

  it("is idempotent — a second visit leaves the same marker", async () => {
    const login = createLogin();
    const profile = createProfile("whatsnew-2", login.id);
    actAs(login, profile);

    await markWhatsNewSeenAction();
    await markWhatsNewSeenAction();

    const rows = db
      .prepare(
        "SELECT value FROM login_settings WHERE login_id = ? AND key = ?"
      )
      .all(login.id, WHATS_NEW_SEEN_KEY) as { value: string }[];
    expect(rows).toEqual([{ value: NEWEST! }]);
  });

  it("never moves the marker backwards (a future marker survives)", async () => {
    const login = createLogin();
    const profile = createProfile("whatsnew-3", login.id);
    actAs(login, profile);
    // e.g. a rolled-back image whose bundled notes are older than what this login
    // already read.
    setWhatsNewSeenDate(login.id, "2099-01-01");

    await markWhatsNewSeenAction();

    expect(getWhatsNewSeenDate(login.id)).toBe("2099-01-01");
  });

  it("gates on a live session", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("whatsnew-4", login.id);
    // A read-only grant still gets to mark its OWN login's notes read — the write
    // touches no profile data — so the gate is requireSession, not write access.
    actAs(login, profile, "read");

    await expect(markWhatsNewSeenAction()).resolves.toEqual({ ok: true });
    expect(getWhatsNewSeenDate(login.id)).toBe(NEWEST);
  });
});
