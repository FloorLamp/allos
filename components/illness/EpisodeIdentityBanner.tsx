import type { AvatarProfile } from "@/components/Avatar";
import ProfileIdentityBanner from "@/components/ProfileIdentityBanner";

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
    <ProfileIdentityBanner
      profile={profile}
      crossProfile={crossProfile}
      testIdPrefix="episode"
    />
  );
}
