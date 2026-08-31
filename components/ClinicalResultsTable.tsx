"use client";

import { useState } from "react";
import Link from "next/link";
import { IconChevronRight } from "@tabler/icons-react";
import { Tag, MedicalValue } from "./ui";
import SortableHeader from "./SortableHeader";
import { CARD_MODE_ONLY } from "@/lib/card-row";
import { ResponsiveTable, Td } from "./ResponsiveTable";
import NotesText from "./NotesText";
import SourceDocumentLink from "./SourceDocumentLink";
import ResultForm from "./ResultForm";
import OverflowMenu, { MENU_ITEM, MENU_ITEM_DANGER } from "./OverflowMenu";
import { useConfirm } from "./ConfirmDialog";
import { useUndoableDelete } from "./useUndoableDelete";
import InfoTooltipIcon from "./InfoTooltipIcon";
import {
  updateResult,
  deleteResult,
} from "@/app/(app)/results/clinical-result-actions";
import { loadClinicalResultPanelRows } from "@/app/(app)/results/actions";
import type {
  ClinicalResultTableObservation,
  ClinicalResultsSearchParams,
} from "@/app/(app)/results/clinical-result-index";
import {
  referenceCell,
  type ReferenceCell,
} from "@/lib/reading-reference-cell";
import { groupContiguous } from "@/lib/table-sort";
import { isBiomarkerStale } from "@/lib/reference-range";
import {
  DATE_AGE_SEPARATOR,
  readingDateLine,
  STALE_AGE_TITLE,
} from "@/lib/reading-date-line";
import { type DisplayFormatPrefs } from "@/lib/format-date";
import { useFormatPrefs } from "./FormatPrefsProvider";
import { RESULTS_CATALOG_CATEGORIES } from "@/lib/medical-categories";
import { clinicalResultDetailHref, type AppRoute } from "@/lib/hrefs";
import SubjectChip from "./SubjectChip";
import { subjectChipVisible, itemAffordanceVisible } from "@/lib/multi-view";
import {
  clinicalResultRowKey,
  tableNameKey,
  tablePanelId,
  DEFAULT_CLINICAL_RESULT_SORT,
  type ClinicalResultSortColumn,
} from "@/lib/derived-table";
import { OTHER_PANEL, panelLabel, type PanelId } from "@/lib/biomarker-panels";
import {
  panelGroupSummary,
  type BoundedPanelGroup,
} from "@/lib/biomarker-panel-groups";

// A table row in multi-view carries its owning profile + stamped subject identity
// (stampSubjects); single-view rows omit both. The subject powers the leading chip
// column and the per-row write gate, and profileId re-keys grouping per member so
// two members' same-named analytes never collapse into one heading (#1331).
// Present ONLY when more than one profile is in view (#1331): the acting profile
// (its own rows imply the subject, so they get no chip) + the flag that turns on the
// leading Profile column and the subject-scoped grouping/write-targeting. Absent in
// single view → the table renders byte-identical.
export interface ClinicalResultsMultiView {
  actingProfileId: number;
}

// The column ordered when the URL names none. Read from lib/derived-table rather than
// restated, so the (hidden) header arrows, the card-mode select and the server's
// parseClinicalResultSortColumn fallback are ONE value instead of twins that can drift.
const DEFAULT_SORT = DEFAULT_CLINICAL_RESULT_SORT;

// The active-filter context threaded through to build the panel/category filter
// links (each preserves the current sort/range/etc., matching the server-built
// hrefs the table used before it became interactive).
interface FilterCtx {
  category?: string;
  panel?: PanelId;
  range?: string;
  q?: string;
  sort: ClinicalResultSortColumn;
  dir: "asc" | "desc";
  current: boolean;
}

// Build a filtered Clinical results URL from the active
// filters, dropping empty ones (#1042 phase 5 — the anchor keeps a filter/sort/
// pager navigation on the section).
function qs(params: Record<string, string | undefined>): AppRoute {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `/results/clinical-results?${s}` : "/results/clinical-results";
}

// A small amber badge flagging an analyte whose latest result has gone stale
// (over a year old — a yearly-retest heuristic).
//
// The badge is the WORD; the sentence behind it is a constant explainer of the same
// vocabulary the amber age token uses, and #3970 rule 1 states it once — on the Date
// column header — instead of mounting an `h-8 w-8` button on every stale analyte.
function staleBadge() {
  return (
    <span className="ml-2 rounded-full bg-amber-50 px-1.5 py-0.5 align-middle text-xs font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-400/10 dark:text-amber-400">
      Stale
    </span>
  );
}

// A small slate badge marking a read-time DERIVED index (issue #40) — computed
// from other readings, not measured. The touch/keyboard info affordance keeps the
// formula (with its component values) inspectable.
function derivedBadge(formula?: string) {
  const detail = formula
    ? `Derived: ${formula}`
    : "Computed from other readings";
  return (
    <span className="ml-2 inline-flex items-center gap-0.5 align-middle">
      <span
        data-testid="derived-badge"
        className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-300"
      >
        Derived
      </span>
      <InfoTooltipIcon label={detail} data-testid="clinical-derived-help" />
    </span>
  );
}

