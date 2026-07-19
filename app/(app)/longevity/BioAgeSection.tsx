import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getUserAge } from "@/lib/settings";
import { getBioAgeReadings } from "@/lib/queries";
import {
  bioAgeSurface,
  inputCompleteness,
  isBioAgeHiddenForAge,
} from "@/lib/bio-age";
import BioAgeHero from "@/components/BioAgeHero";

// Longevity §1 — BioAge (#1042 phase 4): the PhenoAge hero + pace-of-aging +
// missing-inputs CTA, REUSED from the Biomarkers page's BioAgeHero (never a fork
// of the engine). Whether anything renders is the ONE shared bioAgeSurface
// decision (lib/bio-age.ts) — the same call the hero itself makes — so this
// wrapper can't emit an empty anchored section when the hero would return null.
// Deliberately wider than strict pillar membership: the CHECKLIST state (partial
// panel, no complete draw → no bio-age pillar) still renders, because the
// missing-inputs CTA is the door to completing the panel.
export default async function BioAgeSection() {
  const { profile } = await requireSession();
  const age = getUserAge(profile.id);
  const hiddenForProfile =
    isBioAgeHiddenForAge(age) || isTrainingRestricted(profile.id);
  const { draws, presentInputs } = getBioAgeReadings(profile.id);
  const surface = bioAgeSurface(
    hiddenForProfile,
    draws.length,
    inputCompleteness(presentInputs).presentCount
  );
  if (surface === "hidden") return null;

  return (
    <section
      id="bio-age"
      data-testid="longevity-bio-age"
      className="scroll-mt-20"
    >
      <BioAgeHero />
    </section>
  );
}
