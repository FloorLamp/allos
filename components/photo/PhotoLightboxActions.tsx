"use client";

import { useEffect } from "react";
import Button from "@/components/Button";
import { useToast } from "@/components/Toast";
import { useConfirmedAction } from "@/components/useConfirmedAction";

type DeleteResult = { ok: true } | { ok: false; error: string };
type Props = {
  remove: () => Promise<DeleteResult>;
  close: () => void;
  testId?: string;
};

export const Action = Button;

export default function PhotoDeleteAction({ remove, close, testId }: Props) {
  const toast = useToast();
  const { run, pending, result } = useConfirmedAction(
    {
      title: "Delete this photo?",
      message: "This photo and its stored files will be permanently deleted.",
      confirmLabel: "Delete photo",
      danger: true,
    },
    remove
  );

  useEffect(() => {
    if (!result) return;
    if (!result.ok) return toast(result.error, { tone: "error" });
    toast("Photo deleted.");
    close();
  }, [close, result, toast]);

  return (
    <Button disabled={pending} onClick={run} data-testid={testId}>
      {pending ? "Deleting…" : "Delete photo"}
    </Button>
  );
}