// Show the canonical name (the grouping identity) when present, linking to the
// biomarker detail page; fall back to the raw provided name otherwise. Flags the
// group with a Stale badge when its latest result is overdue, and a Derived badge
// when the result is a computed index.
function nameCell(r: {
  name: string;
  canonical_name: string | null;
  stale?: boolean;
  derived?: boolean;
  derived_formula?: string;
}) {
  const stale = r.stale ? staleBadge() : null;
  const derived = r.derived ? derivedBadge(r.derived_formula) : null;
  if (!r.canonical_name)
    return (
      <span>
        <span className="font-medium">{r.name}</span>
        {stale}
        {derived}
      </span>
    );
  return (
    <span>
      <Link
        href={clinicalResultDetailHref(r.canonical_name)}
        className="font-medium text-brand-700 hover:underline dark:text-brand-400"
      >
        {r.canonical_name}
      </Link>
      {stale}
      {derived}
    </span>
  );
}

// Date cell: ONE line, at both viewports (#2316) — `2026-06-03 · 2mo`.
//
// It used to be a `flex-col` of three: the ISO date, the same fact re-notated as
// "2 months ago", and a "Source document" link. On a card that is three stacked
// lines under one DATE label, two of which say the same thing and one of which is
// not a date at all. The age is the shared compact formatter now (#1216, via
// lib/reading-date-line) so this row and the dashboard's clinical-result readout round
// into the same buckets, the over-a-year amber treatment and its pinned detail ride
// on the AGE token (the age is what went stale), and provenance moved to the row's
// ⋯ menu, which is what that menu is for. Older readings in a run still omit the age.
function dateCell(
  r: { date: string; category: string | null },
  now: string,
  showAge: boolean,
  prefs: DisplayFormatPrefs,
  reportedPanelDetail?: string
) {
  const line = readingDateLine(r, now, showAge, prefs);
  return (
    <span className="whitespace-nowrap">
      {line.date}
      {line.age ? (
        <>
          {DATE_AGE_SEPARATOR}
          <span className="inline-flex items-center gap-0.5">
            <span
              data-testid="clinical-result-age"
              className={`text-xs ${line.ageClassName}`}
            >
              {line.stale && "⚠️ "}
              {line.age}
            </span>
          </span>
        </>
      ) : null}
      {reportedPanelDetail ? (
        <InfoTooltipIcon
          label={reportedPanelDetail}
          data-testid="clinical-reported-panel-help"
        />
      ) : null}
    </span>
  );
}

function reportedPanelDisclosureLabel(
  observation: ClinicalResultTableObservation,
  reported: string
) {
  return `Reported under “${reported}” — ${tableNameKey(observation)}, ${observation.date}`;
}

// The Panel cell (#1502). It shows the NORMALIZED clinical panel resolved from the
// row's canonical name — "Lipids", "Complete blood count" — and links the facet by
// stable SLUG, replacing the old cell that printed and filtered by the stored
// free-text heading (in practice the lab VENDOR: "Quest Diagnostics", "LabCorp").
//
// The stored `panel` column is untouched PROVENANCE and still surfaces two ways:
// through the row date's shared disclosure on a resolved row ("Reported under …"), and
// as the visible text for a row the taxonomy can't place — an un-canonicalized analyte the
// extractor coined, where the document's own heading is the best label we have.
// That fallback row is deliberately NOT a filter link: "everything drawn at
// LabCorp" is the useless facet this issue removed, and `?panel=other` (reachable
// from the filter chip) is the meaningful "unclassified" view.
//
// DESKTOP-ONLY DETAIL since #2316 — no `slot`, so the column stays (with its filter
// link) at `md` and up and claims no card line below `sm`. Grouping (#1499) is what
// made it redundant there: the server always groups, `PanelGroupHeader` prints the
// group's label, so inside a group headed "Lipids" every card also said
// `PANEL Lipids`. See the meta-slot rule in components/ResponsiveTable.tsx.
function PanelCell({
  observation,
  href,
}: {
  observation: ClinicalResultTableObservation;
  href: (id: PanelId) => AppRoute;
}) {
  const id = tablePanelId(observation);
  const reported = observation.panel?.trim() || null;
  if (id !== OTHER_PANEL) {
    return (
      <Td label="Panel" className="hidden md:table-cell">
        <Link
          href={href(id)}
          className="text-xs text-slate-500 hover:text-brand-700 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
        >
          {panelLabel(id)}
        </Link>
      </Td>
    );
  }
  return (
    <Td label="Panel" empty={!reported} className="hidden md:table-cell">
      {reported ? (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {reported}
        </span>
      ) : (
        <span className="text-slate-300 dark:text-slate-600">—</span>
      )}
    </Td>
  );
}

