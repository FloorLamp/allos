"use client";

import { useState } from "react";
import Combobox from "@/components/Combobox";
import { useSituationOptions } from "@/components/SituationOptionsContext";
import { FOOD_TIMINGS, FOOD_TIMING_LABELS } from "@/lib/intake-schedule";
import {
  INTAKE_RULE_MENU_LABELS,
  INTAKE_RULE_TYPES,
  nextRuleId,
  type IntakeRule,
  type IntakeRuleType,
} from "@/lib/intake-rules";
import type { FoodTiming } from "@/lib/types";

// The rules builder (#3216 decision 4): five sentences over columns that already
// exist. Each row reads as the sentence it becomes, with its blanks as controls —
// "Take only when [illness]", "Keep [2] h apart from [Iron]" — because a rule the
// person can read back is a rule they can correct, and the previous shape (a
// condition select here, a pause combobox there, a pairs repeater at the bottom)
// never said out loud that those three were the same kind of thing.
//
// SUGGESTED RULES ARE AN OFFER (#1505). A seeded rule arrives marked and deletable
// and is written only because it was still there when Save was pressed.

function newRule(type: IntakeRuleType, firstOtherId: number): IntakeRule {
  const id = nextRuleId();
  switch (type) {
    case "only-when":
      return { id, type, situation: "" };
    case "pause-while":
      return { id, type, situation: "" };
    case "food":
      return { id, type, timing: "with_food" };
    case "keep-apart":
      return { id, type, otherId: firstOtherId, hours: null, note: "" };
    case "take-together":
      return { id, type, otherId: firstOtherId, note: "" };
  }
}

export default function IntakeRulesEditor({
  rules,
  setRules,
  others,
}: {
  rules: IntakeRule[];
  setRules: (next: IntakeRule[]) => void;
  others: { id: number; name: string }[];
}) {
  const situationOptions = useSituationOptions();
  const [adding, setAdding] = useState(false);
  const firstOtherId = others[0]?.id ?? 0;
  // A pair needs something to pair WITH, so those two sentences are offered only
  // when the profile has another item; the rest always apply.
  const offered = INTAKE_RULE_TYPES.filter(
    (t) => others.length > 0 || (t !== "keep-apart" && t !== "take-together")
  );

  function patch(id: string, next: Partial<IntakeRule>) {
    setRules(
      rules.map((r) =>
        r.id === id ? ({ ...r, ...next, suggested: false } as IntakeRule) : r
      )
    );
  }

  return (
    <div data-testid="intake-rules-editor" className="space-y-3">
      {rules.map((rule) => (
        <div
          key={rule.id}
          data-testid="intake-rule-row"
          data-rule-type={rule.type}
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          {rule.type === "only-when" && (
            <>
              <span>Take only when</span>
              <Combobox
                name={`rule-situation-${rule.id}`}
                ariaLabel="Situation"
                value={rule.situation}
                onChange={(v) => patch(rule.id, { situation: v })}
                options={situationOptions}
                allowFreeText
                placeholder="e.g. Illness"
              />
            </>
          )}
          {rule.type === "pause-while" && (
            <>
              <span>Pause while</span>
              <Combobox
                name={`rule-pause-${rule.id}`}
                ariaLabel="Pause during situation"
                value={rule.situation}
                onChange={(v) => patch(rule.id, { situation: v })}
                options={situationOptions}
                allowFreeText
                placeholder="e.g. Pre-surgery"
              />
            </>
          )}
          {rule.type === "food" && (
            <>
              <span>Take</span>
              <select
                aria-label="Food timing"
                value={rule.timing}
                onChange={(e) =>
                  patch(rule.id, { timing: e.target.value as FoodTiming })
                }
                className="input w-auto"
              >
                {FOOD_TIMINGS.filter((t) => t !== "any").map((t) => (
                  <option key={t} value={t}>
                    {FOOD_TIMING_LABELS[t].toLowerCase()}
                  </option>
                ))}
              </select>
            </>
          )}
          {rule.type === "keep-apart" && (
            <>
              <span>Keep</span>
              <input
                type="number"
                min={0}
                step="any"
                aria-label="Hours apart"
                value={rule.hours ?? ""}
                onChange={(e) =>
                  patch(rule.id, {
                    hours: e.target.value ? Number(e.target.value) : null,
                  })
                }
                className="input w-20"
                placeholder="2"
              />
              <span>h apart from</span>
              <OtherItemSelect
                value={rule.otherId}
                others={others}
                onChange={(id) => patch(rule.id, { otherId: id })}
              />
            </>
          )}
          {rule.type === "take-together" && (
            <>
              <span>Take together with</span>
              <OtherItemSelect
                value={rule.otherId}
                others={others}
                onChange={(id) => patch(rule.id, { otherId: id })}
              />
            </>
          )}
          {rule.suggested && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              suggested
            </span>
          )}
          <button
            type="button"
            aria-label="Remove rule"
            onClick={() => setRules(rules.filter((r) => r.id !== rule.id))}
            className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950"
          >
            ×
          </button>
        </div>
      ))}

      {adding ? (
        <div className="flex flex-wrap gap-1.5">
          {offered.map((type) => (
            <button
              key={type}
              type="button"
              data-testid={`intake-rule-add-${type}`}
              onClick={() => {
                setRules([...rules, newRule(type, firstOtherId)]);
                setAdding(false);
              }}
              className="tap-target rounded-full border border-(--border) px-3 py-1.5 text-sm transition hover:bg-(--ghost-hover)"
            >
              {INTAKE_RULE_MENU_LABELS[type]}
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          data-testid="intake-rule-add-open"
          onClick={() => setAdding(true)}
          className="btn-ghost btn-sm"
        >
          Add a rule
        </button>
      )}
    </div>
  );
}

function OtherItemSelect({
  value,
  others,
  onChange,
}: {
  value: number;
  others: { id: number; name: string }[];
  onChange: (id: number) => void;
}) {
  return (
    <select
      aria-label="Other item"
      value={value || others[0]?.id}
      onChange={(e) => onChange(Number(e.target.value))}
      className="input w-auto"
    >
      {others.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
