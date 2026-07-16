"use client";

import { useState } from "react";
import {
  IconPrinter,
  IconShare,
  IconCopy,
  IconCheck,
  IconStethoscope,
} from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { NOTICE_TONE } from "@/components/Notice";
import SubmitButton from "@/components/SubmitButton";
import { SHARE_TTL_OPTIONS } from "@/lib/share-links";
import {
  createEpisodeShareLinkAction,
  promoteEpisodeToConditionAction,
  unpromoteEpisodeConditionAction,
} from "@/app/(app)/medical/episodes/actions";

// Print + Share + Promote-to-condition controls for the episode detail page. Client-only
// so it can drive window.print() and the share modal; the mutations are Server Actions
// gated by requireWriteAccess(). `print:hidden` keeps the whole bar off the printed page.
export default function EpisodeControls({
  anchor,
  promoted,
  canWrite,
}: {
  anchor: string;
  promoted: boolean;
  canWrite: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setCreatedUrl(null);
    setCopied(false);
    setCreating(true);
    const res = await createEpisodeShareLinkAction(
      new FormData(e.currentTarget)
    );
    setCreating(false);
    if (res.ok) setCreatedUrl(window.location.origin + res.path);
    else setError(res.error);
  }

  async function onPromote(fd: FormData) {
    await promoteEpisodeToConditionAction(fd);
  }
  async function onUnpromote(fd: FormData) {
    await unpromoteEpisodeConditionAction(fd);
  }

  async function copy() {
    if (!createdUrl) return;
    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — URL shown for manual copy */
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <button
        type="button"
        className="btn-ghost"
        onClick={() => window.print()}
      >
        <IconPrinter className="h-4 w-4" stroke={1.75} />
        Print
      </button>

      {canWrite && (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          <IconShare className="h-4 w-4" stroke={1.75} />
          Share
        </button>
      )}

      {canWrite &&
        (promoted ? (
          <form action={onUnpromote}>
            <input type="hidden" name="anchor" value={anchor} />
            <SubmitButton className="btn-ghost" pendingLabel="Removing…">
              Remove condition
            </SubmitButton>
          </form>
        ) : (
          <form action={onPromote}>
            <input type="hidden" name="anchor" value={anchor} />
            <SubmitButton className="btn-ghost" pendingLabel="Adding…">
              <IconStethoscope className="h-4 w-4" stroke={1.75} />
              Promote to condition
            </SubmitButton>
          </form>
        ))}

      {open && (
        <ModalShell
          title="Share this illness summary"
          onClose={() => setOpen(false)}
        >
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Create a read-only link anyone can open without logging in — hand it
            to a clinician from the waiting room. Revoke it any time from the
            passport share list.
          </p>

          <form onSubmit={onCreate} className="mt-4 flex flex-col gap-4">
            <input type="hidden" name="anchor" value={anchor} />
            <div>
              <label className="label" htmlFor="ttl">
                Valid for
              </label>
              <select
                id="ttl"
                name="ttl"
                defaultValue="7d"
                className="input sm:w-48"
              >
                {SHARE_TTL_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            {error && (
              <p className="text-sm text-rose-600 dark:text-rose-400">
                {error}
              </p>
            )}
            <SubmitButton disabled={creating} pendingLabel="Creating…">
              Create link
            </SubmitButton>
          </form>

          {createdUrl && (
            <div
              className={`mt-4 rounded-lg border p-3 ${NOTICE_TONE.emerald}`}
            >
              <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">
                Link created — copy it now (it won’t be shown again):
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  readOnly
                  value={createdUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="input font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={copy}
                  className="btn-ghost shrink-0"
                  aria-label="Copy link"
                >
                  {copied ? (
                    <IconCheck className="h-4 w-4" stroke={1.75} />
                  ) : (
                    <IconCopy className="h-4 w-4" stroke={1.75} />
                  )}
                </button>
              </div>
            </div>
          )}
        </ModalShell>
      )}
    </div>
  );
}
