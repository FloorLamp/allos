"use client";

import { useMemo, useState } from "react";
import { IconX } from "@tabler/icons-react";
import Combobox from "@/components/Combobox";
import {
  rankProtocolOutcomeOptions,
  type OutcomeOption,
} from "@/lib/protocol-outcome-picker";
import { formatOutcomeDelta } from "@/lib/protocol-compare";
import type { PanelId } from "@/lib/biomarker-panels";

export default function ProtocolOutcomePicker({
  options,
  selectedKeys,
  onChange,
  relevantPanels,
  externallyDisplayedKeys,
}: {
  options: OutcomeOption[];
  selectedKeys: string[];
  onChange: (keys: string[]) => void;
  relevantPanels: ReadonlySet<PanelId>;
  externallyDisplayedKeys?: ReadonlySet<string>;
}) {
  const [query, setQuery] = useState("");
  const byKey = useMemo(
    () => new Map(options.map((option) => [option.key, option])),
    [options]
  );
  const selected = selectedKeys
    .map((key) => byKey.get(key))
    .filter((option): option is OutcomeOption => option != null);
  const selectedChips = selected.filter(
    (option) => !externallyDisplayedKeys?.has(option.key)
  );
  const selectedSet = new Set(selectedKeys);
  const available = rankProtocolOutcomeOptions(
    options.filter((option) => !selectedSet.has(option.key)),
    relevantPanels
  );
  const hasPreviews = options.some((option) => option.preview != null);

  function add(key: string) {
    const option = byKey.get(key);
    if (!option) return;
    onChange([...selectedKeys, option.key]);
    setQuery("");
  }

  function remove(key: string) {
    onChange(selectedKeys.filter((selectedKey) => selectedKey !== key));
  }

  if (options.length === 0) {
    return (
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        No trackable metrics yet — add body metrics or import labs first.
      </p>
    );
  }

  return (
    <div className="mt-1 space-y-2" data-testid="protocol-outcome-picker">
      {selectedChips.length > 0 && (
        <div
          className="flex flex-wrap gap-1.5"
          data-testid="protocol-outcome-selected"
        >
          {selectedChips.map((option) => (
            <span
              key={option.key}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-50 py-1 pl-2.5 pr-1 text-xs font-medium text-brand-700 dark:bg-brand-500/15 dark:text-brand-300"
            >
              <span className="truncate">{option.label}</span>
              <button
                type="button"
                className="rounded-full p-1 hover:bg-brand-100 dark:hover:bg-brand-500/20"
                aria-label={`Remove ${option.label}`}
                title="Remove outcome metric"
                onClick={() => remove(option.key)}
              >
                <IconX className="h-3.5 w-3.5" stroke={2} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      {selected.map((option) => (
        <input
          key={option.key}
          type="hidden"
          name="outcome_keys"
          value={option.key}
        />
      ))}
      {available.length > 0 ? (
        <Combobox
          value={query}
          onChange={setQuery}
          onPick={add}
          options={available.map((option) => option.key)}
          labelFor={(key) => byKey.get(key)?.label ?? key}
          searchTermsFor={(key) => {
            const option = byKey.get(key);
            return option ? [option.label, ...option.searchTerms] : [];
          }}
          badgeFor={(key) => {
            const preview = byKey.get(key)?.preview;
            if (!preview) return null;
            const unit = preview.unit ? ` ${preview.unit}` : "";
            return (
              <span
                className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400"
                title={`${preview.beforeMean} → ${preview.duringMean}${unit} (${preview.beforeN} before, ${preview.duringN} during)`}
              >
                {formatOutcomeDelta(preview.meanDelta)}
                {unit}
              </span>
            );
          }}
          placeholder="Search outcomes, e.g. ApoB or A1c"
          ariaLabel="Filter outcome metrics"
          emptyLabel="No matching outcomes"
          closeStopsPropagation
        />
      ) : (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          All available outcomes are selected.
        </p>
      )}
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {hasPreviews
          ? "Outcomes with measurable before-and-during changes appear first."
          : "Suggested outcomes appear first."}{" "}
        Search to find any other tracked metric.
      </p>
    </div>
  );
}
