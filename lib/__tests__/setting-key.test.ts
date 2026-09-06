import { describe, expectTypeOf, it } from "vitest";
import type { SettingKey } from "@/lib/settings/kv";

// The type that refuses a new `*_prompted` settings key (issue #4840). A refused
// program never runs, so this is a type-level census: `SettingKey<K>` is K for every
// ordinary key and `never` for a planted marker — and the six primitives in
// lib/settings/kv.ts take `K & SettingKey<K>`, which is what turns `never` into a
// compile error at the call. The one pre-registry marker stays legal by name until
// its family migrates.
describe("SettingKey (#4840)", () => {
  it("keeps every ordinary key, literal or computed", () => {
    expectTypeOf<
      SettingKey<"notify_digest_hour">
    >().toEqualTypeOf<"notify_digest_hour">();
    expectTypeOf<SettingKey<string>>().toEqualTypeOf<string>();
    expectTypeOf<
      SettingKey<`notify_mute_${number}`>
    >().toEqualTypeOf<`notify_mute_${number}`>();
    expectTypeOf<SettingKey<"a_hour" | "b_hour">>().toEqualTypeOf<
      "a_hour" | "b_hour"
    >();
  });

  it("refuses a planted marker and keeps the one that predates the registry", () => {
    expectTypeOf<SettingKey<"steps_prompted">>().toBeNever();
    expectTypeOf<SettingKey<"mood_checkin_prompted">>().toBeNever();
    expectTypeOf<
      SettingKey<"food_telegram_prompted">
    >().toEqualTypeOf<"food_telegram_prompted">();
    // A union that smuggles one in loses exactly that member.
    expectTypeOf<
      SettingKey<"a_hour" | "x_prompted">
    >().toEqualTypeOf<"a_hour">();
  });
});
