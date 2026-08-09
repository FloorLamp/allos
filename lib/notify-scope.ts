// An admin's notification scope (issue #2345) — the PURE half: the shape the opt-in
// control renders from, and the one wording of what that control does. The reader
// that fills the shape lives in lib/notify-scope-db.ts (the day-counter-ledger
// precedent), so this module stays free of `db` and can be imported from BOTH sides
// of the client boundary. The copy in particular must live here rather than in the
// `"use client"` component: every export of a client module is a client REFERENCE, so
// a Server Component that called it there would crash the page.
//
// An admin reaches every profile by role, but the notification fan-out deliberately
// does NOT inherit that (`lib/notifications/fan-out.ts`): a push into someone's
// pocket is opted into per profile, through the same `login_profiles` row a member's
// access rides on.

export interface NotifyScopeProfile {
  id: number;
  name: string;
}

export interface NotifyScope {
  /** Every profile the control can offer, id-ordered (the disambiguation order). */
  profiles: NotifyScopeProfile[];
  /** The profile ids this login currently holds a `login_profiles` row for. */
  granted: number[];
  /** Stored access level per granted profile — the #467 loaded snapshot signs it. */
  access: Record<number, "read" | "write">;
  /** `logins.own_profile_id` (#1013): already in the recipient union, so locked on. */
  ownProfileId: number | null;
}

// The control's own heading. Shared so the host that supplies its own chrome (the
// Notifications page's Section) names it identically.
export const NOTIFY_SCOPE_HEADING = "Notifications";

// What the control does, said once. `self` is the Settings → Notifications rendering,
// where the target login IS the reader; otherwise it targets someone else's login on
// Settings → Family. Copy only — the write path is identical either way.
export function notifyScopeCaption(self: boolean, username: string): string {
  return self
    ? "Which profiles’ reminders reach your channels. You can already see every profile; this only decides what gets pushed to you."
    : `Which profiles’ reminders reach ${username}’s channels. They can already see every profile; this only decides what gets pushed to them.`;
}
