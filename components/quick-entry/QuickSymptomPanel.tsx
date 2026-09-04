"use client";

import SymptomLogBar from "@/components/illness/SymptomLogBar";
import { PICKER_SYMPTOMS } from "@/lib/symptoms";
import type { TemperatureUnit } from "@/lib/settings";

// The quick-log sheet's symptom panel (issue #4064) — one of four mountings of
// `SymptomLogBar`, beside the illness cockpit, the episode log panel and the Cycles
// page. It arrived as a fifth, over the dashboard's own well-day card; #3366 retired
// that card once this row existed, which is the order its Depends-on required. The
// record's day view was a mounting too until #4851 retired that card in turn.
//
// It holds no logic and no write. Every prop below was gathered on the server on open
// (`loadQuickEntry("symptom")`) from the same reads the dashboard's own mount makes, and
// the bar posts the same `logSymptom` / `lowerSymptom` / `setSymptomNote` /
// `removeSymptom` / `activateIllnessForSymptoms` actions it always has — so a tap here
// and a tap in the cockpit are one write path with one validation, differing only in
// the surface each mounting declares (#3087). That equality is asserted rather than
// promised: components/__tests__/quick-symptom-parity.test.tsx builds both mounts and
// compares the FormData they post.
//
// WHY THE CATALOG IS IMPORTED AND NOT SENT. `PICKER_SYMPTOMS` is a pure constant every
// other mount passes the same way, so shipping it over the action boundary would put a
// second copy of one list on the wire without making it any fresher.
//
// ── THE ILLNESS VERB RENDERS FROM STATE ──────────────────────────────────────
//
// Marking an illness is a LIFECYCLE write (docs/internals/stateful-affordances.md): the
// same tap means different things depending on what is already active, so the affordance
// has to say which. The bar's own bridge is the "nothing tracked" arm and is unchanged;
// this panel supplies the other arm, naming what IS tracked, because the bar renders
// nothing at all in that case and a sheet that simply omitted the offer would read as
// "you cannot mark an illness from here". It lives HERE rather than in the bar for the
// #4064 scope reason: the cockpit and Cycles mounts must render exactly as they did.
export default function QuickSymptomPanel({
  today,
  severities,
  notes,
  customNames,
  rankedKeys,
  temperatureUnit,
  timeZone,
  textIntakeEnabled,
  trackingIllness,
  subjectProfileId,
}: {
  today: string;
  severities: Record<string, number>;
  notes: Record<string, string>;
  customNames: string[];
  rankedKeys: string[];
  temperatureUnit: TemperatureUnit;
  // The SUBJECT's zone, not the browser's — the reading-time control and the
  // action's stated-minute pair both read it (#4712 item 2).
  timeZone: string;
  textIntakeEnabled: boolean;
  trackingIllness: string[];
  // The quick-log sheet's chosen subject (#4932), when it is not the acting
  // profile — the SAME `profileId` prop the illness cockpit's own mount already
  // passes (SymptomLogBar's cross-profile support predates this sheet).
  subjectProfileId?: number;
}) {
  return (
    <div className="space-y-3 py-1" data-testid="quick-symptom-panel">
      {trackingIllness.length > 0 && (
        <p
          data-testid="quick-symptom-tracking"
          className="text-xs text-slate-500 dark:text-slate-400"
        >
          Tracking: {trackingIllness.join(", ")}
        </p>
      )}
      <SymptomLogBar
        date={today}
        initial={severities}
        initialNotes={notes}
        symptoms={PICKER_SYMPTOMS}
        customNames={customNames}
        rankedKeys={rankedKeys}
        suggestActivateIllness={trackingIllness.length === 0}
        // ONE ILLNESS PANEL (#4712 item 2). The bar could always draw the
        // temperature fold; every mount that asked for it was episode-gated, so a
        // feverish child's reading at 2 AM went through the Body segment's
        // measurements form instead — which cannot follow this sheet's subject at
        // all (#4932 invariant 2), so it also meant switching profiles first. The
        // Body/measurements path stays for non-illness vitals; the illness
        // statement is whole here.
        showTemperature
        temperatureUnit={temperatureUnit}
        timeZone={timeZone}
        textIntakeEnabled={textIntakeEnabled}
        showTitle={false}
        profileId={subjectProfileId}
        // An active illness situation IS an open episode — `setActiveSituations`
        // composes `syncOpenIllnessEpisode` in its own write — so the fever offer
        // never asks to open the one this subject is already in. The same question
        // `suggestActivateIllness` above answers, from the same list.
        hasOpenEpisode={trackingIllness.length > 0}
      />
    </div>
  );
}
