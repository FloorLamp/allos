// Pure CSV serialization (no DB/network) so it can be unit-tested in isolation.

// RFC-4180-ish CSV: quote fields containing a comma, quote, or newline and
// double any embedded quotes. Null/undefined become empty cells.
//
// Formula-injection guard: spreadsheet apps (Excel, Sheets, LibreOffice) treat a
// cell whose text starts with `=`, `+`, `-`, `@`, or a leading tab/CR as a
// formula, so an exported string like `=HYPERLINK(...)` can execute on open. We
// prefix such STRING cells with a single quote to neutralize them. Numeric cells
// (e.g. a genuine `-5` from a numeric column) are left untouched so exported
// values stay accurate.
export function toCsv(
  columns: string[],
  rows: Record<string, unknown>[]
): string {
  const esc = (v: unknown) => {
    if (v == null) return "";
    let s = String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c])).join(","));
  return lines.join("\n") + "\n";
}
