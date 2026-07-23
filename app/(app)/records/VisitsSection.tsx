import Link from "next/link";
import { today } from "@/lib/db";
import { HOUSEHOLD_HISTORY_HREF } from "@/lib/hrefs";
import {
  getAppointments,
  getEncounters,
  getProviderNames,
  getCarePlanItems,
} from "@/lib/queries";
import { isCarePlanItemOpen } from "@/lib/care-plan-upcoming";
import type { CarePlanMatchItem } from "@/lib/care-plan-appointment";
import { isRealIsoDate } from "@/lib/date";
import { isAppointmentKind } from "@/lib/preventive-appointment";
import ProviderDatalist from "@/components/ProviderDatalist";
import { EmptyState } from "@/components/ui";
import AddVisitEntry from "@/app/(app)/encounters/AddVisitEntry";
import AppointmentList from "@/app/(app)/encounters/AppointmentList";
import EncounterList from "@/app/(app)/encounters/EncounterList";
import { createAppointment } from "@/app/(app)/encounters/appointment-actions";
import { addEncounter } from "@/app/(app)/encounters/actions";

// A single value from the (string | string[]) searchParams shape.
function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || null;
}

// The unified Visits surface (issue #288; former /encounters index, #1042 phase
// 6), now the #visits section of /records. Appointments (future, scheduling) and
// encounters (past, clinical) are one continuum in the user's head, so they share
// two sub-sections — "Upcoming" (appointments management + booking form + #85
// Book CTA + calendar-feed hookup) and "Past" (imported/manual visit history with
// /encounters/[id] detail links, which survive). The tables stay separate
// (different shapes and lifecycles). Book/palette deep links land here via the
// query params (title/kind/date/new), which ride the ONE /records URL.
export default function VisitsSection({
  profileId,
  searchParams,
  showHousehold,
}: {
  profileId: number;
  searchParams: { [key: string]: string | string[] | undefined };
  // The login can reach 2+ profiles — the SAME predicate that gates the Household
  // strip/nav — so a single-profile login never sees the household affordance.
  showHousehold: boolean;
}) {
  const now = today(profileId);
  const appointments = getAppointments(profileId);
  const encounters = getEncounters(profileId);
  const providerNames = getProviderNames();
  // Open care-plan items a completed appointment can offer to close (issue #658).
  // Pared to the fields the pure matcher needs; the client computes the per-
  // appointment matches so the offer mirrors the preventive/log-visit CTAs.
  const openCarePlanItems: CarePlanMatchItem[] = getCarePlanItems(profileId)
    .filter((c) => isCarePlanItemOpen(c.status))
    .map((c) => ({
      id: c.id,
      description: c.description,
      code: c.code,
      planned_date: c.planned_date,
      status: c.status,
    }));

  // Prefill the booking form from a preventive "Book" CTA (issue #85): the item's
  // title + mapped visit kind + suggested date arrive as query params (now pointed
  // at /records#visits). Only build a prefill when a title or kind is present; a
  // lone ?new=1 (command palette) just focuses the empty form. A real ISO date
  // param seeds the form's default date.
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

      {showHousehold && (
        <div className="-mt-2">
          <Link
            href={HOUSEHOLD_HISTORY_HREF}
            className="text-sm font-medium text-sky-700 hover:underline dark:text-sky-300"
            data-testid="household-view-link"
          >
            Household view →
          </Link>
        </div>
      )}

      {/* Upcoming — the appointments surface. */}
      <section data-testid="visits-upcoming">
        <h3 className="mb-3 section-label">Upcoming</h3>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="min-w-0 space-y-6 lg:col-span-2">
            <section>
              <h4 className="mb-2 flex items-center gap-2 section-label">
                Scheduled
                {scheduled.length > 0 && (
                  <span className="text-slate-500 dark:text-slate-400">
                    ({upcomingCount} upcoming)
                  </span>
                )}
              </h4>
              {scheduled.length === 0 ? (
                <EmptyState message="No scheduled appointments. Add one to see it here and on Upcoming." />
              ) : (
                <AppointmentList
                  items={scheduled}
                  defaultDate={now}
                  carePlanItems={openCarePlanItems}
                />
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
                  <AppointmentList
                    items={settled}
                    defaultDate={now}
                    carePlanItems={openCarePlanItems}
                  />
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
        <h3 className="mb-3 section-label">Past</h3>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          To log a visit that already happened, use{" "}
          <span className="font-medium text-slate-500 dark:text-slate-400">
            Add visit
          </span>{" "}
          above and switch it to{" "}
          <span className="font-medium text-slate-500 dark:text-slate-400">
            Already happened
          </span>
          . Imported visits come from uploaded health records (CCD Encounters
          section).
        </p>
        <EncounterList items={encounters} defaultDate={now} />
      </section>
    </div>
  );
}
