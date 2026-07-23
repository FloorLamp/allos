// Pure option-model for the provider picker combobox (issue #1176). No DB/network —
// the ProviderCombobox wrapper feeds it the shared registry rows and renders the
// result through the shared Combobox. Split out so the rows → disambiguated-labels +
// type→icon mapping is unit-tested independent of React.
//
// The native <datalist> it replaces dedupes options BY NAME (#574), collapsing two
// genuinely distinct same-named providers (#534/#536) into one row and losing the
// individual-vs-organization distinction the data model already carries. Here each
// row becomes a UNIQUE disambiguated label (providerDisambigLabel — the #531/#534
// "label by the attribute that differs" helper, with a #id fallback), so a name
// collision yields two distinct, icon-bearing options; a `label → name` map recovers
// the bare name the write path (resolveProviderIdByName) still resolves on submit,
// keeping submit semantics unchanged.

import type { Provider, ProviderType } from "./types";
import { providerDisambigLabel } from "./provider-merge";

export interface ProviderPickerModel {
  // Unique display labels, in the order the providers were given (alphabetical from
  // the query). Fed to the Combobox as its option strings.
  labels: string[];
  // label → the bare provider name that submits (what resolveProviderIdByName reads).
  labelToName: Map<string, string>;
  // label → provider type, so the wrapper can choose the leading icon.
  labelToType: Map<string, ProviderType>;
}

export function providerPickerModel(
  providers: readonly Provider[]
): ProviderPickerModel {
  const labels: string[] = [];
  const labelToName = new Map<string, string>();
  const labelToType = new Map<string, ProviderType>();
  for (const p of providers) {
    const label = providerDisambigLabel(p, providers);
    labels.push(label);
    labelToName.set(label, p.name);
    labelToType.set(label, p.type);
  }
  return { labels, labelToName, labelToType };
}

// The name that should submit for the current display value. A picked label maps back
// to its bare provider name; anything else (a genuinely new typed name) submits as
// typed — the exact string the datalist's plain <input> submitted, so the write path
// (resolveProviderIdByName / pickReusableProviderId, #534) is unchanged.
export function providerSubmitName(
  model: ProviderPickerModel,
  displayValue: string
): string {
  const v = displayValue.trim();
  return model.labelToName.get(v) ?? v;
}
