"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconPhone, IconMapPin, IconId, IconPencil } from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import OpenInMaps from "@/components/OpenInMaps";
import { useToast } from "@/components/Toast";
import type { Provider } from "@/lib/types";
import { updateProviderAction } from "./actions";

// The GLOBAL identity card for a provider (issue #275): name, kind, NPI/identifier,
// phone (tap-to-call), address. Read-only for everyone; an admin gets an inline
// edit form (`canEdit`). Editing is a global mutation, so the server action re-checks
// requireAdmin() — hiding the button is only cosmetic.
export default function ProviderIdentityCard({
  provider,
  canEdit,
}: {
  provider: Provider;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const toast = useToast();

  async function handle(formData: FormData) {
    setError(null);
    const res = await updateProviderAction(formData);
    if (res?.error) {
      setError(res.error);
      return;
    }
    toast("Provider updated");
    setEditing(false);
    router.refresh();
  }

  if (editing) {
    return (
      <form
        action={handle}
        className="card space-y-3"
        data-testid="provider-edit-form"
      >
        <input type="hidden" name="id" value={provider.id} />
        <div>
          <label className="label" htmlFor="prov-name">
            Name
          </label>
          <input
            id="prov-name"
            name="name"
            className="input"
            defaultValue={provider.name}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="prov-type">
            Kind
          </label>
          <select
            id="prov-type"
            name="type"
            className="input"
            defaultValue={provider.type}
          >
            <option value="individual">Individual</option>
            <option value="organization">Organization</option>
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="prov-npi">
              NPI
            </label>
            <input
              id="prov-npi"
              name="npi"
              className="input"
              defaultValue={provider.npi ?? ""}
            />
          </div>
          <div>
            <label className="label" htmlFor="prov-identifier">
              Identifier
            </label>
            <input
              id="prov-identifier"
              name="identifier"
              className="input"
              defaultValue={provider.identifier ?? ""}
            />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="prov-phone">
            Phone
          </label>
          <input
            id="prov-phone"
            name="phone"
            className="input"
            defaultValue={provider.phone ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor="prov-address">
            Address
          </label>
          <input
            id="prov-address"
            name="address"
            className="input"
            defaultValue={provider.address ?? ""}
          />
        </div>
        {error ? (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        ) : null}
        <div className="flex gap-2">
          <SubmitButton>Save</SubmitButton>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setError(null);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  const hasDetails =
    provider.npi || provider.identifier || provider.phone || provider.address;

  return (
    <div className="card" data-testid="provider-identity">
      <div className="flex items-start justify-between gap-3">
        <dl className="min-w-0 flex-1 space-y-2 text-sm">
          {provider.npi ? (
            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <IconId
                className="h-4 w-4 shrink-0 text-slate-400"
                stroke={1.75}
              />
              <span className="tabular-nums">NPI {provider.npi}</span>
            </div>
          ) : null}
          {provider.identifier ? (
            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <IconId
                className="h-4 w-4 shrink-0 text-slate-400"
                stroke={1.75}
              />
              <span className="break-all">{provider.identifier}</span>
            </div>
          ) : null}
          {provider.phone ? (
            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <IconPhone
                className="h-4 w-4 shrink-0 text-slate-400"
                stroke={1.75}
              />
              <a
                href={`tel:${provider.phone.replace(/[^\d+]/g, "")}`}
                className="text-brand-700 hover:underline dark:text-brand-300"
              >
                {provider.phone}
              </a>
            </div>
          ) : null}
          {provider.address ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-600 dark:text-slate-300">
              <IconMapPin
                className="h-4 w-4 shrink-0 text-slate-400"
                stroke={1.75}
              />
              <span>{provider.address}</span>
              <OpenInMaps
                address={provider.address}
                label="Directions"
                showIcon={false}
                className="text-xs text-brand-700 hover:underline dark:text-brand-300"
              />
            </div>
          ) : null}
          {!hasDetails ? (
            <p className="text-slate-400 dark:text-slate-500">
              No identity details on file (name only).
            </p>
          ) : null}
        </dl>
        {canEdit ? (
          <button
            type="button"
            className="btn-ghost inline-flex items-center gap-1.5 text-sm"
            onClick={() => setEditing(true)}
            data-testid="provider-edit-button"
          >
            <IconPencil className="h-4 w-4" stroke={1.75} />
            Edit
          </button>
        ) : null}
      </div>
    </div>
  );
}
