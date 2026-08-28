import { PageHeader } from "@/components/ui";
import LeadFold from "@/components/LeadFold";
import PageContainer from "@/components/PageContainer";
import { getIntegration } from "@/lib/integrations/registry";
import {
  getCalendarFeed,
  getConsolidatedCalendarFeed,
  getTimezone,
  getMentalHealthShareFull,
} from "@/lib/settings";
import { tokenLifecycleStatus } from "@/lib/token-lifecycle";
import { requireSession, getAccessibleProfiles } from "@/lib/auth";
import { dateFromCreatedAt } from "@/lib/timeline-format";
import { today } from "@/lib/db";
import { getAppointments, collectUpcoming } from "@/lib/queries";
import {
  composeFeedPreviewRows,
  feedEligibleSignals,
  selectConsolidatedPreviewRows,
  groupConsolidatedPreviewRows,
  type ConsolidatedProfileFeed,
} from "@/lib/calendar-ics";
import CalendarFeedConfig from "./CalendarFeedConfig";
import CalendarFeedPreview from "./CalendarFeedPreview";
import ConsolidatedFeedConfig from "./ConsolidatedFeedConfig";
import ConsolidatedFeedPreview from "./ConsolidatedFeedPreview";
import { requestNowMs } from "@/lib/request-now";
// The base an external calendar client must be able to reach — one authority,
// shared with Health Connect, Strava and Withings (#2959).
import { externalBaseUrl } from "@/lib/external-url-server";
import BackLink from "@/components/BackLink";
import SetupStepsCard from "@/components/integrations/SetupStepsCard";

export const dynamic = "force-dynamic";

