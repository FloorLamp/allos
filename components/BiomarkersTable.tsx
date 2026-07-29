"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { IconChevronRight } from "@tabler/icons-react";
import type { MedicalRecord } from "@/lib/types";
import { Tag, MedicalValue } from "./ui";
import SortableHeader from "./SortableHeader";
import TableSortSelect from "./TableSortSelect";
import { ResponsiveTable, Td } from "./ResponsiveTable";
import NotesText from "./NotesText";
import RecordForm from "./RecordForm";
import OverflowMenu, { MENU_ITEM, MENU_ITEM_DANGER } from "./OverflowMenu";
import { useConfirm } from "./ConfirmDialog";
import { useUndoableDelete } from "./useUndoableDelete";
import { updateRecord, deleteRecord } from "@/app/(app)/medical/actions";
import { groupContiguous } from "@/lib/table-sort";
import {
  isBiomarkerStale,
  daysBetween,
  humanizeAge,
} from "@/lib/reference-range";
import { BIOMARKER_CATEGORIES } from "@/lib/medical-categories";
import { biomarkerViewHref, importHref, type AppRoute } from "@/lib/hrefs";
import SubjectChip from "./SubjectChip";
import { subjectChipVisible, itemAffordanceVisible } from "@/lib/multi-view";
import {
  multiViewGroupKey,
  tablePanelId,
  DEFAULT_BIOMARKER_SORT,
  type BiomarkerSortColumn,
} from "@/lib/derived-table";
import { OTHER_PANEL, panelLabel, type PanelId } from "@/lib/biomarker-panels";
import {
  defaultOpenPanels,
  groupRowsByPanel,
  panelGroupSummary,
  type PanelGroup,
} from "@/lib/biomarker-panel-groups";
import type { SubjectInfo } from "@/lib/scope";

// A table row in multi-view carries its owning profile + stamped subject identity
// (stampSubjects); single-view rows omit both. The subject powers the leading chip
// column and the per-row write gate, and profileId re-keys grouping per member so
// two members' same-named analytes never collapse into one heading (#1331).
type TableRecord = MedicalRecord & {
  profileId?: number;
  subject?: SubjectInfo;
};

// Present ONLY when more than one profile is in view (#1331): the acting profile
// (its own rows imply the subject, so they get no chip) + the flag that turns on the
// leading Profile column and the subject-scoped grouping/write-targeting. Absent in
// single view → the table renders byte-identical.
export interface BiomarkersMultiView {
  actingProfileId: number;
}

// The sortable columns, as the card-mode select knows them (#1426). One list, kept
// beside the SortableHeaders it mirrors: same column ids, same default directions
// (Date opens newest-first), so the two affordances can't disagree about what
// "sorted by date" means.
const SORT_CHOICES = [
  { column: "name", label: "Name" },
  { column: "date", label: "Date", defaultDir: "desc" as const },
];

// The column ordered when the URL names none. Read from lib/derived-table rather than
// restated, so the (hidden) header arrows, the card-mode select and the server's
// parseBiomarkerSortColumn fallback are ONE value instead of twins that can drift.
const DEFAULT_SORT = DEFAULT_BIOMARKER_SORT;

// The active-filter context threaded through to build the panel/category filter
// links (each preserves the current sort/range/etc., matching the server-built
// hrefs the table used before it became interactive).
interface FilterCtx {
  category?: string;
  panel?: PanelId;
  range?: string;
  q?: string;
  sort: BiomarkerSortColumn;
  dir: "asc" | "desc";
  current: boolean;
}

// Build a filtered URL for the #biomarkers section of /results from the active
// filters, dropping empty ones (#1042 phase 5 — the anchor keeps a filter/sort/
// pager navigation on the section).
function qs(params: Record<string, string | undefined>): AppRoute {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `/results/biomarkers?${s}` : "/results/biomarkers";
}

// The grouping identity for a reading: its canonical name when present, else the
// raw name. Matches the server-side key used to sort/dedupe, so rows of the same
// biomarker land adjacent and can be grouped in the table.
function nameKey(r: { name: string; canonical_name: string | null }): string {
  return r.canonical_name?.trim() || r.name;
}

