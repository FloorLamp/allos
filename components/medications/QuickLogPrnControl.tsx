"use client";

import { IconCheck } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import TodayMedRow from "@/components/medications/TodayMedRow";
import { LabeledVerbChip } from "@/components/Chip";
import { useTimeStatement } from "@/components/TimeStatement";
import { useTimezone } from "@/components/TimezoneProvider";
import { useCockpitDay } from "@/components/illness/CockpitDayContext";
import {
  DOSE_ACTION_BRAND,
  DOSE_ACTION_ICON,
  DOSE_ACTION_NEUTRAL,
} from "@/components/medications/dose-action-styles";
import { medicationHref } from "@/lib/hrefs";
import { formatMedicationDoseProduct } from "@/lib/medication-dose-format";
import { logMedicationAdministration } from "@/app/(app)/medications/actions";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { dateStrInTz } from "@/lib/date";

// One PRN (as-needed) medication's shared quick-log row (#797).
// A primary one-tap records an administration NOW; "Earlier dose" reveals
// the shared WhenControl (#2236) — a DATED absolute time, empty until stated, with
// a one-tap "Now" — the retro-entry home ("gave it at 4pm, logging it now"). The
// old relative chips (30 min / 1 hr ago) are gone: a relative offset is computed at
// TAP time, so it drifts with every minute a rendered page sits open, which is the
// argument lib/correction-time.ts already made and this control never saw
// — the failure #2236 exists to end. Each successful log is a real administration
// (the ledger allows multiples/day), and the action's own revalidate brings back the
// updated "N today · last …" subtitle with its response.
//
// THE DAY COMES FROM THE CARD, THE STATEMENT STATES THE TIME (#4691, converged by
// #4426 under #4738's ruling 3). The row used to hand the WhenControl `minDate ===
// maxDate === today`, which renders the day as static text — so the illness cockpit
// could show a Yesterday toggle above a row that could only ever write today, and last
// night's dose had no path at all short of the med detail page's backfill door. #4691
// answered that with a day RANGE inside the statement, because the cockpit then had no
// day of its own; the Today/Yesterday lift gave it one (`CockpitDayContext`), so the
// day is the SURFACE's again and this is the shared statement like every other mount.
//
// WHAT NARROWED, SAID PLAINLY: the reach is the card's two days rather than
// `doseLogDays`' ±2, and outside a card it is that surface's single day. The owner
// accepted that narrowing — a third day is the med detail page's backfill door, which
// is the deep door built for it.
//
// A PRN dose is ADDITIVE and declares no expected interval (#2007): several
// administrations a day are legitimate and #798's redose line already advises without
// blocking, so this NEVER confirms. It does take layer 1 — the shared ledger's
// post-success cooldown, keyed per offset so the now-tap and a retro entry are separate
// writes — which absorbs the queued second click on the same button.
// ONE WORD, AND NEVER "now" (#4753's copy migration, owner-blessed on the issue).
// "Taken now" carried the whole sentence because the button had no label to say it
// with; the chip's label states the dose, so the verb is only the verb.
//
// GIVE OR TAKE IS NOT A VARIANT — IT IS THE SENTENCE BEING TRUE (#4752 item 4). This
// row carries a `profileId` only when a caregiver is logging for somebody ELSE, which
// is exactly the case where "Take" would be addressed to the wrong person. Nothing
// else about the control changes with it, and no caller chooses it.
const doseVerb = (crossProfile: boolean) => (crossProfile ? "Give" : "Take");

