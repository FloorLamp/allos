"use client";

import { IconLoader2 } from "@tabler/icons-react";
import Link from "next/link";
import type { ClinicalObservation } from "@/lib/types";
import type { ConfidenceFlag } from "@/lib/extraction-confidence";
import { groupContiguous } from "@/lib/table-sort";
import { observationNameLink } from "@/lib/import-browser";
import { triageRowId } from "@/lib/confidence-triage";
import { EmptyState, MedicalValue } from "./ui";
import { ResponsiveTable, Td } from "./ResponsiveTable";
import { ConfidenceRowNote } from "./ConfidenceBadge";
import { TRIAGE_FOCUS_ROW } from "./TriageFocus";
import NotesText from "./NotesText";
import EditableResultRow from "./EditableResultRow";
import RangeFilterSelect from "./RangeFilterSelect";
import SortableHeader from "./SortableHeader";
import ObservationSearch from "./ObservationSearch";

// The grouping identity for a record: its canonical name when present, else the
// raw name — the same key the biomarkers table groups on, so name-sorted rows
// for the same analyte land adjacent under one heading.
function nameKey(r: ClinicalObservation): string {
  return r.canonical_name?.trim() || r.name;
}

// One read-only row of the NON-ANALYTE presentation (#1182): a vitals BP pair, a
// scan, a PHQ-9 score, a bio-age, a blood type — categories with no lab reference
// band and no "Panel", so they get a compact value/date table with no editable
// affordance (the analyte columns don't apply). The name still links where the
// category has a home (vitals → biomarker series; scan/instrument/derived/
// reference get no link, per observationNameLink).
function ReadonlyObservationRow({
  observation: r,
  rowId,
  focused,
  flag,
}: {
  observation: ClinicalObservation;
  rowId: string;
  focused: boolean;
  flag?: ConfidenceFlag;
}) {
  const nameLink = observationNameLink(r.category, r.canonical_name);
  return (
    <tr
      id={rowId}
      data-focused={focused ? "true" : undefined}
      className={`border-b border-black/5 dark:border-white/10 ${focused ? TRIAGE_FOCUS_ROW : ""}`}
    >
      <Td slot="title" className="font-medium">
        {nameLink ? (
          <Link
            href={nameLink.href}
            className="text-brand-700 hover:underline dark:text-brand-400"
            title={nameLink.title}
          >
            {r.name}
          </Link>
        ) : (
          r.name
        )}
        {flag && <ConfidenceRowNote flag={flag} />}
        {r.provider_name ? (
          <div className="text-xs font-normal text-slate-500 dark:text-slate-400">
            {r.provider_id ? (
              <Link
                href={`/providers/${r.provider_id}`}
                className="hover:text-brand-700 hover:underline dark:hover:text-brand-300"
              >
                {r.provider_name}
              </Link>
            ) : (
              r.provider_name
            )}
          </div>
        ) : null}
      </Td>
      {/* Self-describing headline — a reading with its unit and flag needs no
          "VALUE" label above it (the Td label rule). */}
      <Td slot="value">
        <MedicalValue value={r.value} unit={r.unit} flag={r.flag} />
      </Td>
      <Td
        slot="meta"
        label="Notes"
        empty={!r.notes?.trim()}
        className="text-slate-500 dark:text-slate-400"
      >
        <NotesText notes={r.notes} />
      </Td>
      <Td slot="meta" label="Date" className="whitespace-nowrap">
        {r.date}
      </Td>
    </tr>
  );
}

