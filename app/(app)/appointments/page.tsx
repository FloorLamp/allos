import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getAppointments, getProviderNames } from "@/lib/queries";
import { isRealIsoDate } from "@/lib/date";
import { isAppointmentKind } from "@/lib/preventive-appointment";
import ProviderDatalist from "@/components/ProviderDatalist";
import { PageHeader, EmptyState } from "@/components/ui";
import AppointmentForm from "./AppointmentForm";
import AppointmentList from "./AppointmentList";
import { createAppointment } from "./actions";

export const dynamic = "force-dynamic";

// A single value from the (string | string[]) searchParams shape.
function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || null;
}

export default async function AppointmentsPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  const now = today(profile.id);
  const appointments = getAppointments(profile.id);
  const providerNames = getProviderNames();

  // Prefill the create form from a preventive "Book" CTA (issue #85): the item's
  // title + mapped visit kind + suggested date arrive as query params. Only build a
  // prefill when at least a title or kind is present; a lone ?new=1 (command
  // palette) just focuses the empty form. The date param, when a real ISO date,
  // seeds the form's default date.
  const ctaTitle = one(searchParams.title);
  const ctaKindRaw = one(searchParams.kind);
  const ctaKind = isAppointmentKind(ctaKindRaw) ? ctaKindRaw : null;
  const ctaDate = one(searchParams.date);
  const prefillDate = ctaDate && isRealIsoDate(ctaDate) ? ctaDate : now;
  const bookPrefill =
    ctaTitle || ctaKind
      ? { title: ctaTitle, provider: null, location: null, kind: ctaKind }
      : undefined;

  // Split scheduled (future-facing, still on Upcoming) from the settled history so
  // the active list stays actionable. getAppointments returns soonest-first.
  const scheduled = appointments.filter((a) => a.status === "scheduled");
  const past = appointments.filter((a) => a.status !== "scheduled");
  const upcomingCount = scheduled.filter(
    (a) => a.scheduled_at.slice(0, 10) >= now
  ).length;

  return (
    <div>
      {/* Shared provider picker options for the add + edit forms. */}
      <ProviderDatalist names={providerNames} />
      <PageHeader
        title="Appointments"
        subtitle="Scheduled medical visits. Upcoming ones also surface on your Upcoming page; complete or cancel one to clear it."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <section>
            <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Scheduled
              {scheduled.length > 0 && (
                <span className="text-slate-400 dark:text-slate-500">
                  ({upcomingCount} upcoming)
                </span>
              )}
            </h2>
            {scheduled.length === 0 ? (
              <EmptyState message="No scheduled appointments. Add one to see it here and on Upcoming." />
            ) : (
              <AppointmentList items={scheduled} defaultDate={now} />
            )}
          </section>

          {past.length > 0 && (
            <details className="card">
              <summary className="cursor-pointer font-semibold text-slate-800 dark:text-slate-100">
                Completed &amp; cancelled{" "}
                <span className="text-sm font-normal text-slate-400">
                  ({past.length})
                </span>
              </summary>
              <div className="mt-3">
                <AppointmentList items={past} defaultDate={now} />
              </div>
            </details>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <AppointmentForm
            action={createAppointment}
            defaultDate={bookPrefill ? prefillDate : now}
            prefill={bookPrefill}
          />
        </div>
      </div>
    </div>
  );
}
