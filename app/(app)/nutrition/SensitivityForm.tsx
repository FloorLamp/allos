"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import Button from "@/components/Button";
import { useToast } from "@/components/Toast";
import type { CatalogFormCallbacks } from "@/components/CatalogEditor";
import FactEditorHost, {
  useFactEditor,
} from "@/components/facts/FactEditorHost";
import RecordFactRow, {
  RecordFactMoreMenu,
} from "@/components/records/RecordFactRow";
import InlineError from "@/components/InlineError";
import { FOOD_GROUPS } from "@/lib/food-groups";
import { GI_EFFECTS } from "@/lib/gi-effects";
import {
  MEAL_PROPERTIES,
  type FoodSensitivity,
  type FoodSensitivityTriggerKind,
} from "@/lib/food-sensitivities";
import {
  foodSensitivityFactSummary,
  FOOD_SENSITIVITY_FACT_NOUNS,
  type FoodSensitivityFactKey,
} from "@/lib/food-sensitivity-facts";
import {
  createFoodSensitivityAction,
  updateFoodSensitivityAction,
} from "./sensitivity-actions";

// The `Add sensitivity` form (#5865), on the facts-with-editors primitive (#3218) and
// the one form grammar (#5300, entry `food-sensitivity`).
//
// THE TRIGGER IS RULE 1's IDENTIFYING FIELD, above the chips and always open: it is
// what the declaration IS, and it is also the one thing here that cannot be defaulted.
// The effect is the single chip, the note lives behind the trailing affordance, and
// Save is the form's one commit.
//
// ONE SELECT OVER TWO VOCABULARIES, and the optgroups are what keep them apart on
// screen. A meal PROPERTY (spicy, high fat) is marked on the meal when you log it; a
// food GROUP is already in your food log and needs no mark at all. The value carries
// the kind with the slug so the two lists can share one control without the form having
// to guess which vocabulary a slug came from — a `dairy` property and a `dairy` group
// would be the same string otherwise.
//
// NOT DOM-COLLECTED. This form is hosted by the catalog dialog (#5237), which wants a
// pending signal and a saved item back rather than a `<form action>` posting FormData,
// so the state is React's and the editors are unmounted rather than hidden. Nothing
// here needs the hidden-field discipline the record forms carry: there are three values
// and they all live in this component.

export interface SensitivityFormProps {
  sensitivity?: FoodSensitivity;
}

type Panel = FoodSensitivityFactKey | "more";

interface TriggerOption {
  kind: FoodSensitivityTriggerKind;
  slug: string;
  label: string;
}

const encode = (kind: FoodSensitivityTriggerKind, slug: string) =>
  slug ? `${kind}:${slug}` : "";

function decode(value: string): {
  kind: FoodSensitivityTriggerKind;
  slug: string;
} {
  const [kind, ...rest] = value.split(":");
  return {
    kind: kind === "group" ? "group" : "property",
    slug: rest.join(":"),
  };
}

