"use client";

import QueryParamSelect from "./QueryParamSelect";
import {
  OTHER_PANEL,
  PANEL_LABELS,
  type PanelId,
} from "@/lib/biomarker-panels";

// Clinical PANEL dropdown for the clinical results catalog (#1502). Before the panel
// taxonomy existed, `?panel=` held the document's free-text section heading —
// which in practice is the lab VENDOR, so the only facet the browser could offer
// was "show me everything drawn at Quest Diagnostics". This offers the normalized
// taxonomy instead ("Lipids", "Complete blood count", "Thyroid"), writing a stable
// SLUG into the param so a reword never breaks a bookmark.
//
// The offered set is the caller's `panels`, not the panels present in the current
// view — the same decision CategoryFilterSelect made, and it keeps the control's
// contents stable while filters change. What the caller passes is a STATIC
// derivation over the controlled vocabulary (lib/biomarker-panel-reach): the
// taxonomy minus the panels whose analytes all carry a category the surface does not
// list, so the facet can no longer offer an option that returns nothing for anyone
// (#1581 section D). Resolving that here would drag the canonical dataset into the
// client bundle, so the server hands it down. The reserved "Other" slug is offered
// LAST, because it is a real, useful view (the readings the taxonomy can't place,
// i.e. analytes no canonical entry covers) but not a clinical panel.
export default function PanelFilterSelect({
  value,
  panels,
}: {
  value?: PanelId;
  panels: readonly PanelId[];
}) {
  const clinical = panels.filter((id) => id !== OTHER_PANEL);
  const ordered = panels.includes(OTHER_PANEL)
    ? [...clinical, OTHER_PANEL]
    : clinical;

  return (
    <QueryParamSelect
      param="panel"
      label="Panel"
      value={value}
      options={ordered.map((id) => ({
        value: id,
        label: PANEL_LABELS[id].label,
      }))}
    />
  );
}
