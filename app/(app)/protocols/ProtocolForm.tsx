"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import type { Protocol } from "@/lib/types";
import type { OutcomeOption } from "@/lib/queries/protocols";

// Shared add/edit protocol form. Add mode: no `protocol`. Edit mode: pass the row
// (renders a hidden id + Cancel). `options` is the outcome-metric picker (fixed
// body/index metrics + the profile's tracked biomarkers), grouped for headings.
export default function ProtocolForm({
  action,
  options,
  protocol,
  onDone,
}: {
  action: (formData: FormData) => Promise<void>;
  options: OutcomeOption[];
  protocol?: Protocol;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!protocol;
  const [error, setError] = useState<string | null>(null);

  const selected = new Set(protocol?.outcomeKeys ?? []);
  const groups = Array.from(new Set(options.map((o) => o.group)));

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("name") ?? "").trim()) {
      setError("Name your protocol.");
      return;
    }
    try {
      await action(formData);
    } catch (e) {
      // A server-action redirect (create → new detail page, delete → list) throws
      // a NEXT_REDIRECT sentinel that must propagate, not be swallowed as an error.
      if (
        e &&
        typeof e === "object" &&
        "digest" in e &&
        String((e as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT")
      ) {
        throw e;
      }
      setError("Couldn't save this protocol. Please try again.");
      return;
    }
    toast(editing ? "Protocol updated" : "Protocol created");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  const uid = protocol?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      className="card space-y-3"
      data-testid="protocol-form"
    >
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          New protocol
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={protocol!.id} />}
      <div>
        <label className="label" htmlFor={`pr-name-${uid}`}>
          Name
        </label>
        <input
          id={`pr-name-${uid}`}
          name="name"
          className="input"
          defaultValue={protocol?.name ?? ""}
          placeholder="e.g. Creatine 5 g/day, Sauna 4×/week"
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`pr-start-${uid}`}>
            Start date
          </label>
          <DateField
            id={`pr-start-${uid}`}
            name="start_date"
            defaultValue={protocol?.start_date ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor={`pr-end-${uid}`}>
            End date <span className="text-slate-400">(blank = ongoing)</span>
          </label>
          <DateField
            id={`pr-end-${uid}`}
            name="end_date"
            defaultValue={protocol?.end_date ?? ""}
          />
        </div>
      </div>
      <div>
        <span className="label">Outcome metrics to compare</span>
        <div className="mt-1 max-h-56 space-y-3 overflow-y-auto rounded-lg border border-slate-200 p-3 dark:border-ink-700">
          {options.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No trackable metrics yet — add body metrics or import labs first.
            </p>
          )}
          {groups.map((group) => (
            <fieldset key={group}>
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {group}
              </legend>
              <div className="space-y-1">
                {options
                  .filter((o) => o.group === group)
                  .map((o) => (
                    <label
                      key={o.key}
                      className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
                    >
                      <input
                        type="checkbox"
                        name="outcome_keys"
                        value={o.key}
                        defaultChecked={selected.has(o.key)}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      {o.label}
                    </label>
                  ))}
              </div>
            </fieldset>
          ))}
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`pr-situation-${uid}`}>
          Activate situation <span className="text-slate-400">(optional)</span>
        </label>
        <input
          id={`pr-situation-${uid}`}
          name="situation"
          className="input"
          defaultValue={protocol?.situation ?? ""}
          placeholder="e.g. Creatine loading — surfaces situational supplements"
        />
      </div>
      <div>
        <label className="label" htmlFor={`pr-notes-${uid}`}>
          Notes
        </label>
        <textarea
          id={`pr-notes-${uid}`}
          name="notes"
          className="input"
          rows={2}
          defaultValue={protocol?.notes ?? ""}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <SubmitButton className="btn w-full" pendingLabel="Saving…">
          {editing ? "Save" : "Create protocol"}
        </SubmitButton>
        {editing && onDone && (
          <button type="button" className="btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
