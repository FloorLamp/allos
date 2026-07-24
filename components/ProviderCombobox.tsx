"use client";

import { useMemo, useState } from "react";
import { IconUser, IconBuildingHospital } from "@tabler/icons-react";
import Combobox from "@/components/Combobox";
import { useProviderOptions } from "@/components/ProviderOptionsContext";
import { providerPickerModel, providerSubmitName } from "@/lib/provider-picker";
import type { Provider, ProviderType } from "@/lib/types";

// The shared provider picker (issue #1176) — the create-on-type combobox that
// replaces the native suggestion dropdown on every surface that sets a record's
// provider. A thin wrapper over the shared Combobox (#851): fuzzy search + keyboard
// nav + aria come free; this adds the individual-vs-organization LEADING icon (the
// Combobox's `iconFor` slot) and the by-id disambiguated labels (#531/#534) the old
// native control lost.
//
// Submit semantics are UNCHANGED: it renders a hidden <input name={name}> carrying the
// bare provider NAME (a picked disambiguated label maps back to its name; free text
// submits as typed), exactly what the datalist's plain <input> posted — so the write
// path (resolveProviderIdByName / pickReusableProviderId) never changes. The optional
// `counterpartType` filter powers the affiliation picker (individual↔organization).
export default function ProviderCombobox({
  providers,
  name,
  id,
  defaultValue = "",
  placeholder,
  ariaLabel = "Provider",
  onlyType,
  closeStopsPropagation,
}: {
  // The registry rows to offer. Defaults to the section-level ProviderOptionsContext
  // (where a form is nested under a ProviderOptionsProvider); the affiliation picker
  // passes its counterpart rows explicitly.
  providers?: readonly Provider[];
  name: string;
  id?: string;
  defaultValue?: string;
  placeholder?: string;
  ariaLabel?: string;
  // Constrain the offered rows to one type (the affiliation picker offers only the
  // counterpart type). Free text is still allowed — it creates under the caller's type.
  onlyType?: ProviderType;
  closeStopsPropagation?: boolean;
}) {
  const fromContext = useProviderOptions();
  const source = providers ?? fromContext;
  const rows = useMemo(
    () => (onlyType ? source.filter((p) => p.type === onlyType) : source),
    [source, onlyType]
  );
  const model = useMemo(() => providerPickerModel(rows), [rows]);
  const [value, setValue] = useState(defaultValue);

  function iconFor(label: string) {
    const t = model.labelToType.get(label);
    if (!t) return null;
    return t === "individual" ? (
      <IconUser
        className="h-4 w-4 shrink-0 text-slate-400"
        stroke={1.75}
        aria-hidden="true"
        data-testid="provider-icon-individual"
      />
    ) : (
      <IconBuildingHospital
        className="h-4 w-4 shrink-0 text-slate-400"
        stroke={1.75}
        aria-hidden="true"
        data-testid="provider-icon-organization"
      />
    );
  }

  return (
    <>
      <Combobox
        id={id}
        ariaLabel={ariaLabel}
        value={value}
        onChange={setValue}
        options={model.labels}
        iconFor={iconFor}
        allowFreeText
        placeholder={placeholder}
        closeStopsPropagation={closeStopsPropagation}
      />
      {/* The bare provider name submits (unchanged), not the display label. */}
      <input
        type="hidden"
        name={name}
        value={providerSubmitName(model, value)}
      />
    </>
  );
}
