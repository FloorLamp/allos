import type { UpcomingItem } from "../../upcoming";
import { sqlNow } from "../../clock";
import {
  openSyncRequests,
  syncRequestCarrierProfiles,
} from "../../portal-requests";
import {
  daysUntilExpiry,
  syncRequestCopy,
  syncRequestDedupeKey,
  syncRequestExpiryPhrase,
} from "../../sync-requests";
import { daysBetweenDateStr } from "../../date";

// Open PORTAL SYNC REQUESTS as Upcoming items (#1757).
//
// This is the entire reach of the feature, and the limit is the design: an item on the
// Upcoming page, and — because the morning digest's Today section is a formatter over
// this same `collectUpcoming` — one digest line carrying the SAME dedupe key. Dismiss it
// on either surface and both go quiet, through the ordinary suppression bus. There is no
// dedicated send and there will not be one: portal hygiene is never a safety signal.
// (`cardBandForItem` also keeps it off the non-hideable "Needs attention" hero.)
//
// THE DUE DATE IS THE EXPIRY, because that is the only deadline a request has. It is not
// a schedule — nobody is promised a run at a time — but "this ask stops mattering on
// Friday" is a real, honest date, and it is the one the card quotes back
// ("Sync requested · expires in 6 days"). Banding it means an ask sits calmly in "This
// week" rather than shouting "Today" for its whole life.
//
// WHICH PROFILE SEES IT is the routing (lib/portal-requests.ts:
// syncRequestCarrierProfiles): the mapped profiles that the login who actually runs this
// portal's tool manages. That is how "Mom's phone buzzes about Mom's portal" is expressed
// through machinery that is profile-shaped, without inventing a per-login send.
export function syncRequestItems(
  profileId: number,
  today: string
): UpcomingItem[] {
  const now = sqlNow();
  const items: UpcomingItem[] = [];
  for (const req of openSyncRequests(now)) {
    if (!syncRequestCarrierProfiles(req.accountId).includes(profileId))
      continue;
    const copy = syncRequestCopy({
      portalName: req.portalName,
      accountName: req.accountName,
      accountImplicit: req.accountImplicit,
      reason: req.reason,
      daysSinceChecked: req.lastOkAt
        ? daysBetweenDateStr(req.lastOkAt.slice(0, 10), today)
        : null,
      // ONE OPTIONAL CLAUSE on the shared formatter (#1889), never a second formatter:
      // when a scheduled unattended run already tried and could not finish, the ask the
      // person reads carries WHY it is their turn. Null the rest of the time, so the
      // sentence is unchanged for every request nothing has attempted.
      unattendedFailure: req.unattendedFailure,
    });
    const left = daysUntilExpiry(req.expiresAt, today);
    items.push({
      key: syncRequestDedupeKey(req.portalSlug, req.accountSlug, req.createdAt),
      domain: "portal-sync",
      title: copy.title,
      detail: copy.detail,
      // The digest's named line concatenates title and cause, so it gets the fragment
      // the SAME formatter wrote for it (#1913 item 6) rather than the card's complete
      // sentence, which restates the portal and repeats the imperative.
      because: copy.because,
      href: "/integrations/patient-portals",
      // Clamped forward: an open request whose expiry day has already passed in the
      // profile's timezone must still read as a live ask, never as "overdue" work.
      dueDate: left >= 0 ? req.expiresAt.slice(0, 10) : today,
      dueText: syncRequestExpiryPhrase(left),
      actionLabel: "Open portal setup",
      suppressible: true,
    });
  }
  return items;
}
