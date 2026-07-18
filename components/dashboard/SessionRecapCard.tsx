import { IconFlagCheck } from "@tabler/icons-react";
import type { Recap } from "@/lib/session-recap";
import type { WeightUnit } from "@/lib/settings";
import SessionRecapView from "@/components/SessionRecapView";

// The finished-window dashboard card (#924): while derived workout presence reads
// `finished` (lib/workout-presence.ts — the just-ended session, mode-agnostic), the
// dashboard surfaces the recap of that session. Self-view only (the household chip
// stays compact); it disappears when the finished window closes on the next render.
// A pure formatter over the ONE sessionRecap result — never gated on live mode.
export default function SessionRecapCard({
  recap,
  unit,
}: {
  recap: Recap;
  unit: WeightUnit;
}) {
  return (
    <div className="card mb-6" data-testid="session-recap-card">
      <div className="mb-3 flex items-center gap-2">
        <IconFlagCheck className="h-5 w-5 text-brand-600 dark:text-brand-400" />
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Session complete
          {recap.title ? (
            <span className="font-normal text-slate-500 dark:text-slate-400">
              {" "}
              — {recap.title}
            </span>
          ) : null}
        </h2>
      </div>
      <SessionRecapView recap={recap} unit={unit} />
    </div>
  );
}
