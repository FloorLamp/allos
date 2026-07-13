import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getAppointments,
  getEncounters,
  getProviderNames,
} from "@/lib/queries";
import { isRealIsoDate } from "@/lib/date";
import { isAppointmentKind } from "@/lib/preventive-appointment";
import ProviderDatalist from "@/components/ProviderDatalist";
import { PageHeader, EmptyState } from "@/components/ui";
import AddVisitEntry from "./AddVisitEntry";
import AppointmentList from "./AppointmentList";
import EncounterList from "./EncounterList";
import { createAppointment } from "./appointment-actions";
import { addEncounter } from "./actions";

export const dynamic = "force-dynamic";

// A single value from the (string | string[]) searchParams shape.
function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || null;
}

// The unified Visits page (issue #288): appointments (future, scheduling) and
// encounters (past, clinical) are one continuum in the user's head, so they share
// ONE surface with two sections — "Upcoming" (the appointments management +
// booking form + #85 Book CTA + calendar-feed hookup) and "Past" (imported/manual
// visit history with /encounters/[id] detail links). The tables stay separate
// (different shapes and lifecycles); only the page merged. `/appointments`
// redirects here.
export default async function VisitsPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  const now = today(profile.id);
  const appointments = getAppointments(profile.id);
  const encounters = getEncounters(profile.id);
  const providerNames = getProviderNames();

  // Prefill the booking form from a preventive "Book" CTA (issue #85): the item's
  // title + mapped visit kind + suggested date arrive as query params (now pointed
  // at /encounters). Only build a prefill when a title or kind is present; a lone
  // ?new=1 (command palette) just focuses the empty form. A real ISO date param
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
  // A bare ?new=1 (command palette's "Add appointment" — issue #29) focuses the
  // entry and, like every deep link here, defaults it to the appointment branch.
  const focusNew = one(searchParams.new) != null;

  // Split scheduled (future-facing, still on Upcoming) from the settled history so
  // the active list stays actionable. getAppointments returns soonest-first.
  const scheduled = appointments.filter((a) => a.status === "scheduled");
  const settled = appointments.filter((a) => a.status !== "scheduled");
  const upcomingCount = scheduled.filter(
    (a) => a.scheduled_at.slice(0, 10) >= now
  ).length;

  return (
    <div className="space-y-10">
      {/* Shared provider picker options for every add + edit form on the page. */}
      <ProviderDatalist names={providerNames} />
      <PageHeader
        title="Visits"
        subtitle="Your appointments and visit history in one place — book upcoming visits (they also surface on Upcoming) and review past encounters, diagnoses, and notes."
      />

      {/* Upcoming — the appointments surface. */}
      <section data-testid="visits-upcoming">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Upcoming
        </h2>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="min-w-0 space-y-6 lg:col-span-2">
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Scheduled
                {scheduled.length > 0 && (
                  <span className="text-slate-400 dark:text-slate-500">
                    ({upcomingCount} upcoming)
                  </span>
                )}
              </h3>
              {scheduled.length === 0 ? (
                <EmptyState message="No scheduled appointments. Add one to see it here and on Upcoming." />
              ) : (
                <AppointmentList items={scheduled} defaultDate={now} />
              )}
            </section>

            {settled.length > 0 && (
              <details className="card">
                <summary className="cursor-pointer font-semibold text-slate-800 dark:text-slate-100">
                  Completed &amp; cancelled{" "}
                  <span className="text-sm font-normal text-slate-400">
                    ({settled.length})
                  </span>
                </summary>
                <div className="mt-3">
                  <AppointmentList items={settled} defaultDate={now} />
                </div>
              </details>
            )}
          </div>

          <div className="min-w-0 space-y-4">
            {/* The single "Add visit" entry (issue #566): one affordance that
                branches on tense — a future/today date books an appointment, a past
                date logs an encounter — so the user never has to know "which form?".
                Kept inside the Upcoming section so every existing deep link (#85
                Book CTA, #29 command palette, calendar feed) lands here on the
                appointment branch, exactly as before. */}
            <AddVisitEntry
              createAppointment={createAppointment}
              addEncounter={addEncounter}
              defaultDate={bookPrefill ? prefillDate : now}
              today={now}
              prefill={bookPrefill}
              focusNew={focusNew}
            />
          </div>
        </div>
      </section>

      {/* Past — the encounters / visit-history surface. Its add form is now the
          single "Add visit" entry above (toggle to "Already happened"), so this
          section is history-only. */}
      <section data-testid="visits-past">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Past
        </h2>
        <p className="mb-3 text-xs text-slate-400 dark:text-slate-500">
          To log a visit that already happened, use{" "}
          <span className="font-medium text-slate-500 dark:text-slate-400">
            Add visit
          </span>{" "}
          above and switch it to{" "}
          <span className="font-medium text-slate-500 dark:text-slate-400">
            Already happened
          </span>
          . Imported visits come from uploaded health records (CCD Encounters
          section). Informational only, not medical advice.
        </p>
        <EncounterList items={encounters} defaultDate={now} />
      </section>
    </div>
  );
}
