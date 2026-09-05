"use client";
import { measurementsSavedText } from "@/lib/body-metric-input";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import type { StampedFormData } from "@/lib/logged-via";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import {
  IconX,
  IconPlus,
  IconChevronDown,
  IconChartBar,
} from "@tabler/icons-react";
import {
  type Symptom,
  resolveSymptomKey,
  symptomLabel,
  symptomBySlug,
  MAX_SYMPTOM_SEVERITY,
  symptomLabelOptions,
} from "@/lib/symptoms";
import Combobox from "@/components/Combobox";
import type { TemperatureUnit } from "@/lib/settings";
import { useToast } from "@/components/Toast";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { fmtTemp } from "@/lib/units";
import { useTemperatureUnitDetection } from "@/components/useTemperatureUnitDetection";
import TemperatureField from "@/components/vitals/TemperatureField";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import {
  useCockpitDay,
  useDayBinding,
} from "@/components/illness/CockpitDayContext";
import { useTimezone } from "@/components/TimezoneProvider";
import { statedHhmm } from "@/lib/stated-time";
import {
  logSymptom,
  logTemperature,
  activateIllnessForSymptoms,
  suggestSymptomsFromText,
  type IllnessActivationResult,
} from "../../app/(app)/symptom-actions";
import type { SymptomTextMapping } from "@/lib/symptom-text-map";
import type { AppRoute } from "@/lib/hrefs";
import Link from "next/link";
import SymptomSeverityControl from "@/components/illness/SymptomSeverityControl";
import SymptomRowControl from "@/components/illness/SymptomRowControl";
import Button from "@/components/Button";
import IconButton from "@/components/IconButton";
import IllnessMedicationLogger from "@/components/illness/IllnessMedicationLogger";
import { useDoseOfferSignal } from "@/components/illness/DoseOfferContext";
import type { PrnMedForQuickLog } from "@/lib/queries/intake/adherence";
import type { IntakeFormContext } from "@/lib/intake-form-context";
import SubmitButton from "@/components/SubmitButton";

// One-tap symptom logger (issue #799/#857), modeled on the FoodLogBar one-tap pattern:
// optimistic local severities, a Server Action per tap, and reconciliation to the
// server's authoritative value (#748 item 2) — through the shared `useOptimisticLedger`
// (#2041), which also absorbs the second half of a double-tap (#2007 layer 1). A tap is
// IDEMPOTENT here (the day keeps its worst severity), so it never confirms: a normal tap
// RAISES the severity (server-enforced); selecting a lower labeled chip uses the narrow
// lower action directly; the × clears the day's row.
//
// Active-first layout (#857): the LOGGED symptoms render expanded (label + labeled
// severity chips + note + ×) — the working set. Everything else (the ~20-symptom catalog +
// previously-used customs + a free-text add) collapses into ONE "＋ add symptom" picker,
// ranked by the profile's symptom history (rankedKeys) and FROZEN while mounted so a row
// never jumps mid-tap. On the dashboard this renders with a today/yesterday toggle; on the
// Timeline day view it renders for a single day. When no illness-type situation is active
// it offers a suggest-only "Mark as illness" bridge.

type Row = { key: string; label: string; icon?: string };

// The curated symptom labels, built once (catalog order — the picker shows the first
// eight on an empty query).
const SYMPTOM_LABEL_OPTIONS = symptomLabelOptions();

// What a failed activation says (#4962), in the shape this file's other failures
// already take ("Couldn't read that. Try again."). ONE sentence for BOTH doors,
// because both make the same write and a person who taps either is owed the same
// answer.
const ILLNESS_ACTIVATION_FAILED =
  "Couldn't start an illness episode. Try again.";

