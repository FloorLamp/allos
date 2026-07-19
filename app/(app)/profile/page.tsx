import Link from "next/link";
import { IconSettings } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import {
  getDisplayFormatPrefs,
  getEmergencyCardEnabled,
  getUnitPrefs,
} from "@/lib/settings";
import { getProfileSummary } from "@/lib/profile-summary-load";
import { getEmergencyCard } from "@/lib/emergency-card-load";
import { listShareLinks } from "@/lib/share-links-db";
import { parseShareFields, shareLinkStatus } from "@/lib/share-links";
import { PageHeader } from "@/components/ui";
import ProfilePassport from "@/components/ProfilePassport";
import PassportControls, {
  type ShareLinkView,
} from "@/components/PassportControls";
import EmergencyCardView from "@/components/EmergencyCardView";
import EmergencyCardCacher from "@/components/EmergencyCardCacher";
import EmergencyPrintButton from "@/components/EmergencyPrintButton";

// The profile summary / "medical passport": a single read view of a
// profile's latest, most relevant health facts — with the offline Emergency
// Card (issue #42) stacked below as its own anchored section (#1042 phase 3:
// both are print/share artifacts over the same records, so they share one
// page; each keeps a scoped print — see components/print-scope.ts). The old
// /emergency route 308-redirects here (next.config.js) with the #emergency
// anchor. force-dynamic because it reads the session's active profile and
// never caches one profile's data for another.
//
// Offline contract (unchanged by the merge): when the per-profile opt-in is ON,
// the card is assembled server-side and EmergencyCardCacher refreshes the
// offline localStorage copy on every authenticated visit; when OFF, the cacher
// mounts with a null payload to purge any previously-cached copy. The
// session-free reader is the service-worker-precached /offline page, which
// reads localStorage directly — no route dependency, so removing /emergency
// leaves the no-login/no-network readability intact.
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const { login, profile } = await requireSession();
  const units = getUnitPrefs(login.id);
  const summary = getProfileSummary(profile.id, profile.name);
  const generatedAt = new Date().toISOString();

  const links: ShareLinkView[] = listShareLinks(profile.id).map((l) => ({
    id: l.id,
    fields: parseShareFields(l.fields),
    status: shareLinkStatus(l, new Date()),
    expiresAt: l.expires_at,
    createdAt: l.created_at,
  }));

  const emergencyEnabled = getEmergencyCardEnabled(profile.id);
  const card = emergencyEnabled
    ? getEmergencyCard(
        profile.id,
        profile.name,
        generatedAt,
        units.temperatureUnit,
        getDisplayFormatPrefs(login.id).timeFormat
      )
    : null;

  return (
    <div>
      <div data-print-region="passport">
        <PageHeader
          title="Health Passport"
          subtitle={`${profile.name}’s at-a-glance summary — print it or share a read-only link for a provider, coach, or first responder.`}
          action={<PassportControls links={links} />}
        />
        <ProfilePassport
          summary={summary}
          profile={profile}
          weightUnit={units.weightUnit}
          mode="app"
          fields="all"
          generatedAt={generatedAt}
        />
      </div>

      {/* Refresh (or purge) the offline copy on every authenticated visit. */}
      <EmergencyCardCacher profileId={profile.id} card={card} />

      <section
        id="emergency"
        data-testid="emergency-section"
        data-print-region="emergency"
        className="mt-10 scroll-mt-20"
      >
        <div className="mb-6 flex items-end justify-between gap-4 print:hidden">
          <div>
            <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
              Emergency Card
            </h2>
            <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              A terse, printable summary — allergies, medications, conditions,
              blood type, and who to call — that stays readable offline when it
              matters most.
            </div>
          </div>
          {emergencyEnabled && card ? <EmergencyPrintButton /> : null}
        </div>

        {emergencyEnabled && card ? (
          <EmergencyCardView card={card} />
        ) : (
          <div className="mx-auto max-w-2xl rounded-xl border border-black/10 bg-white/80 p-6 dark:border-white/10 dark:bg-ink-900/60">
            <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
              Offline emergency card is off
            </h3>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Turn it on to keep an offline-readable copy of {profile.name}
              &rsquo;s allergies, active medications, conditions, blood type,
              and emergency contact on this device — so it&rsquo;s available the
              moment it&rsquo;s needed, even with no signal. It&rsquo;s off by
              default: the copy is readable on this device without logging in
              (that&rsquo;s the point in an emergency, but also the trade-off if
              the phone is lost while unlocked).
            </p>
            <Link
              href="/medical/background#emergency-card"
              className="btn mt-4 inline-flex w-fit"
            >
              <IconSettings className="h-4 w-4" stroke={1.75} />
              Enable in Medical → Background
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
