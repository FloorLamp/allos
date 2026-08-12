export interface SharedSupplyMemberLabelInput {
  itemId: number;
  profileId: number;
  name: string;
  kind: "supplement" | "medication";
  doseAmounts: readonly string[];
}

// Cabinet links normally stay as the item's name. When one profile has several
// same-named linked records, add the clinical kind and distinct dose amounts so
// each action names what it opens. Truly identical records get a stable ordinal as
// the final fallback; visible and accessible labels must never collapse to the same
// action name for different item ids.
export function sharedSupplyMemberLabels(
  members: readonly SharedSupplyMemberLabelInput[]
): Map<number, string> {
  const byName = new Map<string, SharedSupplyMemberLabelInput[]>();
  for (const member of members) {
    const key = `${member.profileId}\0${member.name.trim().toLocaleLowerCase()}`;
    const group = byName.get(key);
    if (group) group.push(member);
    else byName.set(key, [member]);
  }

  const labels = new Map<number, string>();
  for (const group of byName.values()) {
    if (group.length === 1) {
      labels.set(group[0].itemId, group[0].name);
      continue;
    }

    const detailed = group.map((member) => {
      const amounts = [
        ...new Set(
          member.doseAmounts.map((amount) => amount.trim()).filter(Boolean)
        ),
      ];
      const kind = member.kind === "medication" ? "Medication" : "IntakeItem";
      return {
        member,
        label: [member.name, kind, amounts.join(", ") || null]
          .filter(Boolean)
          .join(" · "),
      };
    });
    const byDetail = new Map<string, typeof detailed>();
    for (const item of detailed) {
      const key = item.label.toLocaleLowerCase();
      const collisions = byDetail.get(key);
      if (collisions) collisions.push(item);
      else byDetail.set(key, [item]);
    }
    for (const collisions of byDetail.values()) {
      collisions.forEach(({ member, label }, index) => {
        labels.set(
          member.itemId,
          collisions.length > 1 ? `${label} · Item ${index + 1}` : label
        );
      });
    }
  }
  return labels;
}
