"use client";

import { useState } from "react";
import { IconPencil, IconTrash, IconPlayerStop } from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import { formatLongDate } from "@/lib/format-date";
import type { Protocol } from "@/lib/types";
import type { OutcomeOption } from "@/lib/queries/protocols";
import ProtocolForm from "./ProtocolForm";

// Detail-page header + lifecycle controls for one protocol: an inline edit toggle
// (reusing ProtocolForm with the update action), an "End now" action for an
// ongoing protocol, and a confirm-guarded delete. End/Delete are plain server-
// action forms so their server-side redirect/revalidate flows straight through.
export default function ProtocolControls({
  protocol,
  options,
  updateAction,
  endAction,
  deleteAction,
}: {
  protocol: Protocol;
  options: OutcomeOption[];
  updateAction: (formData: FormData) => Promise<void>;
  endAction: (formData: FormData) => Promise<void>;
  deleteAction: (formData: FormData) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const ongoing = protocol.end_date == null;

  if (editing) {
    return (
      <ProtocolForm
        action={updateAction}
        options={options}
        protocol={protocol}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="card space-y-3" data-testid="protocol-header">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            {protocol.name}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {ongoing
              ? `Started ${formatLongDate(protocol.start_date)} · ongoing`
              : `${formatLongDate(protocol.start_date)} – ${formatLongDate(
                  protocol.end_date!
                )}`}
          </p>
        </div>
        {ongoing && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            Ongoing
          </span>
        )}
      </div>
      {protocol.situation && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Situation: <span className="font-medium">{protocol.situation}</span>
        </p>
      )}
      {protocol.notes && (
        <p className="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">
          {protocol.notes}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setEditing(true)}
          data-testid="protocol-edit"
        >
          <IconPencil className="h-4 w-4" stroke={1.75} aria-hidden /> Edit
        </button>
        {ongoing && (
          <form action={endAction}>
            <input type="hidden" name="id" value={protocol.id} />
            <SubmitButton className="btn-ghost" pendingLabel="Ending…">
              <IconPlayerStop className="h-4 w-4" stroke={1.75} aria-hidden />{" "}
              End now
            </SubmitButton>
          </form>
        )}
        <form
          action={deleteAction}
          onSubmit={(e) => {
            if (!confirm(`Delete protocol "${protocol.name}"?`))
              e.preventDefault();
          }}
        >
          <input type="hidden" name="id" value={protocol.id} />
          <SubmitButton
            className="btn-ghost text-rose-600 dark:text-rose-400"
            pendingLabel="Deleting…"
          >
            <IconTrash className="h-4 w-4" stroke={1.75} aria-hidden /> Delete
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
