"use client";

import { useTransition } from "react";
import { IconDatabaseImport, IconRefresh } from "@tabler/icons-react";
import Button from "@/components/Button";
import { useToast } from "@/components/Toast";

type IntegrationActionBinding = {
  action: () => Promise<{ status: "done" | "error"; message: string }>;
  label: string;
  pendingLabel: string;
  icon: "sync" | "refresh" | "import";
  testId: string;
  count?: number;
};

export default function IntegrationActionButton({
  binding,
}: {
  binding: IntegrationActionBinding;
}) {
  const [pending, start] = useTransition();
  const toast = useToast();

  function run() {
    start(async () => {
      const result = await binding.action();
      toast(result.message, {
        tone: result.status === "error" ? "error" : "success",
      });
    });
  }

  const Icon = binding.icon === "import" ? IconDatabaseImport : IconRefresh;
  return (
    <Button onClick={run} disabled={pending} data-testid={binding.testId}>
      <Icon
        className={`h-4 w-4 ${binding.icon === "sync" && pending ? "animate-spin motion-reduce:animate-none" : ""}`}
        stroke={1.75}
      />
      {pending ? binding.pendingLabel : binding.label}
      {binding.count != null && binding.count > 0 && (
        <span className="rounded-full bg-slate-100 px-1.5 text-xs text-slate-600 dark:bg-ink-800 dark:text-slate-300">
          {binding.count}
        </span>
      )}
    </Button>
  );
}
