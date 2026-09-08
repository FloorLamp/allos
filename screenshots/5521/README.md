# Quick logger sheet presentation (#5521)

These screenshots compare the same seeded profiles, dates, entry state, and
viewports before and after the presentation changes.

- `before/` was captured from `d774389179856dbbe4ca38c1489edf77228a2f97`.
- `after/` was captured from the changes through
  `34c485fa07a304faffbd025db10663a06e8226ce`.
- `390` images use a 390 × 844 viewport. `1280` images use a 1280 × 900
  viewport.
- The practice fixture is `Red light therapy`; the dose fixture is
  `Hydrocortisone 2.5% Cream — evening application`.

The after capture batch passed for all eight images. A separate browser probe
measured both split practice controls at 34 px and reached each control
independently with a touch five pixels beyond its visible block edge, exercising
the shared 46 px coarse-pointer target. The Mood comparisons wait for the
animated Details frame to reach the bottom of its content. The supplementary
`after/mood-1280-bottom-reach.png` shows Note and Save after that measured wait;
the enabled Save was inside the viewport and all clipping ancestors and was the
element returned by center hit testing. The final full overlay test file and
recorded repository gates are tracked separately from this visual evidence.