// A small amber badge flagging a biomarker whose latest reading has gone stale
// (over a year old — a yearly-retest heuristic).
function staleBadge() {
  return (
    <span
      className="ml-2 rounded-full bg-amber-50 px-1.5 py-0.5 align-middle text-xs font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-400/10 dark:text-amber-400"
      title="Latest reading over a year old — consider retesting"
    >
      Stale
    </span>
  );
}

// A small slate badge marking a read-time DERIVED index (issue #40) — computed
// from other readings, not measured. The formula (with the component values) is the
// hover title so the derivation is inspectable.
function derivedBadge(formula?: string) {
  return (
    <span
      data-testid="derived-badge"
      className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 align-middle text-xs font-medium uppercase tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-300"
      title={formula ? `Derived: ${formula}` : "Computed from other readings"}
    >
      Derived
    </span>
  );
}

// Show the canonical name (the grouping identity) when present, linking to the
// biomarker detail page; fall back to the raw provided name otherwise. Flags the
// group with a Stale badge when its latest reading is overdue, and a Derived badge
// when the reading is a computed index.
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
        href={biomarkerViewHref(r.canonical_name)}
        className="font-medium text-brand-700 hover:underline dark:text-brand-400"
        title={`View ${r.canonical_name} over time`}
      >
        {r.canonical_name}
      </Link>
      {stale}
      {derived}
    </span>
  );
}

// Date cell: the reading's date, linking to its source document when present. The
// latest reading of a biomarker also shows its age below ("8 months ago"), flagged
// amber once it's over a year old (a yearly-retest heuristic). Older readings in a
// group omit the age line — pass `showAge` false for those.
function dateCell(
  r: { date: string; category: string | null; document_id: number | null },
  now: string,
  showAge: boolean
) {
  const dateEl = (
    <span className="whitespace-nowrap">
      {r.document_id ? (
        <Link
          href={importHref(r.document_id)}
          className="text-brand-700 hover:underline dark:text-brand-400"
        >
          {r.date}
        </Link>
      ) : (
        r.date
      )}
    </span>
  );
  if (!showAge) return dateEl;
  const ageDays = daysBetween(r.date, now);
  const stale = isBiomarkerStale(r.date, r.category, now);
  const relative = ageDays <= 0 ? "today" : `${humanizeAge(ageDays)} ago`;
  return (
    <div className="flex flex-col">
      {dateEl}
      <span
        className={`text-xs ${
          stale
            ? "text-amber-600 dark:text-amber-400"
            : "text-slate-500 dark:text-slate-400"
        }`}
        title={stale ? "Over a year old — consider retesting" : undefined}
      >
        {stale && "⚠️ "}
        {relative}
      </span>
    </div>
  );
}

// The Panel cell (#1502). It shows the NORMALIZED clinical panel resolved from the
// row's canonical name — "Lipids", "Complete blood count" — and links the facet by
// stable SLUG, replacing the old cell that printed and filtered by the stored
// free-text heading (in practice the lab VENDOR: "Quest Diagnostics", "LabCorp").
//
// The stored `panel` column is untouched PROVENANCE and still surfaces two ways:
// as the cell's tooltip on a resolved row ("Reported under …"), and as the visible
// text for a row the taxonomy can't place — an un-canonicalized analyte the
// extractor coined, where the document's own heading is the best label we have.
// That fallback row is deliberately NOT a filter link: "everything drawn at
// LabCorp" is the useless facet this issue removed, and `?panel=other` (reachable
// from the filter chip) is the meaningful "unclassified" view.
function PanelCell({
  record,
  href,
}: {
  record: TableRecord;
  href: (id: PanelId) => AppRoute;
}) {
  const id = tablePanelId(record);
  const reported = record.panel?.trim() || null;
  if (id !== OTHER_PANEL) {
    return (
      <Td slot="meta" label="Panel" className="hidden md:table-cell">
        <Link
          href={href(id)}
          title={reported ? `Reported under “${reported}”` : undefined}
          className="text-xs text-slate-500 hover:text-brand-700 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
        >
          {panelLabel(id)}
        </Link>
      </Td>
    );
  }
  return (
    <Td
      slot="meta"
      label="Panel"
      empty={!reported}
      className="hidden md:table-cell"
    >
      {reported ? (
        <span
          className="text-xs text-slate-500 dark:text-slate-400"
          title="Not mapped to a clinical panel — showing the heading it was reported under"
        >
          {reported}
        </span>
      ) : (
        <span className="text-slate-300 dark:text-slate-600">—</span>
      )}
    </Td>
  );
}