export default async function CalendarFeedPage() {
  const { profile, login } = await requireSession();
  const nowMs = requestNowMs();
  const def = getIntegration("calendar-feed")!;
  const feed = getCalendarFeed(profile.id);

  // Build the preview from the SAME inputs the live feed route uses — the same
  // profile-scoped reads (getAppointments + the Upcoming aggregation) and the same
  // saved options (categories/detail/reminders/window) — through the shared pure
  // composer, so the preview can't drift from what a subscribed calendar actually
  // receives. It reflects the SAVED options regardless of whether the feed is
  // currently enabled, so the user can decide what to expose before turning it on.
  // The heavier Upcoming read only runs when a non-appointment category is enabled.
  const profileToday = today(profile.id);
  // The zone a token's expiry DAY is named in (#3573). The instant reaches
  // tokenLifecycleStatus below, which is instant arithmetic and correct as it is; only
  // the printed day needs a calendar, and this profile's is the one the rest of the
  // page already uses.
  const timeZone = getTimezone(profile.id);
  const wantsAppointments = feed.categories.includes("appointment");
  const wantsSignals = feed.categories.some((c) => c !== "appointment");
  const previewRows = composeFeedPreviewRows({
    appointments: wantsAppointments ? getAppointments(profile.id) : [],
    signals: wantsSignals
      ? feedEligibleSignals(collectUpcoming(profile.id, profileToday))
      : [],
    today: profileToday,
    tz: getTimezone(profile.id),
    options: {
      categories: feed.categories,
      detail: feed.detail,
      reminders: feed.reminders,
      pastWindowDays: feed.pastWindowDays,
      futureWindowDays: feed.futureWindowDays,
      mentalHealthShareFull: getMentalHealthShareFull(profile.id),
    },
  });

  // Consolidated "family" feed: one merged view across EVERY profile this login can
  // access (getAccessibleProfiles includes read-only grants — reading appointments
  // is a read). Each profile contributes its own detail level + timezone + day
  // boundary through the SAME pure selection the family feed route uses, so the
  // preview can't drift from what the .ics serves. The feed token itself is
  // login-scoped (login_settings), so its lifecycle is keyed by login.id.
  const accessible = await getAccessibleProfiles();
  const familyFeed = getConsolidatedCalendarFeed(login.id);
  const familyFeeds: ConsolidatedProfileFeed[] = accessible.map((p) => {
    // Each profile's OWN full feed customization (issue #473), mirroring the family
    // feed route so the preview can't drift from the served .ics.
    const pFeed = getCalendarFeed(p.id);
    const pToday = today(p.id);
    const pWantsAppointments = pFeed.categories.includes("appointment");
    const pWantsSignals = pFeed.categories.some((c) => c !== "appointment");
    return {
      profileId: p.id,
      profileName: p.name,
      options: {
        categories: pFeed.categories,
        detail: pFeed.detail,
        reminders: pFeed.reminders,
        pastWindowDays: pFeed.pastWindowDays,
        futureWindowDays: pFeed.futureWindowDays,
        mentalHealthShareFull: getMentalHealthShareFull(p.id),
      },
      tz: getTimezone(p.id),
      today: pToday,
      appts: pWantsAppointments ? getAppointments(p.id) : [],
      signals: pWantsSignals
        ? feedEligibleSignals(collectUpcoming(p.id, pToday))
        : [],
    };
  });
  const familyRows = selectConsolidatedPreviewRows(familyFeeds);
  const familyGroups = groupConsolidatedPreviewRows(familyRows);

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="integration-page"
    >
      <BackLink href="/data" label="Data" />

      <PageHeader title={def.name} />

      {/* One sentence, then the mechanics behind a fold (copy.md rule 10 /
          #3490). The registry carries the split; every integration page renders
          it the same way, so the intro cannot drift per source. */}
      <LeadFold
        lead={def.lead}
        detail={def.detail}
        summary="How it works"
        testId="integration-intro"
        className="mb-6"
      />

      <div className="grid gap-6">
        <CalendarFeedConfig
          enabled={feed.enabled}
          detail={feed.detail}
          categories={feed.categories}
          reminders={feed.reminders}
          pastWindowDays={feed.pastWindowDays}
          futureWindowDays={feed.futureWindowDays}
          baseUrl={await externalBaseUrl()}
          status={tokenLifecycleStatus(
            {
              hasToken: feed.hasToken,
              createdAt: feed.createdAt,
              expiresAt: feed.expiresAt,
            },
            nowMs
          )}
          createdAt={feed.createdAt}
          lastUsedAt={feed.lastUsedAt}
          expiresOnDay={dateFromCreatedAt(feed.expiresAt, timeZone)}
        />

        <CalendarFeedPreview rows={previewRows} detail={feed.detail} />

        <SetupStepsCard
          title="How to subscribe"
          steps={[
            <>Enable the feed above and copy the subscribe URL.</>,
            <>
              In <strong>Google Calendar</strong> → Other calendars →{" "}
              <em>From URL</em>, or <strong>Apple Calendar</strong> → File →{" "}
              <em>New Calendar Subscription</em>, or <strong>Outlook</strong> →
              Add calendar → <em>Subscribe from web</em> — paste the URL.
            </>,
            <>
              Your scheduled medical appointments appear with a 1-day and 1-hour
              reminder each. Cancelled visits propagate as cancellations; the
              calendar app refreshes on its own schedule (often every few
              hours).
            </>,
          ]}
          note={
            <>
              Keep this link private — anyone with it can see this
              profile&apos;s appointment schedule. Regenerate it at any time to
              revoke the old link. By default the feed shows only &ldquo;Medical
              appointment&rdquo; with no sourceId or reason.
            </>
          }
        />

        <div className="mt-2 border-t border-black/5 pt-6 dark:border-white/5">
          <h2 className="mb-1 text-lg font-semibold text-slate-900 dark:text-slate-50">
            Family calendar
          </h2>
          <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
            One consolidated feed and preview across every profile you can
            access — instead of subscribing to each profile&apos;s feed
            separately.
          </p>

          <div className="grid gap-6">
            <ConsolidatedFeedConfig
              enabled={familyFeed.enabled}
              baseUrl={await externalBaseUrl()}
              status={tokenLifecycleStatus(
                {
                  hasToken: familyFeed.hasToken,
                  createdAt: familyFeed.createdAt,
                  expiresAt: familyFeed.expiresAt,
                },
                nowMs
              )}
              createdAt={familyFeed.createdAt}
              lastUsedAt={familyFeed.lastUsedAt}
              expiresOnDay={dateFromCreatedAt(familyFeed.expiresAt, timeZone)}
              profileCount={accessible.length}
            />

            <ConsolidatedFeedPreview
              groups={familyGroups}
              totalRows={familyRows.length}
            />
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
