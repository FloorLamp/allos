"use client";

import { useState } from "react";
import Link from "next/link";
import {
  IconPrinter,
  IconShare,
  IconCopy,
  IconCheck,
} from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { NOTICE_TONE } from "@/components/Notice";
import SubmitButton from "@/components/SubmitButton";
import { SHARE_TTL_OPTIONS } from "@/lib/share-links";
import type { AppRoute } from "@/lib/hrefs";
import { createMedicationShareLinkAction } from "./actions";

// Print + Share controls for the current-medication list (issue #852 item 4). The Print
// link opens the printable /medications/print page; Share mints a tokenized read-only
// /share link (owner opt-in — the med list IS the shared content by design). Client-only
// so it can drive the share modal + clipboard; the mutation is a Server Action gated by
// requireWriteAccess().
const PRINT_HREF = "/medications/print" as AppRoute;

export default function MedicationListActions() {
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
    const res = await createMedicationShareLinkAction(
      new FormData(e.currentTarget)
    );
    setCreating(false);
    if (res.ok) setCreatedUrl(window.location.origin + res.path);
    else setError(res.error);
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
    <div className="flex items-center gap-1 print:hidden">
      <Link
        href={PRINT_HREF}
        className="tap-target flex h-9 w-9 items-center justify-center rounded-lg border border-black/10 bg-white/70 text-slate-600 transition hover:bg-white hover:text-slate-900 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300 dark:hover:bg-ink-750 dark:hover:text-slate-100"
        data-testid="medication-print-link"
        aria-label="Print medication list"
        title="Print medication list"
      >
        <IconPrinter className="h-4 w-4" stroke={1.75} />
      </Link>
      <button
        type="button"
        className="tap-target flex h-9 w-9 items-center justify-center rounded-lg border border-black/10 bg-white/70 text-slate-600 transition hover:bg-white hover:text-slate-900 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300 dark:hover:bg-ink-750 dark:hover:text-slate-100"
        data-testid="medication-share-open"
        aria-label="Share medication list"
        title="Share medication list"
        onClick={() => setOpen(true)}
      >
        <IconShare className="h-4 w-4" stroke={1.75} />
      </button>

      {open && (
        <ModalShell
          title="Share your medication list"
          onClose={() => setOpen(false)}
        >
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Create a read-only link anyone can open without logging in — hand it
            to a clinician or pharmacist. It shows your current medications
            only.
          </p>

          <form onSubmit={onCreate} className="mt-4 flex flex-col gap-4">
            <div>
              <label className="label" htmlFor="med-share-ttl">
                Valid for
              </label>
              <select
                id="med-share-ttl"
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
            <SubmitButton
              disabled={creating}
              pendingLabel="Creating…"
              data-testid="medication-share-create"
            >
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
                  data-testid="medication-share-url"
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
