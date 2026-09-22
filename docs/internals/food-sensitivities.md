# Food sensitivities

A food sensitivity is the person’s statement: after a trigger, an effect. It
is not an allergy: it never gates, warns or reorders, and never reaches the
passport or emergency card. The app never proposes one.

- **Declaration.** `food_sensitivities`, through
  [food-sensitivity-store.ts](../../lib/food-sensitivity-store.ts). The trigger
  is a food group or a meal property
  ([food-sensitivities.ts](../../lib/food-sensitivities.ts)); the effect comes
  from [gi-effects.ts](../../lib/gi-effects.ts). Stop keeps the row.
- **Mark.** `food_log_events.properties`, a JSON array written by the tap. The
  food sheet offers `This meal` chips for declared properties only; a pressed
  chip marks every tap of that day and meal, usual bundles included. Undo
  deletes the row, mark included. Past marks outlive the declaration. Telegram
  and offline taps carry none.

Owner rulings (2026-09-11): the pair stays silent unless the effect was logged
on half the window’s days or more, and above that an unlogged day counts as
zero; declarations live on the Nutrition Manage tab.
