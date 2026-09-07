import { notFound } from "next/navigation";
import BackLink from "@/components/BackLink";
import PageContainer from "@/components/PageContainer";
import NotesText from "@/components/NotesText";
import { PageHeader } from "@/components/ui";
import { accessForProfile, requireSession } from "@/lib/auth";
import { getUnitPrefs, getDisplayFormatPrefs } from "@/lib/settings";
import { getEventDay } from "@/lib/queries";
import { eventDetail, eventKindLabel, eventTitle } from "@/lib/endurance-plan";
import { formatLongDate } from "@/lib/format-date";
import { formatElapsed } from "@/lib/session-detail";
import { fmtDistance } from "@/lib/units";
import { trainingActivityPageHref } from "@/lib/hrefs";
import EventActivities, { type EventActivityView } from "./EventActivities";
import TrainingPhotoStrip from "@/components/training/TrainingPhotoStrip";
import { getEventPhotos } from "@/lib/training-photo-write";

export const dynamic = "force-dynamic";

// One event's page (#3285 item 2): the plan, the day and the result in one place.
// The Overview card and the timeline row both open here; the card keeps its
// countdown and trajectory, this page keeps what happened.
export default async function TrainingEventPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await props.params;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const { login, profile } = await requireSession();
  const day = getEventDay(profile.id, id);
  if (!day) notFound();
  const { plan } = day;
  const units = getUnitPrefs(login.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const km = (n: number) => fmtDistance(n, units.distanceUnit);
  const canWrite =
    accessForProfile(login.id, login.role, profile.id) === "write";

  const dayLabel = formatLongDate(plan.eventDate, formatPrefs, {
    year: "always",
  });
  const target = [
    eventDetail(plan, km),
    plan.targetTimeSec != null && `target ${formatElapsed(plan.targetTimeSec)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const status =
    plan.status === "completed"
      ? `Completed${plan.completedOn ? ` ${formatLongDate(plan.completedOn, formatPrefs, { year: "always" })}` : ""}`
      : plan.status === "abandoned"
        ? "Abandoned"
        : "Planned";

  const activities: EventActivityView[] = day.activities.map((a) => ({
    id: a.id,
    href: trainingActivityPageHref(a.id),
    title: a.title,
    meta: [
      a.distanceKm != null && a.distanceKm > 0 && km(a.distanceKm),
      a.durationMin != null && a.durationMin > 0
        ? formatElapsed(a.durationMin * 60)
        : null,
      a.workoutType,
      a.date !== plan.eventDate && formatLongDate(a.date, formatPrefs),
    ]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" · "),
    linked: a.linked,
    linkedElsewhere: a.linkedElsewhere,
  }));

  return (
    <PageContainer width="reading" className="mx-auto">
      <BackLink href="/training" label="Training" />
      <PageHeader
        title={eventTitle(plan, km)}
        subtitle={
          <span data-testid="event-summary">
            {eventKindLabel(plan.kind)} · {dayLabel} · {status}
            {target ? ` · ${target}` : ""}
          </span>
        }
      />
      {plan.notes && (
        <NotesText
          notes={plan.notes}
          className="mb-4 text-sm text-slate-600 dark:text-slate-300"
        />
      )}
      <EventActivities
        planId={plan.id}
        status={plan.status}
        dayLabel={dayLabel}
        activities={activities}
        canWrite={canWrite}
      />
      {/* The event's own uploads AND its linked activities' — item 3's own sentence,
          answered by one query rather than two lists stitched together, because it is
          one set of pictures from one day. New uploads land on the EVENT. */}
      <div className="mt-6">
        <TrainingPhotoStrip
          owner={{ kind: "event", planId: plan.id }}
          photos={getEventPhotos(profile.id, plan.id).map((p) => ({
            id: p.id,
            date: p.date,
            caption: p.caption,
            ownerLabel: p.planId != null ? "Event" : p.ownerLabel,
          }))}
          canWrite={canWrite}
        />
      </div>
    </PageContainer>
  );
}
