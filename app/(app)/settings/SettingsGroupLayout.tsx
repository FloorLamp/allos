import type { ReactNode } from "react";
import Link from "next/link";
import {
  settingsGroup,
  tierBlurb,
  visibleSettingsGroups,
  type SettingsGroupContext,
  type SettingsGroupId,
} from "@/lib/settings-groups";
import { isTrainingRestricted } from "@/lib/age-gate";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { getProfileAge } from "@/lib/settings";
import type { SessionLogin, SessionProfile } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import SettingsGroupNav from "./SettingsGroupNav";
import SettingsSubPageNav from "./SettingsSubPageNav";

// Which groups this viewer sees, resolved once from the session (#1462). Nav
// visibility only — `adminOnly` here never stands in for an auth check: every admin
// group page calls requireAdmin() itself, so a member typing the URL is redirected
// exactly as before the reshuffle.
export function settingsGroupContext(
  login: Pick<SessionLogin, "role">,
  profile: Pick<SessionProfile, "id">
): SettingsGroupContext {
  return {
    isAdmin: login.role === "admin",
    trainingRelevant: !isTrainingRestricted(profile.id),
    nutritionRelevant: isFoodLoggingRelevant(getProfileAge(profile.id)),
  };
}

// The chrome every settings group page wears (#1462): a breadcrumb back to the
// index, the group's own title, its TIER stated as a subtitle label (tiers are the
// storage architecture; topic is the presentation), the desktop group nav, and — for
// a group with sub-pages — the one sub-page strip.
export default function SettingsGroupLayout({
  group: groupId,
  login,
  profile,
  children,
}: {
  group: SettingsGroupId;
  login: Pick<SessionLogin, "role" | "username">;
  profile: Pick<SessionProfile, "id" | "name">;
  children: ReactNode;
}) {
  const group = settingsGroup(groupId);
  const groups = visibleSettingsGroups(settingsGroupContext(login, profile));
  return (
    <div className="gap-8 lg:grid lg:grid-cols-[14rem_1fr]">
      <div className="lg:sticky lg:top-4 lg:self-start">
        <SettingsGroupNav groups={groups} />
      </div>
      <div className="min-w-0">
        <nav className="mb-2 text-sm" aria-label="Breadcrumb">
          <Link
            href="/settings"
            data-testid="settings-breadcrumb"
            className="text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
          >
            ← All settings
          </Link>
        </nav>
        {/* The group's own title through the ONE shared PageHeader — the tier is
            stated as its subtitle (topic is the architecture, tier is a label). */}
        <PageHeader
          title={group.label}
          subtitle={
            <span data-testid="settings-tier-blurb">
              {tierBlurb(group.tier, {
                username: login.username,
                profileName: profile.name,
              })}
            </span>
          }
        />
        {group.pages && <SettingsSubPageNav pages={group.pages} />}
        {children}
      </div>
    </div>
  );
}
