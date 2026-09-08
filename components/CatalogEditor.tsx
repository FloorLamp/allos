"use client";

import { useState, type ComponentType } from "react";
import { IconPlus } from "@tabler/icons-react";
import Button from "./Button";
import ModalShell from "./ModalShell";
import { useCreateActionLabel } from "./CreateAction";

export interface CatalogFormCallbacks<Item = unknown> {
  onSaved: (item: Item) => void;
  onCancel: () => void;
  onPendingChange?: (pending: boolean) => void;
}

export function CatalogCreateControl({
  onActivate,
}: {
  onActivate: () => void;
}) {
  const label = useCreateActionLabel();
  return (
    <Button onClick={onActivate}>
      <IconPlus className="size-4" aria-hidden />
      {label}
    </Button>
  );
}

export interface CatalogEditorProps<Props, Item> {
  Form: ComponentType<Props & CatalogFormCallbacks<Item>>;
  formProps: Props;
  title: string;
}

export function CatalogFormDialog<Props, Item>({
  Form,
  formProps,
  title,
  onClose,
}: CatalogEditorProps<Props, Item> & { onClose: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <ModalShell title={title} onClose={onClose} closeDisabled={pending}>
      <Form
        {...formProps}
        onSaved={onClose}
        onCancel={onClose}
        onPendingChange={setPending}
      />
    </ModalShell>
  );
}

export default function CatalogEditor<Props, Item>({
  create = false,
  ...props
}: CatalogEditorProps<Props, Item> & { create?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {create ? (
        <CatalogCreateControl onActivate={() => setOpen(true)} />
      ) : (
        <Button onClick={() => setOpen(true)}>Edit</Button>
      )}
      {open && <CatalogFormDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
