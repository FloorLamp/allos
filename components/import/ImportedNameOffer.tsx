"use client";

import { useState } from "react";
import { lookupRxcui } from "@/app/(app)/nutrition/intake-actions";
import { adoptImportedMedicationName } from "@/app/(app)/import/name-actions";
import { isCleanerName } from "@/lib/imported-name";
import { useToast } from "@/components/Toast";
import { useRouter } from "next/navigation";

// The OFFER half of the imported-name boundary (issue #3480) — one row per imported
// medication still carrying its document's own label.
//
// WHAT THE PERSON SEES. The name as the document wrote it, and a button: "Find a
// clearer name". Pressing it lists the RxNorm concepts that match the string, each
// with "Use this name". Nothing changes until one is pressed, and the row then says
// what it kept: "Imported as “…”". Ignoring the offer is a complete answer — the
// medication keeps the name it has, which is the issue's "declining keeps today's
// behavior".
//
// WHY IT IS AN OFFER AND NOT A TRANSFORM. A casing pass at the display boundary
// cannot tell whether "OR" is the route abbreviation or a word in a product name,
// and it would rewrite, on every render, text nobody agreed to change
// (lib/imported-name.ts carries the full reasoning; lib/allergen-vocabulary.ts is
// the recorded precedent for the sibling problem). A medicine's name is how somebody
// identifies their own medicine, so the only safe place to change one is a moment
// where a person is looking at both versions.
//
// THE LOOKUP IS THE EXISTING ONE. `lookupRxcui` is the shared server action behind
// the intake forms' "Match standardized ingredient" affordance (#846 →
// components/intake/RxNormAffordance.tsx → lib/rxnorm.ts, #144). This component
// deliberately does NOT reuse `useIntakeRxcui`: that hook is a FORM-FIELD state
// machine (hidden inputs, invalidate-on-name-edit, reset-after-save) whose copy
// speaks about saving an item, none of which exists here. It shares the one thing
// worth sharing — the resolver — and adds nothing beside it.
export default function ImportedNameOffer({
  itemId,
  documentId,
  name,
  sourceName,
}: {
  itemId: number;
  documentId: number;
  // The name as STORED — the document's label, until somebody accepts an offer.
  name: string;
  // What the document said, once a name has been accepted in its place. Null while
  // `name` is still the document's own label.
  sourceName: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [candidates, setCandidates] = useState<
    { rxcui: string; name: string }[] | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function find() {
    setLoading(true);
    setNote(null);
    try {
      const found = await lookupRxcui(name);
      // Only concepts that are actually an improvement are offered. RxNorm returns
      // product-level names and some of them shout too; offering one of those would
      // trade a document string for a document string.
      const usable = found.filter((c) => isCleanerName(name, c.name));
      setCandidates(usable);
      if (usable.length === 0)
        setNote(
          "No clearer name came back. The name stays as the document wrote it."
        );
    } catch {
      setCandidates([]);
      setNote("Couldn't reach the RxNorm lookup. The name is unchanged.");
    } finally {
      setLoading(false);
    }
  }

  async function use(candidate: { rxcui: string; name: string }) {
    setBusy(candidate.rxcui);
    try {
      const fd = new FormData();
      fd.set("item_id", String(itemId));
      fd.set("document_id", String(documentId));
      fd.set("rxcui", candidate.rxcui);
      fd.set("name", candidate.name);
      const res = await adoptImportedMedicationName(fd);
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(`Renamed to ${candidate.name}.`);
      setCandidates(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      data-testid="imported-name-offer"
      className="border-b border-black/5 py-3 last:border-0 dark:border-white/10"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="font-medium text-slate-800 dark:text-slate-100"
          data-testid="imported-name-current"
        >
          {name}
        </span>
        {/* Offered again after an accepted rename, deliberately: a better concept
            may exist, and the action's COALESCE keeps the DOCUMENT's label as the
            preserved one however many times somebody re-picks. */}
        <button
          type="button"
          data-testid="imported-name-find"
          className="btn-ghost px-2 py-0.5 text-xs"
          onClick={() => void find()}
          disabled={loading}
        >
          {loading ? "Looking up…" : "Find a clearer name"}
        </button>
      </div>
      {sourceName && (
        <p
          className="mt-1 text-xs text-slate-500 dark:text-slate-400"
          data-testid="imported-name-kept"
        >
          Imported as “{sourceName}”
        </p>
      )}
      {note && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {note}
        </p>
      )}
      {candidates && candidates.length > 0 && (
        <div
          data-testid="imported-name-candidates"
          className="mt-2 space-y-1 rounded-lg border border-black/10 p-2 dark:border-white/10"
        >
          {candidates.map((c) => (
            <div
              key={c.rxcui}
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <span className="text-slate-600 dark:text-slate-300">
                {c.name}{" "}
                <span className="text-slate-500 dark:text-slate-400">
                  · {c.rxcui}
                </span>
              </span>
              <button
                type="button"
                data-testid={`imported-name-use-${c.rxcui}`}
                className="btn-ghost px-2 py-0.5 text-xs"
                onClick={() => void use(c)}
                disabled={busy != null}
              >
                {busy === c.rxcui ? "Renaming…" : "Use this name"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
