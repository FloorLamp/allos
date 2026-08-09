"use client";

import { useState, useTransition } from "react";
import { loadedGrantSignature, profileChoiceLabels } from "@/lib/family-ui";
import type { Access } from "@/lib/grants";
import {
  NOTIFY_SCOPE_HEADING,
  notifyScopeCaption,
  type NotifyScopeProfile,
} from "@/lib/notify-scope";
import {
  setGrants,
  type FamilyResult,
} from "@/app/(app)/settings/family/actions";

// An ADMIN login's notification opt-in (issue #2345) — the control that says what it
// does, rendered by BOTH surfaces that need it:
//
//   • Settings → Family, targeting ANY login (the authoritative editor), and
//   • Settings → Notifications, scoped to `self` (the signed-in login).
//
// One action (`setGrants`), two renderers. An opt-in that exists only on a page the
// person is not sent is not an opt-in (the #2299 lesson): the Family screen is
// admin-only and about OTHER people's logins, while someone changing what buzzes
// their OWN phone goes to Notifications.
//
// There is NO read/write selector here. For an admin the `login_profiles` row cannot
// widen or narrow access (they reach every profile by role), so a level control would
// be a control that changes nothing; the row means exactly "notify me about this
// profile". Members keep the access matrix in FamilyManager, unchanged.
//
// The OWN profile renders ON and locked. It is already in the recipient union through
// `logins.own_profile_id` (#1013), so a checkbox that appeared to turn it off would be
// a lying control — and because `setGrants`' desired set is ABSOLUTE, the save submits
// it too, so it is never diffed as a revocation.
//
// Explicit Save, not autosave: this form carries #467's optimistic-concurrency
// snapshot (the signature it LOADED with), which the server re-reads under the write
// lock and refuses on drift. That is the same discipline — and the same control — the
// member access matrix uses, so both renderers behave identically.
export default function NotifyScopeEditor({
  login,
  profiles,
  granted,
  access,
  self,
  chrome = "heading",
}: {
  login: { id: number; username: string; own_profile_id: number | null };
  profiles: NotifyScopeProfile[];
  granted: number[];
  access: Record<number, Access>;
  // True on Settings → Notifications, where the target IS the reader. Copy only —
  // the write path is identical (the action re-resolves the login server-side).
  self: boolean;
  // "heading": the control carries its own heading + caption (Settings → Family,
  // where it sits inline among a login's other controls). "bare": the host already
  // renders both, from the SAME lib/notify-scope exports (the Notifications page's
  // Section) — the copy lives there, not here, because a Server Component cannot
  // call an export of a `"use client"` module.
  chrome?: "heading" | "bare";
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FamilyResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(granted));
  const ownId = login.own_profile_id;

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function save() {
    const fd = new FormData();
    fd.set("loginId", String(login.id));
    // The rows this control LOADED with (#467): setGrants refuses the save when the
    // login's stored set has changed since, instead of letting a stale absolute
    // desired set silently revoke someone else's fresh opt-in.
    fd.set("grants_snapshot", loadedGrantSignature(granted, access));
    const ids = new Set(selected);
    // The locked-on own profile is part of the desired set (see the header note).
    if (ownId != null && profiles.some((p) => p.id === ownId)) ids.add(ownId);
    // No `access_<id>` fields: the action stores the inert 'write' for an admin.
    for (const id of [...ids].sort((a, b) => a - b))
      fd.append("profileId", String(id));
    start(async () => {
      setResult(await setGrants(fd));
    });
  }

  return (
    <div data-testid={`notify-scope-${login.username}`} className="space-y-2">
      {chrome === "heading" && (
        <>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {NOTIFY_SCOPE_HEADING}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {notifyScopeCaption(self, login.username)}
          </p>
        </>
      )}
      {profiles.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Add a profile first — there is nothing to be notified about yet.
        </p>
      ) : (
        <div className="space-y-2">
          {/* Disambiguated labels (#534): two same-named profiles must never render
              as identical rows where picking the wrong one matters. */}
          {profileChoiceLabels(profiles).map(({ id: pid, label }) => {
            const isOwn = pid === ownId;
            return (
              <div
                key={pid}
                data-testid={`notify-scope-cell-${login.username}-${pid}`}
                className="flex flex-wrap items-center gap-2"
              >
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    data-testid={`notify-scope-toggle-${login.username}-${pid}`}
                    checked={isOwn || selected.has(pid)}
                    disabled={isOwn}
                    onChange={() => toggle(pid)}
                    className="h-4 w-4 accent-brand-600 focus:ring-brand-500 disabled:opacity-60"
                  />
                  {label}
                </label>
                {isOwn && (
                  <span
                    data-testid={`notify-scope-own-${login.username}-${pid}`}
                    className="text-xs text-slate-500 dark:text-slate-400"
                  >
                    {self ? "your own profile" : "their own profile"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          data-testid={`notify-scope-save-${login.username}`}
          className="btn-ghost"
        >
          Save notifications
        </button>
        {result && (
          <p
            data-testid={`notify-scope-msg-${login.username}`}
            className={`text-sm ${
              result.ok
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400"
            }`}
          >
            {result.ok ? (result.message ?? "Saved.") : result.error}
          </p>
        )}
      </div>
    </div>
  );
}
