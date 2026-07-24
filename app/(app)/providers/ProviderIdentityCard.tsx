"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  IconPhone,
  IconMapPin,
  IconId,
  IconPencil,
  IconStethoscope,
  IconArchive,
  IconArchiveOff,
} from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import OpenInMaps from "@/components/OpenInMaps";
import Combobox from "@/components/Combobox";
import { useToast } from "@/components/Toast";
import { NUCC_LABEL_OPTIONS } from "@/lib/nucc-taxonomy";
import type { Provider } from "@/lib/types";
import { updateProviderAction, setProviderArchivedAction } from "./actions";

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
  // Specialty is a controlled Combobox (#1177) over the curated NUCC labels — fuzzy
  // search across the hundreds-long taxonomy, free text preserved.
  const [specialty, setSpecialty] = useState(provider.specialty ?? "");
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
          <label className="label" htmlFor="prov-specialty">
            Specialty
          </label>
          {/* Fuzzy Combobox over the curated NUCC labels (#1056/#1177). */}
          <Combobox
            id="prov-specialty"
            name="specialty"
            ariaLabel="Specialty"
            value={specialty}
            onChange={setSpecialty}
            options={NUCC_LABEL_OPTIONS}
            allowFreeText
            placeholder="e.g. Cardiology"
          />
          {/* Round-trip the imported NUCC code so an untouched edit keeps it. */}
          <input
            type="hidden"
            name="specialty_code"
            value={provider.specialty_code ?? ""}
          />
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
    provider.specialty ||
    provider.npi ||
    provider.identifier ||
    provider.phone ||
    provider.address;

  async function toggleArchive() {
    const fd = new FormData();
    fd.set("id", String(provider.id));
    fd.set("archived", provider.archived ? "0" : "1");
    const res = await setProviderArchivedAction(fd);
    if (res?.error) {
      toast(res.error);
      return;
    }
    toast(provider.archived ? "Provider unarchived" : "Provider archived");
    router.refresh();
  }

  return (
    <div className="card" data-testid="provider-identity">
      {provider.archived ? (
        <div
          className="mb-3 inline-flex items-center gap-1.5 rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
          data-testid="provider-archived-badge"
        >
          <IconArchive className="h-3.5 w-3.5" stroke={1.75} />
          Archived
        </div>
      ) : null}
      <div className="flex items-start justify-between gap-3">
        <dl className="min-w-0 flex-1 space-y-2 text-sm">
          {provider.specialty ? (
            <div
              className="flex items-center gap-2 text-slate-600 dark:text-slate-300"
              data-testid="provider-specialty"
            >
              <IconStethoscope
                className="h-4 w-4 shrink-0 text-slate-400"
                stroke={1.75}
              />
              <span>{provider.specialty}</span>
            </div>
          ) : null}
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
            <p className="text-slate-500 dark:text-slate-400">
              No identity details on file (name only).
            </p>
          ) : null}
        </dl>
        {canEdit ? (
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <button
              type="button"
              className="btn-ghost inline-flex items-center gap-1.5 text-sm"
              onClick={() => setEditing(true)}
              data-testid="provider-edit-button"
            >
              <IconPencil className="h-4 w-4" stroke={1.75} />
              Edit
            </button>
            <button
              type="button"
              className="btn-ghost inline-flex items-center gap-1.5 text-sm"
              onClick={toggleArchive}
              data-testid="provider-archive-button"
            >
              {provider.archived ? (
                <>
                  <IconArchiveOff className="h-4 w-4" stroke={1.75} />
                  Unarchive
                </>
              ) : (
                <>
                  <IconArchive className="h-4 w-4" stroke={1.75} />
                  Archive
                </>
              )}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
