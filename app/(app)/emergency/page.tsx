import Link from "next/link";
import { IconSettings } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { getEmergencyCardEnabled, getUnitPrefs } from "@/lib/settings";
import { getEmergencyCard } from "@/lib/emergency-card-load";
import { PageHeader } from "@/components/ui";
import EmergencyCardView from "@/components/EmergencyCardView";
import EmergencyCardCacher from "@/components/EmergencyCardCacher";
import EmergencyPrintButton from "@/components/EmergencyPrintButton";

// The offline Emergency Card (issue #42). Reads the active profile, so it's
// force-dynamic and never cached across profiles. When the per-profile opt-in is
// ON, it assembles the card server-side (the same facts as the Health Passport)
// and mounts EmergencyCardCacher to refresh the offline localStorage copy; when
// OFF it shows an opt-in prompt and mounts the cacher with a null payload to purge
// any previously-cached copy.
export const dynamic = "force-dynamic";

export default async function EmergencyCardPage() {
  const { login, profile } = await requireSession();
  const enabled = getEmergencyCardEnabled(profile.id);
  const card = enabled
    ? getEmergencyCard(
        profile.id,
        profile.name,
        new Date().toISOString(),
        getUnitPrefs(login.id).temperatureUnit
      )
    : null;

  return (
    <div>
      <PageHeader
        title="Emergency Card"
        subtitle="A terse, printable summary — allergies, medications, conditions, blood type, and who to call — that stays readable offline when it matters most."
        action={enabled ? <EmergencyPrintButton /> : undefined}
      />

      {/* Refresh (or purge) the offline copy on every authenticated visit. */}
      <EmergencyCardCacher profileId={profile.id} card={card} />

      {enabled && card ? (
        <EmergencyCardView card={card} />
      ) : (
        <div className="mx-auto max-w-2xl rounded-xl border border-black/10 bg-white/80 p-6 dark:border-white/10 dark:bg-ink-900/60">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            Offline emergency card is off
          </h2>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Turn it on to keep an offline-readable copy of {profile.name}
            &rsquo;s allergies, active medications, conditions, blood type, and
            emergency contact on this device — so it&rsquo;s available the
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
    </div>
  );
}
