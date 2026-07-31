"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveDigestDemotions } from "../actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import {
  DIGEST_CATEGORY_LABELS,
  DIGEST_CATEGORY_NOTABLE,
  DIGEST_TUNABLE_CATEGORIES,
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
export default function DigestTuneSettings({
  demoted,
}: {
  demoted: DigestCategory[];
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<DigestCategory[]>(demoted);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function toggle(category: DigestCategory) {
    const next = toggleDigestDemotion(current, category);
    setCurrent(next);
    runSave(async () => {
      const fd = new FormData();
      fd.set("demoted", serializeDigestDemotions(next));
      await saveDigestDemotions(fd);
      router.refresh();
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
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Turn a category down to <strong>notable only</strong>: routine lines
        stop, and anything the category itself calls notable still comes
        through. This never hides a flagged result or an out-of-range vital —
        those are always shown. The same toggles ride the digest itself as{" "}
        <span className="whitespace-nowrap">⚙️ Tune</span>.
      </p>
      <ul className="space-y-2" data-testid="digest-tune-list">
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
    </div>
  );
}
