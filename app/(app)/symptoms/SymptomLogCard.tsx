import WidgetHeader from "@/components/dashboard/WidgetHeader";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { SYMPTOMS } from "@/lib/symptoms";
import {
  getSymptomSeveritiesOnDate,
  getCustomSymptomNames,
} from "@/lib/queries";
import SymptomLogBar from "./SymptomLogBar";

// Dashboard symptom card (issue #799) — rendered ONLY while an illness-type situation is
// active (the page gates its `available`), so it appears exactly when it's useful. Gathers
// today + yesterday severities server-side and hands them to the one-tap bar (with the
// today/yesterday toggle for the #748 backfill lesson). Because the card is illness-gated,
// the bar's "mark as illness" bridge is off here — that direction lives on the Timeline.
export default function SymptomLogCard({ profileId }: { profileId: number }) {
  const date = today(profileId);
  const yesterday = shiftDateStr(date, -1);
  return (
    <div className="card">
      <WidgetHeader title="Symptoms" href="/timeline" linkLabel="Timeline" />
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Tap a severity to log how you feel today.
      </p>
      <SymptomLogBar
        date={date}
        altDate={yesterday}
        initial={getSymptomSeveritiesOnDate(profileId, date)}
        initialAlt={getSymptomSeveritiesOnDate(profileId, yesterday)}
        symptoms={SYMPTOMS}
        customNames={getCustomSymptomNames(profileId)}
        suggestActivateIllness={false}
        showTemperature
      />
    </div>
  );
}
