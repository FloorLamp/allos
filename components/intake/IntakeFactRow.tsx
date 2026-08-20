"use client";

import FactChipRow, {
  FactAddChip,
  FactChip,
  FactMoreChip,
} from "@/components/facts/FactChipRow";
import {
  moreFactsLabel,
  type IntakeFactKey,
  type IntakeFactSummary,
} from "@/lib/intake-facts";

// Which panel the form has open. The two pseudo-keys are panels that are not a single
// fact: the rules builder, and the list of optional facts that have nothing to state.
export type IntakeOpenPanel = IntakeFactKey | "rules" | "more";

// The summary row of the one intake form (#3216), stated in the shared facts-with-editors
// grammar (#3218). Everything about how a chip looks, announces itself and discloses its
// editor lives in `components/facts/FactChipRow`; this file supplies only the intake
// form's own facts — which ones, in what order, and what each one says.

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
    <FactChipRow testId="intake-fact-row" className="sm:col-span-2">
      {summary.chips.map((chip) => (
        <FactChip
          key={chip.key}
          testId={`intake-fact-${chip.key}`}
          label={chip.label}
          state={chip.state}
          expanded={openEditor === chip.key}
          onOpen={() => onOpen(chip.key)}
          // The machine-readable marking comes from the primitive (#3222); the wording
          // below is this form's own, and stays that way.
          suggested={chip.suggested}
          badge={
            chip.suggested && (
              <span
                data-testid="prefill-badge"
                className="ml-1.5 text-xs font-medium text-brand-700 dark:text-brand-300"
              >
                from label defaults
              </span>
            )
          }
        />
      ))}

      {summary.rules.map((rule) => (
        <FactChip
          key={rule.ruleId}
          testId="intake-fact-rule"
          label={rule.label}
          expanded={openEditor === "rules"}
          onOpen={() => onOpen("rules")}
          suggested={rule.suggested}
          badge={
            rule.suggested && (
              <span className="ml-1.5 text-xs text-slate-500 dark:text-slate-400">
                suggested
              </span>
            )
          }
          remove={{
            testId: "intake-rule-remove",
            label: `Remove rule: ${rule.label}`,
            onClick: () => onRemoveRule(rule.ruleId),
          }}
        />
      ))}

      <FactAddChip
        testId="intake-add-rule"
        label="rule"
        expanded={openEditor === "rules"}
        onOpen={onAddRule}
      />

      {summary.more.length > 0 && (
        <FactMoreChip
          testId="intake-fact-more"
          label={moreFactsLabel(summary.more)}
          expanded={openEditor === "more"}
          onOpen={() => onOpen("more")}
        />
      )}
    </FactChipRow>
  );
}
