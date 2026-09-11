"use client";

import { useLayoutEffect, useReducer, useRef } from "react";
import { logMood } from "@/app/(app)/mood-actions";
import Chip from "@/components/Chip";
import Disclosure from "@/components/Disclosure";
import { useOptionalDayContext } from "@/components/DayContext";
import MoodValencePicker from "@/components/MoodValencePicker";
import IconButton from "@/components/IconButton";
import {
  useOfflineQueue,
  useQueuedDayContextCapture,
  type QueuedCapture,
} from "@/components/OfflineQueueProvider";
import { useToast } from "@/components/Toast";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import {
  ANXIETY_CALM_HIGH_LABEL,
  ANXIETY_CALM_LOW_LABEL,
  MOOD_FACTORS,
  anxietyDisplaySlot,
  anxietyStoredValue,
  moodLabel,
} from "@/lib/mood";
import {
  OFFLINE_CAPTURE_REFUSED_MESSAGE,
  shouldQueueOffline,
} from "@/lib/offline/queue";
import FormDismissAction from "@/components/FormDismissAction";
import SubmitButton from "@/components/SubmitButton";
import { TAP_REACH } from "@/lib/log-manifest";

export interface MoodFormValue {
  valence: number;
  energy: number | null;
  anxiety: number | null;
  factors: string[];
  notes: string | null;
}

export interface MoodFormDay {
  date: string;
  label: string;
  mood: MoodFormValue | null;
}

type MoodDraftValues = Omit<MoodFormValue, "valence"> & {
  valence: number | null;
};

type MoodField = keyof MoodDraftValues;
type MoodTouched = Record<MoodField, boolean>;
type MoodError = { kind: "write" | "reach"; message: string } | null;
type MoodTouchAction = {
  [K in MoodField]: { kind: "touch"; field: K; value: MoodDraftValues[K] };
}[MoodField];

interface MoodAttempt {
  readonly id: number;
  readonly ledgerKey: string;
  readonly date: string;
  readonly label: string;
  readonly values: MoodFormValue;
  readonly dayUnseen: boolean;
  readonly subjectProfileId?: number;
  readonly dateReach: "tap" | "dated";
  readonly capture: QueuedCapture | null;
  readonly presentation: number;
}

interface MoodControllerState {
  readonly date: string | null;
  readonly label: string;
  readonly values: MoodDraftValues;
  readonly touched: MoodTouched;
  readonly complete: boolean;
  readonly error: MoodError;
  readonly attempt: MoodAttempt | null;
  readonly version: number;
}

type MoodControllerAction =
  | {
      kind: "reconcile";
      days: readonly MoodFormDay[];
      selectedDate: string | null;
      complete: boolean;
    }
  | MoodTouchAction
  | { kind: "start"; attempt: MoodAttempt }
  | { kind: "failed"; id: number; message: string }
  | { kind: "finished"; id: number }
  | { kind: "retire"; id: number }
  | { kind: "reset" };

const UNTOUCHED: MoodTouched = {
  valence: false,
  energy: false,
  anxiety: false,
  factors: false,
  notes: false,
};

const ALL_TOUCHED: MoodTouched = {
  valence: true,
  energy: true,
  anxiety: true,
  factors: true,
  notes: true,
};

function rowValues(row: MoodFormDay | undefined): MoodDraftValues {
  return {
    valence: row?.mood?.valence ?? null,
    energy: row?.mood?.energy ?? null,
    anxiety: row?.mood?.anxiety ?? null,
    factors: row?.mood?.factors ?? [],
    notes: row?.mood?.notes ?? null,
  };
}

function initialController(
  days: readonly MoodFormDay[],
  selectedDate: string | null,
  complete: boolean
): MoodControllerState {
  const selected = days.find((entry) => entry.date === selectedDate) ?? days[0];
  return {
    date: selected?.date ?? null,
    label: selected?.label ?? "that day",
    values: rowValues(selected),
    touched: UNTOUCHED,
    complete,
    error: null,
    attempt: null,
    version: 0,
  };
}

