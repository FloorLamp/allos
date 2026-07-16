import { notFound } from "next/navigation";
import { getShareLinkByToken } from "@/lib/share-links-db";
import { shareLinkStatus, parseShareFields } from "@/lib/share-links";
import {
  getProfileSummary,
  getProfileNameById,
} from "@/lib/profile-summary-load";
import ProfilePassport from "@/components/ProfilePassport";
import type { AvatarProfile } from "@/components/Avatar";
import { checkRateLimit } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import {
  assembleIllnessEpisode,
  episodeForProfileId,
  episodeForProfileSituationDate,
} from "@/lib/illness-episode";
import EpisodeSummary from "@/components/illness/EpisodeSummary";
import PrintButton from "@/components/illness/PrintButton";

// A human opening a shared passport hits this a handful of times; 30 requests/min
// per token is far above that while capping a client scraping this PHI-bearing,
// unauthenticated view.
const SHARE_RATE_LIMIT = 30;
const SHARE_RATE_WINDOW_MS = 60 * 1000;

// Unauthenticated, read-only "medical passport" render. This is the
// ONLY session-free view of a profile's data, so it is deliberately minimal:
//   - Looked up by the unguessable token's hash; ANY miss/expiry/revocation
//     returns notFound() (a uniform 404 that never confirms a link exists).
//   - Renders ONLY the sections the link's field allow-list granted.
//   - No app chrome, no navigation, no photo fetch (the avatar falls back to
//     initials — the authed photo route requires a session), no mutations.
//   - Security headers (nosniff, no-store) are attached in middleware for /share/*.
export const dynamic = "force-dynamic";

export default async function SharePage(props: {
  params: Promise<{ token: string }>;
}) {
  const params = await props.params;
  // Rate-limit on the token before any DB read, so a scraper can't hammer the
  // lookup + passport render. This is a Server Component, so it can't emit a 429
  // status or Retry-After header (that needs a route handler; Edge middleware
  // can't share this Node in-process Map) — on rejection we short-circuit with a
  // minimal chrome-less notice instead of the passport.
  const rl = checkRateLimit(`share:${params.token}`, {
    limit: SHARE_RATE_LIMIT,
    windowMs: SHARE_RATE_WINDOW_MS,
  });
  if (!rl.ok) {
    return (
      <div className="mx-auto min-h-screen max-w-3xl px-4 py-10">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Too many requests. Please try again in about {rl.retryAfterSec}{" "}
          seconds.
        </p>
      </div>
    );
  }

  const link = getShareLinkByToken(params.token);
  if (!link) notFound();
  if (shareLinkStatus(link, new Date()) !== "valid") notFound();

  // Audit the unauthenticated access by the link's id (never the raw token). No
  // login; the profile whose passport is exposed is the subject.
  recordAudit({
    profileId: link.profile_id,
    action: AUDIT_ACTIONS.shareLinkView,
    target: String(link.id),
  });

  // Episode share (issues #801/#856): a tokenized illness summary. A #856 link re-anchors
  // to the STABLE episode id (surviving boundary edits); pre-#856 links carry only the
  // situation + anchor date and resolve via the derived fallback. A stale anchor-only link
  // whose day no longer falls in any episode 404s (the documented graceful fallback).
  if (link.kind === "episode") {
    const episode =
      link.episode_id != null
        ? episodeForProfileId(link.profile_id, link.episode_id)
        : link.episode_situation && link.episode_anchor
          ? episodeForProfileSituationDate(
              link.profile_id,
              link.episode_situation,
              link.episode_anchor
            )
          : null;
    if (!episode) notFound();
    const assembled = assembleIllnessEpisode(link.profile_id, episode);
    return (
      <div className="mx-auto min-h-screen max-w-3xl px-4 py-6 sm:py-10">
        <div className="mb-4 flex items-center justify-end">
          <PrintButton />
        </div>
        <EpisodeSummary
          episode={assembled}
          generatedAt={new Date().toISOString()}
        />
      </div>
    );
  }

  const fields = parseShareFields(link.fields);
  const name = getProfileNameById(link.profile_id) ?? "Profile";
  const summary = getProfileSummary(link.profile_id, name);

  // A photo-less avatar profile: the authed /profile-photo route requires a
  // session, so a shared view always renders the initials fallback.
  const sharedProfile: AvatarProfile = {
    id: link.profile_id,
    name: summary.identity.name,
    photo_path: null,
    photo_version: 0,
  };

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-4 py-6 sm:py-10">
      <ProfilePassport
        summary={summary}
        profile={sharedProfile}
        weightUnit="kg"
        mode="share"
        fields={fields}
        generatedAt={new Date().toISOString()}
        expiresAt={link.expires_at}
      />
    </div>
  );
}
