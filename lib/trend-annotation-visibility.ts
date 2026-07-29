import { ANNOTATION_KINDS, type AnnotationKind } from "./trend-annotations";

export type AnnotationVisibility = Record<AnnotationKind, boolean>;

// Per-device display preference. Version the key so a future storage-shape change
// can safely ignore the old payload instead of guessing how to migrate it.
export const TREND_ANNOTATION_VISIBILITY_KEY =
  "allos:trends:annotation-visibility:v1";

export function defaultAnnotationVisibility(): AnnotationVisibility {
  return Object.fromEntries(
    ANNOTATION_KINDS.map((kind) => [kind, true])
  ) as AnnotationVisibility;
}

// Store only disabled kinds. New annotation kinds therefore default visible when
// an older payload is read, instead of silently inheriting an absent/false field.
export function parseAnnotationVisibility(
  raw: string | null
): AnnotationVisibility {
  const enabled = defaultAnnotationVisibility();
  if (!raw) return enabled;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      !Array.isArray((value as { disabled?: unknown }).disabled)
    )
      return enabled;
    const disabled = new Set(
      (value as { disabled: unknown[] }).disabled.filter(
        (kind): kind is AnnotationKind =>
          typeof kind === "string" &&
          ANNOTATION_KINDS.includes(kind as AnnotationKind)
      )
    );
    for (const kind of disabled) enabled[kind] = false;
    return enabled;
  } catch {
    return enabled;
  }
}

export function serializeAnnotationVisibility(
  enabled: AnnotationVisibility
): string {
  return JSON.stringify({
    disabled: ANNOTATION_KINDS.filter((kind) => !enabled[kind]),
  });
}