// The class that tightens a reading row NESTED INSIDE an open panel group (#1581
// section C). In card mode the group already provides the container, so the reading
// under it does not also need the full row padding — that is the #1539 double-frame
// pattern, and with the pager gone an expanded group is the whole panel rather than
// whatever slice a page held. Same mechanism as `.table-section-row` one rule above
// it: an element+class selector that outranks `.table-cards tr`, which a utility
// class on the row could not. Desktop is untouched (the rule is `max-sm:` only), and
// tables that render UNGROUPED never carry the class.
const NESTED_ROW = "table-nested-row";

// One biomarker reading row. Display mode keeps the rich Biomarkers presentation
// (canonical-name grouping heading + Stale badge, panel/category filter links,
// relative-age date, responsive column hiding) and adds a kebab menu; edit swaps
// the row in place for the shared RecordForm. Edit + delete run through the same
// profile-scoped updateRecord/deleteRecord the document view uses — delete matches
// the document view (any row, manual or extracted, behind a danger confirm).
function BiomarkerRow({
  r,
  isStart,
  isEnd,
  stale,
  now,
  filters,
  multiView,
}: {
  r: TableRecord;
  isStart: boolean;
  isEnd: boolean;
  stale: boolean;
  now: string;
  filters: FilterCtx;
  multiView?: BiomarkersMultiView;
}) {
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
  const showChip =
    !!multiView && !!r.subject && subjectChipVisible({ multi: true, isActing });
  const writeProfileId = multiView ? r.profileId : undefined;
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
  // card with no name would be unreadable — it repeats the name below `sm`. Same
  // authored cell, one visibility rule; never a second, separately-written tree.
  const titleCell = (
    <Td slot="title">
      <span className={isStart ? undefined : "sm:hidden"}>
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
          <RecordForm
            mode="edit"
            record={r}
            action={updateRecord}
            onDone={() => setEditing(false)}
            categories={BIOMARKER_CATEGORIES}
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
          <MedicalValue value={r.value} unit={r.unit} flag={r.flag} />
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
        <Td
          slot="meta"
          label="Category"
          empty={!r.category}
          className="hidden md:table-cell"
        >
          <Tag value={r.category} />
        </Td>
        <Td slot="meta" label="Date">
          {dateCell(r, now, !!r.is_latest)}
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
        record={r}
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
        <MedicalValue value={r.value} unit={r.unit} flag={r.flag} />
      </Td>
      <Td
        slot="meta"
        label="Reference"
        empty={!r.reference_range}
        className="hidden text-slate-500 sm:table-cell dark:text-slate-400"
      >
        {r.reference_range ?? "—"}
      </Td>
      <Td
        slot="meta"
        label="Notes"
        empty={!r.notes}
        className="hidden text-slate-500 md:table-cell dark:text-slate-400"
      >
        <NotesText notes={r.notes} />
      </Td>
      <Td
        slot="meta"
        label="Category"
        empty={!r.category}
        className="hidden md:table-cell"
      >
        <Link
          href={qs({
            category: r.category,
            panel,
            range,
            q,
            sort,
            dir,
            current: current ? "1" : undefined,
          })}
          title={`Filter by ${r.category}`}
          className="hover:opacity-80"
        >
          <Tag value={r.category} />
        </Link>
      </Td>
      <Td slot="meta" label="Date">
        {dateCell(r, now, !!r.is_latest)}
      </Td>
      <Td slot="actions">
        {/* Multi-view (#1331): a row whose SUBJECT is read-only-granted shows no
            edit/delete; single-view rows are always the acting profile. */}
        {canWrite ? (
          <div className="flex items-center justify-end">
            <OverflowMenu
              label="Record actions"
              open={menuOpen}
              onOpenChange={setMenuOpen}
            >
              {({ close }) => (
                <>
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
                  {/* Plain button (not a form action): confirm() opens a modal the
                    user must answer, which would deadlock inside a form-action
                    transition. */}
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM_DANGER}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Delete record",
                        // Name it the way the row the user clicked names it —
                        // nameKey is the same canonical-preferred identity nameCell
                        // renders (#1501), so the confirm can't say "URIC ACID"
                        // about a row labelled "Uric Acid".
                        message: `Delete “${nameKey(r)}”? You can undo this.`,
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (!ok) return;
                      close();
                      const fd = new FormData();
                      fd.set("id", String(r.id));
                      // Multi-view: target the ROW's subject profile (gateItemProfile).
                      if (writeProfileId)
                        fd.set("profile_id", String(writeProfileId));
                      await undoable(deleteRecord, fd, {
                        deletedMessage: "Record deleted.",
                      });
                    }}
                  >
                    Delete
                  </button>
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
// of readings with an index entry: "Lipids · 6 analytes · 1 flagged", tap to expand.
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
  group: PanelGroup<TableRecord>;
  open: boolean;
  onToggle: () => void;
  panelId: string;
  colSpan: number;
}) {
  const flagged = group.flaggedCount > 0;
  return (
    <tr className="table-section-row" data-testid="biomarker-panel-header">
      <Td slot="full" colSpan={colSpan} className="!px-0 !py-0">
        <button
          type="button"
          data-testid="biomarker-panel-toggle"
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
              data-testid="biomarker-panel-flagged"
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

// The Biomarkers results table. Client-side so each row can swap in place for an
// inline editor and offer delete — but the display, grouping, sorting, staleness,
// and filter links are unchanged from the prior server-rendered table.
//
// NO PAGER (#1581 section A). It used to ship one 50-row page (#114) and round-trip
// the rest through `?p=`, which is a ROW-denominated bound over a surface whose unit
// is the PANEL: a six-analyte lipid panel with twelve draws is seventy-two rows, so a
// panel could straddle a page boundary and render on both with partial counts, and
// paging re-collapsed every group the reader had opened. The collapsed index is
// bounded by construction instead — PANEL_IDS is a closed 35-entry taxonomy, so the
// header list has a hard ceiling no lab history can exceed, and a collapsed group
// renders no reading rows at all.
export default function BiomarkersTable({
  records,
  now,
  filters,
  multiView,
}: {
  records: TableRecord[];
  now: string;
  filters: FilterCtx;
  // Present ONLY when more than one profile is in view (#1331) — turns on the
  // leading Profile column, the subject-scoped grouping, and per-row write
  // targeting. Omitted in single view → byte-identical render.
  multiView?: BiomarkersMultiView;
}) {
  const { category, panel, range, q, sort, dir, current } = filters;
  // In multi-view group by (profile, display name) so two members' same-named
  // analytes stay in DISTINCT groups (each keeps its heading + chip); single view
  // groups by display name alone, unchanged.
  const groupKey = (r: TableRecord) =>
    multiView && r.profileId != null
      ? multiViewGroupKey({ ...r, profileId: r.profileId })
      : nameKey(r);

  // ── Panel groups (#1499 section A) ──────────────────────────────────────────
  // ONE computation: the header's counts and the rows its expansion draws are
  // fields of the same PanelGroup, and the analyte identity is the table's OWN
  // groupKey — so "Lipids · 6" can never disagree with the six name headings under
  // it, in single OR multi view.
  const groups = useMemo(
    () => groupRowsByPanel(records, groupKey),
    // groupKey is derived from `multiView`; recompute when either changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [records, multiView]
  );
  // Which groups start open is the SERVER-STATE decision (search/facet/short list),
  // recomputed whenever the URL that produced these rows changes — but it is the
  // INITIAL value only: once the reader has opened or closed a group, a re-render
  // of the same view must not yank it back (the #1455/#1517 disclosure contract).
  const openSignature = JSON.stringify([
    category ?? "",
    panel ?? "",
    range ?? "",
    q ?? "",
    sort,
    dir,
    current,
  ]);
  const [openState, setOpenState] = useState(() => ({
    signature: openSignature,
    open: new Set<PanelId>(defaultOpenPanels(groups, filters)),
  }));
  if (openState.signature !== openSignature) {
    setOpenState({
      signature: openSignature,
      open: new Set<PanelId>(defaultOpenPanels(groups, filters)),
    });
  }
  const toggleGroup = (id: PanelId) =>
    setOpenState((prev) => {
      const open = new Set(prev.open);
      if (open.has(id)) open.delete(id);
      else open.add(id);
      return { signature: prev.signature, open };
    });

  return (
    <div className="card mb-6 overflow-hidden p-0">
      {/* Stacked-row mode hides `thead`, so the header's sort links go with it — this
          select is the same sorting, one control instead of a header strip
          (#1426). It writes the SAME `?sort=`/`?dir=` params SortableHeader does,
          so the server ordering below is untouched. */}
      <div className="border-b border-black/5 px-3 py-2 sm:hidden dark:border-white/10">
        <TableSortSelect
          choices={SORT_CHOICES}
          defaultSort={DEFAULT_SORT}
          label="Sort by"
        />
      </div>
      {/* The height cap is a desktop affordance (a tall table under a sticky
          header); on a phone the rows flow with the page instead of trapping a
          second scroll region inside it. */}
      <div className="overflow-auto sm:max-h-[70vh]">
        <ResponsiveTable className="w-full" data-testid="biomarkers-table">
          <thead>
            <tr className="border-b border-black/5 dark:border-white/10">
              {multiView && (
                <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                  Profile
                </th>
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
              <th className="th sticky top-0 z-10 hidden bg-white md:table-cell dark:bg-ink-900">
                Panel
              </th>
              <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                Value
              </th>
              {/* Reference hides below `sm`: the value cell already flags
              out-of-range readings, and full ranges live on the detail page. */}
              <th className="th sticky top-0 z-10 hidden bg-white sm:table-cell dark:bg-ink-900">
                Reference
              </th>
              <th className="th sticky top-0 z-10 hidden bg-white md:table-cell dark:bg-ink-900">
                Notes
              </th>
              <th className="th sticky top-0 z-10 hidden bg-white md:table-cell dark:bg-ink-900">
                Category
              </th>
              <SortableHeader
                column="date"
                label="Date"
                defaultSort={DEFAULT_SORT}
                defaultDir="desc"
              />
              <th className="th sticky top-0 z-10 bg-white text-right dark:bg-ink-900">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          {/* One <tbody> per PANEL group (#1499): its collapsed header, then its
          readings when expanded. A collapsed group renders no rows at all — the DOM
          is the height, and the whole point is that the master list stops being an
          8,000px wall. The group's rows keep the active sort (the partition is
          stable), and within a group adjacent readings of the same biomarker are
          still run-grouped by the shared contiguous-group helper: the name shows
          once per run (on the start row) and a bottom border falls only at run
          ends. */}
          {groups.map((group) => {
            const open = openState.open.has(group.panel);
            const bodyId = `biomarker-panel-${group.panel}`;
            return (
              <tbody
                key={group.panel}
                id={bodyId}
                data-testid="biomarker-panel-group"
                data-panel={group.panel}
                data-open={open ? "true" : "false"}
              >
                <PanelGroupHeader
                  group={group}
                  open={open}
                  onToggle={() => toggleGroup(group.panel)}
                  panelId={bodyId}
                  colSpan={multiView ? 9 : 8}
                />
                {open &&
                  groupContiguous(group.rows, groupKey).map(
                    ({ row: r, isGroupStart, isGroupEnd }) => {
                      // Flag the group as stale off its latest reading — the row
                      // carrying is_latest holds the newest date, so its staleness
                      // is the biomarker's.
                      const stale =
                        !!r.is_latest &&
                        isBiomarkerStale(r.date, r.category, now);
                      return (
                        <BiomarkerRow
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
              </tbody>
            );
          })}
        </ResponsiveTable>
      </div>
    </div>
  );
}
