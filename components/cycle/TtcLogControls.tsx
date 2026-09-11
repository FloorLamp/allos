"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/Toast";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import type { StampedFormData } from "@/lib/logged-via";
import type { TemperatureUnit } from "@/lib/settings";
import type { TtcTodayReadings } from "@/lib/ttc-store";
import { degFTo, tempUnitLabel } from "@/lib/units";
import {
  MUCUS_LABELS,
  MUCUS_QUALITIES,
  type LhResult,
  type MucusQuality,
} from "@/lib/ttc";
import {
  logBbtAction,
  logLhTestAction,
  logMucusAction,
  type TtcActionResult,
} from "@/app/(app)/medical/cycles/ttc-actions";
import InlineError from "@/components/InlineError";

// The TTC log bar (issue #1680) — the daily-habit entry point for the three observations,
// in the mould of SymptomLogBar / MobilityLogBar: one tap per observation, today, active
// profile. Every write answers from its action's TYPED result; nothing is confirmed that
// wasn't written (an edit-locked row refuses and says so).
//
// TWO MOUNTINGS SINCE #5810, and it lives beside <PeriodOfferButton> for the same
// reason: the Cycle page's TtcSection and the quick-log sheet's cycle overlay render
// THIS component over the same server-resolved readings, so the sheet reaches the three
// daily taps without a second write path, a second copy of the copy, or a second answer
// about what is already recorded today. It holds no gate — the sheet's loader decides
// whether a profile has declared TTC, exactly as TtcSection does.
//
// It does NOT take a surface prop: the surface rides the POST. `useLoggedViaStamp()`
// reads the region it is mounted in (#3087/#5349), so the page mount records `page` and
// the sheet mount records `quick-log` without this component knowing which it is.
//
// The temperature field is the only typed input, because a number is the observation. It
// is entered and shown in the LOGIN's unit and converted at the server boundary — the
// stored value is always canonical °F.
//
// Deliberately plain: no streak, no completion meter, no "great job". This bar is used on
// mornings that are hard, and it says nothing about how the month is going.
export default function TtcLogControls({
  todayLh,
  todayBbtF,
  todayMucus,
  temperatureUnit,
}: TtcTodayReadings & { temperatureUnit: TemperatureUnit }) {
  const toast = useToast();
  const stampLoggedVia = useLoggedViaStamp();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [temp, setTemp] = useState(
    todayBbtF == null ? "" : String(degFTo(todayBbtF, temperatureUnit))
  );

  function run(
    action: (fd: StampedFormData) => Promise<TtcActionResult>,
    fd: FormData,
    okMsg: string
  ) {
    setError(null);
    startTransition(async () => {
      let result: TtcActionResult;
      try {
        result = await action(stampLoggedVia(fd));
      } catch {
        setError("Couldn't record that. Try again.");
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast(okMsg);
    });
  }

  function logLh(result: LhResult) {
    const fd = new FormData();
    fd.set("result", result);
    run(logLhTestAction, fd, `LH test recorded as ${result}`);
  }

  function logMucus(quality: MucusQuality) {
    const fd = new FormData();
    fd.set("quality", quality);
    run(logMucusAction, fd, `Cervical mucus: ${MUCUS_LABELS[quality]}`);
  }

  function logTemp() {
    const fd = new FormData();
    fd.set("value", temp);
    fd.set("unit", temperatureUnit);
    run(logBbtAction, fd, "Waking temperature recorded");
  }

  return (
    <div className="space-y-4" data-testid="ttc-log-bar">
      <div className="space-y-2">
        <div className="section-label">Ovulation (LH) test</div>
        <div className="flex flex-wrap gap-2">
          {(["positive", "negative"] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={todayLh === r ? "btn" : "btn-ghost"}
              disabled={pending}
              aria-pressed={todayLh === r}
              data-testid={`ttc-lh-${r}`}
              onClick={() => logLh(r)}
            >
              {r === "positive" ? "Positive" : "Negative"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="section-label">Cervical mucus</div>
        <div className="flex flex-wrap gap-2">
          {MUCUS_QUALITIES.map((q) => (
            <button
              key={q}
              type="button"
              className={todayMucus === q ? "btn" : "btn-ghost"}
              disabled={pending}
              aria-pressed={todayMucus === q}
              data-testid={`ttc-mucus-${q}`}
              onClick={() => logMucus(q)}
            >
              {MUCUS_LABELS[q]}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label
          className="section-label block"
          htmlFor="ttc-bbt"
        >{`Waking temperature (${tempUnitLabel(temperatureUnit)})`}</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="ttc-bbt"
            className="input w-32"
            inputMode="decimal"
            value={temp}
            data-testid="ttc-bbt-input"
            onChange={(e) => setTemp(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={pending || temp.trim() === ""}
            data-testid="ttc-bbt-save"
            onClick={logTemp}
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Taken on waking, before getting up — the reading confirms ovulation
          after the fact, it never predicts it.
        </p>
      </div>

      <InlineError>{error}</InlineError>
    </div>
  );
}
