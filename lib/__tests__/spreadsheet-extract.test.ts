import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { isSupportedFile, spreadsheetToText } from "@/lib/medical-extract";

describe("isSupportedFile", () => {
  it("accepts supported document extensions by name", () => {
    expect(isSupportedFile("labs.pdf", "")).toBe(true);
    expect(isSupportedFile("labs.xlsx", "")).toBe(true);
    expect(isSupportedFile("labs.csv", "")).toBe(true);
    expect(isSupportedFile("scan.png", "")).toBe(true);
  });

  it("rejects legacy binary .xls (exceljs reads .xlsx only)", () => {
    // The spreadsheet reader was swapped from SheetJS to exceljs, which does
    // not parse the legacy BIFF .xls format — so it must no longer be offered.
    expect(isSupportedFile("labs.xls", "")).toBe(false);
    expect(isSupportedFile("labs.xls", "application/vnd.ms-excel")).toBe(false);
  });

  it("falls back to mime type when the extension is unknown", () => {
    expect(isSupportedFile("report", "application/pdf")).toBe(true);
    expect(isSupportedFile("photo", "image/jpeg")).toBe(true);
    expect(isSupportedFile("data", "text/csv")).toBe(true);
    expect(isSupportedFile("mystery", "application/octet-stream")).toBe(false);
  });
});

async function xlsxBuffer(
  sheets: Record<string, (string | number)[][]>
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("spreadsheetToText", () => {
  it("renders each sheet as a labelled CSV block", async () => {
    const buf = await xlsxBuffer({
      Labs: [
        ["Analyte", "Value", "Unit"],
        ["Glucose", 95, "mg/dL"],
      ],
    });
    const text = await spreadsheetToText(buf);
    expect(text).toContain("# Sheet: Labs");
    expect(text).toContain("Analyte,Value,Unit");
    expect(text).toContain("Glucose,95,mg/dL");
  });

  it("CSV-quotes fields containing commas, quotes, or newlines", async () => {
    const buf = await xlsxBuffer({
      S: [["a, b", 'say "hi"', "line1\nline2"]],
    });
    const text = await spreadsheetToText(buf);
    expect(text).toContain('"a, b"');
    expect(text).toContain('"say ""hi"""');
    expect(text).toContain('"line1\nline2"');
  });

  it("separates multiple sheets into distinct blocks", async () => {
    const buf = await xlsxBuffer({
      First: [["x"]],
      Second: [["y"]],
    });
    const text = await spreadsheetToText(buf);
    expect(text).toContain("# Sheet: First");
    expect(text).toContain("# Sheet: Second");
    expect(text.indexOf("First")).toBeLessThan(text.indexOf("Second"));
  });
});