export default function SymptomLogBar({
  date,
  altDate,
  initial,
  initialAlt,
  initialNotes,
  initialAltNotes,
  symptoms,
  customNames,
  rankedKeys,
  suggestActivateIllness,
  showTemperature = false,
  temperatureUnit = "F",
  timeZone,
  profileId,
  episodeId,
  showTitle = true,
  textIntakeEnabled = false,
  analysisHref,
  antipyreticMeds = [],
  intakeContext,
  nowIso,
  hasOpenEpisode = episodeId != null,
}: {
  // Primary date (YYYY-MM-DD). On the dashboard this is today; on the Timeline it's the
  // selected day.
  date: string;
  // Optional second date for the toggle (yesterday on the dashboard). Absent → single-day.
  altDate?: string;
  // symptom key → severity already logged, for the primary and alt dates.
  initial: Record<string, number>;
  initialAlt?: Record<string, number>;
  // symptom key → note already logged, for the primary and alt dates (#857). Optional —
  // absent leaves every note blank until edited.
  initialNotes?: Record<string, string>;
  initialAltNotes?: Record<string, string>;
  // The curated catalog (shortcut chips).
  symptoms: Symptom[];
  // Custom symptom keys this profile has logged before (rendered in the add picker).
  customNames: string[];
  // The picker order — stored keys (curated slugs + customs) ranked by this profile's
  // symptom history (#857, getSymptomLogOrder). Absent → catalog order then customs.
  rankedKeys?: string[];
  // Whether to offer the "Mark as illness" bridge (no illness-type situation active).
  suggestActivateIllness: boolean;
  // Whether to render the body-temperature quick entry (issue #800).
  showTemperature?: boolean;
  // The viewer's login temperature-unit preference (#857) — seeds the entry unit and the
  // fever toast. Canonical storage stays °F; this only changes display. Default "F".
  temperatureUnit?: TemperatureUnit;
  // Profile-local zone used to seed the reading-time field when temperature entry opens.
  // Important for household logging, where the target's zone may differ from the browser.
  timeZone?: string;
  // The profile this bar writes to (issue #858). Set ONLY on the illness Now-group cockpit,
  // where a caregiver logs for a household member without switching — every action posts
  // this so the server gates on the TARGET (requireProfileWriteAccess). Absent on the
  // default dashboard/Timeline mounts, which write the session's active profile.
  profileId?: number;
  // The owning open episode for dashboard cockpit writes. The server validates that
  // it belongs to the target profile and covers the posted day. Other mounts omit it
  // and retain the established newest-open default association.
  episodeId?: number;
  // Composed surfaces may already provide a section heading; keep the count/toggle row
  // without repeating "Daily symptoms" in that case.
  showTitle?: boolean;
  // Whether to render the free-text intake field (issue #877) — true only when a Light
  // AI tier is configured. Absent/false hides it entirely (taps stay the whole story;
  // offline-first, unchanged).
  textIntakeEnabled?: boolean;
  // Where "is it getting worse" is answered for this bar's subject (#1852). PASSED, not
  // hardcoded, because /trends/symptoms reads the SESSION's active profile: on a
  // household member's cockpit — every mount that sets `profileId` — the link would
  // name their symptoms and show the viewer's own, so those mounts omit it.
  analysisHref?: AppRoute;
  // ── THE FOLD'S INLINE FEVER OFFER (#4712 judgement 1, owner ruling 2026-09-03
  // 15:40 UTC, option A) ────────────────────────────────────────────────────────
  //
  // After a fever-range reading, the fold shows a confirmation block UNDER the
  // reading rather than closing: the fever sentence, "Open an episode" (primary)
  // beside the dose offer, and a "Not now" link. It renders only while the fold
  // itself is open — closing the fold (or unmounting the sheet it lives in) takes
  // the block with it; there is no toast and no persistent nudge for this.
  //
  // The PRN subset eligible for the one-tap dose offer, already narrowed to fever
  // reducers by the caller (`antipyreticPrnMeds`, lib/prn-defaults.ts) — this bar
  // stays free of that judgment. Reuses IllnessMedicationLogger (#4834) rather than
  // a second dose control; absent or empty, the block still offers the episode.
  // BOTH HOSTS FEED THIS AGAIN (#4712, owner ruling 2026-09-04 11:20 UTC part 2).
  // It was fed by nobody for a while: the same antipyretic was already a chip in the
  // host's persistent Meds section a few lines below, so the offer could only ever
  // duplicate it. The ruling makes the PERSISTENT SECTION yield instead — one dose
  // prompt at a time — which the host arranges with a `DoseOfferProvider` around this
  // bar and that section plus the section's `yieldsTo` prop, and this bar signals
  // through `useDoseOfferSignal`. A host that wires the props without the provider would show
  // two chips again, so the two arrive together on both mounts.
  antipyreticMeds?: PrnMedForQuickLog[];
  // Required alongside antipyreticMeds to mount IllnessMedicationLogger (its own
  // required prop) — absent, the dose offer is skipped rather than mounted half-fed.
  intakeContext?: IntakeFormContext;
  // IllnessMedicationLogger's redose-window "now" (see QuickLogPrnContent.nowIso).
  nowIso?: string;
  // Whether this write already has a known open episode, so the block does not
  // offer to open one that already exists. Defaults from `episodeId` — set
  // explicitly only where a mount (the episode page, closed-episode backfill)
  // knows the answer independently of the id it posts.
  hasOpenEpisode?: boolean;
}) {
  // THE DAY THIS BAR IS STANDING ON (#4691) comes from the CARD, not from this
  // component: the toggle sets the card's day context and every control beneath it —
  // this bar's taps, notes and temperature fold, and the Meds rows that are this bar's
  // SIBLING — reads the same answer. Unwrapped mounts (the Timeline day view, cycles,
  // the quick-entry sheet) are single-day surfaces and stand on the day they were
  // handed.
  const card = useCockpitDay();
  // The binding, card or no card — so an UNWRAPPED mount (`/history?day=<past>`, the
  // cycles page) answers the has-a-now question from the calendar too, rather than
  // assuming yes. That assumption is what let a past-day reading through those mounts
  // without a stated time.
  const day = useDayBinding(date, timeZone);
  const activeDate = day.activeDate;
  const isPrimaryDay = day.isPrimaryDay;
  const hasToggle = !!card?.altDate;

  const [severitiesByDate, setSeveritiesByDate] = useState<
    Record<string, Record<string, number>>
  >(() => ({
    [date]: initial,
    ...(altDate ? { [altDate]: initialAlt ?? {} } : {}),
  }));
  // Per-symptom notes, kept per day like the severities.
  const [notesByDate, setNotesByDate] = useState<
    Record<string, Record<string, string>>
  >(() => ({
    [date]: initialNotes ?? {},
    ...(altDate ? { [altDate]: initialAltNotes ?? {} } : {}),
  }));
  const [customDraft, setCustomDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [, startTransition] = useTransition();
  const toast = useToast();
  const ledger = useOptimisticLedger<number>("symptom-severity");

  // Body-temperature quick entry (issue #800) — collapsed by default (#857) to one line.
  const [tempOpen, setTempOpen] = useState(false);
  const tempUnitDetection = useTemperatureUnitDetection(temperatureUnit);
  // Reading time (#800/#843) through the shared control, which is what retires this
  // bar's own <input type="time"> from the #2236 allowlist. The day is FIXED to the
  // day the toggle is showing, so the control renders it as text and offers only the clock —
  // and its invariant 3 replaces the old seeded-now field: an untouched time states
  // NOTHING and the action stamps the profile's current minute, which is what a
  // thermometer-to-phone reading meant anyway. Adjusting it for an earlier reading is
  // still one tap away, on the same absolute-local terms every other statement uses.
  const tempZone = useTimezone();
  const [tempWhen, setTempWhen] = useState<WhenValue>(() => ({
    date,
    statedAt: null,
  }));
  // Switching the day re-anchors the pair rather than leaving a time stated on the
  // day the user just left — the WhenControl's own invariant 1, applied by the owner
  // of the day it is pinned to.
  function selectDay(next: string): void {
    card?.select(next);
    setTempWhen({ date: next, statedAt: null });
    // The offer is about the reading that produced it, on the day it was on; leaving
    // it up under a different day would say something about a day it never saw.
    showFeverOffer(null);
  }
  const [tempError, setTempError] = useState<string | null>(null);
  const [tempPending, setTempPending] = useState(false);

  // THE FEVER OFFER (#4712 judgement 1) — set on a fever-range reading, cleared by
  // whatever ends its lifetime: dismissing it, accepting the episode offer, changing
  // the day, or the fold closing. It never survives the fold: rendering below reads
  // `tempOpen && feverOffer`, so there is no separate cleanup this state can forget
  // that would leave the block up with the fold closed.
  const [feverOffer, setFeverOffer] = useState<{ degF: number } | null>(null);
  const [episodeOfferPending, setEpisodeOfferPending] = useState(false);
  // WHICH DOOR ASKED (#4962). The offer and the "Mark as illness" bridge post the
  // same activation, so they share one failure sentence — but it has to appear
  // beside the control that was tapped, and the quick-log sheet renders both at
  // once (no illness tracked, temperature fold open).
  const [activationError, setActivationError] = useState<{
    where: "offer" | "bridge";
    message: string;
  } | null>(null);
  // WHETHER THIS BLOCK WOULD CARRY A DOSE (#4712 ruling 2026-09-04 11:20, part 2).
  // The host's persistent Meds section yields only to a dose offer, never to the
  // episode half — an offer with no eligible PRN takes nothing off the screen.
  const offersDose = antipyreticMeds.length > 0 && !!intakeContext && !!nowIso;
  const yieldMeds = useDoseOfferSignal();
  // ONE SETTER FOR THE OFFER AND ITS SIGNAL, so the host's Meds section cannot be
  // left yielding to a block that is no longer there. Every path that raises or
  // clears the offer goes through here.
  function showFeverOffer(offer: { degF: number } | null): void {
    setFeverOffer(offer);
    yieldMeds(offer != null && offersDose);
    // The offer's own failure sentence lives and dies with the block it is in, so
    // a fresh reading never reopens the offer under the last attempt's error. The
    // bridge's sentence is not this function's to clear.
    setActivationError((e) => (e?.where === "offer" ? null : e));
  }

  // Free-text intake (issue #877): a typed sentence → staged, editable suggestions the
  // user confirms with one tap. Suggest-only — nothing writes until confirm, which goes
  // through the same logSymptom / logTemperature actions a tap uses.
  const [intakeText, setIntakeText] = useState("");
  const [intakeStaged, setIntakeStaged] = useState<SymptomTextMapping | null>(
    null
  );
  const stampLoggedVia = useLoggedViaStamp();
  const [intakePending, setIntakePending] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);

  async function suggestFromText() {
    if (intakeText.trim() === "") return;
    setIntakePending(true);
    setIntakeError(null);
    const fd = new FormData();
    fd.set("text", intakeText);
    const res = await suggestSymptomsFromText(withTarget(fd));
    setIntakePending(false);
    if (res.ok) {
      setIntakeStaged(res.mapping);
    } else if (res.reason === "empty") {
      setIntakeError("Couldn't find any symptoms in that. Add them below.");
    } else if (res.reason === "not-configured") {
      setIntakeError("AI intake isn't configured.");
    } else {
      setIntakeError(res.error || "Couldn't read that. Try again.");
    }
  }

  function setStagedSeverity(idx: number, sev: number) {
    setIntakeStaged((m) => {
      if (!m) return m;
      const symptoms = m.symptoms.map((s, i) =>
        i === idx ? { ...s, severity: sev } : s
      );
      return { ...m, symptoms };
    });
  }

  function dropStaged(idx: number) {
    setIntakeStaged((m) => {
      if (!m) return m;
      return { ...m, symptoms: m.symptoms.filter((_, i) => i !== idx) };
    });
  }

  function dropUnmapped(idx: number) {
    setIntakeStaged((m) => {
      if (!m) return m;
      return { ...m, unmapped: m.unmapped.filter((_, i) => i !== idx) };
    });
  }

  // Confirm (#877): commit every staged suggestion through the EXISTING actions — one
  // logSymptom per row (+ its note), then a logTemperature for a staged reading — so a
  // confirmed sentence lands rows identical to tapping them.
  async function confirmIntake() {
    if (!intakeStaged) return;
    setIntakePending(true);
    // The day the bar is standing on, unless the sentence itself said "yesterday"
    // and the toggle offers that day.
    const altDay = card?.altDate ?? altDate;
    const targetDate =
      intakeStaged.dayOffset === -1 && altDay ? altDay : activeDate;
    // THE COMPOSITE STATES NO TIME, and it has no control to ask through — a typed
    // sentence carries a day at best. It therefore sets no `time` AT ALL and lets the
    // action decide: `logTemperature` stamps the profile's current minute when the day
    // is today and stores the reading untimed otherwise, off the clock seam. That is
    // one rule in one place — the fourth hand-written spelling of "does this day have
    // a now", reading its own `new Date()`, lived here and is gone.
    for (const s of intakeStaged.symptoms) {
      const fd = new FormData();
      fd.set("symptom", s.slug);
      fd.set("severity", String(s.severity));
      fd.set("date", targetDate);
      if (s.note) fd.set("note", s.note);
      await logSymptom(withTarget(fd));
    }
    if (intakeStaged.temperature) {
      const fd = new FormData();
      fd.set("temperature", String(intakeStaged.temperature.value));
      fd.set("temp_unit", intakeStaged.temperature.unit);
      fd.set("date", targetDate);
      await logTemperature(withTarget(fd));
    }
    const count = intakeStaged.symptoms.length;
    setIntakeStaged(null);
    setIntakeText("");
    setIntakePending(false);
    toast(
      count > 0
        ? `Logged ${count} symptom${count === 1 ? "" : "s"}.`
        : "Logged."
    );
  }

  function toggleSymptomPicker() {
    const opening = !pickerOpen;
    setPickerOpen(opening);
    if (opening) {
      setTempOpen(false);
      // THE BLOCK LIVES IN THE FOLD (#4712 judgement 1). Closing it any way —
      // including by opening the OTHER fold, which forces this one shut above —
      // takes the offer with it.
      showFeverOffer(null);
    }
  }

  function toggleTemperatureEntry() {
    const opening = !tempOpen;
    setTempOpen(opening);
    if (opening) setPickerOpen(false);
    else showFeverOffer(null);
  }

  // NO CLIENT RANGE CHECK. `logTemperatureCore` runs `temperatureRangeError` over the
  // same canonical °F this would have computed and answers with that exact sentence, so
  // the second copy could only ever disagree with the one that decides.
  async function logTemp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    // The day the fold is showing (#4691). Under Yesterday this backfills last
    // night's reading — the one the fever-free clock needs evidence of (#4685) —
    // through the same dated core a reading logged today goes through.
    fd.set("date", activeDate);
    const hhmm = statedHhmm(tempWhen.statedAt, timeZone ?? tempZone);
    // ON A PAST DAY THE MINUTE IS THE ASK (#4685). "Now" is not a time on a day that
    // has ended, so there is nothing honest for the action to fall back to — it
    // stores such a reading untimed, and an untimed reading is anchored at noon,
    // which cannot answer "was this before or after the 7:10pm fever?". The control
    // is already mounted and already knows the day, so asking for the minute is the
    // honest ask rather than friction.
    if (!hhmm && !isPrimaryDay) {
      setTempError("Add the time this reading was taken.");
      return;
    }
    if (hhmm) fd.set("time", hhmm);
    setTempError(null);
    setTempPending(true);
    const res = await logTemperature(withTarget(fd));
    setTempPending(false);
    if (res.ok) {
      form.reset();
      tempUnitDetection.reset();
      setTempWhen({ date: activeDate, statedAt: null });
      // FEVER-RANGE KEEPS THE FOLD OPEN (#4712 judgement 1). The confirmation block
      // renders under the reading, in the SAME fold — closing it here would bury the
      // offer under the very toggle that reveals it. A fever reading with nothing to
      // offer (an episode already open and no eligible PRN) closes exactly as before.
      const offers = !hasOpenEpisode || offersDose;
      if (res.flag === "high" && offers) {
        showFeverOffer({ degF: res.degF });
      } else {
        showFeverOffer(null);
        setTempOpen(false);
      }
      // NO ACTION ON THIS TOAST (#4712 judgement 1's second exclusion). The owner
      // ruled the offer never rides a toast; the toast stays exactly what it was
      // before this issue — a confirmation of the write, "— fever" included as
      // TEXT, never as an `action` button. The offer itself is the block below.
      toast(
        `Temperature logged: ${fmtTemp(res.degF, temperatureUnit)}${
          res.flag === "high" ? " — fever" : ""
        }`,
        { tone: res.flag === "high" ? "error" : undefined }
      );
      // Single-reading red flag (#859 item 3): the source's own cited instruction,
      // shown as a distinct, longer-lived error toast at the moment of logging.
      if (res.redFlag) {
        toast(res.redFlag, { tone: "error" });
      }
      // The minute the gate discarded (#4568), said in the body domain's own words —
      // the same sentence `MeasurementsQuickAdd` raises for the sitting's Time. Its
      // own toast for the reason the red flag has one: the reading LANDED, so this
      // amends nothing about the line above and must not be squeezed into it.
      if (res.statedTimeRefused) {
        toast(measurementsSavedText("Saved", res.statedTimeRefused));
      }
    } else {
      setTempError(res.error);
      toast(res.error, { tone: "error" });
    }
  }

  const severities = severitiesByDate[activeDate] ?? {};
  const notes = notesByDate[activeDate] ?? {};

  // Stamp the cross-profile subject (issue #858) onto every write, when this bar is a
  // illness Now cockpit for a non-active profile. A no-op on the default mounts (profileId
  // undefined), which write the session's active profile. ONE SPELLING, `profile_id`
  // (#4424 ruling 4) — the same field every record row posts and `gateItemProfile` reads.
  const withTarget = (fd: FormData): StampedFormData => {
    if (profileId != null) fd.set("profile_id", String(profileId));
    if (episodeId != null) fd.set("episodeId", String(episodeId));
    // WHICH SURFACE (#3087). This bar is mounted on the dashboard, on the Timeline,
    // on the Cycles page and inside the illness cockpit's panels — one component,
    // one action, four surfaces — so the mounting declares itself and the server
    // stops reading every one of them as the symptom page's own form.
    return stampLoggedVia(fd);
  };

  // THE ONE ACTIVATION, AND ITS ANSWER READ (#4962). Both doors below — the
  // offer's "Open an episode" and the "Mark as illness" bridge — post this same
  // subject-capable write (#4922), and both used to await it and throw the result
  // away: a write that produced no episode cleared the affordance exactly like one
  // that did, and nobody was told. `IllnessActivationResult.episodeId` is the
  // action's own invitation to answer from what happened, so this answers from it.
  // True only when an episode now exists.
  //
  // Idempotent, unchanged: if one was already open by the time this lands,
  // activating again changes nothing and the id comes back all the same.
  async function openIllnessEpisode(
    where: "offer" | "bridge"
  ): Promise<boolean> {
    setActivationError(null);
    let res: IllnessActivationResult;
    try {
      res = await activateIllnessForSymptoms(withTarget(new FormData()));
    } catch {
      setActivationError({ where, message: ILLNESS_ACTIVATION_FAILED });
      return false;
    }
    if (!res.ok || res.episodeId == null) {
      setActivationError({
        where,
        message: (res.ok ? "" : res.error) || ILLNESS_ACTIVATION_FAILED,
      });
      return false;
    }
    return true;
  }

  // "OPEN AN EPISODE" (#4712 judgement 1), for the reading's own subject.
  // Dismisses the block on success; the newly-open episode is the durable surface
  // from here, not this transient confirmation. On a failure the block STAYS with
  // the sentence above under it — this is the primary action of a surface that has
  // just told someone their temperature is high, so vanishing would report a
  // success that did not happen (#4962).
  function acceptEpisodeOffer() {
    setEpisodeOfferPending(true);
    startTransition(async () => {
      const opened = await openIllnessEpisode("offer");
      setEpisodeOfferPending(false);
      if (opened) showFeverOffer(null);
    });
  }

  function dismissFeverOffer() {
    showFeverOffer(null);
  }

  // The full universe of rows (curated catalog + any custom keys already logged, either
  // day). Labels/icons only — order comes from `orderedKeys`.
  const rows = useMemo<Row[]>(() => {
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const s of symptoms) {
      seen.add(s.slug);
      out.push({ key: s.slug, label: s.label, icon: s.icon });
    }
    const customs = [
      ...customNames,
      ...Object.keys(severitiesByDate[date] ?? {}),
      ...(altDate ? Object.keys(severitiesByDate[altDate] ?? {}) : []),
    ];
    for (const key of customs) {
      if (seen.has(key) || symptomBySlug(key)) continue;
      seen.add(key);
      out.push({ key, label: symptomLabel(key) });
    }
    return out;
  }, [symptoms, customNames, severitiesByDate, date, altDate]);

  const rowMap = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  // Freeze the picker order for the life of this mount: the server re-ranks on every
  // read, so the re-render each tap's action triggers must not reorder rows under the
  // finger (the FoodLogBar #591 discipline). The order only changes on remount (navigate away + back).
  const [frozenOrder] = useState<string[]>(
    () => rankedKeys ?? [...symptoms.map((s) => s.slug), ...customNames]
  );
  const orderedKeys = useMemo(() => {
    const idx = new Map(frozenOrder.map((k, i) => [k, i]));
    return rows
      .map((r, i) => ({ k: r.key, i }))
      .sort((a, b) => {
        const ai = idx.get(a.k) ?? Number.MAX_SAFE_INTEGER;
        const bi = idx.get(b.k) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi || a.i - b.i;
      })
      .map((x) => x.k);
  }, [rows, frozenOrder]);

  const loggedKeys = orderedKeys.filter((k) => (severities[k] ?? 0) > 0);
  const pickerKeys = orderedKeys.filter((k) => (severities[k] ?? 0) <= 0);

  function setSeverity(key: string, value: number) {
    setSeveritiesByDate((m) => {
      const day = { ...(m[activeDate] ?? {}) };
      if (value <= 0) delete day[key];
      else day[key] = value;
      return { ...m, [activeDate]: day };
    });
  }

  function setNote(key: string, value: string) {
    setNotesByDate((m) => {
      const day = { ...(m[activeDate] ?? {}) };
      if (value.trim() === "") delete day[key];
      else day[key] = value;
      return { ...m, [activeDate]: day };
    });
  }

  // Tap RAISES (worst-severity), matching the server. Adding from the picker taps at 1.
  async function tap(key: string, severity: number) {
    const prev = severities[key] ?? 0;
    await ledger.tap({
      // Keyed on the TRANSITION, like the dose control's: a row's chips all write the
      // same day's severity, so "the same write twice" is prev→next, not the chip.
      // Two taps of one chip share a key and the second is absorbed; every deliberate
      // move — raise, then lower back to where it started — is a different transition
      // and always lands.
      key: `${key}:${prev}->${severity}`,
      from: prev,
      optimistic: Math.max(prev, severity),
      commit: (value) => setSeverity(key, value),
      write: () => {
        const fd = new FormData();
        fd.set("symptom", key);
        fd.set("severity", String(severity));
        fd.set("date", activeDate);
        return logSymptom(withTarget(fd));
      },
      settle: (res) => {
        if (res.ok) return { kind: "adopt", value: res.severity };
        toast(res.error || "Couldn't log that symptom — try again.", {
          tone: "error",
        });
        return { kind: "rollback" };
      },
      onError: () => {
        toast("Couldn't log that symptom — try again.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
  }

  function addCustom(name: string = customDraft) {
    // #3325: resolve against the spellings this profile already uses, so a typed
    // "kratom" raises the existing "Kratom" chip instead of putting a second one beside
    // it. The optimistic key has to agree with the one the server will write — this
    // state is seeded once and never re-synced from props, so a divergent optimistic key
    // would linger next to the real row until the next mount. The server re-resolves
    // against the full ledger in first-seen order and stays authoritative; `customNames`
    // is the same vocabulary ordered newest-used-first, which only differs where a
    // profile already carries two spellings of one name (rows that predate this fix —
    // see lib/vocabulary-store.ts).
    const key = resolveSymptomKey(name, customNames);
    setCustomDraft("");
    if (!key) return;
    // One add path (#857): a typed name logs at severity 1, becoming a logged row.
    void tap(key, 1);
  }

  const loggedCount = loggedKeys.length;

  return (
    <div data-testid="symptom-log-bar">
      {/* NOT A HEADER ROW (#4548 ruling 3). This was `justify-between` around ONE
          child, and the count it looks like it would push to the right edge lives
          inside the label's own paragraph. There is nothing for the arrangement to
          arrange, so the wrapper goes and the label carries the margin; adopting
          CardSectionHeader here would have moved the count instead. */}
      {showTitle && (
        <p className="section-label mb-2">
          Daily symptoms
          <span
            data-testid="symptom-logged-count"
            className="ml-2 font-normal normal-case tracking-normal"
          >
            {loggedCount} logged
          </span>
        </p>
      )}

      {/* ONE ROW (#4752 item 5). The day toggle, both add buttons and the empty
          state used to occupy three stacked rows above an empty list — three lines
          of chrome before a single symptom. They are one row now, and the empty
          state is the sentence at its end rather than a paragraph of its own. */}
      <div
        data-testid="symptom-log-actions"
        className="mb-3 flex flex-wrap items-center gap-2"
      >
        <button
          type="button"
          data-testid="symptom-add-picker-toggle"
          aria-expanded={pickerOpen}
          aria-controls="symptom-add-picker"
          onClick={toggleSymptomPicker}
          className="btn-ghost btn-sm"
        >
          <IconChevronDown
            className={`h-3.5 w-3.5 transition-transform ${pickerOpen ? "rotate-180" : ""}`}
          />
          Add symptom
        </button>
        {showTemperature && (
          <button
            type="button"
            data-testid="temp-quick-toggle"
            aria-expanded={tempOpen}
            aria-controls="temp-quick-entry"
            onClick={toggleTemperatureEntry}
            className="btn-ghost btn-sm"
          >
            <IconChevronDown
              className={`h-3.5 w-3.5 transition-transform ${tempOpen ? "rotate-180" : ""}`}
            />
            <span>Log temperature</span>
          </button>
        )}
        {analysisHref && (
          <Link
            href={analysisHref}
            data-testid="symptom-analysis-link"
            className="btn-ghost btn-sm"
          >
            <IconChartBar className="h-3.5 w-3.5" />
            Symptom trends
          </Link>
        )}
        {loggedCount === 0 && (
          <p
            data-testid="symptom-none-logged"
            className="text-xs text-slate-500 dark:text-slate-400"
          >
            No symptoms logged{hasToggle ? " for this day" : ""}.
          </p>
        )}
        {card?.altDate && (
          <div
            data-testid="symptom-day-toggle"
            className="ml-auto inline-flex overflow-hidden rounded-md border border-black/10 text-xs dark:border-white/15"
          >
            <button
              type="button"
              data-testid="symptom-day-primary"
              aria-pressed={isPrimaryDay}
              onClick={() => selectDay(card.date)}
              className={`px-2 py-1 ${isPrimaryDay ? "bg-slate-100 font-medium text-slate-700 dark:bg-ink-800 dark:text-slate-100" : "text-slate-500 dark:text-slate-400"}`}
            >
              {card.dateLabel}
            </button>
            <button
              type="button"
              data-testid="symptom-day-alt"
              aria-pressed={!isPrimaryDay}
              onClick={() => selectDay(card.altDate!)}
              className={`px-2 py-1 ${!isPrimaryDay ? "bg-slate-100 font-medium text-slate-700 dark:bg-ink-800 dark:text-slate-100" : "text-slate-500 dark:text-slate-400"}`}
            >
              {card.altDateLabel}
            </button>
          </div>
        )}
      </div>

      {pickerOpen && (
        <div
          id="symptom-add-picker"
          data-testid="symptom-add-picker"
          className="subpanel-inset-sm mb-3 rounded-lg border border-black/5 p-3 dark:border-white/5"
        >
          {textIntakeEnabled && (
            <div
              data-testid="symptom-text-intake"
              className="mb-3 border-b border-black/5 pb-3 dark:border-white/5"
            >
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void suggestFromText();
                }}
              >
                <input
                  data-testid="symptom-text-input"
                  value={intakeText}
                  onChange={(e) => {
                    setIntakeText(e.target.value);
                    if (intakeError) setIntakeError(null);
                  }}
                  placeholder="Describe it: “fever since lunch, croupy cough”…"
                  maxLength={500}
                  className="input flex-1 text-sm"
                />
                <Button
                  type="submit"
                  data-testid="symptom-text-suggest"
                  disabled={intakePending || intakeText.trim() === ""}
                >
                  {intakePending ? "Reading…" : "Suggest"}
                </Button>
              </form>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Review the suggestions and confirm — nothing is logged until you
                do.
              </p>

              {intakeError && (
                <p
                  role="alert"
                  data-testid="symptom-text-error"
                  className="mt-1 text-xs text-rose-600 dark:text-rose-400"
                >
                  {intakeError}
                </p>
              )}

              {intakeStaged && (
                <div
                  data-testid="symptom-text-staged"
                  className="mt-2 space-y-1.5"
                >
                  {intakeStaged.symptoms.map((s, idx) => (
                    <div
                      key={`${s.slug}-${idx}`}
                      data-testid={`symptom-text-staged-${idx}`}
                      className="flex items-center gap-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
                        {s.label}
                        {s.isCustom && (
                          <span className="ml-1 text-xs text-slate-400">
                            (new)
                          </span>
                        )}
                      </span>
                      {/* `gap-3` is the reach floor (#3938). */}
                      <div className="flex items-center gap-3">
                        <SymptomSeverityControl
                          symptomLabel={s.label}
                          value={s.severity}
                          onChange={(severity) =>
                            setStagedSeverity(idx, severity)
                          }
                        />
                        <IconButton
                          type="button"
                          label={`Remove ${s.label} suggestion`}
                          onClick={() => dropStaged(idx)}
                        >
                          <IconX className="h-3.5 w-3.5" />
                        </IconButton>
                      </div>
                    </div>
                  ))}

                  {intakeStaged.temperature && (
                    <div className="text-xs text-slate-600 dark:text-slate-300">
                      🌡️ Temperature {intakeStaged.temperature.value}°
                      {intakeStaged.temperature.unit} — will be logged
                    </div>
                  )}

                  {intakeStaged.unmapped.map((u, idx) => (
                    <div
                      key={`unmapped-${idx}`}
                      className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        Couldn&apos;t map: “{u}”
                      </span>
                      <Button
                        type="button"
                        onClick={() => {
                          void tap(u, 1);
                          dropUnmapped(idx);
                        }}
                      >
                        + Add as custom
                      </Button>
                    </div>
                  ))}

                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      type="button"
                      data-testid="symptom-text-confirm"
                      disabled={
                        intakePending ||
                        (intakeStaged.symptoms.length === 0 &&
                          !intakeStaged.temperature)
                      }
                      onClick={() => void confirmIntake()}
                    >
                      {intakePending ? "Logging…" : "Confirm & log"}
                    </Button>
                    <Button
                      type="button"
                      data-testid="symptom-text-cancel"
                      onClick={() => setIntakeStaged(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            {pickerKeys.map((key) => {
              const r = rowMap.get(key);
              if (!r) return null;
              return (
                <Button
                  key={key}
                  type="button"
                  data-testid={`symptom-pick-${key}`}
                  onClick={() => void tap(key, 1)}
                >
                  {r.icon && <span aria-hidden>{r.icon} </span>}
                  {r.label}
                </Button>
              );
            })}
          </div>
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addCustom();
            }}
          >
            {/* The curated labels (#1676). resolveSymptomKey() already collapses an
                EXACT label onto its catalog slug, but a near-miss ("Head ache")
                minted a custom key sitting next to the curated `headache`; offering
                the vocabulary turns those near-misses into exact matches. Free text
                still logs — a custom symptom is a first-class one. */}
            <div className="flex-1" data-testid="symptom-custom-input">
              <Combobox
                ariaLabel="Add another symptom"
                value={customDraft}
                onChange={setCustomDraft}
                onPick={(v) => addCustom(v)}
                options={SYMPTOM_LABEL_OPTIONS}
                allowFreeText
                closeStopsPropagation
                placeholder="Add another symptom…"
                inputClassName="h-8 text-sm"
              />
            </div>
            <IconButton
              type="submit"
              data-testid="symptom-custom-add"
              label="Add symptom"
            >
              <IconPlus className="h-3.5 w-3.5" />
            </IconButton>
          </form>
        </div>
      )}

      {suggestActivateIllness && (
        <div
          data-testid="symptom-illness-bridge"
          className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
        >
          <span>Tracking an illness?</span>
          <button
            type="button"
            data-testid="symptom-illness-bridge-activate"
            // THE SUBJECT RIDES THE BRIDGE (#4712), through `withTarget` — the same
            // stamp every symptom and temperature this bar posts carries, rather
            // than a second hand-written copy of it. Without it, a household
            // member's bar would open an episode for the CAREGIVER.
            onClick={() =>
              startTransition(() => void openIllnessEpisode("bridge"))
            }
            className="btn-ghost btn-sm border-dashed"
          >
            + Mark as illness
          </button>
          {activationError?.where === "bridge" && (
            <p
              role="alert"
              data-testid="symptom-illness-bridge-error"
              className="w-full text-rose-600 dark:text-rose-400"
            >
              {activationError.message}
            </p>
          )}
        </div>
      )}

      {showTemperature && tempOpen && (
        <>
          <form
            id="temp-quick-entry"
            data-testid="temp-quick-entry"
            onSubmit={(event) => void logTemp(event)}
            className="subpanel-inset-sm mb-3 rounded-lg border border-black/5 p-3 dark:border-white/5"
          >
            <label className="label mb-1 block" htmlFor="temp-quick-input">
              Temperature
            </label>
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-40 flex-1">
                {/* THE VITALS FORM'S FIELD (#4424 ruling 5), not a second drawing of it. */}
                <TemperatureField
                  id="temp-quick-input"
                  testIdPrefix="temp-quick"
                  detection={tempUnitDetection}
                  unitLabel="Temperature unit"
                  required
                  autoFocus
                />
              </div>
              <WhenControl
                mode="state"
                grain="minute"
                value={tempWhen}
                onChange={setTempWhen}
                tz={timeZone}
                // ONE DAY, the day the bar is standing on: a reading is filed against
                // the day the toggle is showing, so the control renders it as text and
                // the pair rule holds with nothing to enforce.
                minDate={activeDate}
                maxDate={activeDate}
                // A past day has no "now" to fall back to (#4685), so the minute is
                // required there and optional on today.
                timeRequired={!isPrimaryDay}
                timeLabel="Reading time"
                testId="temp-quick"
              />
              <SubmitButton
                data-testid="temp-quick-save"
                disabled={tempPending}
              >
                {tempPending ? "Logging…" : "Log temp"}
              </SubmitButton>
            </div>
            {tempError && (
              <p
                role="alert"
                data-testid="temp-quick-error"
                className="mt-1 text-xs text-rose-600 dark:text-rose-400"
              >
                {tempError}
              </p>
            )}
          </form>

          {/* THE OFFER (#4712 judgement 1) — UNDER the reading, inside the SAME
              fold: it renders only while `tempOpen` holds, so the enclosing
              condition is this block's whole lifetime, never a second copy of it.
              No toast, no persistent nudge (StaleEpisodeNudge or otherwise) —
              this is the one and only place the episode/dose offer appears. */}
          {feverOffer && (
            <div
              data-testid="fever-offer"
              className="subpanel-inset-sm mb-3 rounded-lg border border-black/5 p-3 dark:border-white/5"
            >
              <p
                data-testid="fever-offer-sentence"
                className="text-sm text-slate-700 dark:text-slate-200"
              >
                That’s a fever — {fmtTemp(feverOffer.degF, temperatureUnit)}.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {/* PRIMARY, beside the dose (#4712 judgement 1's row grammar) —
                    omitted only when this write already names an open episode,
                    so the offer never asks to open the one it is already in. */}
                {!hasOpenEpisode && (
                  <Button
                    variant="primary"
                    data-testid="fever-offer-open-episode"
                    disabled={episodeOfferPending}
                    onClick={acceptEpisodeOffer}
                  >
                    Open an episode
                  </Button>
                )}
                {offersDose && intakeContext && nowIso && (
                  <div data-testid="fever-offer-dose" className="min-w-0">
                    {/* THE DOSE REUSES IllnessMedicationLogger (#4834), narrowed
                        to fever reducers — never a second dose control spelled
                        here (08:24 audit on #4712). */}
                    <IllnessMedicationLogger
                      meds={antipyreticMeds}
                      tz={timeZone ?? tempZone}
                      profileId={profileId}
                      intakeContext={intakeContext}
                      canAdd={false}
                      nowIso={nowIso}
                      // TAKEN ENDS THE OFFER (#4712 ruling part 2's own words). The
                      // dose is on the ledger and the host's Meds chip comes straight
                      // back; the fold itself stays open, exactly as accepting the
                      // episode half leaves it.
                      onLogged={() => showFeverOffer(null)}
                    />
                  </div>
                )}
              </div>
              {/* THE FAILURE IS STATED AND THE BLOCK STAYS (#4962) — the write's
                  own answer, not an assumption that it worked. */}
              {activationError?.where === "offer" && (
                <p
                  role="alert"
                  data-testid="fever-offer-error"
                  className="mt-2 text-xs text-rose-600 dark:text-rose-400"
                >
                  {activationError.message}
                </p>
              )}
              {/* A LINK, NOT A THIRD BUTTON (#4712 judgement 1's row grammar). */}
              <button
                type="button"
                data-testid="fever-offer-dismiss"
                onClick={dismissFeverOffer}
                className="tap-target mt-2 inline-flex min-h-(--control-box) items-center text-sm text-link"
              >
                Not now
              </button>
            </div>
          )}
        </>
      )}

      {/* Picker guidance stays with the expanded picker instead of occupying the
          collapsed logger (#857). */}
      {pickerOpen && (
        <p
          data-testid="symptom-severity-legend"
          className="mb-3 text-xs text-slate-500 dark:text-slate-400"
        >
          Choose 1 (mild) to {MAX_SYMPTOM_SEVERITY} (very severe). The highest
          level logged for the day is kept.
        </p>
      )}

      {loggedCount > 0 && (
        <ul className="space-y-2" data-testid="symptom-logged-list">
          {loggedKeys.map((key) => {
            const r = rowMap.get(key);
            if (!r) return null;
            const sev = severities[key] ?? 0;
            const note = notes[key] ?? "";
            return (
              <li
                key={key}
                data-testid={`symptom-${key}`}
                className="subpanel-inset-sm rounded-lg border border-black/5 p-3 dark:border-white/5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-slate-800 dark:text-slate-100">
                    {r.icon && <span aria-hidden>{r.icon}</span>}
                    <span className="truncate">{r.label}</span>
                  </span>
                  {/* THE DOMAIN'S ONE ROW CONTROL (#4424 ruling 3). The bar owns which
                      rows are logged; the control owns what each one's taps write. */}
                  <SymptomRowControl
                    symptom={key}
                    label={r.label}
                    date={activeDate}
                    severity={sev}
                    note={note}
                    subjectProfileId={profileId}
                    episodeId={episodeId}
                    onSeverity={(value) => setSeverity(key, value)}
                    onNote={(value) => setNote(key, value)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