function moodController(
  state: MoodControllerState,
  action: MoodControllerAction
): MoodControllerState {
  switch (action.kind) {
    case "reconcile": {
      const selected = action.days.find(
        (entry) => entry.date === action.selectedDate
      );
      const fallback = selected ?? action.days[0];
      if (!fallback) return state;
      if (fallback.date !== state.date) {
        return {
          ...initialController(action.days, fallback.date, action.complete),
          error:
            state.date == null
              ? null
              : {
                  kind: "reach",
                  message:
                    "That day is no longer available. Your draft was reset to the offered day.",
                },
          attempt: state.attempt,
        };
      }
      const fresh = rowValues(fallback);
      return {
        ...state,
        label: fallback.label,
        values: {
          valence: state.touched.valence ? state.values.valence : fresh.valence,
          energy: state.touched.energy ? state.values.energy : fresh.energy,
          anxiety: state.touched.anxiety ? state.values.anxiety : fresh.anxiety,
          factors: state.touched.factors ? state.values.factors : fresh.factors,
          notes: state.touched.notes ? state.values.notes : fresh.notes,
        },
        // Once an authoritative row (including an authoritative absence) has been
        // incorporated, a later held/device copy cannot make the draft blind again.
        complete: state.complete || action.complete,
      };
    }
    case "touch":
      return {
        ...state,
        values: { ...state.values, [action.field]: action.value },
        touched: { ...state.touched, [action.field]: true },
      };
    case "start":
      return {
        ...state,
        values: action.attempt.values,
        touched: { ...state.touched, valence: true },
        error: state.error?.kind === "reach" ? state.error : null,
        attempt: action.attempt,
      };
    case "failed":
      return state.attempt?.id === action.id
        ? {
            ...state,
            error: { kind: "write", message: action.message },
            attempt: null,
          }
        : state;
    case "finished":
      return state.attempt?.id === action.id
        ? { ...state, attempt: null, error: null }
        : state;
    case "retire":
      return state.attempt?.id === action.id
        ? { ...state, attempt: null }
        : state;
    case "reset":
      return {
        ...state,
        values: rowValues(undefined),
        // A repeat History entry starts from an intentionally blank local draft.
        // Own those blanks so the refresh triggered by the prior save cannot refill
        // them from the row that was just written.
        touched: ALL_TOUCHED,
        complete: true,
        error: null,
        attempt: null,
        version: state.version + 1,
      };
  }
}

function ScaleRow({
  name,
  value,
  onPick,
  testPrefix,
  lowLabel,
  highLabel,
}: {
  name: string;
  value: number | null;
  onPick: (value: number) => void;
  testPrefix: string;
  lowLabel: string;
  highLabel: string;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-2">
      <legend className="label w-16">{name}</legend>
      <span className="text-xs text-slate-400">{lowLabel}</span>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((score) => (
          <IconButton
            key={score}
            data-testid={`${testPrefix}-${score}`}
            label={`${name}: ${score}`}
            pressed={value === score}
            onClick={() => onPick(score)}
          >
            {score}
          </IconButton>
        ))}
      </div>
      <span className="text-xs text-slate-400">{highLabel}</span>
    </fieldset>
  );
}

