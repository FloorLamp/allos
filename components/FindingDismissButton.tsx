import type { Finding } from "@/lib/findings";
import Button from "@/components/Button";

// ONE finding's dismiss, on its own. Extracted out of FindingRow (#4076) because the
// dashboard now renders a finding as a ROW in the shared grammar and hosts this in
// the row's trailing control slot — same `dedupeKey`, same namespace-guarded server
// action, same findings bus, so a dismiss on the dashboard still silences the origin
// surface and vice-versa. Hand-mirrored dismiss markup is exactly what drifts.
export default function FindingDismissButton({
  finding: f,
  dismissAction,
  dismissTestid,
  dismissKey,
}: {
  finding: Finding;
  dismissAction: (formData: FormData) => void | Promise<void>;
  dismissTestid: string;
  /**
   * The key POSTED to the bus, when it is deliberately BROADER than this finding's
   * own identity — the Results-hub trajectory watch posts its analyte-level
   * `supersedes` (#564). Defaults to the finding's own dedupeKey.
   */
  dismissKey?: string;
}) {
  return (
    <form action={dismissAction}>
      <input type="hidden" name="dedupe_key" value={dismissKey ?? f.dedupeKey} />
      <Button
        type="submit"
        pendingLabel="…"
        data-testid={dismissTestid}
        aria-label={`Dismiss ${f.title}`}
      >
        Dismiss
      </Button>
    </form>
  );
}
