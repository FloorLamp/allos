// #3489 deliverables 2 + 7: the cross-page consistency review lane.
//
// Territory reviewers can reason about one page at full size. Between-page drift
// needs the opposite view: one comparable state from EVERY route, side by side.
// The walkthrough marks default desktop captures explicitly; this module filters
// those into one reduced contact sheet instead of handing a reviewer ~120 raw
// desktop/mobile/expanded/hover files.

export const CONSISTENCY_REVIEW_DIMENSIONS = [
  {
    id: "control-grammar",
    label: "Control grammar",
    brief: "chips, buttons, stat tiles, arrow glyphs, and link colors",
  },
  {
    id: "density",
    label: "Density",
    brief: "information and control density compared with peer surfaces",
  },
  {
    id: "inset-stacking",
    label: "Inset stacking",
    brief: "cards nested in cards, doubled gutters, and competing boundaries",
  },
  {
    id: "copy-jargon",
    label: "Copy jargon",
    brief: "terms a regular person would not use or understand",
  },
  {
    id: "state-honesty",
    label: "State honesty",
    brief: "claims that are stronger than the visible sample or state supports",
  },
];

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function consistencyReviewEntries(manifest) {
  const entries = manifest
    .filter(
      (entry) =>
        entry.consistency?.kind === "page-default" &&
        entry.consistency.viewport === "desktop"
    )
    .map((entry) => ({
      route: entry.consistency.route,
      file: entry.file,
    }));

  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.route))
      throw new Error(
        `cross-page consistency review has two default desktop captures for ${entry.route}`
      );
    seen.add(entry.route);
  }
  return entries;
}

export function consistencyReviewHtml(entries) {
  const dimensions = CONSISTENCY_REVIEW_DIMENSIONS.map(
    (dimension) =>
      `<li><strong>${escapeHtml(dimension.label)}</strong> — ${escapeHtml(dimension.brief)}</li>`
  ).join("\n");
  const figures = entries
    .map(
      (entry) => `<figure>
  <a href="${escapeHtml(entry.file)}"><img loading="lazy" src="${escapeHtml(entry.file)}" alt="${escapeHtml(entry.route)}"></a>
  <figcaption><strong>${escapeHtml(entry.route)}</strong><br>${escapeHtml(entry.file)}</figcaption>
</figure>`
    )
    .join("\n");

  return `<!doctype html><meta charset="utf-8"><title>cross-page consistency review</title>
<style>
body{font-family:system-ui;margin:0;background:#eeece8;color:#252422}
header{position:sticky;top:0;z-index:1;padding:.75rem 1rem;background:#fffdf9eF;border-bottom:1px solid #cbc7c0;backdrop-filter:blur(8px)}
h1{font-size:18px;margin:0 0 .35rem}p{font-size:13px;margin:.25rem 0}ul{display:flex;flex-wrap:wrap;gap:.25rem 1rem;margin:.5rem 0 0;padding-left:1rem;font-size:12px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;padding:8px}
figure{margin:0;background:#fff;border:1px solid #d8d4cd;border-radius:6px;padding:5px;min-width:0}
img{display:block;width:100%;height:220px;object-fit:contain;object-position:top;background:#f7f5f2}
figcaption{font-size:10px;line-height:1.3;padding-top:4px;overflow-wrap:anywhere}
</style>
<header><h1>Cross-page consistency review — ${entries.length} default desktop routes</h1>
<p>One comparable state per reached route. Report only between-page drift; click a frame to verify a candidate at full size.</p>
<ul>${dimensions}</ul></header><main>${figures}</main>`;
}

export function consistencyAuditSection(entries) {
  if (!entries.length) return [];
  const dimensions = CONSISTENCY_REVIEW_DIMENSIONS.map(
    (dimension) => `**${dimension.label}** (${dimension.brief})`
  ).join("; ");
  return [
    "## Cross-page consistency review",
    "",
    `- Artifact: [consistency.html](consistency.html) — one default desktop capture for each of ${entries.length} reached routes, together at low zoom. Mobile, expanded, and hover captures are excluded so every frame represents the same state.`,
    "- Dedicated reviewer lane: report only between-page drift, name every compared route, list routes that are consistent, and end with the five highest-value findings.",
    `- Dimensions: ${dimensions}.`,
    "",
  ];
}