// The Reference cell (#2315) — a JUDGMENT cell, not a transcription.
//
// It used to print `reference_range`, the free-text string the lab document stated,
// beside a flag that was never derived from it: `reconciledFlag` judges against the
// CANONICAL reference range and then the CANONICAL optimal band, and the printed
// string reaches it only as an input to the #761 unit-mislabel detector. The row
// showed the one range that never judges it and hid both that do — 10.5% of a real
// profile's readings visibly contradicting their own row, including a red "High" on
// a value sitting comfortably inside the printed range.
//
// The cell content is decided server-side (lib/reading-reference-cell over
// lib/queries/metric-judgment) and arrives on the row, so nothing is derived here —
// this renders the answer, names it, and keeps the lab's own string as the hover
// provenance it always was. The full string stays on the reading detail page under
// its own "Lab reference" column.
//
// `cell` is absent only on a derived index, which never reaches this component.
function ReferenceCellTd({
  cell,
  printed,
}: {
  cell?: ReferenceCell;
  printed: string | null;
}) {
  // The fallback for a row that somehow arrives without a resolved cell: the lab's
  // string, labelled and prefixed as the lab's. Built by the SAME pure function the
  // gather uses rather than hand-assembled here, so the fallback cannot drift from
  // the real answer's spelling (which is what would have happened to #2344's `lab`
  // prefix the moment this literal was left behind).
  const resolved: ReferenceCell =
    cell ?? referenceCell({ judgment: null, printed, unit: null });
  return (
    <Td
      slot="meta"
      label={resolved.label}
      empty={!resolved.text}
      className="hidden text-slate-500 sm:table-cell dark:text-slate-400"
    >
      {/* #3970 rule 2. The lab's own printed string is a PER-ROW fact with an
          existing detail home: the reading detail page renders it in full under its
          own "Lab reference" column (#2315, app/(app)/results/clinical-results/view).
          The table keeps the verdict — the bands the flag actually came from — and
          the detail keeps the derivation, so the row spends no control on it. */}
      <span
        data-testid="clinical-result-reference"
        data-judged={resolved.judged ? "true" : "false"}
      >
        {resolved.text ?? "—"}
      </span>
    </Td>
  );
}

// The class that tightens a result row NESTED INSIDE an open panel group (#1581
// section C). In card mode the group already provides the container, so the result
// under it does not also need the full row padding — that is the #1539 double-frame
// pattern, and with the pager gone an expanded group is the whole panel rather than
// whatever slice a page held. Same mechanism as `.table-section-row` one rule above
// it: an element+class selector that outranks `.table-cards tr`, which a utility
// class on the row could not. Desktop is untouched (the rule is `max-sm:` only), and
// tables that render UNGROUPED never carry the class.
const NESTED_ROW = "table-nested-row";

