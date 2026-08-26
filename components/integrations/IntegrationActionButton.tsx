"use client";

import { useTransition } from "react";
import { IconDatabaseImport, IconRefresh } from "@tabler/icons-react";
import Button from "@/components/Button";
import { useToast } from "@/components/Toast";

type IntegrationActionBinding = {
  action: () => Promise<{ status: "done" | "error"; message: string }>;
  copy: readonly [label: string, pendingLabel: string];
  control: { icon: "sync" | "refresh" | "import"; testId: string };
  count?: number;
};

type Props = { binding: IntegrationActionBinding };

export default function IntegrationActionButton({ binding }: Props) {
  const [pending, start] = useTransition();
  const toast = useToast();

  function run() {
    start(async () => {
      const { status, message } = await binding.action();
      toast(message, { tone: status === "error" ? "error" : "success" });
    });
  }

  const { icon, testId } = binding.control;
  const Icon = icon === "import" ? IconDatabaseImport : IconRefresh;
  return (
    <Button onClick={run} disabled={pending} data-testid={testId}>
      <Icon
        className={`h-4 w-4 ${icon === "sync" && pending ? "animate-spin motion-reduce:animate-none" : ""}`}
        stroke={1.75}
      />
      {binding.copy[pending ? 1 : 0]}
      {binding.count ? <span className="badge">{binding.count}</span> : null}
    </Button>
  );
}
