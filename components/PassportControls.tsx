"use client";

import { useState } from "react";
import { formatDateShape, type DisplayFormatPrefs } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import {
  IconPrinter,
  IconShare,
  IconCopy,
  IconCheck,
} from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { NOTICE_TONE } from "@/components/Notice";
import SubmitButton from "@/components/SubmitButton";
import {
  SHARE_FIELDS,
  SHARE_TTL_OPTIONS,
  type ShareField,
} from "@/lib/share-links";
import {
  createShareLinkAction,
  revokeShareLinkAction,
} from "@/app/(app)/profile/actions";

export interface ShareLinkView {
  id: number;
  fields: ShareField[];
  status: "valid" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
}

const FIELD_LABEL = new Map(SHARE_FIELDS.map((f) => [f.key, f.label]));

function statusBadge(status: ShareLinkView["status"]): string {
  if (status === "valid")
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";
  if (status === "expired")
    return "bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400";
  return "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300";
}

// Pref-aware (#964/#1020): the viewer's date shape via formatDateShape (local
// calendar day of the timestamp), replacing the old implicit-locale
// toLocaleDateString.
function fmtDate(iso: string, prefs: DisplayFormatPrefs): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : formatDateShape(
        prefs.dateFormat,
        d.getFullYear(),
        d.getMonth() + 1,
        d.getDate(),
        { monthStyle: "short", year: true }
      );
}

// Print + Share controls for the passport page. Client-only so it
// can drive window.print() and the share modal; the actual link mutations are
// Server Actions gated by requireSession().
export default function PassportControls({
  links,
}: {
  links: ShareLinkView[];
}) {
  const formatPrefs = useFormatPrefs();
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
    const res = await createShareLinkAction(new FormData(e.currentTarget));
    setCreating(false);
    if (res.ok && res.path) {
      setCreatedUrl(window.location.origin + res.path);
    } else if (!res.ok) {
      setError(res.error);
    }
  }

  // Client wrapper so the revoke <form> gets a void-returning action (the Server
  // Action returns a result object); the page auto-refreshes via revalidatePath.
  async function onRevoke(fd: FormData) {
    await revokeShareLinkAction(fd);
  }

  async function copy() {
    if (!createdUrl) return;
    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the URL is shown for manual copy */
    }
  }

  return (
    <div className="flex items-center gap-2 print:hidden">
      <button
        type="button"
        className="btn-ghost"
        onClick={() => window.print()}
      >
        <IconPrinter className="h-4 w-4" stroke={1.75} />
        Print
      </button>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        <IconShare className="h-4 w-4" stroke={1.75} />
        Share
      </button>

      {open && (
        <ModalShell title="Share this passport" onClose={() => setOpen(false)}>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Create a read-only link anyone can open without logging in. Choose
            what to include and how long it stays valid; you can revoke it any
            time.
          </p>

          <form onSubmit={onCreate} className="mt-4 flex flex-col gap-4">
            <fieldset>
              <legend className="label">Include</legend>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {SHARE_FIELDS.map((f) => (
                  <label
                    key={f.key}
                    className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
                  >
                    <input
                      type="checkbox"
                      name="field"
                      value={f.key}
                      defaultChecked
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    {f.label}
                  </label>
                ))}
              </div>
            </fieldset>

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

          {links.length > 0 && (
            <div className="mt-5">
              <div className="label">Existing links</div>
              <ul className="flex flex-col gap-2">
                {links.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`badge ${statusBadge(l.status)} capitalize`}
                        >
                          {l.status}
                        </span>
                        <span className="text-xs text-slate-400">
                          {l.status === "revoked"
                            ? "revoked"
                            : `expires ${fmtDate(l.expiresAt, formatPrefs)}`}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
                        {l.fields
                          .map((f) => FIELD_LABEL.get(f) ?? f)
                          .join(", ")}
                      </div>
                    </div>
                    {l.status === "valid" && (
                      <form action={onRevoke} className="shrink-0">
                        <input type="hidden" name="id" value={l.id} />
                        <SubmitButton
                          className="btn-danger px-3 py-1.5 text-xs"
                          pendingLabel="Revoking…"
                        >
                          Revoke
                        </SubmitButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </ModalShell>
      )}
    </div>
  );
}
