import DestinationLink from "@/components/DestinationLink";
import { today } from "@/lib/db";
import { EPISODES_HREF } from "@/lib/hrefs";
import {
  getAppointments,
  getEncounters,
  getPickerProviders,
  getCarePlanItems,
  linkedRowCountsForEncounters,
  episodesForEncounters,
  episodesForAppointments,
} from "@/lib/queries";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
import { isCarePlanItemOpen } from "@/lib/care-plan-upcoming";
import type { CarePlanMatchItem } from "@/lib/care-plan-appointment";
import { isRealIsoDate } from "@/lib/date";
import { isAppointmentKind } from "@/lib/preventive-appointment";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import { EmptyState } from "@/components/ui";
import AddEntryPanel from "@/components/AddEntryPanel";
import CardSectionHeader from "@/components/CardSectionHeader";
import AddVisitEntry from "@/app/(app)/encounters/AddVisitEntry";
import AppointmentList from "@/app/(app)/encounters/AppointmentList";
import EncounterList from "@/app/(app)/encounters/EncounterList";
import { createAppointment } from "@/app/(app)/encounters/appointment-actions";
import { addEncounter } from "@/app/(app)/encounters/actions";
import Disclosure from "@/components/Disclosure";

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
  scope,
  searchParams,
  showHousehold,
}: {
  scope: ProfileScope;
  searchParams: { [key: string]: string | string[] | undefined };
  // The login can reach 2+ profiles — the SAME predicate that gates the Household
  // strip/nav — so a single-profile login never sees the household affordance.
  showHousehold: boolean;
}) {
  // Multi-view (#1359): the "Past" encounters list is a flat, per-profile-deduped
  // dated fact — read the whole view-set list-first (readForProfiles loops the
  // representative-id dedup per profile) + stamp subject identity, so non-acting rows
  // carry a subject chip and per-item write gate. Everything ELSE on this surface —
  // the Upcoming appointments split (today()-derived scheduled/settled), the care-plan
  // match offers, and the Add-visit booking form — stays ACTING-ONLY: it is either
  // per-profile-context-derived (the #1096 scope-limit: today()/dueness must not be
  // evaluated in another member's context) or write-centric (a single write target).
  // The "Household view →" link remains the full merged cross-profile entry point.
  const profileId = scope.actingProfileId;
  const multi = scope.viewIds.length > 1;
  const now = today(profileId);
  const appointments = getAppointments(profileId);
  const appointmentEpisodes = episodesForAppointments(profileId);
  const encounters = stampSubjects(
    scope,
    readForProfiles(scope.viewIds, (pid) => getEncounters(pid))
  );
  const linkedRecordCounts = Object.fromEntries(
    scope.viewIds.flatMap((pid) =>
      Object.entries(linkedRowCountsForEncounters(pid))
    )
  );
  const encounterEpisodes = Object.fromEntries(
    scope.viewIds.flatMap((pid) => Object.entries(episodesForEncounters(pid)))
  );
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
  const focusNew =
    one(searchParams.new) != null || one(searchParams.focus) != null;

  // Split scheduled (future-facing, still on Upcoming) from the settled history so
  // the active list stays actionable. getAppointments returns soonest-first.
  const scheduled = appointments.filter((a) => a.status === "scheduled");
  const settled = appointments.filter((a) => a.status !== "scheduled");
  const upcomingScheduled = scheduled.filter((a) => a.date >= now);
  const overdueScheduled = scheduled.filter((a) => a.date < now);

  // ── CONTENT LEADS; AN ABSENCE DOES NOT (#3408, item B) ────────────────────
  //
  // Upcoming led unconditionally, and for a profile with no appointments — which
  // is the COMMON case — that meant the first thing under the pane chip was a
  // `p-10` dashed billboard announcing nothing, with the PAST list (the reason
  // the visit happened, and the only records on the pane) starting about 250px
  // down a 430px screen.
  //
  // TWO CHANGES, AND THEY ARE DIFFERENT SIZES. The empty state goes `compact`
  // ALWAYS — one line and its action instead of a billboard, which is #2399's
  // rule that an absence stops reserving room. The ORDER only flips when the
  // whole Upcoming section is empty, and "empty" here means what the section
  // renders, not just the scheduled list: an overdue appointment or a settled one
  // is a real record and Upcoming still leads when it holds either.
  //
  // ORDER STAYS UPCOMING-FIRST WHEN APPOINTMENTS EXIST (the issue left this to
  // the implementer). An appointment is a thing you are about to DO; a past visit
  // is a thing you look up. Leading with what is coming is the right reading of
  // the pane whenever there is anything coming — the defect was never the order,
  // it was paying a screen for the order when there is nothing to order.
  const upcomingEmpty =
    upcomingScheduled.length === 0 &&
    overdueScheduled.length === 0 &&
    settled.length === 0;

  // AUTHORED ONCE, PLACED TWICE (#2305). The Past list is the same node in both
  // orders — a `hidden`/`md:block` twin pair, or two copies of this markup with
  // one branch dead, is two lists to keep in step and the unused one is the one
  // that rots. Only its POSITION in the parent moves.
  const pastSection = (
    // Past — the encounter history, without an entry form between the two lists.
    <section data-testid="visits-past">
      <CardSectionHeader title="Past" variant="label">
        {showHousehold && (
          <DestinationLink
            href={EPISODES_HREF}
            className="shrink-0 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
            data-testid="household-view-link"
          >
            View illness episodes
          </DestinationLink>
        )}
      </CardSectionHeader>
      <EncounterList
        items={encounters}
        defaultDate={now}
        linkedRecordCounts={linkedRecordCounts}
        episodes={encounterEpisodes}
        multiView={
          multi ? { actingProfileId: scope.actingProfileId } : undefined
        }
      />
    </section>
  );

  return (
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <div
        className="section-stack space-y-10"
        data-testid="visits-body"
        // The order the pane resolved to, declared rather than inferred from two
        // bounding boxes — an e2e that wants to know WHY it saw Past first should
        // read this, not measure.
        data-lead={upcomingEmpty ? "past" : "upcoming"}
      >
        <AddEntryPanel
          testId="add-visit-panel"
          panelId="add-visit-panel-body"
          label="Add visit"
          defaultOpen={focusNew || !!bookPrefill}
          presentation="modal"
        >
          <AddVisitEntry
            createAppointment={createAppointment}
            addEncounter={addEncounter}
            defaultDate={bookPrefill ? prefillDate : now}
            today={now}
            prefill={bookPrefill}
            focusNew={focusNew}
          />
        </AddEntryPanel>

        {upcomingEmpty && pastSection}

        {/* Upcoming — the appointments surface. */}
        <section data-testid="visits-upcoming">
          <h3 className="mb-3 flex items-center gap-2 section-label">
            Upcoming
            {upcomingScheduled.length > 0 && (
              <span className="text-slate-500 dark:text-slate-400">
                ({upcomingScheduled.length} scheduled)
              </span>
            )}
          </h3>
          <div className="section-stack-sm min-w-0 space-y-6">
            {/* No inner "Scheduled" label (#1449): the outer heading names the
                list; the count that carries information lives with it. */}
            <section>
              {upcomingScheduled.length === 0 ? (
                <EmptyState
                  compact
                  message="No scheduled appointments. Add one to see it here and on Upcoming."
                />
              ) : (
                <AppointmentList
                  items={upcomingScheduled}
                  defaultDate={now}
                  carePlanItems={openCarePlanItems}
                  episodes={appointmentEpisodes}
                />
              )}
            </section>

            {overdueScheduled.length > 0 && (
              // `bleed-none`: the amber rail is 14px of inset this disclosure
              // supplies itself, so a card inside it stays inside it instead of
              // cancelling the PAGE's gutter and crossing its own rail (#3931).
              <Disclosure className="bleed-none border-l-2 border-amber-300 pl-3 dark:border-amber-800">
                <summary className="cursor-pointer py-1 font-semibold text-amber-800 dark:text-amber-200">
                  Past date—update status{" "}
                  <span className="text-sm font-normal">
                    ({overdueScheduled.length})
                  </span>
                </summary>
                <div className="mt-3">
                  <AppointmentList
                    items={overdueScheduled}
                    defaultDate={now}
                    carePlanItems={openCarePlanItems}
                    episodes={appointmentEpisodes}
                  />
                </div>
              </Disclosure>
            )}

            {settled.length > 0 && (
              <Disclosure className="border-t border-black/5 pt-3 dark:border-white/5">
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
                    episodes={appointmentEpisodes}
                  />
                </div>
              </Disclosure>
            )}
          </div>
        </section>

        {!upcomingEmpty && pastSection}
      </div>
    </ProviderOptionsProvider>
  );
}
