import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { getUnitPrefs } from "@/lib/settings";
import { getProfileSummary } from "@/lib/profile-summary-load";
import { listShareLinks } from "@/lib/share-links-db";
import { parseShareFields, shareLinkStatus } from "@/lib/share-links";
import { PageHeader } from "@/components/ui";
import ProfilePassport from "@/components/ProfilePassport";
import PassportControls, {
  type ShareLinkView,
} from "@/components/PassportControls";

// The profile summary / "medical passport": a single read view of a
// profile's latest, most relevant health facts. force-dynamic because it reads
// the session's active profile and never caches one profile's data for another.
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

  return (
    <div>
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
        formatPrefs={getDisplayFormatPrefs(login.id)}
      />
    </div>
  );
}
