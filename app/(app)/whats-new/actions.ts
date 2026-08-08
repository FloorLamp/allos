"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireSession } from "@/lib/auth";
import { loadReleaseNotes, newestNoteDate } from "@/lib/release-notes";
import { setWhatsNewSeenDate } from "@/lib/settings";
import { formOk, type FormResult } from "@/lib/types";

// Mark the bundled release notes as seen by the CALLING LOGIN (issue #1421).
//
// Auth tier: login-scoped. This writes one display-preference key in
// login_settings keyed by login.id — it touches no profile-owned data and grants
// nothing — so requireSession() is the right gate (the same shape as saveUnitPrefs
// and dismissMultiviewHintAction; allowlisted in
// lib/__tests__/actions-write-access.test.ts).
//
// The date is resolved SERVER-SIDE from the bundled notes rather than accepted
// from the caller: the client has no business naming which date it "read", and
// the setter is monotonic anyway. Fired once on mount by the /whats-new page's
// <MarkWhatsNewSeen> — visiting the page IS the dismissal.
export async function markWhatsNewSeenAction(): Promise<FormResult> {
  const { login } = await requireSession();
  const newest = newestNoteDate(loadReleaseNotes());
  if (newest) {
    setWhatsNewSeenDate(login.id, newest);
    // The unread dot lives in the app shell (the shared sidebar footer), so the
    // whole layout has to re-render for it to clear.
    revalidateRoute("/", "layout");
  }
  return formOk();
}
