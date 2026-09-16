// THE DOSE FORM'S VOCABULARY, read once per profile.
//
// Which items exist — a retired item still took the doses history keeps listing, so the
// list is every item, not the active ones — and which of them still have a LIVE dose to
// log against. Both surfaces that mount the cross-item dose ledger (Home's record band
// and the record's own day view) asked this question with the same twenty lines; it is
// one question about one profile's intake, so it is answered here.
//
// NO READ OF ITS OWN. `getIntakeItems` and `getIntakeDoses` are both snapshot-cached, so
// a caller that already took either pays nothing for asking again.

import { isOnDemand } from "@/lib/intake-schedule";
import type { IntakeDose, IntakeItemKind } from "@/lib/types";
import { getIntakeDoses, getIntakeItems } from "./schedule";

// An item the ledger can log a past dose against, with the live doses it offers. Only
// items with a LIVE dose can be logged against, so an item whose doses are all retired
// carries an empty list and is simply absent from the picker (its history still lists).
export interface DoseLedgerItem {
  id: number;
  name: string;
  kind: IntakeItemKind;
  product: string | null;
  asNeeded: boolean;
  doses: Pick<IntakeDose, "id" | "amount" | "time_of_day" | "versions">[];
}

export function doseLedgerItems(profileId: number): DoseLedgerItem[] {
  const dosesByItem = new Map<number, DoseLedgerItem["doses"]>();
  for (const dose of getIntakeDoses(profileId)) {
    const list = dosesByItem.get(dose.item_id) ?? [];
    list.push({
      id: dose.id,
      amount: dose.amount,
      time_of_day: dose.time_of_day,
      versions: dose.versions,
    });
    dosesByItem.set(dose.item_id, list);
  }
  return getIntakeItems(profileId).map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    product: item.product,
    asNeeded: isOnDemand(item),
    doses: dosesByItem.get(item.id) ?? [],
  }));
}
