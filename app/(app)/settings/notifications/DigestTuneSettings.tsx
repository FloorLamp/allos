"use client";

import { useState } from "react";
import { saveDigestDemotions } from "../actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import {
  DIGEST_CATEGORY_LABELS,
  DIGEST_CATEGORY_NOTABLE,
  DIGEST_TUNABLE_CATEGORIES,
  digestTuneSummary,
  serializeDigestDemotions,
  toggleDigestDemotion,
  type DigestCategory,
} from "@/lib/notifications/digest-tune";

// The Settings MIRROR of the digest's ⚙️ Tune control (#1714). One storage, two
// surfaces (#221): the message carries the escape hatch where the annoyance is, and
// this page makes the same preferences discoverable, reversible off-Telegram, and
// visible to someone auditing why their digest looks thin.
//
// Login-scoped, like the Telegram channel config beside it — which lines a digest
// routinely carries is a display preference of the person reading it, not a fact
// about the data subject.
//
// COLLAPSED BY DEFAULT (#1868 §3). Being a mirror is exactly why ten always-rendered
// checkboxes were the wrong weight on the densest settings page in the app: the
// canonical control rides the message, and this surface exists for discovery and
// reversal. So the card costs ONE honest line — `digestTuneSummary` names what is
// actually turned down — and opens to the full list on demand. Deleting the card
// instead was the other candidate and is NOT the smaller change: it would strip the
// only off-Telegram way to reverse a demotion, which is the whole point of #1714's
// mirror. Nothing about the preference, its storage, or its reach changed.
export default function DigestTuneSettings({
  demoted,
}: {
  demoted: DigestCategory[];
}) {
  const [current, setCurrent] = useState<DigestCategory[]>(demoted);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function toggle(category: DigestCategory) {
    const next = toggleDigestDemotion(current, category);
    setCurrent(next);
    runSave(async () => {
      const fd = new FormData();
      fd.set("demoted", serializeDigestDemotions(next));
      await saveDigestDemotions(fd);
    });
  }

  return (
    <div id="digest-tune" className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Morning digest lines
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>
      <p
        className="text-xs text-slate-500 dark:text-slate-400"
        data-testid="digest-tune-summary"
      >
        {digestTuneSummary(current)} The same toggles ride the digest itself as{" "}
        <span className="whitespace-nowrap">⚙️ Tune</span>.
      </p>
      <details>
        <summary
          className="cursor-pointer text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          data-testid="digest-tune-disclosure"
        >
          Change which categories
        </summary>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Turn a category down to <strong>notable only</strong>: routine lines
          stop, and anything the category itself calls notable still comes
          through. This never hides a flagged result or an out-of-range vital —
          those are always shown.
        </p>
        <ul className="mt-2 space-y-2" data-testid="digest-tune-list">
          {DIGEST_TUNABLE_CATEGORIES.map((c) => {
            const off = current.includes(c);
            return (
              <li key={c} className="flex items-start gap-2">
                <input
                  id={`digest-tune-${c}`}
                  type="checkbox"
                  checked={off}
                  onChange={() => toggle(c)}
                  className="mt-0.5 h-4 w-4 accent-brand-600"
                  data-testid={`digest-tune-${c}`}
                />
                <label htmlFor={`digest-tune-${c}`} className="text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {DIGEST_CATEGORY_LABELS[c]} — notable only
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {DIGEST_CATEGORY_NOTABLE[c]}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}