// The observations table for one medical_records category tab of the import-detail
// results browser (#271): the old CategoryFilterSelect collapsed into the tab
// strip, so the host passes the tab's label as `title` and scopes the observations
// itself. Re-extraction is NOT triggered here anymore (#1071): the immediate
// fire-and-replace icon this table used to carry was the unsafe twin of the
// detail page's preview-first flow, so it was removed — the SOLE per-document
// reprocess is ImportDetailActions' "Preview changes → Save changes". A
// "Processing…" overlay still stays over the table while the document is
// `processing` (a first upload extraction, or a re-extraction kicked off from the
// preview flow), and the app-wide ExtractionToaster refreshes the page and toasts
// when the background job finishes (clearing it).
//
// Presentation splits by category (#1182): analyte categories (lab/biomarker/
// genomics) keep the editable analyte grid — Name · Panel · Value · Reference · …
// — because those legitimately carry a value/unit/reference band; every other
// category (vitals/scan/instrument/derived/reference) gets the read-only compact
// value/date table above, with no Panel/Reference columns and no edit affordance.
export default function ExtractedObservations({
  title = "Extracted results",
  analyte,
  processing,
  observations,
  q,
  range,
  sort,
  emptyMessage,
  tabKey,
  focusedRowId,
  rowFlags,
}: {
  // Heading for the table — the active tab's label ("Labs", "Vitals"…).
  title?: string;
  // Whether this tab's category carries the analyte grammar (value/unit/reference
  // band). True → the editable analyte grid; false → the read-only value/date
  // table. Decided by isAnalyteCategory in lib/import-browser.
  analyte: boolean;
  // The document's extraction is still running (from upload or a re-extraction
  // kicked off from the detail page's preview flow), so we show a spinner and a
  // "Processing…" overlay over the table until it settles.
  processing: boolean;
  observations: ClinicalObservation[];
  q?: string;
  range?: "oor" | "nonoptimal";
  // Active sort column, so we know whether to render contiguous name groups
  // (only when the table is name-sorted, matching the biomarkers table).
  sort: "name" | "panel" | "date";
  emptyMessage: string;
  // The tab these rows belong to — half of a row's DOM id, so a "Check these
  // first" link can name one row on one tab (#2339).
  tabKey: string;
  // The row a `?focus=` label resolved to, when it resolved to exactly one.
  focusedRowId?: string | null;
  // What the extractor hedged about, by row id — only for flags that resolved to
  // exactly one row, so the badge never overstates which row it describes.
  rowFlags?: Record<string, ConfidenceFlag>;
}) {
  // Group contiguous same-name rows only when name-sorted AND on the analyte
  // grid (rows already arrive adjacent by name from the query); the read-only
  // non-analyte table renders flat (its rows are heterogeneous, not one analyte).
  const grouped =
    analyte && sort === "name" ? groupContiguous(observations, nameKey) : null;

  // A row's triage identity (#2339): its anchor id on this tab, whether a
  // "Check these first" link focused it, and what the extractor hedged about it.
  const triage = (r: ClinicalObservation) => {
    const rowId = triageRowId(tabKey, r.id);
    return {
      rowId,
      focused: rowId === focusedRowId,
      flag: rowFlags?.[rowId],
    };
  };

  return (
    <div
      className="card mb-6 overflow-hidden p-0"
      data-testid="extracted-observations"
    >
      <div className="flex flex-wrap items-center gap-4 px-5 pt-5">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {title}{" "}
          <span className="font-normal text-slate-500 dark:text-slate-400">
            ({observations.length})
          </span>
        </h2>
        <ObservationSearch q={q} />
        {/* The out-of-range filter keys on a reference band — analyte-only. */}
        {analyte && <RangeFilterSelect value={range} />}
        {processing && (
          <IconLoader2
            className="ml-auto h-4 w-4 animate-spin text-slate-500 motion-reduce:animate-none dark:text-slate-400"
            aria-label="Processing"
          />
        )}
      </div>

      <div className="relative">
        {observations.length === 0 ? (
          <div className="p-5">
            <EmptyState message={emptyMessage} />
          </div>
        ) : (
          <div className="mt-3 max-h-[70vh] overflow-auto">
            {/* Stacked cards below `sm` (#1426's shared primitive, adopted here by
                #2614). The analyte grid is eight columns wide; on a phone that cut
                the header to "REFER|" and the reference bands to "3.5-5.|" against
                the card edge, reachable only by swiping — on the very surface an
                import is TRIAGED from. Nothing changes at `sm` and up. */}
            <ResponsiveTable className="w-full">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/10">
                  <SortableHeader
                    column="name"
                    label="Name"
                    defaultSort="name"
                  />
                  {analyte && (
                    <SortableHeader
                      column="panel"
                      label="Panel"
                      defaultSort="name"
                    />
                  )}
                  <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                    Value
                  </th>
                  {analyte && (
                    <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                      Reference
                    </th>
                  )}
                  <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                    Notes
                  </th>
                  {analyte && (
                    <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                      Category
                    </th>
                  )}
                  <SortableHeader
                    column="date"
                    label="Date"
                    defaultSort="name"
                    defaultDir="desc"
                  />
                  {analyte && (
                    <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {!analyte
                  ? observations.map((r) => (
                      <ReadonlyObservationRow
                        key={r.id}
                        observation={r}
                        {...triage(r)}
                      />
                    ))
                  : grouped
                    ? grouped.map(({ row: r, isGroupStart, isGroupEnd }) => (
                        <EditableResultRow
                          key={r.id}
                          observation={r}
                          grouped={{ isGroupStart, isGroupEnd }}
                          {...triage(r)}
                        />
                      ))
                    : observations.map((r) => (
                        <EditableResultRow
                          key={r.id}
                          observation={r}
                          {...triage(r)}
                        />
                      ))}
              </tbody>
            </ResponsiveTable>
          </div>
        )}

        {processing && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/70 dark:bg-ink-900/70">
            <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
              Processing…
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
