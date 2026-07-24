"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import {
  GENOMIC_RESULT_TYPES,
  GENOMIC_SIGNIFICANCES,
  ZYGOSITIES,
  resultTypeLabel,
  significanceLabel,
} from "@/lib/genomic-variant";
import type { GenomicVariant, FormResult } from "@/lib/types";

// Shared add/edit genomic-variant form. Add mode: no `variant`. Edit mode: pass the
// row + an `onDone` callback (renders a hidden id + a Cancel button). Enum fields
// (result type / significance / zygosity) are <select>s so a value can never miss
// the DB CHECK set; the action also re-normalizes on the server.
export default function GenomicVariantForm({
  action,
  variant,
  profileId,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  variant?: GenomicVariant;
  // Multi-view (#1328): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!variant;
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("gene") ?? "").trim()) {
      setError("Enter the gene symbol.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this variant. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Variant updated" : "Variant saved");
    if (!editing) formRef.current?.reset();
    onDone?.();
    router.refresh();
  }

  const uid = variant?.id ?? "new";
  return (
    <form
      ref={formRef}
      action={handle}
      className="card space-y-3"
      data-testid="genomic-variant-form"
    >
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add genomic variant
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={variant!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`gv-gene-${uid}`}>
            Gene
          </label>
          <input
            id={`gv-gene-${uid}`}
            name="gene"
            className="input"
            defaultValue={variant?.gene ?? ""}
            placeholder="e.g. BRCA1, CYP2C19"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor={`gv-variant-${uid}`}>
            Variant (rsID / HGVS)
          </label>
          <input
            id={`gv-variant-${uid}`}
            name="variant"
            className="input"
            defaultValue={variant?.variant ?? ""}
            placeholder="e.g. rs4986893"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`gv-genotype-${uid}`}>
            Genotype
          </label>
          <input
            id={`gv-genotype-${uid}`}
            name="genotype"
            className="input"
            defaultValue={variant?.genotype ?? ""}
            placeholder="e.g. ε3/ε4"
          />
        </div>
        <div>
          <label className="label" htmlFor={`gv-star-${uid}`}>
            Star allele
          </label>
          <input
            id={`gv-star-${uid}`}
            name="star_allele"
            className="input"
            defaultValue={variant?.star_allele ?? ""}
            placeholder="e.g. *2/*2"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`gv-zygosity-${uid}`}>
            Zygosity
          </label>
          <select
            id={`gv-zygosity-${uid}`}
            name="zygosity"
            className="input"
            defaultValue={variant?.zygosity ?? ""}
          >
            <option value="">—</option>
            {ZYGOSITIES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`gv-result-type-${uid}`}>
            Result type
          </label>
          <select
            id={`gv-result-type-${uid}`}
            name="result_type"
            className="input"
            defaultValue={variant?.result_type ?? "other"}
          >
            {GENOMIC_RESULT_TYPES.map((t) => (
              <option key={t} value={t}>
                {resultTypeLabel(t)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`gv-significance-${uid}`}>
            Clinical significance
          </label>
          <select
            id={`gv-significance-${uid}`}
            name="significance"
            className="input"
            defaultValue={variant?.significance ?? ""}
          >
            <option value="">—</option>
            {GENOMIC_SIGNIFICANCES.map((s) => (
              <option key={s} value={s}>
                {significanceLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`gv-report-date-${uid}`}>
            Report date
          </label>
          <DateField
            id={`gv-report-date-${uid}`}
            name="report_date"
            defaultValue={variant?.report_date ?? ""}
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`gv-source-lab-${uid}`}>
          Source lab
        </label>
        <input
          id={`gv-source-lab-${uid}`}
          name="source_lab"
          className="input"
          defaultValue={variant?.source_lab ?? ""}
          placeholder="e.g. Invitae"
        />
      </div>
      <div>
        <label className="label" htmlFor={`gv-interpretation-${uid}`}>
          Interpretation
        </label>
        <input
          id={`gv-interpretation-${uid}`}
          name="interpretation"
          className="input"
          defaultValue={variant?.interpretation ?? ""}
          placeholder="The report's own interpretation, verbatim"
        />
      </div>
      <div>
        <label className="label" htmlFor={`gv-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`gv-notes-${uid}`}
          name="notes"
          className="input"
          defaultValue={variant?.notes ?? ""}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <SubmitButton className="btn w-full" pendingLabel="Saving…">
          {editing ? "Save" : "Add"}
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
