import { headers } from "next/headers";
import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import { getIntegration } from "@/lib/integrations/registry";
import { getCalendarFeed, getPublicUrl, getTimezone } from "@/lib/settings";
import { tokenLifecycleStatus } from "@/lib/token-lifecycle";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getAppointments } from "@/lib/queries";
import { selectFeedPreviewRows } from "@/lib/calendar-ics";
import CalendarFeedConfig from "./CalendarFeedConfig";
import CalendarFeedPreview from "./CalendarFeedPreview";

export const dynamic = "force-dynamic";

// Configured public URL (Settings → Public app URL) when set, else derived from
// the request headers — same helper the Health Connect setup page uses. This is
// the base an external calendar client must be able to reach.
function baseUrl(): string {
  const configured = getPublicUrl();
  if (configured) return configured;
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export default function CalendarFeedPage() {
  const { profile } = requireSession();
  const def = getIntegration("calendar-feed")!;
  const feed = getCalendarFeed(profile.id);

  // Build the preview from the SAME inputs the live feed route uses — the same
  // profile-scoped query (getAppointments), the same `today`/timezone, and the
  // saved detail level — through the shared pure selection + mapping, so the
  // preview can't drift from what a subscribed calendar actually receives. This
  // reflects the SAVED detail regardless of whether the feed is currently
  // enabled, so the user can decide what to expose before turning it on.
  const previewRows = selectFeedPreviewRows(getAppointments(profile.id), {
    today: today(profile.id),
    tz: getTimezone(profile.id),
    detail: feed.detail,
  });

  return (
    <div>
      <Link
        href="/data"
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <IconArrowLeft className="h-4 w-4" /> Data
      </Link>

      <PageHeader title={def.name} subtitle={def.blurb} />

      <div className="grid max-w-3xl gap-6">
        <CalendarFeedConfig
          enabled={feed.enabled}
          detail={feed.detail}
          baseUrl={baseUrl()}
          status={tokenLifecycleStatus(
            {
              hasToken: feed.hasToken,
              createdAt: feed.createdAt,
              expiresAt: feed.expiresAt,
            },
            Date.now()
          )}
          createdAt={feed.createdAt}
          lastUsedAt={feed.lastUsedAt}
          expiresAt={feed.expiresAt}
        />

        <CalendarFeedPreview rows={previewRows} detail={feed.detail} />

        <div className="card space-y-3 text-sm text-slate-600 dark:text-slate-300">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            How to subscribe
          </h2>
          <ol className="list-decimal space-y-2 pl-5">
            <li>Enable the feed above and copy the subscribe URL.</li>
            <li>
              In <strong>Google Calendar</strong> → Other calendars →{" "}
              <em>From URL</em>, or <strong>Apple Calendar</strong> → File →{" "}
              <em>New Calendar Subscription</em>, or <strong>Outlook</strong> →
              Add calendar → <em>Subscribe from web</em> — paste the URL.
            </li>
            <li>
              Your scheduled medical appointments appear with a 1-day and 1-hour
              reminder each. Cancelled visits propagate as cancellations; the
              calendar app refreshes on its own schedule (often every few
              hours).
            </li>
          </ol>
          <p className="text-xs text-slate-400 dark:text-slate-500">
            Keep this link private — anyone with it can see this profile&apos;s
            appointment schedule. Regenerate it at any time to revoke the old
            link. By default the feed shows only &ldquo;Medical
            appointment&rdquo; with no provider or reason.
          </p>
        </div>
      </div>
    </div>
  );
}
