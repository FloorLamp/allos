import type { AppRoute } from "@/lib/hrefs";

// The Health-record two-level nav model (#1079): group tab → section sub-tab →
// one pane. Grouping organizes NAVIGATION only. The load-bearing rule: a pane
// renders ONE section, EXCEPT a curated set of LIGHT sections may share a stacked
// pane (Problems = Conditions + Allergies; Care › Overview = Background + Family
// history + Care plan + Health goals); heavy sections (the Immunizations chart, the
// long Visits list, the Providers directory) are NEVER stacked.
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
  // The secondary strip. Empty for a single-pane group (Problems) → no sub-tabs.
  panes: RecordsPane[];
};

// Vision/Dental are DATA-GATED (getNavRelevance): a hidden section omits its sub-tab
// AND its route re-gates server-side. Skin/Mental health always render (their
// in-page forms are the only creation path). Substance use is LIFE-STAGE gated
// (#1174/#1175): shown for adults + unknown age, hidden for a KNOWN minor — its
// AUDIT/DAST instruments are adult-validated. This shapes only the Specialty group.
export type RecordsRelevance = {
  vision: boolean;
  dental: boolean;
  substanceUse: boolean;
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
  {
    id: "dental",
    label: "Dental",
    href: "/records/specialty/dental",
    gated: "dental",
  },
  { id: "skin", label: "Skin", href: "/records/specialty/skin", gated: null },
  {
    id: "mental-health",
    label: "Mental health",
    href: "/records/specialty/mental-health",
    gated: null,
  },
  // Substance use (#1175) sits beside Mental health but gates DIFFERENTLY (#1174):
  // life-stage, not data — adult-validated instruments, so hidden for a known minor.
  {
    id: "substance-use",
    label: "Substance use",
    href: "/records/specialty/substance-use",
    gated: "substanceUse",
  },
];

// The Specialty panes visible for a profile, in fixed order — Vision/Dental drop
// when their relevance bit is false; Skin/Mental health always stay.
export function visibleSpecialtyPanes(
  relevance: RecordsRelevance
): RecordsPane[] {
  return SPECIALTY_ALL.filter((p) => p.gated == null || relevance[p.gated]).map(
    ({ id, label, href }) => ({ id, label, href })
  );
}

// The full group model for the primary + secondary tab strips. Specialty's panes
// and its group-tab href reflect the gated set (the group tab lands on the first
// VISIBLE pane, which is always present — Skin/Mental health never gate).
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
      href: "/records/problems",
      panes: [],
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
