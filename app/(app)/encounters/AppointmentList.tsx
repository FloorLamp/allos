"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  IconPencil,
  IconTrash,
  IconCheck,
  IconX,
  IconCalendarPlus,
  IconStethoscope,
} from "@tabler/icons-react";
import AppointmentForm from "./AppointmentForm";
import {
  createAppointment,
  updateAppointment,
  completeAppointment,
  cancelAppointment,
  reopenAppointment,
  deleteAppointment,
  recordPreventiveFromAppointment,
  logVisitFromAppointment,
  completeCarePlanItemFromAppointment,
} from "./appointment-actions";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import OpenInMaps from "@/components/OpenInMaps";
import { satisfiedRuleForCompletedKind } from "@/lib/preventive-appointment";
import {
  matchCarePlanItemsForAppointment,
  type CarePlanMatchItem,
} from "@/lib/care-plan-appointment";
import { preventiveRuleByKey } from "@/lib/preventive-catalog";
import { formatRecordDate, formatRecordDateTime } from "@/lib/record-format";
import type { Appointment, AppointmentStatus, FormResult } from "@/lib/types";

// The preventive rule name a completed appointment's kind would satisfy (issue
// #85), or null when the kind is unset / ambiguous. Drives the close-the-loop
// "Also mark … done" offer.
function satisfiableRuleName(a: Appointment): string | null {
  const ruleKey = satisfiedRuleForCompletedKind(a.kind);
  return ruleKey ? (preventiveRuleByKey(ruleKey)?.name ?? null) : null;
}

const STATUS_BADGE: Record<AppointmentStatus, string> = {
  scheduled:
    "bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
  completed:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  cancelled: "bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400",
};
const STATUS_TEXT: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
};

// Fire a status/delete server action for a row without a full <form> element (so
// a confirm dialog can gate the destructive delete).
async function submit(
  action: (fd: FormData) => Promise<void | FormResult>,
  id: number
): Promise<void> {
  const fd = new FormData();
  fd.set("id", String(id));
  await action(fd);
}