export default function QuickLogPrnControl({
  itemId,
  name,
  doseAmount,
  product,
  dayLabel,
  redoseLine = null,
  redosePrimary = true,
  linkToDetail = false,
  profileId,
  rowVariant = "inset",
  layout = "row",
  compactActions = false,
  tz: tzProp,
}: {
  itemId: number;
  name: string;
  doseAmount?: string | null;
  product?: string | null;
  dayLabel: string;
  // The redose-window status line (#798), or null when the med has no confirmed
  // interval/max. Informational — window state + running count, never permissive.
  redoseLine?: string | null;
  redosePrimary?: boolean;
  // The name links to the med's detail page (#852 item 2), matching the scheduled row.
  // Both hosts — the Medications Today panel (#851 item 10) and the dashboard quick-log
  // atom — pass this now; it stays a prop only so a future non-linking host can opt out.
  linkToDetail?: boolean;
  // The profile this dose is logged for (issue #858). Set on the illness Now-group cockpit so
  // a caregiver logs a household member's PRN dose without switching — the action gates on
  // the TARGET (requireProfileWriteAccess). Absent on the dashboard/medications mounts.
  profileId?: number;
  rowVariant?: "inset" | "embedded";
  // The medication detail card already establishes the medication identity and dose.
  // Its Today block needs only status + actions; list/dashboard hosts keep the full row.
  layout?: "row" | "detail";
  compactActions?: boolean;
  // The TARGET profile's timezone, for hosts that log another profile's dose (#858)
  // — the shared WhenControl's day/time must be that profile's, not the viewer's.
  // Defaults to the app-wide TimezoneProvider (the acting profile).
  tz?: string;
}) {
  const contextTz = useTimezone();
  const tz = tzProp ?? contextTz;
  // WHICH SURFACE THIS PRN CONTROL IS ON (#3087). It mounts on the medications
  // page's card, on the dashboard's own 'Log a dose' card and inside the illness
  // cockpit — three regions, one action, and only the region knows which.
  const stampLoggedVia = useLoggedViaStamp();
  const todayStr = dateStrInTz(tz);
  // THE CARD'S DAY (#4691), when this row is inside one. The illness cockpit's toggle
  // is the day context for every control beneath it, so flipping to Yesterday opens
  // this statement on yesterday — the Meds row and the Symptoms section can no longer
  // disagree about which day the card is showing. Outside a cockpit (the medications
  // page, the dashboard's own dose card) there is no card day and the statement opens
  // on today.
  const card = useCockpitDay();
  const cardDay = card?.activeDate ?? todayStr;
  const toast = useToast();
  const ledger = useOptimisticLedger("prn-dose");
  const busy = ledger.pending("now") || ledger.pending("custom");
  const doseDetail = formatMedicationDoseProduct(doseAmount, product);
  // WHAT THE TAP WRITES, as the reader should see it: this administration's DOSE.
  // A med with no recorded amount has nothing quantitative to promise, so the label
  // falls back to the medication itself — #4753's own `Ibuprofen · [Give]` shape.
  const doseLabel = doseDetail || name;
  const verb = doseVerb(profileId != null);
  // The whole sentence for a reader, where the visible pill abbreviates it. Both arms
  // read this one string.
  const takeName = `${verb} ${name}${doseDetail ? ` · ${doseDetail}` : ""}`;
  // The shared collapsed statement (#4426). Its four rules — no field until one is
  // stated, only what was on screen, a day change DROPS the statement, and a statement
  // is spent by the tap it answers — are stated once in `useTimeStatement` and were
  // four private spellings before. This row draws the two halves in two places, so it
  // renders `reveal` in its footer and opens it from the action button below.
  const statement = useTimeStatement({
    day: cardDay,
    tz,
    timeLabel: "Specific time",
    testId: "prn-log-when",
    disabled: busy,
  });

  async function log(offset: string, customTime?: string) {
    // What THIS tap spends, read once — the same one-expression discipline the shared
    // statement's rule 2 keeps for what it posts.
    const consumed = customTime ?? null;
    await ledger.tap({
      key: offset,
      write: () => {
        const fd = stampLoggedVia(new FormData());
        fd.set("id", String(itemId));
        fd.set("offset", offset);
        if (customTime) {
          fd.set("time", customTime);
          // The card's day, not the statement's: the day is the surface's and the
          // statement is the time half (#4738 ruling 1).
          fd.set("date", cardDay);
        }
        if (profileId != null) fd.set("profileId", String(profileId));
        return logMedicationAdministration(fd);
      },
      settle: (res) => {
        if (!res.ok) {
          toast(res.error, { tone: "error" });
          // Nothing was administered, so a retry needs no cooldown.
          return { kind: "rollback" };
        }
        toast(
          res.outcome === "duplicate"
            ? offset === "now"
              ? `${name} was already logged just now.`
              : `${name} already has a dose logged at about that time.`
            : `Logged ${name}${doseDetail ? ` · ${doseDetail}` : ""}.`
        );
        // Rule 4, and `consumed` is why this is not the unconditional reset it used to
        // be: the now-tap consumes NO statement, so one made beside it survives the tap
        // that did not pay for it — and a statement made while this write was in flight
        // survives its settle. The reveal closes on the SAME event, because a spent
        // statement is the only reason there was to close it; leaving it open on a
        // now-tap keeps a live statement on screen instead of hiding one.
        if (consumed) statement.setOpen(false);
        statement.spend(consumed);
        return { kind: "keep" };
      },
      onError: () => {
        toast("Couldn't log that dose. Try again.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
  }

  // THE CLOCK DOOR IS THE SHARED CONTROL'S OWN (#4426's rendering ruling). This row
  // used to hand-roll the glyph button beside the statement it opened — the last
  // hand-rolled half of the toggle in the tree — so the door's box, its glyph and its
  // accessible name lived here and could drift from every other mount's. Seated by
  // whichever arm renders below; the reveal opens in this row's FOOTER, which is why
  // this mount takes the statement in two pieces.
  const clockDoor = statement.door;

  const control = compactActions ? (
    // THE ICON-ONLY ARM KEEPS THE SHAPE IT SHIPPED WITH, deliberately (#4753, open
    // question 3). A chip with no visible label would contradict the primitive's one
    // claim — the label shows the payload — so this arm is NOT the chip, and whether
    // it should become a compact rendering of one is the owner's to say. What the
    // adoption does reach here is the COPY, which the issue settles outright: the
    // verb never says "now". The name is the same sentence the pill composes, so the
    // two arms cannot drift into two ways of saying one tap.
    <>
      <button
        type="button"
        onClick={() => log("now")}
        disabled={busy}
        className={`${DOSE_ACTION_ICON} ${redosePrimary ? DOSE_ACTION_BRAND : DOSE_ACTION_NEUTRAL}`}
        aria-label={takeName}
        data-testid="prn-log-now"
      >
        <IconCheck className="h-3.5 w-3.5" stroke={2.5} />
        <span className="sr-only">{takeName}</span>
      </button>
      {clockDoor}
    </>
  ) : (
    // THE LABELED ARM IS THE CHIP (#4753). "Taken now" said WHEN because nothing else
    // on the button did; the label says the DOSE this tap writes, so the verb is one
    // word and the row's identity line no longer has to be read to know what a tap
    // costs. `redosePrimary` — #798's window state — is the tone it always was, and
    // it lands on the verb nub rather than filling the pill (#4548's ruling).
    <LabeledVerbChip
      label={doseLabel}
      verb={verb}
      tone={redosePrimary ? "brand" : "neutral"}
      onAct={() => log("now")}
      disabled={busy}
      ariaLabel={takeName}
      testId="prn-log-now"
      clockDoor={clockDoor}
    />
  );

  const sublines = (
    <div className="mt-0.5 min-w-0">
      <div
        className="text-xs text-slate-500 dark:text-slate-400"
        data-testid="prn-day-label"
      >
        {dayLabel}
      </div>
      {redoseLine && (
        <div
          className="text-xs font-medium text-slate-600 dark:text-slate-300"
          data-testid="prn-redose-line"
        >
          {redoseLine}
        </div>
      )}
    </div>
  );

  // The saved value is the statement's local wall time, resolved back to an instant
  // SERVER-side against the day it was stated on (the same reason the food bar submits
  // a choice rather than a client timestamp).
  const savedHhmm = statement.at;
  const options = statement.open ? (
    <div data-testid="prn-log-options">
      <p className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">
        When was it taken?
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {statement.reveal}
        <button
          type="button"
          onClick={() => savedHhmm && log("custom", savedHhmm)}
          disabled={busy || !savedHhmm}
          className="btn btn-sm"
          data-testid="prn-log-custom"
        >
          <IconCheck className="h-3.5 w-3.5" stroke={2.5} />
          <span>Save dose</span>
        </button>
      </div>
    </div>
  ) : null;

  if (layout === "detail") {
    return (
      <div data-testid="quick-log-prn-item" data-item-id={itemId}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="section-label">Today</div>
            <div
              className="mt-1 text-sm font-medium text-slate-700 dark:text-slate-200"
              data-testid="prn-day-label"
            >
              {dayLabel}
            </div>
            {redoseLine ? (
              <div
                className="mt-0.5 text-xs text-slate-500 dark:text-slate-400"
                data-testid="prn-redose-line"
              >
                {redoseLine}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {control}
          </div>
        </div>
        {options ? (
          <div className="mt-3 border-t border-black/5 pt-3 dark:border-white/5">
            {options}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <TodayMedRow
      testId="quick-log-prn-item"
      itemId={itemId}
      variant={rowVariant}
      name={name}
      detail={doseDetail}
      href={linkToDetail ? medicationHref(itemId) : undefined}
      control={control}
      sublines={sublines}
      footer={
        options ? (
          <div className="border-t border-black/5 pt-2 pl-6 dark:border-white/5">
            {options}
          </div>
        ) : null
      }
    />
  );
}
