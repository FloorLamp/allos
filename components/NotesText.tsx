// Shared renderer for free-text notes (issue #794 cluster 11a). User- and
// import-sourced notes (conditions, encounters, allergies, appointments, care
// plans, …) are multi-line and can contain long unbroken tokens (a pasted URL).
// Rendering them bare flattened CCD/extraction notes — encounters especially — to
// one run-on line, and let a URL overflow a min-w-0 flex/table cell. Every notes
// surface renders through here so the `whitespace-pre-wrap break-words` treatment
// can't be forgotten; a source-scan guard (lib/__tests__/notes-text.test.ts) fails
// the build if a note is rendered as a bare JSX child instead of through this.
//
// The note is passed as the `notes` PROP (not children) precisely so the guard has
// a reliable signature to ban — a raw `{x.notes}` JSX child. Renders nothing when
// there is no note (so callers can drop their own empty-guard ternary).
export default function NotesText({
  notes,
  as: Tag = "span",
  className,
  "data-testid": testId,
}: {
  notes: string | null | undefined;
  as?: "span" | "p" | "div";
  className?: string;
  "data-testid"?: string;
}) {
  if (!notes) return null;
  const base = "whitespace-pre-wrap break-words";
  return (
    <Tag
      className={className ? `${base} ${className}` : base}
      data-testid={testId}
    >
      {notes}
    </Tag>
  );
}
