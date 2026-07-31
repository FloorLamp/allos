export const BIOMARKER_SOURCE_PREVIEW_LIMIT = 4;

// Keep the auto-suggestion provenance useful without letting a large lab import
// turn each suggestion into an unbounded comma-separated paragraph.
export function biomarkerSuggestionSource(
  names: string[],
  limit = BIOMARKER_SOURCE_PREVIEW_LIMIT
): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const visible = unique.slice(0, Math.max(0, limit));
  const remaining = unique.length - visible.length;
  return `New/changed biomarkers: ${visible.join(", ")}${
    remaining > 0 ? ` · +${remaining} more` : ""
  }`;
}
