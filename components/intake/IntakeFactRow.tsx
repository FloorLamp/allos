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

// The "+ rule" prompt's own focus identity (#3311). It is NOT a fact key: every rule
// sentence and this prompt all open the one rules builder, so the panel key cannot say
// which of them the person came from. Declared here, next to the chip that renders it
// and the callback that reports it, so the two cannot drift apart.
const ADD_RULE_FOCUS = "add-rule";

// One rule chip's focus identity. Per SENTENCE, so closing the builder returns to the
// rule that was opened rather than to whichever happens to be first.
function ruleFocusKey(ruleId: string): string {
  return `rule-${ruleId}`;
}

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
  // `focusKey` names the chip the person actually activated; the form relays it to the
  // primitive so focus comes back to that chip and not to the panel's first door.
  onOpen: (key: IntakeOpenPanel, focusKey: string) => void;
  onAddRule: (focusKey: string) => void;
  onRemoveRule: (ruleId: string) => void;
}) {
  return (
    <FactChipRow testId="intake-fact-row" className="sm:col-span-2">
      {summary.chips.map((chip) => (
        <FactChip
          key={chip.key}
          testId={`intake-fact-${chip.key}`}
          // One chip, one panel, so the chip's focus identity is just its fact key
          // (#3311). The row is unmounted while an editor is open, so a key is what
          // survives the remount — the element the person clicked does not.
          focusKey={chip.key}
          label={chip.label}
          state={chip.state}
          expanded={openEditor === chip.key}
          onOpen={(focusKey) => onOpen(chip.key, focusKey)}
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
          // Every rule sentence is a door to the ONE rules builder, so the panel key and
          // the focus key part company here — this is the case that made them two
          // questions (#3311). The chip hands its own key back through `onOpen`, so it
          // is written once.
          focusKey={ruleFocusKey(rule.ruleId)}
          label={rule.label}
          expanded={openEditor === "rules"}
          onOpen={(focusKey) => onOpen("rules", focusKey)}
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
        focusKey={ADD_RULE_FOCUS}
        label="rule"
        expanded={openEditor === "rules"}
        onOpen={onAddRule}
      />

      {summary.more.length > 0 && (
        <FactMoreChip
          testId="intake-fact-more"
          focusKey="more"
          label={moreFactsLabel(summary.more)}
          expanded={openEditor === "more"}
          onOpen={(focusKey) => onOpen("more", focusKey)}
        />
      )}
    </FactChipRow>
  );
}