// List of a profile's appointments; each row edits in place (expands the shared
// form) and carries status controls. Grouped visually only by badge — the parent
// page passes them already sorted soonest-first.
export default function AppointmentList({
  items,
  defaultDate,
  carePlanItems = [],
}: {
  items: Appointment[];
  defaultDate: string;
  // The profile's OPEN care-plan items (issue #658). The close-the-loop offer
  // computes, client-side, which of these a just-completed appointment plausibly
  // satisfied — mirroring how satisfiableRuleName derives the preventive offer.
  carePlanItems?: CarePlanMatchItem[];
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  // The visit a follow-up is being scheduled from (prefills the create form).
  const [followUpFrom, setFollowUpFrom] = useState<Appointment | null>(null);
  // The appointment id whose preventive satisfaction has already been recorded
  // from the close-the-loop offer, so the button reads "Recorded" and no-ops.
  const [recordedId, setRecordedId] = useState<number | null>(null);
  // The appointment id whose visit has just been logged this session, so its
  // "Log visit" button flips to a done state without waiting for the refresh.
  const [loggedId, setLoggedId] = useState<number | null>(null);
  // Care-plan item ids marked done from the close-the-loop offer this session, so
  // each button flips to "Done ✓" immediately (issue #658).
  const [doneCareItems, setDoneCareItems] = useState<Set<number>>(new Set());
  const confirm = useConfirm();
  const toast = useToast();
  const router = useRouter();

  // The open care-plan items the just-completed appointment plausibly satisfied —
  // the confirm-first close-the-loop offer (issue #658). Pure matcher over the
  // items the page passed; empty when nothing matches (no offer shown).
  const carePlanMatches = followUpFrom
    ? matchCarePlanItemsForAppointment(
        {
          kind: followUpFrom.kind,
          title: followUpFrom.title,
          notes: followUpFrom.notes,
          scheduledAt: followUpFrom.scheduled_at,
        },
        carePlanItems
      )
    : [];

  // Complete a scheduled visit, then offer to schedule the next one prefilled
  // from it — so recurring visits don't fall off.
  async function onComplete(a: Appointment) {
    await submit(completeAppointment, a.id);
    setFollowUpFrom(a);
  }

  // Close the loop (issue #85): record the preventive satisfaction a completed,
  // kind-tagged visit implies. Server-side re-derives the rule from the stored kind.
  async function onRecordPreventive(a: Appointment) {
    await submit(recordPreventiveFromAppointment, a.id);
    setRecordedId(a.id);
    toast("Preventive care recorded");
  }

  // Close the appointment → encounter loop (issue #288): create a linked visit
  // prefilled from this appointment (date/provider/kind) and complete it. The new
  // visit lands in the Past section below; refresh so it (and the linked badge)
  // appear.
  async function onLogVisit(a: Appointment) {
    await submit(logVisitFromAppointment, a.id);
    setLoggedId(a.id);
    setFollowUpFrom(null);
    toast("Visit logged");
    router.refresh();
  }

  // Close a matched care-plan item from the completed-appointment offer (issue
  // #658). Marks it done server-side, flips the button locally, then refreshes so
  // the closed item drops off the offer / Upcoming / the care-plan page.
  async function onCompleteCareItem(item: CarePlanMatchItem) {
    await submit(completeCarePlanItemFromAppointment, item.id);
    setDoneCareItems((prev) => new Set(prev).add(item.id));
    toast("Care-plan item marked done");
    router.refresh();
  }

  async function onDelete(a: Appointment) {
    const ok = await confirm({
      title: "Delete appointment",
      message: `Delete this appointment from ${formatRecordDate(a.scheduled_at.slice(0, 10))}? This can’t be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await submit(deleteAppointment, a.id);
  }

  return (
    <div className="space-y-3">
      {followUpFrom && (
        <div className="rounded-xl border border-brand-200 bg-brand-50/50 p-3 dark:border-brand-900 dark:bg-brand-950/30">
          {/* Close the appointment → encounter loop (issue #288): turn the just-
              completed appointment into a real, linked visit in the Past section —
              prefilled from it — instead of the row just settling to "Completed"
              with nothing recorded. Hidden once this appointment already links a
              visit. */}
          {followUpFrom.encounter_id == null && (
            <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-brand-200/60 pb-3 dark:border-brand-900/60">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Log this as a visit in your history?
              </p>
              <button
                type="button"
                data-testid="log-visit"
                disabled={loggedId === followUpFrom.id}
                onClick={() => onLogVisit(followUpFrom)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
              >
                <IconStethoscope className="h-3.5 w-3.5" stroke={1.75} />
                {loggedId === followUpFrom.id
                  ? "Visit logged ✓"
                  : "Log this visit"}
              </button>
            </div>
          )}
          {/* Close the loop (issue #85): a completed kind-tagged visit can mark the
              matching preventive care done in one click, so a due reminder clears
              without a separate mark-done on Upcoming. */}
          {satisfiableRuleName(followUpFrom) && (
            <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-brand-200/60 pb-3 dark:border-brand-900/60">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Also record{" "}
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {satisfiableRuleName(followUpFrom)}
                </span>{" "}
                as done?
              </p>
              <button
                type="button"
                disabled={recordedId === followUpFrom.id}
                onClick={() => onRecordPreventive(followUpFrom)}
                className="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
              >
                {recordedId === followUpFrom.id ? "Recorded ✓" : "Mark done"}
              </button>
            </div>
          )}
          {/* Close the care-plan loop (issue #658): a completed visit can close the
              open care-plan items it satisfied (e.g. the "colonoscopy" item), in one
              click each — confirm-first, so the user chooses. */}
          {carePlanMatches.length > 0 && (
            <div
              data-testid="care-plan-offer"
              className="mb-3 space-y-2 border-b border-brand-200/60 pb-3 dark:border-brand-900/60"
            >
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Also close these matching care-plan items?
              </p>
              {carePlanMatches.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
                    {item.description}
                  </span>
                  <button
                    type="button"
                    data-testid="care-plan-offer-done"
                    disabled={doneCareItems.has(item.id)}
                    onClick={() => onCompleteCareItem(item)}
                    className="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
                  >
                    {doneCareItems.has(item.id) ? "Done ✓" : "Mark done"}
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            Scheduling a follow-up to{" "}
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {followUpFrom.title?.trim() ||
                followUpFrom.provider_name ||
                "the completed visit"}
            </span>{" "}
            — pick a new date.
          </p>
          <AppointmentForm
            action={createAppointment}
            defaultDate={defaultDate}
            onDone={() => setFollowUpFrom(null)}
            prefill={{
              title: followUpFrom.title,
              provider: followUpFrom.provider_name,
              location: followUpFrom.location,
              kind: followUpFrom.kind,
            }}
          />
        </div>
      )}
      <div className="card divide-y divide-black/5 p-0 dark:divide-white/5">
        {items.map((a) =>
          editingId === a.id ? (
            <div key={a.id} className="p-3">
              <AppointmentForm
                action={updateAppointment}
                appointment={a}
                onDone={() => setEditingId(null)}
                defaultDate={defaultDate}
              />
            </div>
          ) : (
            <div
              key={a.id}
              data-testid="appointment-row"
              className="flex items-start gap-3 p-3 transition hover:bg-slate-50 dark:hover:bg-ink-850"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {a.title?.trim() || a.provider_name || "Appointment"}
                  </span>
                  <span className={`badge ${STATUS_BADGE[a.status]}`}>
                    {STATUS_TEXT[a.status]}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {formatRecordDateTime(a.scheduled_at)}
                  {a.provider_name ? ` · ${a.provider_name}` : ""}
                  {a.location ? ` · ${a.location}` : ""}
                  {a.location ? (
                    <>
                      {" · "}
                      <OpenInMaps
                        address={a.location}
                        label="Directions"
                        showIcon={false}
                        className="text-brand-700 hover:underline dark:text-brand-300"
                      />
                    </>
                  ) : null}
                </div>
                {a.notes ? (
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {a.notes}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {a.status === "scheduled" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => onComplete(a)}
                      aria-label="Mark completed"
                      title="Mark completed"
                      className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-emerald-50 hover:text-emerald-600 dark:text-slate-400 dark:hover:bg-emerald-950 dark:hover:text-emerald-400"
                    >
                      <IconCheck className="h-4 w-4" stroke={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => submit(cancelAppointment, a.id)}
                      aria-label="Cancel appointment"
                      title="Cancel"
                      className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-800"
                    >
                      <IconX className="h-4 w-4" stroke={1.75} />
                    </button>
                  </>
                ) : (
                  <>
                    {a.status === "completed" &&
                      (a.encounter_id != null ? (
                        <Link
                          href={`/encounters/${a.encounter_id}`}
                          aria-label="View linked visit"
                          title="View linked visit"
                          data-testid="view-linked-visit"
                          className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-emerald-600 transition hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
                        >
                          <IconStethoscope className="h-4 w-4" stroke={1.75} />
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onLogVisit(a)}
                          aria-label="Log this visit"
                          title="Log this visit"
                          data-testid="log-visit-row"
                          className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-emerald-50 hover:text-emerald-600 dark:text-slate-400 dark:hover:bg-emerald-950 dark:hover:text-emerald-400"
                        >
                          <IconStethoscope className="h-4 w-4" stroke={1.75} />
                        </button>
                      ))}
                    {a.status === "completed" && (
                      <button
                        type="button"
                        onClick={() => setFollowUpFrom(a)}
                        aria-label="Schedule follow-up"
                        title="Schedule follow-up"
                        className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-brand-50 hover:text-brand-600 dark:text-slate-400 dark:hover:bg-brand-950 dark:hover:text-brand-400"
                      >
                        <IconCalendarPlus className="h-4 w-4" stroke={1.75} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => submit(reopenAppointment, a.id)}
                      className="rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-800"
                    >
                      Reopen
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setEditingId(a.id)}
                  aria-label="Edit"
                  className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-800"
                >
                  <IconPencil className="h-4 w-4" stroke={1.75} />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(a)}
                  aria-label="Delete"
                  className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950 dark:hover:text-rose-400"
                >
                  <IconTrash className="h-4 w-4" stroke={1.75} />
                </button>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
