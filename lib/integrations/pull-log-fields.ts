import { redactSecrets } from "@/lib/error-log-format";

const COUNT_FIELDS = [
  "activities",
  "workouts",
  "bodyMetrics",
  "vitals",
  "samples",
  "skipped",
  "hours",
  "days",
  "inserted",
  "updated",
  "unchanged",
] as const;

// The pull tick's deliberate operator-log contract. Runner results are wider and
// extensible; a new result field must be added here intentionally before it can be
// disclosed. Strings still pass through the shared credential redactor.
export function pullLogFields(
  result: Record<string, unknown>
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of COUNT_FIELDS) {
    if (typeof result[key] === "number") fields[key] = result[key];
  }
  for (const key of ["error", "partial"] as const) {
    if (typeof result[key] === "string")
      fields[key] = redactSecrets(result[key]);
  }
  if (typeof result.truncated === "boolean")
    fields.truncated = result.truncated;
  return fields;
}
