import type { AppRoute } from "@/lib/hrefs";

// The Health-record two-level nav model (#1079): group tab → section sub-tab →
// one pane. Grouping organizes NAVIGATION only. The load-bearing rule: a pane
// renders ONE section, EXCEPT a curated set of LIGHT sections may share a stacked
// pane (Care › Overview = Background + Family history + Care plan + Health goals);
// heavy sections (the Immunizations chart, the long Visits list, the Providers
// directory) are NEVER stacked.
//
// Problems used to be the other stacked pane (Conditions + Allergies) and was the
// family's one outlier for it (#1449): with no secondary strip, its two sections
// had to name themselves with h1-scale in-page headings that competed with the
// page title. It is now a normal two-pane group like History/Specialty — the pill
// sub-tab names the pane, so the pane needs no heading of its own, and a deep link
// lands on the SECTION a caller meant rather than a stack it has to scroll.
//
// This module is the ONE source of truth for the group/pane structure, shared by
// the client `RecordsTabs` strip and the server layout / bare-route redirects, so
// they can't drift on which panes exist, their order, or the data-gated set.

export type RecordsPane = {
  id: string;
  label: string;
  href: AppRoute;
};

export type RecordsGroup = {
  id: string;
  label: string;
  // Prefix that lights this group tab (pathname startsWith).
  basePath: string;
  // Where the group tab points — its first (visible) pane.
  href: AppRoute;
  // The secondary strip. Every group now has >1 pane, so every group shows one;
  // `RecordsTabs` still renders nothing for a 0/1-pane group should one appear.
  panes: RecordsPane[];
};

// Vision/Dental are DATA-GATED (getNavRelevance): a hidden section omits its sub-tab
// AND its route re-gates server-side. Hearing/Skin always render (their in-page forms
// are the only creation path). Substance use and Mental health are LIFE-STAGE gated,
// each at the line its own instruments carry: substance use (#1174/#1175) hides for a
// KNOWN minor because AUDIT/DAST are adult-validated; mental health (#2807) hides only
// for a KNOWN infant/child because PHQ-9/GAD-7 are validated from adolescence. Both show
// for unknown age. This shapes only the Specialty group.
export type RecordsRelevance = {
  vision: boolean;
  dental: boolean;
  substanceUse: boolean;
  mentalHealth: boolean;
};

const HISTORY_PANES: RecordsPane[] = [
  { id: "visits", label: "Visits", href: "/records/history/visits" },
  {
    id: "procedures",
    label: "Procedures",
    href: "/records/history/procedures",
  },
  {
    id: "immunizations",
    label: "Immunizations",
    href: "/records/history/immunizations",
  },
];

const PROBLEMS_PANES: RecordsPane[] = [
  {
    id: "conditions",
    label: "Conditions",
    href: "/records/problems/conditions",
  },
  { id: "allergies", label: "Allergies", href: "/records/problems/allergies" },
];

const CARE_PANES: RecordsPane[] = [
  { id: "overview", label: "Overview", href: "/records/care/overview" },
  { id: "providers", label: "Providers", href: "/records/care/providers" },
];

const SPECIALTY_ALL: (RecordsPane & {
  gated: keyof RecordsRelevance | null;
})[] = [
  {
    id: "vision",
    label: "Vision",
    href: "/records/specialty/vision",
    gated: "vision",
  },
  // Hearing (#1600) sits directly beside Vision — the sense-organ pair — and is
  // deliberately UNGATED: its in-page audiogram form is the only creation path today
  // (audiometry import comes later), so a data gate would make the first hearing test
  // unreachable. Vision/Dental can gate because Data → Import also creates their rows.
  {
    id: "hearing",
    label: "Hearing",
    href: "/records/specialty/hearing",
    gated: null,
  },
  {
    id: "dental",
    label: "Dental",
    href: "/records/specialty/dental",
    gated: "dental",
  },
  { id: "skin", label: "Skin", href: "/records/specialty/skin", gated: null },
  // Mental health (#1079) gates on LIFE STAGE since #2807 — the same argument #1174
  // made next door, at the line its own instruments carry: PHQ-9/GAD-7 are validated
  // from adolescence, so an infant/child gets neither the tab nor the route.
  {
    id: "mental-health",
    label: "Mental health",
    href: "/records/specialty/mental-health",
    gated: "mentalHealth",
  },
  // Substance use (#1175) sits beside Mental health and gates on life stage too, but at
  // a HIGHER line (#1174): AUDIT/DAST are adult-validated, so hidden for a known minor.
  {
    id: "substance-use",
    label: "Substance use",
    href: "/records/specialty/substance-use",
    gated: "substanceUse",
  },
];

// The Specialty panes visible for a profile, in fixed order — Vision/Dental/Mental
// health/Substance use drop when their relevance bit is false; Hearing and Skin always
// stay, which is what keeps the set non-empty for every profile (the group tab and the
// redirect target below both take the FIRST visible pane).
export function visibleSpecialtyPanes(
  relevance: RecordsRelevance
): RecordsPane[] {
  return SPECIALTY_ALL.filter((p) => p.gated == null || relevance[p.gated]).map(
    ({ id, label, href }) => ({ id, label, href })
  );
}

// The full group model for the primary + secondary tab strips. Specialty's panes
// and its group-tab href reflect the gated set (the group tab lands on the first
// VISIBLE pane, which is always present — Hearing/Skin never gate).
export function recordsGroups(relevance: RecordsRelevance): RecordsGroup[] {
  const specialty = visibleSpecialtyPanes(relevance);
  return [
    {
      id: "history",
      label: "History",
      basePath: "/records/history",
      href: HISTORY_PANES[0].href,
      panes: HISTORY_PANES,
    },
    {
      id: "problems",
      label: "Problems",
      basePath: "/records/problems",
      href: PROBLEMS_PANES[0].href,
      panes: PROBLEMS_PANES,
    },
    {
      id: "care",
      label: "Care",
      basePath: "/records/care",
      href: CARE_PANES[0].href,
      panes: CARE_PANES,
    },
    {
      id: "specialty",
      label: "Specialty",
      basePath: "/records/specialty",
      href: specialty[0].href,
      panes: specialty,
    },
  ];
}
