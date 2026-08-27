"use client";

import Button, { type ButtonProps } from "@/components/Button";
import { useToast } from "@/components/Toast";
import { useConfirmedAction } from "@/components/useConfirmedAction";

type DeleteResult = { ok: true } | { ok: false; error: string };
type ActionProps = Pick<
  ButtonProps,
  "children" | "type" | "disabled" | "onClick" | "data-testid"
>;
type Props = {
  remove: () => Promise<DeleteResult>;
  close: () => void;
  testId?: string;
};

export function LightboxAction(props: ActionProps) {
  return (
    <span className="inline-flex [&>.button-control]:border-slate-600 [&>.button-control]:bg-slate-800 [&>.button-control]:text-white [&>.button-control:hover]:bg-slate-700 [&>.button-control:focus-visible]:ring-white">
      <Button {...props} />
    </span>
  );
}

export default function PhotoDeleteAction({ remove, close, testId }: Props) {
  const toast = useToast();
  const { run, pending } = useConfirmedAction(
    {
      title: "Delete this photo?",
      message: "This photo and its stored files will be permanently deleted.",
      confirmLabel: "Delete photo",
      danger: true,
    },
    async () => {
      const result = await remove();
      if (!result.ok) return toast(result.error, { tone: "error" });
      toast("Photo deleted.");
      close();
    }
  );

  return (
    <span className="inline-flex [&>.button-control]:border-rose-800 [&>.button-control]:bg-rose-950 [&>.button-control]:text-rose-100 [&>.button-control:hover]:bg-rose-900 [&>.button-control:focus-visible]:ring-white">
      <Button disabled={pending} onClick={run} data-testid={testId}>
        {pending ? "Deleting…" : "Delete photo"}
      </Button>
    </span>
  );
}
