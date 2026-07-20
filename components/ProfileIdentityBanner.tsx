import { IconArrowsExchange } from "@tabler/icons-react";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import SubmitButton from "@/components/SubmitButton";
import { switchProfileAction } from "@/app/(app)/user-actions";

// Identifies the data subject on a page that may be showing a non-active accessible
// profile. Switching is explicit: viewing another household member never silently
// changes the acting profile, while the standard session action re-checks access before
// making the switch.
export default function ProfileIdentityBanner({
  profile,
  crossProfile,
  testIdPrefix = "profile",
}: {
  profile: AvatarProfile;
  crossProfile: boolean;
  testIdPrefix?: string;
}) {
  return (
    <div
      data-testid={`${testIdPrefix}-identity-banner`}
      className="flex items-center gap-3 print:hidden"
    >
      <Avatar profile={profile} size="md" />
      <div className="min-w-0 flex-1">
        <div
          data-testid={`${testIdPrefix}-subject-name`}
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
            data-testid={`${testIdPrefix}-switch-profile`}
          >
            <IconArrowsExchange className="h-4 w-4" stroke={1.75} />
            Act as {profile.name}
          </SubmitButton>
        </form>
      )}
    </div>
  );
}