// One clinical-result row. Display mode keeps the rich analyte presentation
// (canonical-name grouping heading + Stale badge, panel/category filter links,
// relative-age date, responsive column hiding) and adds a kebab menu; edit swaps
// the row in place for the shared ResultForm. Edit + delete run through the same
// profile-scoped updateResult/deleteResult the document view uses — delete matches
// the document view (any row, manual or extracted, behind a danger confirm).
function ClinicalResultRow({
  r,
  isStart,
  isEnd,
  stale,
  now,
  filters,
  multiView,
}: {
  r: ClinicalResultTableObservation;
  isStart: boolean;
  isEnd: boolean;
  stale: boolean;
  now: string;
  filters: FilterCtx;
  multiView?: ClinicalResultsMultiView;
}) {
  const prefs = useFormatPrefs();
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const confirm = useConfirm();
  const undoable = useUndoableDelete();

  // Multi-view (#1331): the row's own subject powers the leading chip + the write
  // gate. A chip shows only on a NON-acting member's row; the edit/delete affordance
  // is gated on the SUBJECT's write access (a read-only-granted member's rows show
  // no buttons), and each write posts the row's OWN profile_id so it targets the
  // subject, never the acting profile. Single view leaves all of this off.
  const isActing =
    !multiView || r.subject?.profileId === multiView.actingProfileId;
  const canWrite = multiView
    ? itemAffordanceVisible("item", {
        isActing,
        subjectCanWrite: r.subject?.access === "write",
      })
    : true;
  // What the ⋯ menu would hold (#2316). Edit + delete are the WRITE items;
  // "View source document" is provenance navigation and is offered on any row that
  // has a document, read-only or not. The menu renders when at least one item does.
  const canViewSource = r.document_id != null;
  const hasMenu = canWrite || canViewSource;
  const showChip =
    !!multiView && !!r.subject && subjectChipVisible({ multi: true, isActing });
  const writeProfileId = multiView ? r.profileId : undefined;
  const reportedPanelAlias =
    !r.derived && tablePanelId(r) !== OTHER_PANEL
      ? r.panel?.trim() || null
      : null;
  // The leading subject cell (multi-view only), rendered first in every row. On a
  // card it's the first meta item — the chip IS its own label (#534), so no
  // "Profile" prefix — and it drops out entirely on an acting-profile row.
  const subjectCell = multiView ? (
    <Td slot="meta" empty={!showChip} className="align-top">
      {showChip && r.subject ? <SubjectChip subject={r.subject} /> : null}
    </Td>
  ) : null;
  // The name cell. In TABLE mode the group's name shows once, on the group's start
  // row (the classic run-heading). A CARD is a standalone row, so a continuation
  // card with no name would be unreadable — it repeats the name in card mode. Same
  // authored cell, one visibility rule; never a second, separately-written tree.
  // The rule is CARD_MODE_ONLY (lib/card-row.ts, #3457) rather than a `sm:` literal:
  // this is exactly what that constant is for — markup that exists only on a card —
  // and a second copy of the number would have to keep agreeing with the
  // `table-cards` CSS that lays this row out.
  const titleCell = (
    <Td slot="title">
      <span className={isStart ? undefined : CARD_MODE_ONLY}>
        {nameCell({ ...r, stale })}
      </span>
    </Td>
  );

  if (editing) {
    return (
      <tr
        className={`${NESTED_ROW} border-b border-black/5 bg-slate-50/60 dark:border-white/10 dark:bg-ink-900/60`}
      >
        <Td slot="full" colSpan={multiView ? 9 : 8} className="py-3">
          <ResultForm
            mode="edit"
            observation={r}
            action={updateResult}
            onDone={() => setEditing(false)}
            categories={RESULTS_CATALOG_CATEGORIES}
            writeProfileId={writeProfileId}
          />
        </Td>
      </tr>
    );
  }

  const { category, panel, range, q, sort, dir, current } = filters;
  // A derived index is a computed, read-only virtual row: no source document, no
  // panel/category filter links, and no edit/delete (there's no stored row to
  // mutate). Its formula shows in the Notes column so the derivation is visible.
  if (r.derived) {
    return (
      <tr
        className={`${NESTED_ROW}${isEnd ? " border-b border-black/5 dark:border-white/10" : ""}`}
      >
        {subjectCell}
        {titleCell}
        {/* Panel/Reference are structurally absent for a computed index — they hold
            the table's column grid, and claim no card slot (`empty`), so the card
            shows only what a derived row actually has. */}
        <Td empty className="hidden md:table-cell">
          <span className="text-slate-300 dark:text-slate-600">—</span>
        </Td>
        <Td slot="value">
          <MedicalValue
            value={r.value}
            unit={r.unit}
            flag={r.flag}
            showFlagLabel
          />
        </Td>
        <Td
          empty
          className="hidden text-slate-500 sm:table-cell dark:text-slate-400"
        >
          —
        </Td>
        <Td
          slot="meta"
          label="Formula"
          empty={!r.derived_formula}
          className="hidden text-slate-500 md:table-cell dark:text-slate-400"
        >
          {r.derived_formula ?? ""}
        </Td>
        {/* Desktop-only detail (#2316), like the stored row's Category cell. */}
        <Td
          label="Category"
          empty={!r.category}
          className="hidden md:table-cell"
        >
          {r.category ? <Tag value={r.category} /> : null}
        </Td>
        <Td slot="meta" label="Date">
          {dateCell(r, now, !!r.is_latest, prefs)}
        </Td>
        <Td
          slot="actions"
          className="text-right text-xs text-slate-500 dark:text-slate-400"
        >
          Computed
        </Td>
      </tr>
    );
  }
  return (
    <tr
      className={`${NESTED_ROW}${isEnd ? " border-b border-black/5 dark:border-white/10" : ""}`}
    >
      {subjectCell}
      {titleCell}
      <PanelCell
        observation={r}
        href={(id) =>
          qs({
            category,
            panel: id,
            range,
            sort,
            dir,
            current: current ? "1" : undefined,
          })
        }
      />
      <Td slot="value">
        {/* The severity WORD, visibly (#1220/#2315). This list intermixes
            out-of-range and above-optimal readings, so red-vs-amber alone was the
            only channel telling a sighted reader which one a row is. */}
        <MedicalValue
          value={r.value}
          unit={r.unit}
          flag={r.flag}
          showFlagLabel
        />
      </Td>
      <ReferenceCellTd cell={r.referenceCell} printed={r.reference_range} />
      <Td
        slot="meta"
        label="Notes"
        empty={!r.notes}
        className="hidden text-slate-500 md:table-cell dark:text-slate-400"
      >
        <NotesText notes={r.notes} />
      </Td>
      {/* Desktop-only detail (#2316): no `slot`, so the column and its filter link
          stay at `md` and up and the card stops reprinting a value that is constant
          inside every real panel — see components/ResponsiveTable.tsx. */}
      <Td label="Category" empty={!r.category} className="hidden md:table-cell">
        <Link
          href={qs({
            category: r.category ?? undefined,
            panel,
            range,
            q,
            sort,
            dir,
            current: current ? "1" : undefined,
          })}
          className="hover:opacity-80"
        >
          {r.category ? <Tag value={r.category} /> : null}
        </Link>
      </Td>
      <Td slot="meta" label="Date">
        {dateCell(
          r,
          now,
          !!r.is_latest,
          prefs,
          reportedPanelAlias
            ? reportedPanelDisclosureLabel(r, reportedPanelAlias)
            : undefined
        )}
      </Td>
      <Td slot="actions">
        {/* The menu renders whenever it has at least one item (#2316). It used to be
            `canWrite ? … : null` (#1331), which was right while every item was a
            WRITE — but "View source document" is provenance NAVIGATION, and a
            household-granted read-only row is exactly the row whose reader most
            needs to see where a value came from. So a read-only row with a source
            document gets a menu holding that one item; a read-only row without one
            still gets no menu, because an empty menu is a worse affordance than
            none. Multi-view (#1331): a row whose SUBJECT is read-only-granted keeps
            showing no edit/delete; single-view rows are always the acting profile. */}
        {hasMenu ? (
          <div className="flex items-center justify-end">
            <OverflowMenu
              kind="Result"
              itemName={r.name}
              open={menuOpen}
              onOpenChange={setMenuOpen}
            >
              {({ close }) => (
                <>
                  {canWrite ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setEditing(true);
                        close();
                      }}
                      className={MENU_ITEM}
                    >
                      Edit
                    </button>
                  ) : null}
                  {/* Plain button (not a form action): confirm() opens a modal the
                    user must answer, which would deadlock inside a form-action
                    transition. */}
                  {canWrite ? (
                    <button
                      type="button"
                      role="menuitem"
                      className={MENU_ITEM_DANGER}
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete result",
                          // Name it the way the row the user clicked names it —
                          // tableNameKey is the same canonical-preferred identity
                          // nameCell renders (#1501), so the confirm can't say
                          // "URIC ACID" about a row labelled "Uric Acid".
                          message: `Delete “${tableNameKey(r)}”? This can be undone.`,
                          confirmLabel: "Delete",
                          danger: true,
                        });
                        if (!ok) return;
                        close();
                        const fd = new FormData();
                        fd.set("id", String(r.id));
                        // Multi-view: target the ROW's subject profile
                        // (gateItemProfile).
                        if (writeProfileId)
                          fd.set("profile_id", String(writeProfileId));
                        await undoable(deleteResult, fd, {
                          deletedMessage: "Result deleted.",
                        });
                      }}
                    >
                      Delete
                    </button>
                  ) : null}
                  {/* Provenance navigation, moved off the card's date line (#2316).
                      Last, under the writes, and the ONLY item a read-only row has. */}
                  {canViewSource ? (
                    <SourceDocumentLink
                      documentId={r.document_id}
                      className={MENU_ITEM}
                      testId="clinical-result-source-document-link"
                      role="menuitem"
                      onClick={close}
                    >
                      View source document
                    </SourceDocumentLink>
                  ) : null}
                </>
              )}
            </OverflowMenu>
          </div>
        ) : null}
      </Td>
    </tr>
  );
}

