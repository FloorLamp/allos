"use server";

import { revalidatePath } from "next/cache";
import { requireSession, requireWriteAccess } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import {
  mintCalendarFeedToken,
  disableCalendarFeed,
  setCalendarFeedDetail,
  setCalendarFeedOptions,
  mintConsolidatedCalendarFeedToken,
  disableConsolidatedCalendarFeed,
  type CalendarFeedDetail,
} from "@/lib/settings";
import { upsertConnection } from "@/lib/integrations/connections";
import { isValidExpiryChoice } from "@/lib/token-lifecycle";

// Server Actions for the calendar subscribe feed. Every action is gated by
// requireWriteAccess() and operates ONLY on the session's active profile
// (session.profile.id) — there is no profile_id input to tamper with, so a login
// can only manage the feed of a profile it's authorized to act as. The raw feed
// token is returned exactly once (on enable/regenerate) and never stored — only
// its hash is persisted (lib/settings.mintCalendarFeedToken).

const PROVIDER = "calendar-feed";

export type FeedResult =
  { ok: true; path?: string; message?: string } | { ok: false; error: string };

// Mint a token (or rotate an existing one — a new token immediately kills the old
// URL) and return the relative feed PATH once. `expiry` (issue #24) is an optional
// mint-time expiry choice ("never" | "90d" | "1y"); anything else falls back to
// "never" to preserve behaviour. The connection row mirrors the enabled state so
// the integrations grid shows "Connected".
export async function enableCalendarFeedAction(
  expiry?: string
): Promise<FeedResult> {
  const { profile, login } = await requireWriteAccess();
  const choice = isValidExpiryChoice(expiry) ? expiry : "never";
  const token = mintCalendarFeedToken(profile.id, choice);
  upsertConnection(profile.id, PROVIDER, { status: "connected" });
  // Minting kills any prior token, so this covers both first mint and rotation.
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.tokenMint,
    target: "calendar-feed",
    detail: `expiry:${choice}`,
  });
  revalidatePath("/integrations/calendar-feed");
  revalidatePath("/data");
  return { ok: true, path: `/api/calendar/${token}.ics` };
}

// Disable the feed: the token hash is dropped (URL dies) and the route 404s.
export async function disableCalendarFeedAction(): Promise<FeedResult> {
  const { profile, login } = await requireWriteAccess();
  disableCalendarFeed(profile.id);
  upsertConnection(profile.id, PROVIDER, { status: "disconnected" });
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.tokenRevoke,
    target: "calendar-feed",
  });
  revalidatePath("/integrations/calendar-feed");
  revalidatePath("/data");
  return { ok: true, message: "Feed disabled." };
}

// Switch the detail level. "full" is an explicit opt-in that sends provider/reason
// to the calendar provider; "minimal" (default) sends only "Medical appointment".
export async function setCalendarFeedDetailAction(
  formData: FormData
): Promise<FeedResult> {
  const { profile } = await requireWriteAccess();
  const detail: CalendarFeedDetail =
    String(formData.get("detail")) === "full" ? "full" : "minimal";
  setCalendarFeedDetail(profile.id, detail);
  revalidatePath("/integrations/calendar-feed");
  return { ok: true, message: `Detail set to ${detail}.` };
}

// Save the content/window customization (issue #12): which categories the feed
// includes, whether it emits reminders, and the past/future windows. Write-gated
// on the active profile like the detail action; the settings helper validates the
// category list and clamps the windows, so untrusted form input can't corrupt the
// stored prefs. `futureWindowDays` empty/"none" means an unbounded horizon.
export async function setCalendarFeedOptionsAction(
  formData: FormData
): Promise<FeedResult> {
  const { profile } = await requireWriteAccess();
  const categories = formData.getAll("category").map(String);
  const reminders = String(formData.get("reminders")) === "1";
  const pastWindowDays = Number(formData.get("pastWindowDays"));
  const futureRaw = String(formData.get("futureWindowDays") ?? "");
  const futureWindowDays =
    futureRaw === "" || futureRaw === "none" ? null : Number(futureRaw);
  setCalendarFeedOptions(profile.id, {
    categories,
    reminders,
    pastWindowDays,
    futureWindowDays,
  });
  revalidatePath("/integrations/calendar-feed");
  return { ok: true, message: "Feed options saved." };
}

// ---- Consolidated (per-login) "family" calendar feed -----------------------
// These are LOGIN-SCOPED: they mint/revoke a token keyed by the caller's own
// login.id (in login_settings), NOT a write to any profile-owned data. The feed
// only ever exposes appointments the login can already READ (resolved at request
// time from live grants), so a read-only member may manage it — hence requireSession()
// rather than requireWriteAccess(), justified/allowlisted in the write-access test
// exactly like the push-subscription actions (another login-scoped token surface).

// Mint (or rotate) the family feed token and return its relative PATH once. The
// consolidated feed spans every profile the login can access; each profile's own
// detail level is honored, so no per-feed detail input exists here.
export async function enableConsolidatedCalendarFeedAction(
  expiry?: string
): Promise<FeedResult> {
  const { profile, login } = await requireSession();
  const choice = isValidExpiryChoice(expiry) ? expiry : "never";
  const token = mintConsolidatedCalendarFeedToken(login.id, choice);
  // Minting kills any prior token, so this covers both first mint and rotation.
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.tokenMint,
    target: "family-calendar-feed",
    detail: `expiry:${choice}`,
  });
  revalidatePath("/integrations/calendar-feed");
  return { ok: true, path: `/api/calendar/family/${token}.ics` };
}

// Disable the family feed: the token hash is dropped (URL dies) and the route 404s.
export async function disableConsolidatedCalendarFeedAction(): Promise<FeedResult> {
  const { profile, login } = await requireSession();
  disableConsolidatedCalendarFeed(login.id);
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.tokenRevoke,
    target: "family-calendar-feed",
  });
  revalidatePath("/integrations/calendar-feed");
  return { ok: true, message: "Family feed disabled." };
}
