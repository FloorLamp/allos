"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  IconPrinter,
  IconShare,
  IconCopy,
  IconCheck,
} from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { useConfirm } from "@/components/ConfirmDialog";
import OverflowMenu, { MENU_ITEM } from "@/components/OverflowMenu";
import EpisodeEditor from "@/components/illness/EpisodeEditor";
import { NOTICE_TONE } from "@/components/Notice";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { SHARE_TTL_OPTIONS } from "@/lib/share-links";
import {
  createEpisodeShareLinkAction,
  promoteEpisodeToConditionAction,
  unpromoteEpisodeConditionAction,
} from "@/app/(app)/medical/episodes/actions";

// Print, share, and overflow controls for the episode detail page. Lifecycle actions
// live after the logging workspace in EpisodeLifecycleControl.
// Client-only so it can drive window.print() and the share modal; the mutations are
// Server Actions gated by requireWriteAccess(). `print:hidden` keeps the whole bar off
// the printed page. Everything keys on the STABLE episode id (#856), not a date anchor.
export default function EpisodeControls({
  episodeId,
  ongoing,
  promoted,
  canWrite,
  profileId,
  editor,
}: {
  episodeId: number;
  ongoing: boolean;
  promoted: boolean;
  canWrite: boolean;
  // The cross-profile write target (issue #879). Set when the page shows a household
  // member's episode (not the acting profile), so every mutation posts it and the action
  // gates on THAT profile (requireProfileWriteAccess). Absent on the acting profile's own
  // page — the action then uses the active profile (requireWriteAccess).
  profileId?: number;
  editor?: {
    startedAt: string | null;
    endedAt: string | null;
    note: string | null;
    outcome: string | null;
  };
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [conditionBusy, setConditionBusy] = useState(false);
  const confirm = useConfirm();
  const router = useRouter();
  const toast = useToast();

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

  async function onPromote() {
    const ok = await confirm({
      title: "Add to medical conditions?",
      message:
        "This saves the illness in Conditions so it remains part of the medical history. Its dates and status will stay in sync with this episode.",
      confirmLabel: "Add condition",
    });
    if (!ok) return;
    setConditionBusy(true);
    try {
      const result = await promoteEpisodeToConditionAction(stateFormData());
      if (!result.ok) toast(result.error);
      else router.refresh();
    } finally {
      setConditionBusy(false);
    }
  }
  async function onUnpromote(fd: FormData) {
    await unpromoteEpisodeConditionAction(fd);
  }
  function stateFormData() {
    const fd = new FormData();
    fd.set("episodeId", String(episodeId));
    if (profileId != null) fd.set("profileId", String(profileId));
    return fd;
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
    <div
      className="flex flex-wrap items-center gap-2 print:hidden"
      data-testid="episode-controls"
    >
      <button
        type="button"
        className="btn-ghost h-9 w-9 p-0"
        onClick={() => window.print()}
        aria-label="Print episode"
        title="Print"
      >
        <IconPrinter className="h-4 w-4" stroke={1.75} />
      </button>

      {canWrite && (
        <button
          type="button"
          className="btn-ghost h-9 w-9 p-0"
          onClick={() => setShareOpen(true)}
          aria-label="Share episode"
          title="Share"
        >
          <IconShare className="h-4 w-4" stroke={1.75} />
        </button>
      )}

      {canWrite && (
        <OverflowMenu
          label="More episode actions"
          open={menuOpen}
          onOpenChange={setMenuOpen}
        >
          {({ close }) => (
            <>
              {editor && (
                <button
                  type="button"
                  className={MENU_ITEM}
                  data-testid="episode-edit-open"
                  onClick={() => {
                    close();
                    setEditorOpen(true);
                  }}
                >
                  Edit episode
                </button>
              )}
              {promoted ? (
                <form
                  action={async (fd) => {
                    await onUnpromote(fd);
                    close();
                  }}
                >
                  <input type="hidden" name="episodeId" value={episodeId} />
                  {profileId != null && (
                    <input type="hidden" name="profileId" value={profileId} />
                  )}
                  <SubmitButton className={MENU_ITEM} pendingLabel="Removing…">
                    Remove condition
                  </SubmitButton>
                </form>
              ) : (
                <button
                  type="button"
                  className={MENU_ITEM}
                  disabled={conditionBusy}
                  onClick={() => {
                    close();
                    void onPromote();
                  }}
                >
                  {conditionBusy ? "Adding…" : "Promote to condition"}
                </button>
              )}
            </>
          )}
        </OverflowMenu>
      )}

      {shareOpen && (
        <ModalShell
          title="Share this illness summary"
          onClose={() => setShareOpen(false)}
        >
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Create a read-only link anyone can open without logging in — hand it
            to a clinician from the waiting room. Revoke it any time from the
            passport share list.
          </p>

          <form onSubmit={onCreate} className="mt-4 flex flex-col gap-4">
            <input type="hidden" name="episodeId" value={episodeId} />
            {profileId != null && (
              <input type="hidden" name="profileId" value={profileId} />
            )}
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
      {editor && (
        <EpisodeEditor
          episodeId={episodeId}
          ongoing={ongoing}
          startedAt={editor.startedAt}
          endedAt={editor.endedAt}
          note={editor.note}
          outcome={editor.outcome}
          profileId={profileId}
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}