export default function SensitivityForm({
  sensitivity,
  onSaved,
  onCancel,
  onPendingChange,
}: SensitivityFormProps & CatalogFormCallbacks<FoodSensitivity>) {
  const initialTrigger = sensitivity
    ? encode(sensitivity.trigger_kind, sensitivity.trigger_slug)
    : "";
  const [trigger, setTrigger] = useState(initialTrigger);
  const [effect, setEffect] = useState(sensitivity?.effect ?? "");
  const [note, setNote] = useState(sensitivity?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const scopeRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const toast = useToast();
  const editor = useFactEditor<Panel>({ scopeRef });

  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  const properties: TriggerOption[] = MEAL_PROPERTIES.map((p) => ({
    kind: "property",
    slug: p.slug,
    label: p.label,
  }));
  // The curated food-group catalog is pure and client-safe by contract
  // (lib/food-groups.ts), so the form reads it rather than having 25 names passed
  // down through the section that renders it.
  const groupOptions: TriggerOption[] = FOOD_GROUPS.map((g) => ({
    kind: "group",
    slug: g.slug,
    label: g.name,
  }));

  const summary = foodSensitivityFactSummary({ effect, note });

  // THE DIALOG MUST BE ABLE TO ASK BEFORE IT THROWS THIS AWAY (#3356). The registry
  // sees `<form>` elements; this is a div, so it answers for itself — without the
  // declaration, closing the dialog over a half-written declaration discards it with
  // nothing asking.
  const dirty =
    trigger !== initialTrigger ||
    effect !== (sensitivity?.effect ?? "") ||
    note !== (sensitivity?.note ?? "");

  function save() {
    if (!trigger) {
      setError("Pick what sets it off.");
      return;
    }
    if (!effect) {
      setError("Pick the effect.");
      editor.open("effect");
      return;
    }
    setError(null);
    const { kind, slug } = decode(trigger);
    const input = {
      trigger_kind: kind,
      trigger_slug: slug,
      effect,
      note,
    };
    startTransition(async () => {
      try {
        if (sensitivity) {
          const result = await updateFoodSensitivityAction(
            sensitivity.id,
            input
          );
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast("Sensitivity updated");
          onSaved({
            ...sensitivity,
            trigger_kind: kind,
            trigger_slug: slug,
            effect,
            note: note.trim() || null,
          });
        } else {
          const result = await createFoodSensitivityAction(input);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast("Sensitivity saved");
          onSaved(result.sensitivity);
        }
      } catch {
        setError("Couldn’t save this sensitivity. Try again.");
      }
    });
  }

  return (
    <div
      ref={scopeRef}
      data-unsaved={dirty ? "true" : "false"}
      onKeyDown={editor.onKeyDown}
      className="space-y-3"
      data-testid="sensitivity-form"
    >
      <div>
        <label className="label" htmlFor={`sens-trigger-${uid}`}>
          After
        </label>
        <select
          id={`sens-trigger-${uid}`}
          className="input"
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
        >
          <option value="">Choose a trigger</option>
          <optgroup label="A property of the meal">
            {properties.map((o) => (
              <option key={o.slug} value={encode(o.kind, o.slug)}>
                {o.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="A food group you log">
            {groupOptions.map((o) => (
              <option key={o.slug} value={encode(o.kind, o.slug)}>
                {o.label}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      {/* THE SENTENCE, and the one open editor behind it (#3218). */}
      {editor.openEditor == null && (
        <RecordFactRow
          prefix="sensitivity"
          summary={summary}
          nouns={FOOD_SENSITIVITY_FACT_NOUNS}
          openEditor={editor.openEditor}
          onOpen={(panel, focusKey) => editor.open(panel as Panel, focusKey)}
        />
      )}

      {editor.openEditor != null && (
        <FactEditorHost
          testId="sensitivity-editor"
          doneTestId="sensitivity-editor-done"
          panel={editor.openEditor}
          onDone={editor.close}
          bodyClassName="space-y-3"
        >
          {editor.openEditor === "effect" && (
            <div>
              <label className="label" htmlFor={`sens-effect-${uid}`}>
                Effect
              </label>
              {/* ONE SHARED VOCABULARY (lib/gi-effects.ts): the same set the fiber ×
                  GI panel marks, so a sensitivity can never name an effect the app
                  has no way to read back. */}
              <select
                id={`sens-effect-${uid}`}
                className="input"
                autoFocus
                value={effect}
                onChange={(e) => setEffect(e.target.value)}
              >
                <option value="">Choose an effect</option>
                {GI_EFFECTS.map((e) => (
                  <option key={e.slug} value={e.slug}>
                    {e.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {editor.openEditor === "note" && (
            <div>
              <label className="label" htmlFor={`sens-note-${uid}`}>
                Note
              </label>
              <input
                id={`sens-note-${uid}`}
                className="input"
                value={note}
                placeholder="e.g. only the very hot ones"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          )}
          {editor.openEditor === "more" && (
            <RecordFactMoreMenu
              prefix="sensitivity"
              more={summary.more}
              nouns={FOOD_SENSITIVITY_FACT_NOUNS}
              onOpen={(panel) => editor.open(panel as Panel)}
            />
          )}
        </FactEditorHost>
      )}

      <InlineError>{error}</InlineError>
      {/* The form's one commit, full width — this dialog has a single primary act and
          nothing to weigh it against (#5300 rule 6). Cancel stays quiet beside it. */}
      <div className="grid w-full gap-2">
        <Button
          variant="primary"
          onClick={save}
          disabled={pending}
          data-testid="sensitivity-save"
        >
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
