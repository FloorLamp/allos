"use client";

import { useRef, useState } from "react";
import SaveStatus from "@/components/SaveStatus";
import DateField from "@/components/DateField";
import { useSaveStatus, useFlushOnHide } from "@/components/useSaveStatus";
import {
  CODE_STATUSES,
  ORGAN_DONOR_STATUSES,
  type AdvanceDirectives,
} from "@/lib/advance-directives";
import { saveAdvanceDirectives } from "./actions";

// The advance-directive summary (issue #1848), edited inside the Passport's
// #emergency section beside the card settings it feeds — the topic-first rule the
// #1087 move established: the fields sit with the card that prints them, not on a
// settings page a person has to go find. Every field autosaves (select/date on
// change, free text on blur) through the shared save-status helpers.
//
// Storage is profile_settings (data-subject health facts). The signed document
// itself is deliberately NOT stored here: that is an uploaded medical document.
// This is the at-a-glance summary an ED reads when the person can't speak.

type Draft = {
  codeStatus: string;
  codeStatusEffective: string;
  codeStatusNote: string;
  proxyName: string;
  proxyRelation: string;
  proxyPhone: string;
  organDonor: string;
  documentsAt: string;
};

function draftFrom(d: AdvanceDirectives): Draft {
  return {
    codeStatus: d.codeStatus ?? "",
    codeStatusEffective: d.codeStatusEffective ?? "",
    codeStatusNote: d.codeStatusNote ?? "",
    proxyName: d.proxy?.name ?? "",
    proxyRelation: d.proxy?.relation ?? "",
    proxyPhone: d.proxy?.phone ?? "",
    organDonor: d.organDonor ?? "",
    documentsAt: d.documentsAt ?? "",
  };
}

export default function AdvanceDirectivesSettings({
  directives,
}: {
  directives: AdvanceDirectives;
}) {
  const [draft, setDraft] = useState<Draft>(draftFrom(directives));
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  const formRef = useRef<HTMLDivElement>(null);
  useFlushOnHide(formRef);

  function save(next: Draft) {
    const fd = new FormData();
    fd.set("code_status", next.codeStatus);
    fd.set("code_status_effective", next.codeStatusEffective);
    fd.set("code_status_note", next.codeStatusNote);
    fd.set("healthcare_proxy_name", next.proxyName);
    fd.set("healthcare_proxy_relation", next.proxyRelation);
    fd.set("healthcare_proxy_phone", next.proxyPhone);
    fd.set("organ_donor", next.organDonor);
    fd.set("directive_documents_at", next.documentsAt);
    runSave(async () => {
      await saveAdvanceDirectives(fd);
    });
  }

  // `next` is derived from the CURRENT render's draft, never inside a setState
  // updater: the updater can be invoked more than once and must stay pure, so
  // firing the save from in there would queue a second component's state update
  // from another component's render — the React error that leaves a controlled
  // input reverted to its last committed value. `immediate` marks the controls that
  // save on change (select / date) rather than on blur.
  const update = (patch: Partial<Draft>, immediate: boolean) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (immediate) save(next);
  };

  return (
    <div
      ref={formRef}
      id="advance-directives"
      data-testid="advance-directives-settings"
      className="card mt-6 max-w-lg space-y-5"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Code status &amp; directives
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        The first questions asked when you can&rsquo;t speak for yourself. All
        optional, and all shown on the emergency card and the passport. The
        signed document itself isn&rsquo;t stored here — upload that under
        Medical → Documents and note below where the paper copy lives.
      </p>

      <div>
        <label className="label" htmlFor="code-status">
          Code status
        </label>
        <select
          id="code-status"
          data-testid="code-status-select"
          value={draft.codeStatus}
          onChange={(e) => update({ codeStatus: e.target.value }, true)}
          className="input"
        >
          <option value="">Not recorded</option>
          {CODE_STATUSES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label} — {c.detail}
            </option>
          ))}
        </select>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="code-status-effective">
              Effective date
            </label>
            <DateField
              id="code-status-effective"
              value={draft.codeStatusEffective}
              onChange={(v) => update({ codeStatusEffective: v }, true)}
              data-testid="code-status-effective"
            />
          </div>
          <div>
            <label className="label" htmlFor="code-status-note">
              Qualifier
            </label>
            <input
              id="code-status-note"
              data-testid="code-status-note"
              value={draft.codeStatusNote}
              placeholder="e.g. DNR, but intubate for a reversible cause"
              onChange={(e) =>
                update({ codeStatusNote: e.target.value }, false)
              }
              onBlur={() => save(draft)}
              className="input"
            />
          </div>
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          The qualifier carries anything the five options are too coarse for. It
          prints verbatim beneath the code status.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/5">
        <label className="label">Healthcare proxy</label>
        <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
          The person authorized to decide for you (healthcare power of attorney,
          or a minor&rsquo;s legal guardian).
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            value={draft.proxyName}
            placeholder="Name"
            aria-label="Healthcare proxy name"
            data-testid="proxy-name"
            onChange={(e) => update({ proxyName: e.target.value }, false)}
            onBlur={() => save(draft)}
            className="input"
          />
          <input
            value={draft.proxyPhone}
            placeholder="Phone"
            aria-label="Healthcare proxy phone"
            data-testid="proxy-phone"
            inputMode="tel"
            onChange={(e) => update({ proxyPhone: e.target.value }, false)}
            onBlur={() => save(draft)}
            className="input"
          />
          <input
            value={draft.proxyRelation}
            placeholder="Relationship (e.g. Spouse)"
            aria-label="Healthcare proxy relationship"
            onChange={(e) => update({ proxyRelation: e.target.value }, false)}
            onBlur={() => save(draft)}
            className="input sm:col-span-2"
          />
        </div>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/5">
        <label className="label" htmlFor="organ-donor">
          Organ donation
        </label>
        <select
          id="organ-donor"
          data-testid="organ-donor-select"
          value={draft.organDonor}
          onChange={(e) => update({ organDonor: e.target.value }, true)}
          className="input sm:w-64"
        >
          <option value="">Not recorded</option>
          {ORGAN_DONOR_STATUSES.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Left blank, the card says nothing — an unanswered question and a
          declared &ldquo;no&rdquo; are different answers.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/5">
        <label className="label" htmlFor="directive-documents">
          Documents on file at
        </label>
        <input
          id="directive-documents"
          data-testid="directive-documents"
          value={draft.documentsAt}
          placeholder="e.g. POLST on the fridge; copy with Dr. Reed"
          onChange={(e) => update({ documentsAt: e.target.value }, false)}
          onBlur={() => save(draft)}
          className="input"
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Where the signed paperwork physically is, so a responder knows where
          to look.
        </p>
      </div>
    </div>
  );
}
