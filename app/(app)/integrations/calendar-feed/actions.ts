"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import {
  mintCalendarFeedToken,
  disableCalendarFeed,
  setCalendarFeedDetail,
  type CalendarFeedDetail,
} from "@/lib/settings";
import { upsertConnection } from "@/lib/integrations/connections";

// Server Actions for the calendar subscribe feed. Every action is gated by
// requireSession() and operates ONLY on the session's active profile
// (session.profile.id) — there is no profile_id input to tamper with, so a login
// can only manage the feed of a profile it's authorized to act as. The raw feed
// token is returned exactly once (on enable/regenerate) and never stored — only
// its hash is persisted (lib/settings.mintCalendarFeedToken).

const PROVIDER = "calendar-feed";

export type FeedResult =
  { ok: true; path?: string; message?: string } | { ok: false; error: string };

// Mint a token (or rotate an existing one — a new token immediately kills the old
// URL) and return the relative feed PATH once. The connection row mirrors the
// enabled state so the integrations grid shows "Connected".
export async function enableCalendarFeedAction(): Promise<FeedResult> {
  const { profile } = requireSession();
  const token = mintCalendarFeedToken(profile.id);
  upsertConnection(profile.id, PROVIDER, { status: "connected" });
  revalidatePath("/integrations/calendar-feed");
  revalidatePath("/data");
  return { ok: true, path: `/api/calendar/${token}.ics` };
}

// Disable the feed: the token hash is dropped (URL dies) and the route 404s.
export async function disableCalendarFeedAction(): Promise<FeedResult> {
  const { profile } = requireSession();
  disableCalendarFeed(profile.id);
  upsertConnection(profile.id, PROVIDER, { status: "disconnected" });
  revalidatePath("/integrations/calendar-feed");
  revalidatePath("/data");
  return { ok: true, message: "Feed disabled." };
}

// Switch the detail level. "full" is an explicit opt-in that sends provider/reason
// to the calendar provider; "minimal" (default) sends only "Medical appointment".
export async function setCalendarFeedDetailAction(
  formData: FormData
): Promise<FeedResult> {
  const { profile } = requireSession();
  const detail: CalendarFeedDetail =
    String(formData.get("detail")) === "full" ? "full" : "minimal";
  setCalendarFeedDetail(profile.id, detail);
  revalidatePath("/integrations/calendar-feed");
  return { ok: true, message: `Detail set to ${detail}.` };
}
