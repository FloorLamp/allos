"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { IconX, IconRotateClockwise } from "@tabler/icons-react";
import type { Equipment } from "@/lib/types";
import type { WeightUnit } from "@/lib/settings";
import { kgTo, toKg, round, stripNegative } from "@/lib/units";
import {
  PLATE_DENOMINATIONS,
  STANDARD_BAR_WEIGHT,
  MAX_PLATES_PER_SIDE,
  platesForWeight,
  platesPerSideWeight,
  barbellTotal,
} from "@/lib/plates";
import { createEquipmentAction } from "@/app/(app)/settings/equipment/actions";

// select() sentinel for the "create a custom barbell" row at the bottom.
const NEW_BAR = "__new__";

// Plate fill colors, following IPF/competition plate conventions so each
// denomination is recognizable at a glance. Falls back to slate for any unknown.
// A metallic sheen (url(#plateShade)) is layered on top at render time, so these
// are the flat base hues. Light plates lean on the stroke to stay visible.
const PLATE_COLORS: Record<WeightUnit, Map<number, string>> = {
  kg: new Map([
    [25, "#dc2626"], // red
    [20, "#2563eb"], // blue
    [15, "#eab308"], // yellow
    [10, "#16a34a"], // green
    [5, "#e2e8f0"], // white
    [2.5, "#111827"], // black
    [1.25, "#9ca3af"], // chrome
  ]),
  lb: new Map([
    [45, "#2563eb"], // blue
    [35, "#eab308"], // yellow
    [25, "#16a34a"], // green
    [10, "#111827"], // black
    [5, "#64748b"], // gray
    [2.5, "#94a3b8"], // light gray
    [1.25, "#cbd5e1"], // chrome
  ]),
};

// A schematic barbell loaded symmetrically: plates sized by weight (taller =
// heavier) and ordered largest-inner, mirrored on both sides like a real bar.
function BarbellSvg({
  platesPerSide,
  unit,
}: {
  platesPerSide: number[];
  unit: WeightUnit;
}) {
  const W = 320;
  const H = 132;
  const cx = W / 2;
  const midY = H / 2;
  const gripHalf = 58; // half-width of the central knurl (longer shaft = wider bar)
  const collarW = 8; // inner collar block
  const sleeveTip = 16; // bar sticking out past the last plate
  const maxDenom = PLATE_DENOMINATIONS[unit][0];
  const colors = PLATE_COLORS[unit];

  const sorted = [...platesPerSide].sort((a, b) => b - a); // largest loads inner
  const n = sorted.length;
  const halfAvail = cx - gripHalf - collarW - sleeveTip - 6;
  const step = Math.min(13, n > 0 ? halfAvail / n : 13);
  const plateW = Math.max(4, step * 0.78);
  const heightFor = (w: number) =>
    26 + Math.min(1, w / maxDenom) * (H - 40 - 26);

  const rects: {
    x: number;
    y: number;
    w: number;
    h: number;
    fill: string;
    key: string;
  }[] = [];
  let x = cx + gripHalf + collarW; // inner edge of first right-side plate
  for (let i = 0; i < n; i++) {
    const h = heightFor(sorted[i]);
    const fill = colors.get(sorted[i]) ?? "#64748b";
    rects.push({ x, y: midY - h / 2, w: plateW, h, fill, key: `r${i}` });
    rects.push({
      x: cx - (x - cx) - plateW, // mirror onto the left side
      y: midY - h / 2,
      w: plateW,
      h,
      fill,
      key: `l${i}`,
    });
    x += step;
  }
  const sleeveR = x + sleeveTip;
  const sleeveL = cx - (sleeveR - cx);

  // Evenly spaced hatch lines suggesting the knurled grip.
  const knurls = 19;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label={`Barbell loaded with ${n} plate${n === 1 ? "" : "s"} per side`}
    >
      <defs>
        {/* Vertical sheen layered over every plate so a flat disc reads round. */}
        <linearGradient id="plateShade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={0.5} />
          <stop offset="42%" stopColor="#ffffff" stopOpacity={0.06} />
          <stop offset="58%" stopColor="#000000" stopOpacity={0.06} />
          <stop offset="100%" stopColor="#000000" stopOpacity={0.36} />
        </linearGradient>
        {/* Brushed-steel gradient for the shaft and grip. */}
        <linearGradient id="barSteel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f1f5f9" />
          <stop offset="50%" stopColor="#cbd5e1" />
          <stop offset="100%" stopColor="#64748b" />
        </linearGradient>
        {/* Slightly darker steel for the collars so they sit behind the plates. */}
        <linearGradient id="collarSteel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e2e8f0" />
          <stop offset="50%" stopColor="#94a3b8" />
          <stop offset="100%" stopColor="#475569" />
        </linearGradient>
      </defs>

      {/* bar shaft + sleeves */}
      <rect
        x={sleeveL}
        y={midY - 3.5}
        width={sleeveR - sleeveL}
        height={7}
        rx={3.5}
        fill="url(#barSteel)"
        stroke="#475569"
        strokeOpacity={0.35}
        strokeWidth={0.5}
      />
      {/* plates: colored disc + sheen overlay */}
      {rects.map((r) => (
        <g key={r.key}>
          <rect
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            rx={2.5}
            fill={r.fill}
          />
          <rect
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            rx={2.5}
            fill="url(#plateShade)"
            stroke="#1e293b"
            strokeOpacity={0.45}
            strokeWidth={0.75}
          />
        </g>
      ))}
      {/* inner collars */}
      <rect
        x={cx - gripHalf - collarW}
        y={midY - 12}
        width={collarW}
        height={24}
        rx={2}
        fill="url(#collarSteel)"
        stroke="#475569"
        strokeOpacity={0.4}
        strokeWidth={0.5}
      />
      <rect
        x={cx + gripHalf}
        y={midY - 12}
        width={collarW}
        height={24}
        rx={2}
        fill="url(#collarSteel)"
        stroke="#475569"
        strokeOpacity={0.4}
        strokeWidth={0.5}
      />
      {/* knurled grip */}
      <rect
        x={cx - gripHalf}
        y={midY - 5.5}
        width={gripHalf * 2}
        height={11}
        rx={2.5}
        fill="url(#barSteel)"
        stroke="#475569"
        strokeOpacity={0.3}
        strokeWidth={0.5}
      />
      {Array.from({ length: knurls }).map((_, i) => {
        const gx = cx - gripHalf + 3 + (i * (gripHalf * 2 - 6)) / (knurls - 1);
        return (
          <line
            key={i}
            x1={gx}
            y1={midY - 4.5}
            x2={gx}
            y2={midY + 4.5}
            stroke="#475569"
            strokeOpacity={0.45}
            strokeWidth={0.6}
          />
        );
      })}
    </svg>
  );
}

