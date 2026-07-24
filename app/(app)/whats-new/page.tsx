import { requireSession } from "@/lib/auth";
import PageContainer from "@/components/PageContainer";
import { PageHeader } from "@/components/ui";
import AppVersion from "@/components/AppVersion";
import MarkWhatsNewSeen from "@/components/MarkWhatsNewSeen";
import { getDisplayFormatPrefs, getWhatsNewSeenDate } from "@/lib/settings";
import { formatLongDate } from "@/lib/format-date";
import {
  hasUnseenNotes,
  issueUrl,
  loadReleaseNotes,
  newestNoteDate,
  pullRequestUrl,
  type ReleaseNoteKind,
} from "@/lib/release-notes";

export const dynamic = "force-dynamic";

// The bundled "What's new" surface (issue #1421). Reads the checked-in, curated
// lib/release-notes.json — so an operator who just pulled a new image can see what
// it brought without leaving the app or reaching GitHub — and pairs it with the
// running build hash, keeping "what am I running" and "what's new" together.
//
// Visiting marks the notes seen for the CALLING LOGIN (login_settings), which is
// what clears the unread dot beside the version hash in the sidebar footer and on
// Settings → Preferences. Notes are per-image content, not per-profile data, so
// nothing here is profile-scoped.

// Kind chips. Each kind gets its OWN color (never one family color, #533) so the
// classification is readable at a glance; an entry with no kind renders no chip.
const KIND_CHIP: Record<ReleaseNoteKind, { label: string; className: string }> =
  {
    feature: {
      label: "New",
      className:
        "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30",
    },
    fix: {
      label: "Fix",
      className: "bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/30",
    },
    security: {
      label: "Security",
      className:
        "bg-amber-500/10 text-amber-800 dark:text-amber-300 ring-amber-500/30",
    },
    perf: {
      label: "Faster",
      className:
        "bg-violet-500/10 text-violet-700 dark:text-violet-300 ring-violet-500/30",
    },
  };

export default async function WhatsNewPage() {
  const { login } = await requireSession();
  const notes = loadReleaseNotes();
  const prefs = getDisplayFormatPrefs(login.id);
  // Mount the seen-marker writer only when there IS something unseen, so a repeat
  // visit issues no write at all. Same one comparison the dot uses.
  const unseen = hasUnseenNotes(
    newestNoteDate(notes),
    getWhatsNewSeenDate(login.id)
  );

  return (
    <PageContainer width="reading" className="mx-auto space-y-6">
      {unseen && <MarkWhatsNewSeen />}
      <PageHeader
        title="What's new"
        subtitle={
          <>
            Changes included in this build. Running{" "}
            <span data-testid="whats-new-version">
              <AppVersion />
            </span>
            {"."}
          </>
        }
      />
      {notes.days.length === 0 ? (
        <div className="card text-sm text-slate-600 dark:text-slate-300">
          No release notes are bundled with this build yet.
        </div>
      ) : (
        <div className="space-y-6" data-testid="whats-new-days">
          {notes.days.map((day) => (
            <section
              key={day.date}
              className="card space-y-4"
              data-testid="whats-new-day"
              data-date={day.date}
            >
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {formatLongDate(day.date, prefs)}
              </h2>
              <ul className="space-y-4">
                {day.entries.map((entry) => {
                  const chip = entry.kind ? KIND_CHIP[entry.kind] : null;
                  return (
                    <li
                      key={entry.pr}
                      className="space-y-1"
                      data-testid="whats-new-entry"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {chip && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${chip.className}`}
                          >
                            {chip.label}
                          </span>
                        )}
                        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {entry.title}
                        </span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap text-slate-600 dark:text-slate-300">
                        {entry.body}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                        {/* Repo links are EXTERNAL URLs, so plain strings (#285). */}
                        <a
                          href={pullRequestUrl(entry.pr)}
                          target="_blank"
                          rel="noreferrer"
                          className="underline-offset-2 hover:text-slate-700 hover:underline dark:hover:text-slate-200"
                        >
                          #{entry.pr}
                        </a>
                        {entry.issues.map((issue) => (
                          <a
                            key={issue}
                            href={issueUrl(issue)}
                            target="_blank"
                            rel="noreferrer"
                            className="underline-offset-2 hover:text-slate-700 hover:underline dark:hover:text-slate-200"
                          >
                            issue #{issue}
                          </a>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {day.operatorNotes.length > 0 && (
                <div
                  className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
                  data-testid="whats-new-operator-notes"
                >
                  <h3 className="text-xs font-semibold tracking-wide text-amber-800 uppercase dark:text-amber-300">
                    For the operator
                  </h3>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-slate-700 dark:text-slate-300">
                    {day.operatorNotes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
