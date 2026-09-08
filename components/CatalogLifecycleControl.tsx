"use client";

import { useTransition } from "react";
import Button from "./Button";
import { useToast } from "./Toast";

export interface CatalogLifecycle {
  verb: string;
  reverse: string;
  past: string;
  reversePast: string;
  dated: boolean;
}

export default function CatalogLifecycleControl({
  name,
  inactive,
  lifecycle,
  action,
  testId,
}: {
  name: string;
  inactive: boolean;
  lifecycle: CatalogLifecycle;
  action: (
    inactive: boolean
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  testId?: string;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  return (
    <Button
      disabled={pending}
      data-testid={testId}
      onClick={() =>
        startTransition(async () => {
          const result = await action(!inactive);
          if (!result.ok) {
            toast(result.error, { tone: "error" });
            return;
          }
          toast(`${inactive ? lifecycle.reversePast : lifecycle.past} ${name}`);
        })
      }
    >
      {inactive ? lifecycle.reverse : lifecycle.verb}
    </Button>
  );
}
