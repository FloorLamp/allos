import { liftInfo, muscleLabel, type Equipment } from "@/lib/lifts";
import { getExerciseGuide } from "@/lib/exercise-guides";
import MuscleAnatomy from "@/components/MuscleAnatomy";

// The "How to" section of the per-exercise surface (#734). It renders the static
// form-reference guide from lib/exercise-guides.ts (#733) — setup, execution cues,
// breathing, common mistakes, safety notes, and the per-implement cue when one
// applies. It is the ONE guide-rendering component shared by every surface:
// ExerciseDetailPanel embeds it, and the strength set editor's ⓘ overlay renders
// the same component (responsive-surfaces / one-computation convention — never a
// second exercise surface).
//
// Graceful absence: a custom (non-catalog) lift has no guide, so getExerciseGuide
// returns undefined and this renders nothing — the affordance/section simply
// doesn't appear, matching custom-lift behavior elsewhere.
//
// INFORMATIONAL FORM REFERENCE, NOT MEDICAL ADVICE. The app carries a medical
// passport, so the disclaimer is stated explicitly.
export default function ExerciseGuideSection({
  name,
  equipment,
}: {
  name: string;
  // The currently-selected implement, when the surface has one (the set editor
  // knows it). When omitted (the aggregate detail panel spans every variant), all
  // per-implement notes are shown, each labeled by its implement.
  equipment?: Equipment | null;
}) {
  const guide = getExerciseGuide(name);
  if (!guide) return null;

  // The anatomy figure (#737) shares the guide's graceful absence: it renders
  // only for catalog lifts (a guide exists ⇒ the lift is catalog, so liftInfo
  // resolves). Per-exercise mode is a pure LiftDef lookup — primary muscles
  // saturated, secondary muted — and the text list below always accompanies the
  // figure (never color-only).
  const info = liftInfo(name);
  const muscles =
    info && info.primaryMuscles.length > 0
      ? { primary: info.primaryMuscles, secondary: info.secondaryMuscles }
      : null;

  const equipmentNotes = guide.equipmentNotes ?? {};
  // Show only the current implement's note when one is given; otherwise every
  // implement note the guide carries (the panel isn't scoped to one implement).
  const notes: { eq: Equipment; note: string }[] = equipment
    ? equipmentNotes[equipment]
      ? [{ eq: equipment, note: equipmentNotes[equipment]! }]
      : []
    : (Object.entries(equipmentNotes) as [Equipment, string][]).map(
        ([eq, note]) => ({ eq, note })
      );

  return (
    <section data-testid="exercise-guide" className="mt-5">
      <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
        How to
      </h3>
      <p className="mb-3 text-xs italic text-slate-500 dark:text-slate-400">
        Form reference, not medical advice.
      </p>

      {muscles && (
        <div className="mt-3" data-testid="guide-muscles">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Muscles
          </h4>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            <span className="font-medium text-slate-700 dark:text-slate-200">
              Primary:
            </span>{" "}
            {muscles.primary.map(muscleLabel).join(", ")}
            {muscles.secondary.length > 0 && (
              <>
                {" · "}
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  Secondary:
                </span>{" "}
                {muscles.secondary.map(muscleLabel).join(", ")}
              </>
            )}
          </p>
          <MuscleAnatomy
            mode="exercise"
            primary={muscles.primary}
            secondary={muscles.secondary}
            className="mt-2 w-full max-w-[15rem]"
          />
        </div>
      )}

      <GuideList
        title="Setup"
        items={guide.setup}
        ordered
        testid="guide-setup"
      />
      <GuideList
        title="Execution"
        items={guide.execution}
        ordered
        testid="guide-execution"
      />

      {guide.breathing && (
        <div className="mt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Breathing
          </h4>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {guide.breathing}
          </p>
        </div>
      )}

      <GuideList
        title="Common mistakes"
        items={guide.commonMistakes}
        testid="guide-mistakes"
      />

      {guide.safetyNotes && guide.safetyNotes.length > 0 && (
        <GuideList
          title="Safety"
          items={guide.safetyNotes}
          testid="guide-safety"
        />
      )}

      {notes.length > 0 && (
        <div className="mt-3" data-testid="guide-equipment-notes">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Equipment notes
          </h4>
          <ul className="mt-1 space-y-1 text-sm text-slate-600 dark:text-slate-300">
            {notes.map(({ eq, note }) => (
              <li key={eq}>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {eq}:
                </span>{" "}
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function GuideList({
  title,
  items,
  ordered = false,
  testid,
}: {
  title: string;
  items: string[];
  ordered?: boolean;
  testid?: string;
}) {
  if (items.length === 0) return null;
  const listClass =
    "mt-1 space-y-1 text-sm text-slate-600 dark:text-slate-300 " +
    (ordered ? "list-decimal" : "list-disc") +
    " pl-5";
  return (
    <div className="mt-3" data-testid={testid}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </h4>
      {ordered ? (
        <ol className={listClass}>
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      ) : (
        <ul className={listClass}>
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
