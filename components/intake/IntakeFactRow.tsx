"use client";

import { IconPlus } from "@tabler/icons-react";
import {
  moreFactsLabel,
  type IntakeFactKey,
  type IntakeFactSummary,
} from "@/lib/intake-facts";

// Which panel the form has open. The two pseudo-keys are panels that are not a single
// fact: the rules builder, and the list of optional facts that have nothing to state.
export type IntakeOpenPanel = IntakeFactKey | "rules" | "more";

// The summary row of the one intake form (#3216): the facts the form will save,
// each a button that opens that fact's editor.
//
// EVERY CHIP IS A BUTTON WITH `aria-expanded`, which is the whole accessibility
// contract of a summary-first form: a chip is a disclosure, so the thing a screen
// reader announces has to be "this states a fact AND opens an editor", not a
// decorative span beside an invisible control. Keyboard reaches every chip in
// reading order for the same reason.
//
// A MISSING ESSENTIAL renders dashed and says what to add; an absent optional
// renders nothing and is reached through the one trailing affordance, which NAMES
// the facts it holds so "more" never means "somewhere in here".

export default function IntakeFactRow({
  summary,
  openEditor,
  onOpen,
  onAddRule,
  onRemoveRule,
}: {
  summary: IntakeFactSummary;
  openEditor: IntakeOpenPanel | null;
  onOpen: (key: IntakeOpenPanel) => void;
  onAddRule: () => void;
  onRemoveRule: (ruleId: string) => void;
}) {
  return (
    <div
      data-testid="intake-fact-row"
      className="flex flex-wrap items-center gap-1.5 sm:col-span-2"
    >
      {summary.chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          data-testid={`intake-fact-${chip.key}`}
          data-fact-state={chip.state}
          aria-expanded={openEditor === chip.key}
          onClick={() => onOpen(chip.key)}
          className={
            chip.state === "missing"
              ? "tap-target rounded-full border border-dashed border-brand-400 px-3 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50 dark:border-brand-500 dark:text-brand-300 dark:hover:bg-brand-950"
              : "tap-target rounded-full border border-(--border) bg-surface px-3 py-1.5 text-sm text-slate-700 transition hover:bg-(--ghost-hover) dark:text-slate-200"
          }
        >
          {chip.label}
        </button>
      ))}

      {summary.rules.map((rule) => (
        <span
          key={rule.ruleId}
          data-testid="intake-fact-rule"
          data-suggested={rule.suggested ? "1" : "0"}
          className="inline-flex items-center gap-1 rounded-full border border-(--border) bg-surface py-1.5 pr-1.5 pl-3 text-sm text-slate-700 dark:text-slate-200"
        >
          <button
            type="button"
            aria-expanded={openEditor === "rules"}
            onClick={() => onOpen("rules")}
            className="text-left"
          >
            {rule.label}
            {rule.suggested && (
              <span className="ml-1.5 text-xs text-slate-500 dark:text-slate-400">
                suggested
              </span>
            )}
          </button>
          <button
            type="button"
            data-testid="intake-rule-remove"
            aria-label={`Remove rule: ${rule.label}`}
            onClick={() => onRemoveRule(rule.ruleId)}
            className="tap-target flex h-6 w-6 items-center justify-center rounded-full text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950 dark:hover:text-rose-400"
          >
            ×
          </button>
        </span>
      ))}

      <button
        type="button"
        data-testid="intake-add-rule"
        aria-expanded={openEditor === "rules"}
        onClick={onAddRule}
        className="tap-target inline-flex items-center gap-1 rounded-full border border-dashed border-(--border) px-3 py-1.5 text-sm text-slate-600 transition hover:bg-(--ghost-hover) dark:text-slate-300"
      >
        <IconPlus className="h-3.5 w-3.5" stroke={2} aria-hidden="true" />
        rule
      </button>

      {summary.more.length > 0 && (
        <button
          type="button"
          data-testid="intake-fact-more"
          aria-expanded={
            openEditor != null &&
            summary.more.includes(openEditor as IntakeFactKey)
          }
          onClick={() => onOpen(summary.more[0])}
          className="tap-target rounded-full px-3 py-1.5 text-sm text-slate-500 underline-offset-2 transition hover:underline dark:text-slate-400"
        >
          {moreFactsLabel(summary.more)}
        </button>
      )}
    </div>
  );
}
