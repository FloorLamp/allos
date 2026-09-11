"use client";

import { useRef, useState } from "react";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import Combobox from "@/components/Combobox";
import { useAddEntryModalClose } from "@/components/AddEntryPanel";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import RecordFactRow, {
  RecordFactMoreMenu,
} from "@/components/records/RecordFactRow";
import {
  GENOMIC_RESULT_TYPES,
  GENOMIC_SIGNIFICANCES,
  PGX_GENE_SYMBOLS,
  ZYGOSITIES,
  resultTypeLabel,
  significanceLabel,
} from "@/lib/genomic-variant";
import {
  genomicVariantFactSummary,
  GENOMIC_VARIANT_FACT_NOUNS,
  type GenomicVariantFactKey,
} from "@/lib/genomic-variant-facts";
import type { GenomicVariant, FormResult } from "@/lib/types";
import InlineError from "@/components/InlineError";

// WHICH PANELS EXIST is the fact keys plus the trailing affordance's own menu — the
// intake form's shape (#3216).
type GenomicOpenPanel = GenomicVariantFactKey | "more";

// Shared add/edit genomic-variant form, on the facts-with-editors primitive (#5302,
// over #3218 and #5300's grammar) — the last of the twelve. Add mode: no `variant`.
// Edit mode: pass the row + an `onDone` callback (renders a hidden id + a Cancel
// button). Enum fields (result type / significance / zygosity) are <select>s so a value
// can never miss the DB CHECK set; the action also re-normalizes on the server.
//
// WHAT CHANGED, and what deliberately did not. Eleven labelled controls stood open for
// a record whose statement is one gene's call. Now the GENE is rule 1's one identifying
// field, the row states the RESULT TYPE and the CALL — the router and the diplotype,
// which are what the PGx cross-check and the hereditary cadence actually read, argued
// in lib/genomic-variant-facts — and the rest live behind the one trailing affordance.
// The clinical significance is deliberately NOT among the essentials, and that argument
// is the one most worth reading before changing it. The write is untouched: the same
// `<form action={…}>` posts the same named fields to the same Server Action.
//
// IT IS DOM-COLLECTED, so every named input stays MOUNTED whichever panel is open and
// the closed panels are merely hidden; an unmounted field is a field the form CLEARS
// (#2359) and one the dirty-form registry cannot see. See ConditionForm's header for
// the same reading at the sibling address.
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
  const toast = useToast();
  const closeEntryModal = useAddEntryModalClose();
  const prefs = useFormatPrefs();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!variant;
  const [error, setError] = useState<string | null>(null);
  // Gene is a controlled Combobox over the PGx symbols (#1676) — form.reset() can't
  // clear it, so the add path clears this state explicitly on a successful save.
  const [gene, setGene] = useState(variant?.gene ?? "");
  // The chips' copies of the DOM-owned fields: `defaultValue` keeps the browser's value
  // the one that posts, and these only draw the sentence.
  const [resultType, setResultType] = useState<string>(
    variant?.result_type ?? "other"
  );
  const [genotype, setGenotype] = useState(variant?.genotype ?? "");
  const [starAllele, setStarAllele] = useState(variant?.star_allele ?? "");
  const [zygosity, setZygosity] = useState(variant?.zygosity ?? "");
  const [variantId, setVariantId] = useState(variant?.variant ?? "");
  const [significance, setSignificance] = useState(variant?.significance ?? "");
  const [reportDate, setReportDate] = useState(variant?.report_date ?? "");
  const [sourceLab, setSourceLab] = useState(variant?.source_lab ?? "");
  const [interpretation, setInterpretation] = useState(
    variant?.interpretation ?? ""
  );
  const [notes, setNotes] = useState(variant?.notes ?? "");

  const {
    openEditor,
    open: openPanel,
    close: closePanel,
    onKeyDown,
  } = useFactEditor<GenomicOpenPanel>({ scopeRef: formRef });

  const summary = genomicVariantFactSummary({
    resultType,
    genotype,
    starAllele,
    zygosity,
    variant: variantId,
    significance,
    reportDate,
    sourceLab,
    interpretation,
    notes,
    prefs,
  });

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
    if (!editing) {
      formRef.current?.reset();
      setGene("");
      setResultType("other");
      setGenotype("");
      setStarAllele("");
      setZygosity("");
      setVariantId("");
      setSignificance("");
      setReportDate("");
      setSourceLab("");
      setInterpretation("");
      setNotes("");
      closePanel();
    }
    onDone?.();
    if (!editing) closeEntryModal?.();
  }

  const uid = variant?.id ?? "new";
  // Add mode renders in the shared entry modal; edit mode swaps into a table row.
  // The form stays frameless in both places so neither host gets a nested card.
  return (
    <form
      ref={formRef}
      action={handle}
      onKeyDown={onKeyDown}
      className="space-y-3"
      data-testid="genomic-variant-form"
    >
      {editing && <input type="hidden" name="id" value={variant!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      <div>
        <label className="label" htmlFor={`gv-gene-${uid}`}>
          Gene
        </label>
        {/* The PGx cross-check (#710) matches this symbol EXACTLY, so a drifted
            spelling drops the check silently. The picker offers the ten symbols
            CPIC guidance actually covers; a hereditary-risk gene (BRCA1 and the
            rest) is still typed freely, which is why the empty state says so
            rather than claiming there is no such gene. */}
        <Combobox
          id={`gv-gene-${uid}`}
          name="gene"
          ariaLabel="Gene"
          value={gene}
          onChange={setGene}
          options={[...PGX_GENE_SYMBOLS]}
          emptyLabel="Not a pharmacogenomic gene — type any symbol"
          placeholder="e.g. BRCA1, CYP2C19"
        />
      </div>

      {/* THE SENTENCE, and the one open editor behind it (#3218). */}
      {openEditor == null && (
        <RecordFactRow
          prefix="genomic-variant"
          summary={summary}
          nouns={GENOMIC_VARIANT_FACT_NOUNS}
          openEditor={openEditor}
          // One chip, one panel here, so a chip's focus identity is its fact key.
          onOpen={(panel, focusKey) =>
            openPanel(panel as GenomicOpenPanel, focusKey)
          }
        />
      )}

      <FactEditorHost
        testId="genomic-variant-editor"
        doneTestId="genomic-variant-editor-done"
        panel={openEditor}
        onDone={closePanel}
        bodyClassName="space-y-3"
        // Hidden rather than unmounted — see the header: this form is DOM-collected,
        // so an unmounted field is a cleared field.
        className={openEditor == null ? "hidden" : undefined}
      >
        <div hidden={openEditor !== "result_type"}>
          <label className="label" htmlFor={`gv-result-type-${uid}`}>
            Result type
          </label>
          <select
            id={`gv-result-type-${uid}`}
            name="result_type"
            className="input"
            defaultValue={variant?.result_type ?? "other"}
            onChange={(e) => setResultType(e.target.value)}
          >
            {GENOMIC_RESULT_TYPES.map((t) => (
              <option key={t} value={t}>
                {resultTypeLabel(t)}
              </option>
            ))}
          </select>
          {/* The value's meaning, which is the one sentence an open editor may carry
              (#5300 rule 4): this select is what routes the row to a consumer. */}
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Pharmacogenomic rows are cross-checked against your medications;
            hereditary-risk rows can change a screening cadence. “Other” is
            stored and read by neither.
          </p>
        </div>

        {/* The three call columns are ONE fact over ONE editor — `variantCallLabel`
            reads them back with one precedence everywhere else. */}
        <div hidden={openEditor !== "call"} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`gv-genotype-${uid}`}>
                Genotype
              </label>
              <input
                id={`gv-genotype-${uid}`}
                name="genotype"
                className="input"
                defaultValue={variant?.genotype ?? ""}
                onChange={(e) => setGenotype(e.target.value)}
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
                onChange={(e) => setStarAllele(e.target.value)}
                placeholder="e.g. *2/*2"
              />
            </div>
          </div>
          <div>
            <label className="label" htmlFor={`gv-zygosity-${uid}`}>
              Zygosity
            </label>
            <select
              id={`gv-zygosity-${uid}`}
              name="zygosity"
              className="input"
              defaultValue={variant?.zygosity ?? ""}
              onChange={(e) => setZygosity(e.target.value)}
            >
              <option value="">—</option>
              {ZYGOSITIES.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div hidden={openEditor !== "variant"}>
          <label className="label" htmlFor={`gv-variant-${uid}`}>
            Variant (rsID / HGVS)
          </label>
          <input
            id={`gv-variant-${uid}`}
            name="variant"
            className="input"
            defaultValue={variant?.variant ?? ""}
            onChange={(e) => setVariantId(e.target.value)}
            placeholder="e.g. rs4986893"
          />
        </div>

        <div hidden={openEditor !== "significance"}>
          <label className="label" htmlFor={`gv-significance-${uid}`}>
            Clinical significance
          </label>
          <select
            id={`gv-significance-${uid}`}
            name="significance"
            className="input"
            defaultValue={variant?.significance ?? ""}
            onChange={(e) => setSignificance(e.target.value)}
          >
            <option value="">—</option>
            {GENOMIC_SIGNIFICANCES.map((s) => (
              <option key={s} value={s}>
                {significanceLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <div hidden={openEditor !== "report_date"}>
          <label className="label" htmlFor={`gv-report-date-${uid}`}>
            Report date
          </label>
          <DateField
            id={`gv-report-date-${uid}`}
            name="report_date"
            value={reportDate}
            onChange={setReportDate}
          />
        </div>

        <div hidden={openEditor !== "source_lab"}>
          <label className="label" htmlFor={`gv-source-lab-${uid}`}>
            Source lab
          </label>
          <input
            id={`gv-source-lab-${uid}`}
            name="source_lab"
            className="input"
            defaultValue={variant?.source_lab ?? ""}
            onChange={(e) => setSourceLab(e.target.value)}
            placeholder="e.g. Invitae"
          />
        </div>

        <div hidden={openEditor !== "interpretation"}>
          <label className="label" htmlFor={`gv-interpretation-${uid}`}>
            Interpretation
          </label>
          <input
            id={`gv-interpretation-${uid}`}
            name="interpretation"
            className="input"
            defaultValue={variant?.interpretation ?? ""}
            onChange={(e) => setInterpretation(e.target.value)}
            placeholder="The report's own interpretation, verbatim"
          />
        </div>

        <div hidden={openEditor !== "notes"}>
          <label className="label" htmlFor={`gv-notes-${uid}`}>
            Notes
          </label>
          <input
            id={`gv-notes-${uid}`}
            name="notes"
            className="input"
            defaultValue={variant?.notes ?? ""}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div hidden={openEditor !== "more"}>
          <RecordFactMoreMenu
            prefix="genomic-variant"
            more={summary.more}
            nouns={GENOMIC_VARIANT_FACT_NOUNS}
            onOpen={(panel) => openPanel(panel as GenomicOpenPanel)}
          />
        </div>
      </FactEditorHost>

      <InlineError>{error}</InlineError>
      <div className="flex gap-2" data-testid="genomic-variant-actions">
        <div
          className="grid w-full sm:w-auto"
          data-testid="genomic-variant-primary-action"
        >
          <SubmitButton pendingLabel="Saving…" variant="primary">
            {editing ? "Save" : "Add"}
          </SubmitButton>
        </div>
        {editing && onDone && (
          <button type="button" className="btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
