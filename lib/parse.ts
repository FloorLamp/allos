// Trim a value to a non-empty string, or null. Shared by form actions, AI
// normalizers, and seeders so the "empty means null" rule is defined once.
export function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
