// SERVER-ACTION TIER — the persisted "Recently resolved — reopen?" dismissal (#1548).
//
// The bug this pins: the band's X was client `useState` only, so a dismissed line came
// back on every reload for the rest of its 7-day window — the one X in the app that
// resurrected. The tier matters. A pure test can't see it (the truth is a stored row)
// and a browser test can't see the REFUSALS, so the store + the action's id
// authorization live here, and the browser spec (e2e/dashboard-household-folds.spec.ts)
// covers only the dismiss → reload → still-gone journey.
//
// What each case is actually asserting:
//   • persistence      — the id lands in the acting LOGIN's login_settings row, and the
//                        page's own filter (visibleRecentlyResolved) then drops the line;
//   • idempotence      — a repeat dismissal is a no-op, not a duplicate id;
//   • pruning          — an id whose reopen window has since closed drops out on the
//                        next write, so the stored list stays at household scale;
//   • refusal          — an id outside the login's reopen-eligible set (another
//                        household's episode, an expired one, a garbage number) is a
//                        silent no-op and never enters the store;
//   • per-login scope  — a second caregiver granted the SAME profile still sees the
//                        line. That is the deliberate design (#1548 Boundary), not an
//                        oversight, so it gets an assertion of its own;
//   • eligibility      — the dismissal never touches the episode row or its 7-day
//                        window. Suppressing a line must not be able to resolve, reopen,
//                        or re-window an illness.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { dismissRecentlyResolved } from "@/app/(app)/actions";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  createEpisodeRow,
  reopenEligibleEpisodeForProfile,
} from "@/lib/illness-episode-store";
import { getRecentlyResolvedDismissed, getLoginSetting } from "@/lib/settings";
import { visibleRecentlyResolved } from "@/lib/recently-resolved";
import { createLogin, createProfile, actAs } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => revalidate.mockClear());

// A member login + a profile carrying an episode resolved `daysAgo` days ago.
// end_date is the INCLUSIVE last active day (#2232), so it is simply
// today - daysAgo.
function seedResolved(
  loginId: number,
  profileName: string,
  situation: string,
  daysAgo: number
): { profileId: number; episodeId: number } {
  const profile = createProfile(profileName, loginId);
  const on = today(profile.id);
  const episodeId = createEpisodeRow(
    profile.id,
    situation,
    shiftDateStr(on, -(daysAgo + 5)),
    shiftDateStr(on, -daysAgo)
  );
  return { profileId: profile.id, episodeId };
}