// Build a target set weight from a barbell + plates loaded on both sides. Each
// plate button adds one plate PER SIDE (so it counts twice toward the total).
export default function PlateBuilderModal({
  unit,
  equipment,
  initialBarId,
  initialWeight,
  onUse,
  onCreated,
  onClose,
}: {
  unit: WeightUnit;
  equipment: Equipment[];
  initialBarId: number | null;
  // A weight already in the set's field (display unit). When > 0, the builder
  // opens pre-loaded with the plates that reach it (without going over).
  initialWeight: number;
  onUse: (total: number, barId: number | null) => void;
  onCreated: (e: Equipment) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  // Only equipment with a known weight can act as a bar.
  const bars = useMemo(
    () => equipment.filter((e) => e.weight_kg != null),
    [equipment]
  );
  // A null barId means the built-in Standard Barbell (no saved equipment). A real
  // equipment id is honored when passed in (the set was already tagged with a bar).
  const initBarId =
    initialBarId != null && bars.some((b) => b.id === initialBarId)
      ? initialBarId
      : null;
  const [barId, setBarId] = useState<number | null>(initBarId);
  // Seed the plates from any weight already entered in the set, using the weight
  // of the bar selected on open (the tagged bar, else the Standard Barbell).
  // Computed once, at mount, inside the initializer.
  const [plates, setPlates] = useState<number[]>(() => {
    if (!(initialWeight > 0)) return [];
    const initBar =
      initBarId != null ? bars.find((b) => b.id === initBarId) : undefined;
    const initBarWeight =
      initBar?.weight_kg != null
        ? round(kgTo(initBar.weight_kg, unit), 2)
        : STANDARD_BAR_WEIGHT[unit];
    return platesForWeight(initialWeight, initBarWeight, unit);
  }); // per side, display unit

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newWeight, setNewWeight] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bar = bars.find((b) => b.id === barId) ?? null;
  // Per-side plate sum (re-rounded so repeated fractional plates don't drift).
  const perSide = platesPerSideWeight(plates);
  const platesSorted = [...plates].sort((a, b) => b - a);
  const atPlateLimit = plates.length >= MAX_PLATES_PER_SIDE;

  // Whether the new-bar fields are valid, and the bar weight typed (display unit).
  const newWeightNum = Number(newWeight);
  const newWeightInvalid =
    newWeight.trim() !== "" &&
    (!Number.isFinite(newWeightNum) || newWeightNum < 0);
  const newBarValid =
    newName.trim() !== "" && newWeight.trim() !== "" && !newWeightInvalid;

  // Effective bar weight drives the live total — while creating, it follows the
  // typed weight so "Use this" reflects the bar about to be made; with no bar
  // selected it's the built-in Standard Barbell.
  const effBarWeight = creating
    ? newBarValid
      ? round(newWeightNum, 2)
      : 0
    : bar?.weight_kg != null
      ? round(kgTo(bar.weight_kg, unit), 2)
      : STANDARD_BAR_WEIGHT[unit];
  const total = barbellTotal(effBarWeight, plates);

  function addPlate(p: number) {
    setPlates((prev) =>
      prev.length >= MAX_PLATES_PER_SIDE ? prev : [...prev, p]
    );
  }

  // Returns the created bar, or null on validation/server error.
  async function createBar(): Promise<Equipment | null> {
    if (!newName.trim()) {
      setError("Name the bar.");
      return null;
    }
    if (
      newWeight.trim() === "" ||
      !Number.isFinite(newWeightNum) ||
      newWeightNum < 0
    ) {
      setError("Enter a valid bar weight (0 or more).");
      return null;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await createEquipmentAction({
        name: newName.trim(),
        weight_kg: toKg(newWeightNum, unit),
        category: "Barbell",
      });
      if (!res.ok) {
        setError(res.error);
        return null;
      }
      onCreated(res.equipment);
      setBarId(res.equipment.id);
      setCreating(false);
      setNewName("");
      setNewWeight("");
      router.refresh();
      return res.equipment;
    } finally {
      setSaving(false);
    }
  }

  // "Use this": if mid-creation, create the bar first (when valid) so the total
  // uses the new bar; then hand the total + bar back. For the Standard Barbell
  // and any built bar, barId is null/the new id respectively.
  async function handleUse() {
    if (creating) {
      const created = await createBar();
      if (!created) return;
      const bw = round(kgTo(created.weight_kg as number, unit), 2);
      const t = barbellTotal(bw, plates);
      if (t <= 0) return;
      onUse(t, created.id);
      return;
    }
    if (total <= 0) return;
    onUse(total, barId);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8 dark:bg-black/70"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-4 shadow-xl sm:p-5 dark:bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
            Plate builder
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
            aria-label="Close"
          >
            <IconX className="h-5 w-5" />
          </button>
        </div>

        {/* Bar selector / create */}
        <div className="mt-4">
          <label className="label">Barbell</label>
          {!creating ? (
            <select
              value={barId == null ? "standard" : String(barId)}
              onChange={(e) => {
                const v = e.target.value;
                if (v === NEW_BAR) {
                  setCreating(true);
                  setError(null);
                } else {
                  setBarId(v === "standard" ? null : Number(v));
                }
              }}
              className="input"
            >
              <option value="standard">
                Standard Barbell — {STANDARD_BAR_WEIGHT[unit]} {unit}
              </option>
              {bars.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} — {round(kgTo(b.weight_kg as number, unit), 2)}{" "}
                  {unit}
                </option>
              ))}
              <option value={NEW_BAR}>+ Create custom barbell…</option>
            </select>
          ) : (
            <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Olympic bar"
                  className="input"
                  autoFocus
                />
                <input
                  value={newWeight}
                  onChange={(e) => setNewWeight(stripNegative(e.target.value))}
                  inputMode="decimal"
                  placeholder={`weight (${unit})`}
                  aria-invalid={newWeightInvalid || undefined}
                  className={`input ${
                    newWeightInvalid
                      ? "border-rose-300 dark:border-rose-800"
                      : ""
                  }`}
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={createBar}
                  disabled={saving}
                  className="btn disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Create bar"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setError(null);
                  }}
                  className="btn-ghost"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Visualization */}
        <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-ink-950">
          <BarbellSvg platesPerSide={plates} unit={unit} />
        </div>

        {/* Plate buttons */}
        <div className="mt-4">
          <label className="label">Add plates (per side)</label>
          <div className="flex flex-wrap gap-2">
            {PLATE_DENOMINATIONS[unit].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => addPlate(p)}
                disabled={atPlateLimit}
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:border-brand-400 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-ink-900 dark:text-slate-200 dark:hover:bg-brand-950"
              >
                +{p}
              </button>
            ))}
          </div>
          {atPlateLimit && (
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              Max {MAX_PLATES_PER_SIDE} plates per side.
            </p>
          )}
        </div>

        {/* Loaded plates */}
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <label className="label mb-0">Loaded (each side)</label>
            {plates.length > 0 && (
              <button
                type="button"
                onClick={() => setPlates([])}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-rose-500 dark:text-slate-400"
              >
                <IconRotateClockwise className="h-3.5 w-3.5" /> Reset
              </button>
            )}
          </div>
          {plates.length === 0 ? (
            <p className="mt-1 text-sm text-slate-400 dark:text-slate-500">
              No plates yet — tap a plate above.
            </p>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {platesSorted.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  title="Remove one"
                  onClick={() => {
                    // Remove one plate of this denomination.
                    const idx = plates.indexOf(p);
                    setPlates((prev) => prev.filter((_, j) => j !== idx));
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-rose-950"
                >
                  {p} <IconX className="h-3 w-3" />
                </button>
              ))}
            </div>
          )}
        </div>

        {error && (
          <p className="mt-3 text-sm text-rose-500 dark:text-rose-400">
            {error}
          </p>
        )}

        {/* Total + actions */}
        <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4 dark:border-slate-800">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
              Total
            </div>
            <div className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
              {total} {unit}
            </div>
            <div className="text-xs text-slate-400 dark:text-slate-500">
              {effBarWeight} {unit} bar + {round(perSide * 2, 2)} {unit} plates
            </div>
          </div>
          <button
            type="button"
            onClick={handleUse}
            disabled={saving || (creating ? !newBarValid : total <= 0)}
            className="btn disabled:opacity-50"
          >
            Use this
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