// The collapsed PANEL-GROUP header (#1499 section A) — the row that replaces a wall
// of results with an index entry: "Lipids · 6 analytes · 1 flagged", tap to expand.
//
// ONE ROW, BOTH VIEWPORTS. It is a `<tr>` inside the group's `<tbody>`, so the
// desktop table and the phone's card stack (.table-cards re-lays this same DOM) get
// the same grouping from the same markup — the AGENTS.md responsive-surface rule:
// no `hidden md:*` twin to drift, and no per-viewport semantic fork where a phone
// groups and a desktop doesn't.
//
// A FLAGGED GROUP SELF-IDENTIFIES: the amber treatment is on the BUTTON, not the
// `<tr>` — `.table-cards tr` (a class+element selector) outranks a utility class on
// the row in card mode, so styling the row would silently lose on a phone, which is
// the one viewport this is for.
function PanelGroupHeader({
  group,
  open,
  onToggle,
  panelId,
  colSpan,
}: {
  group: BoundedPanelGroup<ClinicalResultTableObservation>;
  open: boolean;
  onToggle: () => void;
  panelId: string;
  colSpan: number;
}) {
  const flagged = group.flaggedCount > 0;
  return (
    <tr
      className="table-section-row"
      data-testid="clinical-result-panel-header"
    >
      <Td slot="full" colSpan={colSpan} className="px-0! py-0!">
        <button
          type="button"
          data-testid="clinical-result-panel-toggle"
          data-panel={group.panel}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={panelGroupSummary(group)}
          onClick={onToggle}
          className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition max-sm:rounded-xl ${
            flagged
              ? "bg-amber-50/70 hover:bg-amber-100/70 dark:bg-amber-950/30 dark:hover:bg-amber-950/50"
              : "bg-slate-50/70 hover:bg-slate-100/70 dark:bg-ink-850/50 dark:hover:bg-ink-800/60"
          }`}
        >
          <IconChevronRight
            className={`h-4 w-4 shrink-0 text-slate-500 transition-transform dark:text-slate-400 ${
              open ? "rotate-90" : ""
            }`}
            stroke={2}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate font-semibold text-slate-800 dark:text-slate-100">
            {group.label}
          </span>
          <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
            {group.analyteCount}
          </span>
          {flagged && (
            <span
              data-testid="clinical-result-panel-flagged"
              className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-400/15 dark:text-amber-300"
            >
              {group.flaggedCount} flagged
            </span>
          )}
        </button>
      </Td>
    </tr>
  );
}

// The rows a group is currently showing, and whether that is all of them. The
// server's slice is what arrived; a fetched set replaces it wholesale.
function groupRows(
  group: BoundedPanelGroup<ClinicalResultTableObservation>,
  loaded: Map<PanelId, ClinicalResultTableObservation[]>
): ClinicalResultTableObservation[] {
  return loaded.get(group.panel) ?? group.rows;
}

function groupComplete(
  group: BoundedPanelGroup<ClinicalResultTableObservation>,
  loaded: Map<PanelId, ClinicalResultTableObservation[]>
): boolean {
  return loaded.has(group.panel) || group.rows.length >= group.total;
}

// The footer inside an expanded group that has more results than it was given —
// the visible half of the payload bound (#1651). It states what is being held back
// and loads the rest on demand; a collapsed group's expansion loads through the same
// path, so there is one fetch, not two mechanisms.
function PanelRowsFooter({
  group,
  shown,
  loading,
  failed,
  onLoad,
  colSpan,
}: {
  group: BoundedPanelGroup<ClinicalResultTableObservation>;
  shown: number;
  loading: boolean;
  failed: boolean;
  onLoad: () => void;
  colSpan: number;
}) {
  return (
    <tr className={NESTED_ROW} data-testid="clinical-result-panel-more">
      <Td slot="full" colSpan={colSpan} className="py-2">
        {loading ? (
          <span
            className="text-xs text-slate-500 dark:text-slate-400"
            data-testid="clinical-result-panel-loading"
          >
            Loading clinical results…
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            {failed ? (
              <span data-testid="clinical-result-panel-error">
                Couldn’t load these clinical results.
              </span>
            ) : (
              shown > 0 && (
                <span>
                  Showing {shown} of {group.total} clinical results
                </span>
              )
            )}
            <button
              type="button"
              data-testid="clinical-result-panel-load-all"
              data-panel={group.panel}
              onClick={onLoad}
              className="font-medium text-brand-700 hover:underline dark:text-brand-400"
            >
              {failed
                ? "Try again"
                : `Show all ${group.total} clinical ${group.total === 1 ? "result" : "results"}`}
            </button>
          </span>
        )}
      </Td>
    </tr>
  );
}

// What the reader has opened, and what has been loaded for it. All five fields move
// together under ONE signature: they describe a particular URL's result set, so when
// the URL changes they are replaced wholesale rather than carried onto rows they no
// longer describe.
interface DisclosureState {
  signature: string;
  open: Set<PanelId>;
  // Panels whose FULL row set has been fetched — the server's bounded slice is
  // replaced by it.
  loaded: Map<PanelId, ClinicalResultTableObservation[]>;
  loading: Set<PanelId>;
  failed: Set<PanelId>;
}

function initialDisclosure(
  signature: string,
  initialOpen: readonly PanelId[]
): DisclosureState {
  return {
    signature,
    open: new Set(initialOpen),
    loaded: new Map(),
    loading: new Set(),
    failed: new Set(),
  };
}

function without<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  next.delete(value);
  return next;
}

// The Clinical results table. Client-side so each row can swap in place for an
// inline editor and offer delete — but the display, grouping, sorting, staleness,
// and filter links are unchanged from the prior server-rendered table.
//
// NO PAGER (#1581 section A). It used to ship one 50-row page (#114) and round-trip
// the rest through `?p=`, which is a ROW-denominated bound over a surface whose unit
// is the PANEL: a six-analyte lipid panel with twelve draws is seventy-two rows, so a
// panel could straddle a page boundary and render on both with partial counts, and
// paging re-collapsed every group the reader had opened. The INDEX is bounded by
// construction instead — PANEL_IDS is a closed, small taxonomy (37 entries today), so
// the header list has a hard ceiling no lab history can exceed.
//
// BOUNDED PAYLOAD (#1651). That ceiling is on the index, not on the results inside
// it, and props handed to a client component are serialized into the RSC payload
// whatever the component renders — so gating rows behind `{open && …}` bounded the
// DOM and nothing else. The groups therefore arrive already grouped and already
// BOUNDED (lib/biomarker-panel-groups' boundPanelGroups): whole-panel header facts
// for every group, results only for the groups that arrive expanded, capped at
// PANEL_ROW_LIMIT. Expanding a group — or asking a truncated one for the rest — loads
// that ONE panel's results through loadClinicalResultPanelRows.
export default function ClinicalResultsTable({
  panelGroups,
  initialOpen,
  now,
  filters,
  searchParams,
  multiView,
}: {
  // Already grouped and bounded on the server. The header facts (label, analyte and
  // flagged counts) describe the WHOLE panel; `rows` is the slice that was sent and
  // `total` what the panel holds.
  panelGroups: BoundedPanelGroup<ClinicalResultTableObservation>[];
  // The groups that arrive expanded — the same server decision that decided which
  // groups' results were sent. Initial state only: once the reader has opened or
  // closed a group, a re-render must not yank it back (#1455/#1517).
  initialOpen: PanelId[];
  now: string;
  filters: FilterCtx;
  // The URL this view was built from, replayed to the server when a panel's results
  // are requested so the expansion returns rows from the same filtered set.
  searchParams: ClinicalResultsSearchParams;
  // Present ONLY when more than one profile is in view (#1331) — turns on the
  // leading Profile column, the subject-scoped grouping, and per-row write
  // targeting. Omitted in single view → byte-identical render.
  multiView?: ClinicalResultsMultiView;
}) {
  const { category, panel, range, q, sort, dir, current } = filters;
  // In multi-view group by (profile, display name) so two members' same-named
  // analytes stay in DISTINCT groups (each keeps its heading + chip); single view
  // groups by display name alone. The SAME key the server counted the panel's
  // analytes with, so "Lipids · 6" can never disagree with the headings under it.
  const groupKey = (r: ClinicalResultTableObservation) =>
    clinicalResultRowKey(r, !!multiView);

  // The URL that produced these groups. When it changes, the disclosure state and
  // everything loaded under it are replaced — they described the previous result set.
  const signature = JSON.stringify([
    category ?? "",
    panel ?? "",
    range ?? "",
    q ?? "",
    sort,
    dir,
    current,
  ]);
  const [state, setState] = useState<DisclosureState>(() =>
    initialDisclosure(signature, initialOpen)
  );
  if (state.signature !== signature)
    setState(initialDisclosure(signature, initialOpen));

  // Fetch ONE panel's full results. Guarded by the signature: a response that
  // arrives after the reader has filtered away describes rows this view no longer
  // shows, so it is dropped rather than merged into a different result set.
  const loadPanel = (id: PanelId) => {
    const at = signature;
    setState((prev) =>
      prev.loading.has(id)
        ? prev
        : {
            ...prev,
            loading: new Set(prev.loading).add(id),
            failed: without(prev.failed, id),
          }
    );
    loadClinicalResultPanelRows({ panel: id, searchParams })
      .then((res) =>
        setState((prev) => {
          if (prev.signature !== at) return prev;
          const loading = without(prev.loading, id);
          if (!res.ok)
            return { ...prev, loading, failed: new Set(prev.failed).add(id) };
          return {
            ...prev,
            loading,
            loaded: new Map(prev.loaded).set(id, res.rows),
          };
        })
      )
      .catch(() =>
        setState((prev) =>
          prev.signature === at
            ? {
                ...prev,
                loading: without(prev.loading, id),
                failed: new Set(prev.failed).add(id),
              }
            : prev
        )
      );
  };

  // Opening a group it has no results for fetches them — the reader asked for that
  // panel, which is what pays for its rows. A TRUNCATED open group is deliberately
  // NOT auto-filled: it is already showing results, and topping every open group up
  // on arrival would rebuild the unbounded payload for exactly the narrowed views
  // that open them all. Its footer asks.
  const toggleGroup = (
    group: BoundedPanelGroup<ClinicalResultTableObservation>
  ) => {
    const opening = !state.open.has(group.panel);
    setState((prev) => {
      const open = new Set(prev.open);
      if (open.has(group.panel)) open.delete(group.panel);
      else open.add(group.panel);
      return { ...prev, open };
    });
    if (
      opening &&
      groupRows(group, state.loaded).length === 0 &&
      !groupComplete(group, state.loaded) &&
      !state.loading.has(group.panel)
    )
      loadPanel(group.panel);
  };

  return (
    <div className="card section-seam mb-6 overflow-hidden p-0">
      {/* Stacked-row mode hides `thead`, so the header's sort links go with it. The
          replacement select (#1426) now lives in the filter block above the table
          (#2316), inside the same disclosure as the facets: on a phone "narrow this
          list" and "reorder this list" are one job, and splitting them across two
          strips is what made the chrome above the first result a screen tall. It is
          the same control writing the same `?sort=`/`?dir=` params — see
          ClinicalResultsSection, which passes it to MedicalFilters. */}
      {/* The height cap is a desktop affordance (a tall table under a sticky
          header); on a phone the rows flow with the page instead of trapping a
          second scroll region inside it. */}
      <div className="overflow-auto sm:max-h-[70vh]">
        <ResponsiveTable
          className="w-full"
          data-testid="clinical-results-table"
        >
          <thead>
            <tr className="border-b border-black/5 dark:border-white/10">
              {multiView && (
                <th className="th sticky top-0 z-10 bg-surface">Profile</th>
              )}
              <SortableHeader
                column="name"
                label="Name"
                defaultSort={DEFAULT_SORT}
              />
              {/* Panel, Notes and Category hide below `md` so the table fits a
              phone without side-scrolling; panel/category stay reachable through
              the filters above and the biomarker detail page. Panel is NOT sortable:
              the rows are already partitioned into panel groups emitted in curated
              clinical order, so a panel sort would reorder rows within groups that
              no ordering can move (#1581 section B). */}
              <th className="th sticky top-0 z-10 hidden bg-surface md:table-cell">
                {/* #3970 rule 1. The "not mapped to a clinical panel" sentence is a
                    property of the COLUMN, not of a row, and it used to mount a
                    button on every row of an unmapped group. The header carries the
                    same `hidden md:table-cell` visibility the cells do, so nothing
                    that could reach the old mount loses the sentence. */}
                <span className="inline-flex items-center gap-1">
                  Panel
                  <InfoTooltipIcon
                    label="A panel shown as plain text is not mapped to a clinical panel — it is the heading the result was reported under"
                    data-testid="clinical-reported-panel-help"
                  />
                </span>
              </th>
              <th className="th sticky top-0 z-10 bg-surface">Value</th>
              {/* Reference hides below `sm`: the value cell already flags
              out-of-range results, and full ranges live on the detail page. */}
              <th className="th sticky top-0 z-10 hidden bg-surface sm:table-cell">
                Reference
              </th>
              <th className="th sticky top-0 z-10 hidden bg-surface md:table-cell">
                Notes
              </th>
              <th className="th sticky top-0 z-10 hidden bg-surface md:table-cell">
                Category
              </th>
              <SortableHeader
                column="date"
                label="Date"
                defaultSort={DEFAULT_SORT}
                defaultDir="desc"
              >
                {/* #3970 rule 1. ONE statement of the stale vocabulary for the whole
                    table — the amber "⚠️ 1y" age token and the Stale badge on the
                    name both mean this, and each used to carry its own 34px button on
                    every stale row. */}
                <InfoTooltipIcon
                  label={STALE_AGE_TITLE}
                  data-testid="clinical-stale-help"
                />
              </SortableHeader>
              <th className="th sticky top-0 z-10 bg-surface text-right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          {/* One <tbody> per PANEL group (#1499): its collapsed header, then its
          results when expanded. A collapsed group renders no rows at all — and
          since #1651 is sent none either, so the DOM and the payload agree. The
          group's rows keep the active sort (the server partition is stable), and
          within a group adjacent results of the same analyte are still
          run-grouped by the shared contiguous-group helper: the name shows once per
          run (on the start row) and a bottom border falls only at run ends. */}
          {panelGroups.map((group) => {
            const open = state.open.has(group.panel);
            const rows = groupRows(group, state.loaded);
            const complete = groupComplete(group, state.loaded);
            const bodyId = `clinical-result-panel-${group.panel}`;
            const colSpan = multiView ? 9 : 8;
            return (
              <tbody
                key={group.panel}
                id={bodyId}
                data-testid="clinical-result-panel-group"
                data-panel={group.panel}
                data-open={open ? "true" : "false"}
                data-total={group.total}
              >
                <PanelGroupHeader
                  group={group}
                  open={open}
                  onToggle={() => toggleGroup(group)}
                  panelId={bodyId}
                  colSpan={colSpan}
                />
                {open &&
                  groupContiguous(rows, groupKey).map(
                    ({ row: r, isGroupStart, isGroupEnd }) => {
                      // Flag the group as stale off its latest result — the row
                      // carrying is_latest holds the newest date, so its staleness
                      // is the biomarker's.
                      const stale =
                        !!r.is_latest &&
                        isBiomarkerStale(r.date, r.category, now);
                      return (
                        <ClinicalResultRow
                          // In multi-view two members can share a derived row id
                          // (negative, per-profile), so key on (profileId, id).
                          key={
                            multiView && r.profileId != null
                              ? `${r.profileId}:${r.id}`
                              : r.id
                          }
                          r={r}
                          isStart={isGroupStart}
                          isEnd={isGroupEnd}
                          stale={stale}
                          now={now}
                          filters={filters}
                          multiView={multiView}
                        />
                      );
                    }
                  )}
                {open && !complete && (
                  <PanelRowsFooter
                    group={group}
                    shown={rows.length}
                    loading={state.loading.has(group.panel)}
                    failed={state.failed.has(group.panel)}
                    onLoad={() => loadPanel(group.panel)}
                    colSpan={colSpan}
                  />
                )}
              </tbody>
            );
          })}
        </ResponsiveTable>
      </div>
    </div>
  );
}
