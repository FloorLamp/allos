import ImportedNameOffer from "./ImportedNameOffer";

// The imported-name review card (issue #3480), above this document's medication
// listing. It appears only when at least one of this document's rows still carries
// the document's own label rather than a name — so on a clean import there is no
// card, no prompt, and nothing to dismiss.
//
// THE LEAD SAYS "these", not "these medications". Every row the import wrote arrives
// as a medication, but a person may re-save one as a supplement from the medication
// form, and the boundary follows the row's PROVENANCE rather than its current kind
// (lib/imported-name-write.ts). Naming the kind in the lead would be wrong on screen
// for exactly those rows.
//
// One lead sentence, no fold (copy.md rule 10): the mechanism is the row beneath it.
export default function ImportedNamesCard({
  documentId,
  rows,
}: {
  documentId: number;
  rows: {
    id: number;
    name: string;
    source_name: string | null;
  }[];
}) {
  return (
    <div className="card" data-testid="imported-names-card">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Names from this document
      </h2>
      <p className="mt-1 mb-2 text-sm text-slate-600 dark:text-slate-300">
        These came in under the wording the document used. Swap one for its
        standard name if you like — what the document said is kept either way.
      </p>
      <div className="text-sm">
        {rows.map((row) => (
          <ImportedNameOffer
            key={row.id}
            itemId={row.id}
            documentId={documentId}
            name={row.name}
            sourceName={row.source_name}
          />
        ))}
      </div>
    </div>
  );
}
