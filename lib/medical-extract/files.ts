// File-type handling: which uploads are supported, and turning a spreadsheet
// into the plain text the model reads.
import ExcelJS from "exceljs";

export const IMAGE_TYPES: Record<
  string,
  "image/png" | "image/jpeg" | "image/webp" | "image/gif"
> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export function ext(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return m ? m[1].toLowerCase() : "";
}

export function isSupportedFile(filename: string, mime: string): boolean {
  const e = ext(filename);
  if (e === "pdf" || e === "csv" || e === "xlsx") return true;
  if (e in IMAGE_TYPES) return true;
  return (
    mime === "application/pdf" ||
    mime.startsWith("image/") ||
    mime === "text/csv"
  );
}

// Render a single exceljs cell value as plain text. exceljs surfaces rich
// cells as objects (formulas, hyperlinks, rich text, errors) and dates as JS
// Date, so flatten each to the text a reader would see.
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const o = value as unknown as {
      richText?: { text?: string }[];
      text?: unknown;
      result?: ExcelJS.CellValue;
      error?: unknown;
      formula?: unknown;
    };
    if (Array.isArray(o.richText)) {
      return o.richText.map((r) => r.text ?? "").join("");
    }
    if (o.text !== undefined) return String(o.text); // hyperlink
    if (o.result !== undefined) return cellText(o.result); // formula
    if (o.error !== undefined) return String(o.error);
    return "";
  }
  return String(value);
}

// CSV-quote a field the way a spreadsheet export would (RFC 4180): wrap in
// double quotes and double any interior quote when it contains a comma, quote,
// or newline.
function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Convert a spreadsheet buffer into a readable plain-text representation
// (one labelled CSV block per sheet) for the model to read. exceljs reads the
// OOXML .xlsx format only (legacy binary .xls is not supported).
export async function spreadsheetToText(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  // exceljs's `Buffer` type and Node 24's global `Buffer` resolve to
  // incompatible declarations; cast to the method's own parameter type.
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const parts: string[] = [];
  wb.eachSheet((ws) => {
    const colCount = ws.columnCount;
    const lines: string[] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= colCount; c++) {
        cells.push(csvField(cellText(row.getCell(c).value)));
      }
      lines.push(cells.join(","));
    });
    parts.push(`# Sheet: ${ws.name}\n${lines.join("\n")}`);
  });
  return parts.join("\n\n");
}