// The mood domain's ONE form (#4424): one-tap valence and the full daily statement
// share the same state, payload, offline capture and optional write subject. The
// mounting context declares whether a rating is a quick write or local edit state;
// history add is deliberately a single dated day that remains quick-entry capable.
export default function MoodForm({
  days,
  showCalm,
  dayUnseen = false,
  subjectProfileId,
  dateReach = "tap",
  mode = "quick",
  repeatAfterSave = false,
  onSaved,
  onDone,
  onCancel,
}: {
  days: readonly MoodFormDay[];
  showCalm: boolean;
  dayUnseen?: boolean;
  subjectProfileId?: number;
  dateReach?: "tap" | "dated";
  mode?: "quick" | "edit";
  repeatAfterSave?: boolean;
  onSaved?: () => void;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const toast = useToast();
  const dayContext = useOptionalDayContext();
  const { enqueue } = useOfflineQueue();
  const captureDayContext = useQueuedDayContextCapture();
  const ledger = useOptimisticLedger<void>("mood-valence");
  const selectedDate = dayContext?.parts.day ?? days[0]?.date ?? null;
  const [controller, dispatch] = useReducer(
    moodController,
    initialController(days, selectedDate, !dayUnseen)
  );
  const attemptId = useRef(0);
  const writing = useRef(false);
  const presentation = useRef(0);
  const offeredDate =
    days.find((entry) => entry.date === selectedDate)?.date ??
    days[0]?.date ??
    "missing";
  const presentationIdentity = `${dayContext?.key ?? "unscoped"}:${subjectProfileId ?? "acting"}:${dateReach}:${offeredDate}`;
  useLayoutEffect(() => {
    const token = ++presentation.current;
    return () => {
      if (presentation.current === token) presentation.current += 1;
    };
  }, [presentationIdentity]);
  useLayoutEffect(() => {
    dispatch({
      kind: "reconcile",
      days,
      selectedDate,
      complete: !dayUnseen,
    });
  }, [days, selectedDate, dayUnseen]);

  const busy = controller.attempt != null;
  const { valence, energy, anxiety, factors, notes } = controller.values;

  function complete(attempt: MoodAttempt, message?: string): void {
    if (attempt.presentation !== presentation.current) return;
    dispatch({ kind: "finished", id: attempt.id });
    writing.current = false;
    toast(
      message ??
        `Logged ${moodLabel(attempt.values.valence)} · ${attempt.label}`
    );
    onSaved?.();
    if (repeatAfterSave) dispatch({ kind: "reset" });
    else onDone?.();
  }

  function payload(attempt: MoodAttempt): FormData {
    const fd = new FormData();
    fd.set("date", attempt.date);
    fd.set("valence", String(attempt.values.valence));
    if (attempt.values.energy != null)
      fd.set("energy", String(attempt.values.energy));
    if (attempt.values.anxiety != null)
      fd.set("anxiety", String(attempt.values.anxiety));
    for (const factor of attempt.values.factors) fd.append("factors", factor);
    if (attempt.values.notes) fd.set("note", attempt.values.notes);
    if (attempt.dayUnseen) fd.set("day_unseen", "1");
    if (attempt.subjectProfileId != null)
      fd.set("profile_id", String(attempt.subjectProfileId));
    fd.set("date_reach", attempt.dateReach);
    return fd;
  }

  async function queueIfOffline(
    err: unknown,
    attempt: MoodAttempt
  ): Promise<"not-offline" | "refused" | "queued"> {
    // The queue is stamped to the acting profile and carries no subject. A record-row
    // correction posts its subject and therefore must fail honestly rather than queue
    // a write that could replay onto somebody else.
    if (
      attempt.subjectProfileId != null ||
      !shouldQueueOffline(
        typeof navigator === "undefined" ? true : navigator.onLine,
        err
      )
    ) {
      return "not-offline";
    }
    let outcome: "kept" | "closed" | "failed";
    if (!attempt.capture) return "refused";
    try {
      outcome = await enqueue(
        "mood",
        {
          valence: attempt.values.valence,
          energy: attempt.values.energy,
          anxiety: attempt.values.anxiety,
          factors: attempt.values.factors,
          note: attempt.values.notes,
          ...(attempt.dayUnseen ? { dayUnseen: true as const } : {}),
        },
        attempt.capture
      );
    } catch {
      outcome = "failed";
    }
    if (outcome !== "kept") {
      return "refused";
    }
    return "queued";
  }

  function submit(nextValence: number): void {
    if (controller.date == null || writing.current) return;
    const ledgerKey = `${controller.date}:${nextValence}:${controller.version}`;
    if (ledger.blocked(ledgerKey)) return;
    if (mode === "edit") {
      dispatch({ kind: "touch", field: "valence", value: nextValence });
    }
    writing.current = true;
    const values: MoodFormValue = {
      ...controller.values,
      valence: nextValence,
      notes: controller.values.notes?.trim() || null,
    };
    const attempt: MoodAttempt = {
      id: ++attemptId.current,
      ledgerKey,
      date: controller.date,
      label: controller.label,
      values,
      dayUnseen: !controller.complete,
      subjectProfileId,
      dateReach,
      capture: captureDayContext(controller.date, TAP_REACH["mood-valence"]),
      presentation: presentation.current,
    };
    dispatch({ kind: "start", attempt });
    void ledger
      .tap({
        key: attempt.ledgerKey,
        write: async () => {
          if (attempt.capture) await attempt.capture.writeToken;
          return logMood(payload(attempt));
        },
        settle: (result) => {
          if (attempt.presentation !== presentation.current)
            return { kind: "rollback" };
          if (!result.ok) {
            dispatch({ kind: "failed", id: attempt.id, message: result.error });
            writing.current = false;
            return { kind: "rollback" };
          }
          complete(attempt);
          return { kind: "keep" };
        },
        onError: async (err) => {
          const queued = await queueIfOffline(err, attempt);
          // Persistence belongs to the captured attempt even if its sheet has moved;
          // only presentation is suppressed for an obsolete lifetime.
          if (attempt.presentation !== presentation.current)
            return queued === "queued"
              ? { kind: "keep" }
              : { kind: "rollback" };
          if (queued === "queued") {
            complete(attempt, "Saved offline — will sync when you reconnect.");
            return { kind: "keep" };
          }
          if (queued === "refused")
            toast(OFFLINE_CAPTURE_REFUSED_MESSAGE, { tone: "error" });
          dispatch({
            kind: "failed",
            id: attempt.id,
            message:
              queued === "refused"
                ? OFFLINE_CAPTURE_REFUSED_MESSAGE
                : "Couldn't save that check-in — try again.",
          });
          writing.current = false;
          return { kind: "rollback" };
        },
      })
      .finally(() => {
        writing.current = false;
        dispatch({ kind: "retire", id: attempt.id });
      });
  }

  function tap(nextValence: number): void {
    if (mode === "edit") {
      dispatch({ kind: "touch", field: "valence", value: nextValence });
      return;
    }
    submit(nextValence);
  }

  function toggleFactor(slug: string): void {
    dispatch({
      kind: "touch",
      field: "factors",
      value: factors.includes(slug)
        ? factors.filter((factor) => factor !== slug)
        : [...factors, slug],
    });
  }

  return (
    <form
      className="space-y-3"
      data-testid="mood-form"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (valence != null) submit(valence);
      }}
    >
      {/* One write snapshots the whole statement and its date. Freeze that whole
          transaction boundary until it settles so the visible draft cannot move
          beyond the payload already in flight or receive a rollback for another day. */}
      <fieldset
        className="min-w-0 space-y-3"
        data-testid="mood-form-controls"
        disabled={busy}
      >
        <div className="flex flex-wrap items-center gap-2">
          <MoodValencePicker
            value={valence}
            onChange={tap}
            disabled={busy}
            testIdPrefix="quick-mood-tap"
          />
          <span
            className="text-xs text-slate-500 dark:text-slate-400"
            data-testid="quick-mood-status"
          >
            {valence != null ? moodLabel(valence) : "Tap to log that day."}
          </span>
        </div>

        <Disclosure data-testid="mood-details">
          <summary className="fold-control text-sm font-medium text-link">
            Details
          </summary>
          <div className="mt-3 space-y-3">
            <ScaleRow
              name="Energy"
              value={energy}
              onPick={(score) =>
                dispatch({
                  kind: "touch",
                  field: "energy",
                  value: energy === score ? null : score,
                })
              }
              testPrefix="mood-energy"
              lowLabel="drained"
              highLabel="energized"
            />
            {showCalm ? (
              <ScaleRow
                name="Calm"
                value={anxiety == null ? null : anxietyDisplaySlot(anxiety)}
                onPick={(score) => {
                  const stored = anxietyStoredValue(score);
                  dispatch({
                    kind: "touch",
                    field: "anxiety",
                    value: anxiety === stored ? null : stored,
                  });
                }}
                testPrefix="mood-anxiety"
                lowLabel={ANXIETY_CALM_LOW_LABEL}
                highLabel={ANXIETY_CALM_HIGH_LABEL}
              />
            ) : null}
            <fieldset>
              <legend className="label mb-1">What’s going on?</legend>
              <div className="flex flex-wrap gap-1.5 pointer-coarse:gap-3.5">
                {MOOD_FACTORS.map((factor) => (
                  <Chip
                    key={factor.slug}
                    role="filter"
                    pressed={factors.includes(factor.slug)}
                    onClick={() => toggleFactor(factor.slug)}
                  >
                    {factor.label}
                  </Chip>
                ))}
              </div>
            </fieldset>
            <label className="label block">
              Note
              <textarea
                className="input mt-1 min-h-20"
                value={notes ?? ""}
                maxLength={500}
                onChange={(event) =>
                  dispatch({
                    kind: "touch",
                    field: "notes",
                    value: event.target.value,
                  })
                }
              />
            </label>
            <div className="flex flex-col items-stretch gap-1">
              <SubmitButton
                variant="primary"
                layout="block"
                disabled={busy || valence == null}
              >
                {busy ? "Saving…" : "Save"}
              </SubmitButton>
              {onCancel ? (
                <FormDismissAction disabled={busy} onClick={onCancel}>
                  Cancel
                </FormDismissAction>
              ) : null}
            </div>
          </div>
        </Disclosure>

        {controller.error ? (
          <p className="text-xs text-rose-600" role="alert">
            {controller.error.message}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}
