import { IconArrowsExchange } from "@tabler/icons-react";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import SubmitButton from "@/components/SubmitButton";
import { switchProfileAction } from "@/app/(app)/user-actions";

// Whose episode this is, rendered ON the page (issues #879 / #531 / #534). The episode
// page can now show ANY accessible profile's episode (a caregiver opening a household
// member's illness from the hero), so identity can no longer be inferred from how you got
// here: the subject's Avatar + name lead the page ALWAYS, so with several kids sick you
// can't read the wrong child's story by mistake.
//
// When the subject isn't the acting profile, an explicit "Act as <name>" affordance
// switches the acting context — the SAME setActiveProfile machinery the header switcher
// uses (switchProfileAction re-checks accessibility). It is NEVER automatic (#879): the
// page stays a cross-profile READ until the caregiver chooses to switch.
export default function EpisodeIdentityBanner({
  profile,
  crossProfile,
}: {
  profile: AvatarProfile;
  crossProfile: boolean;
}) {
  return (
    <div
      data-testid="episode-identity-banner"
      className="flex items-center gap-3 print:hidden"
    >
      <Avatar profile={profile} size="md" />
      <div className="min-w-0 flex-1">
        <div
          data-testid="episode-subject-name"
          className="truncate text-lg font-semibold text-slate-800 dark:text-slate-100"
        >
          {profile.name}
        </div>
      </div>
      {crossProfile && (
        <form action={switchProfileAction}>
          <input type="hidden" name="profileId" value={profile.id} />
          <SubmitButton
            className="btn-ghost shrink-0"
            pendingLabel="Switching…"
            data-testid="episode-switch-profile"
          >
            <IconArrowsExchange className="h-4 w-4" stroke={1.75} />
            Act as {profile.name}
          </SubmitButton>
        </form>
      )}
    </div>
  );
}
