"use client";

import { useState, useTransition } from "react";
import { IconBan } from "@tabler/icons-react";
import { allowDocumentReacquisition } from "@/app/(app)/data/review-actions";
import type { DocumentTombstone } from "@/lib/document-tombstones";

// Data → Review: "Blocked from re-acquisition" (#1777) — the documents a user deleted,
// which an acquirer is therefore refused when it offers them again.
//
// WHY THIS SURFACE HAS TO EXIST. The tombstone is a standing, invisible refusal: without
// a list, a household could never find out that allos is declining a document every
// night, and could never change its mind. A block a user cannot see or lift is not a
// safety feature, it is a mystery. This is the FIRST user-facing tombstone-clearing
// surface in the app — the activity/body-metric tombstones have none — and it is
// deliberately kept document-scoped rather than generalized into a tombstone manager
// nobody asked for.
//
// SUGGEST, NEVER SILENTLY WRITE. Allowing again is a tap. Nothing here un-blocks on its
// own, and the outcome is rendered from what the action actually did rather than assumed
// — the row may already be gone (another tab, or a human re-upload that cleared it on
// the way in), and "Allowed" would then be a claim about a write that never happened.
//
// WHY IT IS A SIBLING OF THE PORTAL SOURCE CARD RATHER THAN NESTED IN IT: that card is
// rendered conditionally (a provider with no connection and no history is hidden), so
// nesting would make the only allow-again affordance disappear exactly when a household
// has deleted documents but no live portal connection. It renders nothing at all when
// there is nothing blocked, which is the common case.

// A tombstone's natural key is an opaque hash, so a row with no captured filename (one
// written before migration 134) falls back to a short prefix. Long enough to be
// distinguishable, short enough not to read as noise.
function documentLabel(t: DocumentTombstone): string {
  return t.label ?? `Document ${t.contentHash.slice(0, 12)}…`;
}

function BlockedRow({ tombstone }: { tombstone: DocumentTombstone }) {
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);

  function onAllow() {
    const form = new FormData();
    form.set("hash", tombstone.contentHash);
    startTransition(async () => {
      const res = await allowDocumentReacquisition(form);
      setOutcome(res.message);
      // Both non-error outcomes end with the block lifted, so the row stops offering
      // an action either way — but it keeps saying WHICH happened.
      if (res.status !== "error") setCleared(true);
    });
  }

  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-black/5 p-2.5 dark:border-white/5"
      data-testid="blocked-document-row"
    >
      <div className="min-w-0">
        <p className="truncate text-sm text-slate-800 dark:text-slate-100">
          {documentLabel(tombstone)}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Deleted {tombstone.deletedAt.slice(0, 10)}
        </p>
      </div>
      {cleared ? (
        <span
          className="text-sm text-slate-500 dark:text-slate-400"
          data-testid="blocked-document-outcome"
        >
          {outcome}
        </span>
      ) : (
        <button
          type="button"
          onClick={onAllow}
          disabled={pending}
          data-testid="allow-reacquisition"
          className="btn-ghost text-sm font-medium text-brand-600 dark:text-brand-400"
        >
          {pending ? "Allowing…" : "Allow re-acquisition"}
        </button>
      )}
    </li>
  );
}

export default function BlockedDocuments({
  tombstones,
}: {
  tombstones: DocumentTombstone[];
}) {
  // Nothing blocked is the common case, and an empty "0 documents blocked" card would be
  // permanent furniture explaining a mechanism most households never meet.
  if (tombstones.length === 0) return null;
  return (
    <div className="card" data-testid="blocked-documents">
      <div className="mb-1 flex items-center gap-2">
        <IconBan className="h-5 w-5 shrink-0 text-slate-400" stroke={1.75} />
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {tombstones.length === 1
            ? "1 document blocked from re-acquisition"
            : `${tombstones.length} documents blocked from re-acquisition`}
        </h2>
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        You deleted these, so portal sync will not bring them back. Allow one
        again to let an acquirer re-file it, or upload the file yourself.
      </p>
      <ul className="mt-3 space-y-2">
        {tombstones.map((t) => (
          <BlockedRow key={t.contentHash} tombstone={t} />
        ))}
      </ul>
    </div>
  );
}
