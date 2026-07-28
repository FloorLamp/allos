"use client";

import { useMemo, useState } from "react";
import { IconX } from "@tabler/icons-react";
import Combobox from "@/components/Combobox";
import {
  rankProtocolOutcomeOptions,
  type OutcomeOption,
} from "@/lib/protocol-outcome-picker";
import type { PanelId } from "@/lib/biomarker-panels";

export default function ProtocolOutcomePicker({
  options,
  selectedKeys,
  onChange,
  relevantPanels,
}: {
  options: OutcomeOption[];
  selectedKeys: string[];
  onChange: (keys: string[]) => void;
  relevantPanels: ReadonlySet<PanelId>;
}) {
  const [query, setQuery] = useState("");
  const byKey = useMemo(
    () => new Map(options.map((option) => [option.key, option])),
    [options]
  );
  const selected = selectedKeys
    .map((key) => byKey.get(key))
    .filter((option): option is OutcomeOption => option != null);
  const selectedSet = new Set(selectedKeys);
  const available = rankProtocolOutcomeOptions(
    options.filter((option) => !selectedSet.has(option.key)),
    relevantPanels
  );

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
      {selected.length > 0 && (
        <div
          className="flex flex-wrap gap-1.5"
          data-testid="protocol-outcome-selected"
        >
          {selected.map((option) => (
            <span
              key={option.key}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-50 py-1 pl-2.5 pr-1 text-xs font-medium text-brand-700 dark:bg-brand-500/15 dark:text-brand-300"
            >
              <span className="truncate">{option.label}</span>
              <button
                type="button"
                className="rounded-full p-1 hover:bg-brand-100 dark:hover:bg-brand-500/20"
                aria-label={`Remove ${option.label}`}
                onClick={() => remove(option.key)}
              >
                <IconX className="h-3.5 w-3.5" stroke={2} aria-hidden />
              </button>
              <input type="hidden" name="outcome_keys" value={option.key} />
            </span>
          ))}
        </div>
      )}
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
        Relevant panels appear first; every tracked outcome remains searchable.
      </p>
    </div>
  );
}
