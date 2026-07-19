"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// The crisis-resources config editor (issue #996), used for BOTH the global
// instance default (Settings → Server, admin) and the per-profile override
// (Settings → Profile). One resource per line as "Label | contact" (or just
// "contact"); blank clears the list. Autosaves on blur (the Settings-card pattern),
// submitting the raw text — the server action parses/normalizes it. The parent
// passes the tier-appropriate action, so this component stays auth-blind.
export default function CrisisResourcesEditor({
  action,
  initialText,
  title,
  description,
  testid,
}: {
  action: (formData: FormData) => Promise<void>;
  initialText: string;
  title: string;
  description: string;
  testid?: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(initialText);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save(next: string) {
    if (next === initialText) return;
    const fd = new FormData();
    fd.set("crisis_resources", next);
    runSave(async () => {
      await action(fd);
      router.refresh();
    });
  }

  return (
    <div className="card max-w-lg space-y-3" data-testid={testid}>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {title}
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {description}
      </p>
      <textarea
        className="input font-mono text-sm"
        rows={4}
        defaultValue={initialText}
        data-testid="crisis-resources-input"
        placeholder={
          "e.g.\nLocal crisis line | 000-000-0000\nEmergency services | 112"
        }
        onChange={(e) => setText(e.target.value)}
        onBlur={() => save(text)}
      />
      <p className="text-xs text-slate-500 dark:text-slate-400">
        One resource per line as <code>Label | contact</code> (the label is
        optional). No number is assumed — leave this empty to show the neutral
        “contact your local emergency services” guidance instead.
      </p>
    </div>
  );
}
