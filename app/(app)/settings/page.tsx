import { getWhatsNewSeenDate } from "@/lib/settings";
import {
  hasUnseenNotes,
  loadReleaseNotes,
  newestNoteDate,
} from "@/lib/release-notes";
import { requireSession } from "@/lib/auth";
import {
  visibleSettingsGroups,
  tierBlurb,
  tierChip,
} from "@/lib/settings-groups";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import AppVersion from "@/components/AppVersion";
import WhatsNewLink from "@/components/WhatsNewLink";
import { settingsGroupContext } from "./SettingsGroupLayout";

export const dynamic = "force-dynamic";

// The Settings INDEX (#1462) — the one navigation system, rendered on EVERY viewport.
//
// It replaced three: a top tab strip, the Profile tab's anchor jump-nav, and the
// admin pill row. That collapse is also what fixed #1451.C — the admin groups used to
// be tab entries that clipped off the right edge of a 390px viewport with no
// affordance that more tabs existed; as index rows they are structurally
// discoverable, no scroll hint required.
//
// Rows are grouped member-then-admin and come straight from the registry, so a new
// group shows up here and in the group pages' left nav together or not at all.
export default async function SettingsIndexPage() {
  const { login, profile } = await requireSession();
  const groups = visibleSettingsGroups(settingsGroupContext(login, profile));
  const memberGroups = groups.filter((g) => !g.adminOnly);
  const adminGroups = groups.filter((g) => g.adminOnly);
  // Same ONE unread comparison the app shell uses for the sidebar dot (#1421).
  const whatsNewUnseen = hasUnseenNotes(
    newestNoteDate(loadReleaseNotes()),
    getWhatsNewSeenDate(login.id)
  );

  return (
    <PageContainer width="reading">
      <PageHeader
        title="Settings"
        subtitle={`Signed in as ${login.username}, viewing ${profile.name}. Each group says who it applies to.`}
      />

      <ul className="space-y-2" data-testid="settings-index">
        {memberGroups.map((g) => (
          <li key={g.id}>
            <Link
              href={g.route}
              data-testid={`settings-group-${g.id}`}
              className="card block transition-colors hover:border-brand-400/60 hover:bg-slate-50 dark:hover:bg-ink-800"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {g.label}
                </span>
                <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                  {tierChip(g.tier, {
                    username: login.username,
                    profileName: profile.name,
                  })}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {g.summary}
              </p>
            </Link>
          </li>
        ))}
      </ul>

      {adminGroups.length > 0 && (
        <section className="mt-8" data-testid="settings-index-admin">
          <h2 className="section-label">Administration</h2>
          <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
            {tierBlurb("server", {
              username: login.username,
              profileName: profile.name,
            })}
          </p>
          <ul className="space-y-2">
            {adminGroups.map((g) => (
              <li key={g.id}>
                <Link
                  href={g.route}
                  data-testid={`settings-group-${g.id}`}
                  className="card block transition-colors hover:border-brand-400/60 hover:bg-slate-50 dark:hover:bg-ink-800"
                >
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {g.label}
                  </span>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {g.summary}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-black/10 pt-4 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
        <span>
          Version <AppVersion />
        </span>
        <span aria-hidden>·</span>
        {/* The bundled release notes sit right next to the version they describe
        (issue #1421); the dot is the same login-scoped unread verdict the sidebar
        footer shows, and opening the page clears it. */}
        <WhatsNewLink unseen={whatsNewUnseen} />
        <span aria-hidden>·</span>
        <Link
          href="/disclaimer"
          className="underline-offset-2 hover:text-slate-700 hover:underline dark:hover:text-slate-200"
        >
          Disclaimer
        </Link>
      </footer>
    </PageContainer>
  );
}
