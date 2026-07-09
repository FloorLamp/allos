"use client";

import { useState } from "react";
import {
  IconPencil,
  IconTrash,
  IconCheck,
  IconX,
  IconCalendarPlus,
} from "@tabler/icons-react";
import AppointmentForm from "./AppointmentForm";
import {
  createAppointment,
  updateAppointment,
  completeAppointment,
  cancelAppointment,
  reopenAppointment,
  deleteAppointment,
} from "./actions";
import { useConfirm } from "@/components/ConfirmDialog";
import type { Appointment, AppointmentStatus } from "@/lib/types";

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
  action: (fd: FormData) => Promise<void>,
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
}: {
  items: Appointment[];
  defaultDate: string;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  // The visit a follow-up is being scheduled from (prefills the create form).
  const [followUpFrom, setFollowUpFrom] = useState<Appointment | null>(null);
  const confirm = useConfirm();

  // Complete a scheduled visit, then offer to schedule the next one prefilled
  // from it (issue #213 Phase 3) — so recurring visits don't fall off.
  async function onComplete(a: Appointment) {
    await submit(completeAppointment, a.id);
    setFollowUpFrom(a);
  }

  async function onDelete(a: Appointment) {
    const ok = await confirm({
      title: "Delete appointment",
      message: `Delete this appointment from ${a.scheduled_at.slice(0, 10)}? This can’t be undone.`,
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
                  {a.scheduled_at}
                  {a.provider_name ? ` · ${a.provider_name}` : ""}
                  {a.location ? ` · ${a.location}` : ""}
                </div>
                {a.notes ? (
                  <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
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