describe("dismissRecentlyResolved (#1548)", () => {
  it("persists the hide for the acting login and revalidates the dashboard", async () => {
    const login = createLogin({ role: "member" });
    const { profileId, episodeId } = seedResolved(
      login.id,
      "Reopen Persist",
      "Cold",
      3
    );
    actAs(login, { id: profileId, name: "Reopen Persist" });

    // Precondition: the line is eligible and nothing is dismissed yet.
    expect(reopenEligibleEpisodeForProfile(profileId)?.id).toBe(episodeId);
    expect(getRecentlyResolvedDismissed(login.id)).toEqual([]);

    await dismissRecentlyResolved(episodeId);

    expect(getRecentlyResolvedDismissed(login.id)).toEqual([episodeId]);
    // Stored where the sibling per-login viewer preferences live — login_settings,
    // as a JSON id array — NOT on the findings/upcoming suppression bus.
    expect(getLoginSetting(login.id, "recently_resolved_dismissed")).toBe(
      JSON.stringify([episodeId])
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM upcoming_dismissals WHERE profile_id = ?"
        )
        .get(profileId)
    ).toEqual({ n: 0 });

    // The page's own filter is what the dashboard runs; assert THAT, not just the row.
    expect(
      visibleRecentlyResolved(
        [{ episodeId }],
        getRecentlyResolvedDismissed(login.id)
      )
    ).toEqual([]);

    // #1549 depends on this re-render: the dismissal can move the household-history
    // promo from the reopen band to the household strip.
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("is idempotent — dismissing the same line twice stores one id", async () => {
    const login = createLogin({ role: "member" });
    const { profileId, episodeId } = seedResolved(
      login.id,
      "Reopen Idem",
      "Cold",
      2
    );
    actAs(login, { id: profileId, name: "Reopen Idem" });

    await dismissRecentlyResolved(episodeId);
    await dismissRecentlyResolved(episodeId);

    expect(getRecentlyResolvedDismissed(login.id)).toEqual([episodeId]);
  });

  it("prunes ids whose reopen window has closed on the next write", async () => {
    const login = createLogin({ role: "member" });
    const a = seedResolved(login.id, "Reopen Prune A", "Cold", 3);
    actAs(login, { id: a.profileId, name: "Reopen Prune A" });
    await dismissRecentlyResolved(a.episodeId);
    expect(getRecentlyResolvedDismissed(login.id)).toEqual([a.episodeId]);

    // Age A's episode out of its 7-day window by rewriting its end date, then dismiss
    // a DIFFERENT, still-eligible line. The stale id must not survive the write.
    db.prepare("UPDATE illness_episodes SET end_date = ? WHERE id = ?").run(
      shiftDateStr(today(a.profileId), -20),
      a.episodeId
    );
    expect(reopenEligibleEpisodeForProfile(a.profileId)).toBeNull();

    const b = seedResolved(login.id, "Reopen Prune B", "Flu", 1);
    await dismissRecentlyResolved(b.episodeId);

    expect(getRecentlyResolvedDismissed(login.id)).toEqual([b.episodeId]);
  });

  it("refuses an id outside the login's reopen-eligible set, as a silent no-op", async () => {
    const mine = createLogin({ role: "member" });
    const theirs = createLogin({ role: "member" });
    const own = seedResolved(mine.id, "Reopen Mine", "Cold", 2);
    // Another household's line: granted to `theirs` only.
    const other = seedResolved(theirs.id, "Reopen Theirs", "Cold", 2);
    actAs(mine, { id: own.profileId, name: "Reopen Mine" });

    // A stranger's episode, an id that never existed, and junk all no-op.
    await dismissRecentlyResolved(other.episodeId);
    await dismissRecentlyResolved(999_999);
    await dismissRecentlyResolved(0);
    await dismissRecentlyResolved(-1);
    await dismissRecentlyResolved(Number.NaN);

    expect(getRecentlyResolvedDismissed(mine.id)).toEqual([]);
    // And it never spilled into the OTHER login's preference either.
    expect(getRecentlyResolvedDismissed(theirs.id)).toEqual([]);

    // A real, eligible id from the same call sequence still works — proving the
    // refusals above were about the ID, not a wedged action.
    await dismissRecentlyResolved(own.episodeId);
    expect(getRecentlyResolvedDismissed(mine.id)).toEqual([own.episodeId]);
  });

  it("refuses an EXPIRED episode of the login's own profile", async () => {
    const login = createLogin({ role: "member" });
    // Resolved 20 days ago — outside the 7-day reopen window, so no line renders and
    // no dismissal may be recorded for it.
    const expired = seedResolved(login.id, "Reopen Expired", "Cold", 20);
    actAs(login, { id: expired.profileId, name: "Reopen Expired" });
    expect(reopenEligibleEpisodeForProfile(expired.profileId)).toBeNull();

    await dismissRecentlyResolved(expired.episodeId);

    expect(getRecentlyResolvedDismissed(login.id)).toEqual([]);
  });

  it("is per-login: a co-caregiver on the same profile still sees the line", async () => {
    const first = createLogin({ role: "member" });
    const { profileId, episodeId } = seedResolved(
      first.id,
      "Reopen Shared",
      "Cold",
      2
    );
    // A second caregiver granted the SAME profile.
    const second = createLogin({ role: "member" });
    db.prepare(
      "INSERT OR IGNORE INTO login_profiles (login_id, profile_id) VALUES (?, ?)"
    ).run(second.id, profileId);

    actAs(first, { id: profileId, name: "Reopen Shared" });
    await dismissRecentlyResolved(episodeId);

    expect(getRecentlyResolvedDismissed(first.id)).toEqual([episodeId]);
    expect(getRecentlyResolvedDismissed(second.id)).toEqual([]);
    expect(
      visibleRecentlyResolved(
        [{ episodeId }],
        getRecentlyResolvedDismissed(second.id)
      )
    ).toEqual([{ episodeId }]);
  });

  it("never touches the episode row or its reopen eligibility", async () => {
    const login = createLogin({ role: "member" });
    const { profileId, episodeId } = seedResolved(
      login.id,
      "Reopen Untouched",
      "Cold",
      3
    );
    actAs(login, { id: profileId, name: "Reopen Untouched" });
    const before = db
      .prepare("SELECT * FROM illness_episodes WHERE id = ?")
      .get(episodeId);

    await dismissRecentlyResolved(episodeId);

    expect(
      db.prepare("SELECT * FROM illness_episodes WHERE id = ?").get(episodeId)
    ).toEqual(before);
    // Still eligible — the viewer hid their copy of the line, the window is untouched,
    // and another login's dashboard is unaffected.
    expect(reopenEligibleEpisodeForProfile(profileId)?.id).toBe(episodeId);
  });
});
