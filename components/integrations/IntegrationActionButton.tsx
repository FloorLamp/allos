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
      {/* A BADGE INSIDE A CONTROL IS CONTENT, NOT A CONTROL. The box spends what
          the element's own line box leaves over, so that line box is also the
          tallest child the control can hold before it grows past 34 — and
          `.badge`'s own block padding put this at 22px inside a 16px line, which
          rendered the button 40 beside its 34px neighbours (#3938). `py-0
          leading-none` keeps the badge's paint and gives up the padding it does
          not need in here. */}
      {binding.count ? (
        <span className="badge py-0 leading-none">{binding.count}</span>
      ) : null}
    </Button>
  );
}
