"use client";

import { IconCheck } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { useResettableState } from "@/components/useResettableState";
import CardSectionHeader from "@/components/CardSectionHeader";
import PediatricWeightUpdate from "@/components/medications/PediatricWeightUpdate";
import TodayMedRow from "@/components/medications/TodayMedRow";
import { LabeledVerbChip } from "@/components/OfferRow";
import { useTimeStatement } from "@/components/TimeStatement";
import { useTimezone } from "@/components/TimezoneProvider";
import {
  cockpitDayLabel,
  useCockpitDay,
  useDayBinding,
} from "@/components/illness/CockpitDayContext";
import {
  DOSE_ACTION_BRAND,
  DOSE_ACTION_ICON,
  DOSE_ACTION_NEUTRAL,
} from "@/components/medications/dose-action-styles";
import { medicationHref } from "@/lib/hrefs";
import { formatMedicationDoseProduct } from "@/lib/medication-dose-format";
import { prnDoseRowOffer, type PediatricFormContext } from "@/lib/prn-dosing";
import { logMedicationAdministration } from "@/app/(app)/medications/actions";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { dateStrInTz } from "@/lib/date";

// One PRN (as-needed) medication's shared quick-log row (#797).
// A primary one-tap records an administration NOW; the clock door beside it — this
// row's retired "Earlier dose" words, now the glyph the ruling makes the statement's
// only spelling (#4426) — reveals the shared WhenControl (#2236): a DATED absolute
// time, empty until stated, with a one-tap "Now", the retro-entry home ("gave it at
// 4pm, logging it now"). The old relative chips (30 min / 1 hr ago) are gone: a
// relative offset is computed at TAP time, so it drifts with every minute a rendered
// page sits open, which is the argument lib/correction-time.ts already made and this
// control never saw — the failure #2236 exists to end. Each successful log is a real
// administration (the ledger allows multiples/day), and the action's own revalidate
// brings back the updated "N today · last …" subtitle with its response.
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
  proposedTime,
  pediatric: pediatricProp = null,
  onLogged,
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
  // THE MINUTE THE HOST'S PROMPT IS ABOUT (#5489 fix 5): the fever offer's reading
  // time, a profile-local HH:MM on this surface's day. The statement opens seeded with
  // it — VISIBLY, because a statement only ever posts what was on screen — so the dose
  // offered for an 11:30 PM reading proposes 11:30 PM instead of an empty field.
  proposedTime?: string | null;
  // THE SUBJECT'S PEDIATRIC DOSING CONTEXT (#4713) — the profile this row writes for,
  // never the viewer's. Present, and the label's weight band is evaluated HERE, at the
  // tap, instead of only inside the add form that set the stored snapshot. Absent (or
  // an adult, or an item with no label chart) and every line below is the snapshot the
  // row has always shown.
  pediatric?: PediatricFormContext | null;
  // Fired once a dose is RECORDED — used by the illness fold's dose offer, which the
  // ruling ends when the offer is "taken" (#4712, 2026-09-04 11:20 UTC part 2). It
  // fires on the duplicate outcome too: the dose the offer existed to get is on the
  // ledger either way, so the prompt has been answered.
  onLogged?: () => void;
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
  // ONE DAY BINDING, card or no card (#4691) — `useDayBinding` answers the card's day
  // where there is one and this surface's single day where there is not, so
  // `isPrimaryDay` has one definition here rather than a hand-written fallback beside
  // the context arm.
  const card = useDayBinding(todayStr, tz);
  const cardDay = card.activeDate;
  // WHETHER THIS ROW IS UNDER A CARD AT ALL. `useDayBinding` answers a day either
  // way — that is what makes `isPrimaryDay` one definition — but only a card's day
  // is STATE. Outside one it is this render's `today`, which the write below must
  // not post (see `log`).
  const inCard = useCockpitDay() !== null;
  // WHETHER THE CARD IS STANDING ON A DAY THAT STILL HAS A "NOW" (#4686). A day that
  // has ended has none, so the tap below asks for the minute instead of stamping one.
  const isPrimaryDay = card.isPrimaryDay;
  const toast = useToast();
  const ledger = useOptimisticLedger("prn-dose");
  const busy = ledger.pending("now") || ledger.pending("custom");
  // THE WEIGHT THIS ROW IS BANDING FROM, and the one thing on this surface that can
  // change without a navigation: the refusal below mounts the shared one-field weight
  // fixer, whose save posts the real body-metric write and hands back the updated
  // context — so the offer re-derives in place rather than sending a caregiver to the
  // Body page and back at 2 a.m.
  // Keyed on the SERVER's own reading, so the two ways this can change compose: a
  // weight saved here wins until the server states a different one, and a weight
  // logged anywhere else lands on the next render instead of being shadowed forever
  // by a local override.
  const [pediatric, setPediatric] = useResettableState(
    pediatricProp,
    `${pediatricProp?.weightKg ?? ""}|${pediatricProp?.weightDate ?? ""}|${pediatricProp?.today ?? ""}`
  );
  // #798's band lookup, run at DOSE time (#4713). For an adult, an item with no label
  // chart, or a host that states no context, this is the stored snapshot and nothing
  // below renders.
  const offer = prnDoseRowOffer(
    { name, product, amount: doseAmount },
    pediatric
  );
  const doseDetail = formatMedicationDoseProduct(offer.amount, product);
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
    proposed: proposedTime ?? null,
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
        // THE SURFACE'S DAY RIDES BOTH ARMS (#5489 fix 1). The day is the surface's
        // and the statement is only the time half (#4738 ruling 1) — so the day is
        // stated whether or not a minute was, and the now-tap can no longer post a
        // dose with no day at all from a card that says Yesterday.
        //
        // A HOST WITH NO DAY OF ITS OWN STILL SAYS NOTHING, which is the action's own
        // rule and matters more now that a stale day is REFUSED rather than ignored:
        // outside a card `cardDay` is the day this render computed, so a medications
        // page left open across local midnight would post yesterday on the next tap
        // and turn a one-tap dose into "add the time". A stated minute is different —
        // it was anchored on the day the statement showed, so that day rides with it.
        if (inCard || customTime) fd.set("date", cardDay);
        if (customTime) fd.set("time", customTime);
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
        onLogged?.();
        return { kind: "keep" };
      },
      onError: () => {
        toast("Couldn't log that dose. Try again.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
  }

  // THE PRIMARY TAP, AND WHAT IT DOES ON A DAY THAT HAS ENDED (#5489 fix 2, the
  // #4686 ruling): "on a day that has ended, ASK for the minute, as the temperature
  // fold and the PRN row's 'Earlier dose' both do". Yesterday has no "now" to stamp,
  // and the instant this writes is the safety line — it arms the redose clock and the
  // trailing-24h ceiling — so the tap RESOLVES TO THE STATEMENT rather than stamping
  // the current minute: it writes the minute already stated beside it, or opens the
  // statement to ask for one. On the card's own today it is the one-tap it always was,
  // and a statement made beside it still survives a tap that did not pay for it.
  function take(): void {
    if (isPrimaryDay) {
      void log("now");
      return;
    }
    // ONLY WHAT IS ON SCREEN (`TimeStatement` rule 2). A minute typed and then
    // dismissed is not a statement this tap may spend, so a closed reveal asks again
    // rather than writing the answer the reader just walked away from.
    const stated = statement.open ? statement.at : null;
    if (stated) void log("custom", stated);
    else statement.setOpen(true);
  }

  // Seated by whichever arm renders below; the reveal opens in this row's FOOTER,
  // which is why this mount draws the statement in two pieces. The door itself used
  // to be hand-rolled here, glyph and accessible name and all (#4426).
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
        onClick={take}
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
      onAct={take}
      disabled={busy}
      ariaLabel={takeName}
      testId="prn-log-now"
      clockDoor={clockDoor}
    />
  );

  // THE ROW STATES ITS BASIS (#4713 fix 1, and #4752's last unmet clause). "160 mg ·
  // 24–35 lb band" — the figure the tap writes, and the label band it came from, so a
  // caregiver can see that the offer follows THIS child's recorded weight rather than
  // whatever the item was last saved with.
  const bandBasis = offer.bandLabel ? (
    <div
      className="text-xs text-slate-500 dark:text-slate-400"
      data-testid="prn-band-basis"
    >
      {doseDetail} · {offer.bandLabel} band
    </div>
  ) : null;

  // THE LABEL'S REFUSAL, ON THE ROW (#4713 fix 2). The same vocabulary the add form
  // states — #798's gates decide, this only moves where they run — reached from the
  // surface a dose is actually given from. A missing or stale weight also mounts the
  // shared one-field fixer already open, because "go to Body, expand the body group,
  // come back" is the trip that made these refusals unreachable in practice.
  const refusal = offer.result;
  const needsWeight =
    refusal?.kind === "need-weight" || refusal?.kind === "stale-weight";
  const bandNote =
    refusal && refusal.kind !== "dose" ? (
      <div data-testid="prn-band-refusal" className="text-xs">
        <p className="text-amber-700 dark:text-amber-300">
          {refusal.kind === "ask-doctor"
            ? refusal.reason
            : refusal.kind === "need-weight"
              ? "Enter a current weight to match the package label\u2019s weight band."
              : refusal.kind === "stale-weight"
                ? `The latest recorded weight is over ${refusal.thresholdDays} days old. Enter a current weight before using a weight band.`
                : `Recorded weight is ${refusal.weightLbs} lb. The available package-label chart starts at ${refusal.minimumLbs} lb, so no dose band is suggested. Check the product label and ask a clinician or pharmacist before use.`}
        </p>
        {needsWeight && pediatric ? (
          <PediatricWeightUpdate
            idPrefix={`prn-${itemId}`}
            context={pediatric}
            initiallyOpen
            onSaved={setPediatric}
          />
        ) : null}
      </div>
    ) : null;

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
      {bandBasis}
      {bandNote}
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
        {/* THE SHARED HEADER ROW (#4548 ruling 4). The same eyebrow with the same
            trailing control the read-only arm of this card already draws as a
            CardSectionHeader — one alignment, one margin — so the two arms of the
            medication card's day block can no longer be arranged differently.
            The day label and the redose line are the block's BODY, not the row.
            ITS WORDS ARE THE CARD'S (#5489 fix 4): the eyebrow was the literal
            "Today", so a panel opened on a cockpit standing on Yesterday was headed
            TODAY above a tap that wrote yesterday. */}
        <CardSectionHeader
          title={cockpitDayLabel(card, cardDay) ?? "Today"}
          variant="label"
        >
          {control}
        </CardSectionHeader>
        <div
          className="text-sm font-medium text-slate-700 dark:text-slate-200"
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
        {bandBasis ? <div className="mt-0.5">{bandBasis}</div> : null}
        {bandNote ? <div className="mt-1">{bandNote}</div> : null}
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
