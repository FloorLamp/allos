# Quick logger sheet presentation (#5521)

These screenshots compare the same seeded profiles, dates, entry state, and
viewports before and after the presentation changes.

- `before/` was captured from `d774389179856dbbe4ca38c1489edf77228a2f97`.
- The practice and dose images in `after/` were captured from the changes
  through `34c485fa07a304faffbd025db10663a06e8226ce`.
- The measurements images in `after/` were refreshed from the current-main
  composition `c2ca26e99a79aca0e9d7a8c8d1d0dec3d7d120e5`, using the original
  fixture and frozen instant `2026-09-08T01:24:53.459Z`.
- The Mood images in `after/` were captured from the composed candidate
  `60cdb7bf4f46ca57b482cca1e13fae5bda0331f9`.
- `390` images use a 390 × 844 viewport. `1280` images use a 1280 × 900
  viewport.
- The practice fixture is `Red light therapy`; the dose fixture is
  `Hydrocortisone 2.5% Cream — evening application`.

The original after capture batch passed for all eight images, and the targeted
current-main refresh passed for both measurements images. A separate browser probe
measured both split practice controls at 34 px and reached each control
independently with a touch five pixels beyond its visible block edge, exercising
the shared 46 px coarse-pointer target. The Mood comparisons wait for the
animated Details frame to reach the bottom of its content. The supplementary
`after/mood-1280-bottom-reach.png` shows Note and Save after that measured wait;
the enabled Save was inside the viewport and all clipping ancestors and was the
element returned by center hit testing. The final full overlay test file and
recorded repository gates are tracked separately from this visual evidence.
