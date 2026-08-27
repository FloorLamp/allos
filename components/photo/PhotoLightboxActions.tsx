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
    <button
      type="button"
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={run}
      data-testid={testId}
      className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-rose-800 bg-rose-950 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-rose-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0 sm:min-w-0"
    >
      {pending ? "Deleting…" : "Delete photo"}
    </button>
  );
}
