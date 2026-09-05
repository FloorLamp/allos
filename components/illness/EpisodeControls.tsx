"use client";

import { useState } from "react";
import { IconPrinter, IconShare } from "@tabler/icons-react";
import CreatedShareLink from "@/components/CreatedShareLink";
import ModalShell from "@/components/ModalShell";
import { useConfirm } from "@/components/ConfirmDialog";
import OverflowMenu, {
  MENU_ITEM,
  OverflowMenuSubmitItem,
} from "@/components/OverflowMenu";
import EpisodeEditor from "@/components/illness/EpisodeEditor";
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
  situation,
  ongoing,
  promoted,
  canWrite,
  profileId,
  editor,
}: {
  episodeId: number;
  // What the page's own h1 calls this episode ("Flu", "Cold") — the name its ⋯
  // sheet owes a viewer who can no longer see the header (#3501).
  situation: string;
  ongoing: boolean;
  promoted: boolean;
  canWrite: boolean;
  // The cross-profile write target (issue #879). Set when the page shows a household
  // member's episode (not the acting profile), so every mutation posts it and the action
  // gates on THAT profile (requireProfileWriteAccess). Absent on the acting profile's own
  // page — the action then uses the active profile (requireWriteAccess).
  profileId?: number;
  editor?: {
    startDate: string | null;
    endDate: string | null;
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
  const [conditionBusy, setConditionBusy] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setCreatedUrl(null);
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
    } finally {
      setConditionBusy(false);
    }
  }
  function stateFormData() {
    const fd = new FormData();
    fd.set("episodeId", String(episodeId));
    if (profileId != null) fd.set("profileId", String(profileId));
    return fd;
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2 print:hidden"
      data-testid="episode-controls"
    >
      <button
        type="button"
        className="btn-ghost w-9 px-0"
        onClick={() => window.print()}
        aria-label="Print episode"
      >
        <IconPrinter className="h-4 w-4" stroke={1.75} />
      </button>

      {canWrite && (
        <button
          type="button"
          className="btn-ghost w-9 px-0"
          onClick={() => setShareOpen(true)}
          aria-label="Share episode"
        >
          <IconShare className="h-4 w-4" stroke={1.75} />
        </button>
      )}

      {canWrite && (
        <OverflowMenu
          kind="More episode"
          itemName={situation}
          open={menuOpen}
          onOpenChange={setMenuOpen}
        >
          {({ close, runAction }) => (
            <>
              {editor && (
                <button
                  type="button"
                  role="menuitem"
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
                // THE LAST HAND-ROLLED MENU WRITE, ON THE SHARED PATH (#2641).
                //
                // This was `action={async (fd) => { await unpromote…(fd);
                // close(); }}` — the one kebab write in the app that did not go
                // through `runAction`. What that cost was not the panel —
                // `runAction` closes on the same beat this did, which
                // components/OverflowMenu.tsx now measures — but the OUTCOME:
                // `unpromoteEpisodeConditionAction`
                // returns a `FormResult` and refuses an episode that is no
                // longer there, and this discarded it. The menu closed, the item
                // still read "Remove condition", and a refused write was
                // indistinguishable from a lost tap — the inline-action rule
                // (#2133), broken at the one site nothing was watching.
                //
                // `runAction` reports it, and reports a throw as well instead of
                // escalating to the route error boundary (#477).
                <form
                  action={(fd) =>
                    runAction(
                      unpromoteEpisodeConditionAction,
                      fd,
                      "Condition removed"
                    )
                  }
                >
                  <input type="hidden" name="episodeId" value={episodeId} />
                  {profileId != null && (
                    <input type="hidden" name="profileId" value={profileId} />
                  )}
                  <OverflowMenuSubmitItem pendingLabel="Removing…">
                    Remove condition
                  </OverflowMenuSubmitItem>
                </form>
              ) : (
                <button
                  type="button"
                  role="menuitem"
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
            <SubmitButton
              disabled={creating}
              pendingLabel="Creating…"
              variant="primary"
            >
              Create link
            </SubmitButton>
          </form>

          {createdUrl && <CreatedShareLink value={createdUrl} />}
        </ModalShell>
      )}
      {editor && (
        <EpisodeEditor
          episodeId={episodeId}
          ongoing={ongoing}
          startDate={editor.startDate}
          endDate={editor.endDate}
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
