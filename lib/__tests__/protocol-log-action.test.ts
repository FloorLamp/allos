import { describe, expect, it } from "vitest";
import { protocolLogAction } from "@/lib/protocol-log-action";

describe("protocolLogAction (#1584)", () => {
  it("dispatches every protocol practice scope to its owning logger", () => {
    expect(protocolLogAction("practice", "Sauna")).toEqual({
      kind: "practice",
      practice: "Sauna",
      label: "Log session",
    });
    expect(protocolLogAction("type", "cardio")).toEqual({
      kind: "activity",
      type: "cardio",
      label: "Log cardio session",
    });
    expect(protocolLogAction("food_group", "fatty_fish")).toEqual({
      kind: "food",
      foodGroup: "fatty_fish",
      label: "Log servings",
    });
  });

  it("does not open an activity editor for a corrupt type target", () => {
    expect(protocolLogAction("type", "unknown")).toBeNull();
  });
});
