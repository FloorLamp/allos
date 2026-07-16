import Link from "next/link";
import { IconArrowRight, IconCheck, IconLock } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import SubmitButton from "@/components/SubmitButton";
import TimezoneSelect from "@/components/TimezoneSelect";
import { LogoMark } from "@/components/Wordmark";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getAccessibleProfiles, requireSession } from "@/lib/auth";
import { resolveWidgetList } from "@/lib/dashboard-widgets";
import { getEquipment } from "@/lib/equipment";
import { frequencyScopeLabel } from "@/lib/goals";
import {
  hasOnboardingFirstValue,
  initialOnboardingState,
  nextOnboardingStep,
  onboardingFocusDef,
  ONBOARDING_NOTIFICATION_INTENT_DEFS,
  ONBOARDING_STEP_COUNT,
  resolveOnboardingStep,
  type OnboardingStep,
} from "@/lib/onboarding";
import { getOnboardingDataPresence } from "@/lib/onboarding-data";
import { ROUTINE_TEMPLATES } from "@/lib/routine-templates";
import { getActiveRoutine, getTrainingTargetsToReplace } from "@/lib/routines";
import {
  getOnboardingState,
  getDashboardLayout,
  getStoredAge,
  getTimezone,
  getUnitPrefs,
  getUserBirthdate,
  getUserSex,
} from "@/lib/settings";
import {
  completeOnboarding,
  continueOnboardingData,
  saveOnboardingBasics,
  saveOnboardingDashboard,
  saveOnboardingFocuses,
  saveOnboardingNotifications,
} from "./actions";
import DashboardChoices from "./DashboardChoices";
import FocusChoices from "./FocusChoices";
import AgeInputs from "./AgeInputs";
import ProfilePathChoices from "./ProfilePathChoices";
import RoutineStarter from "./RoutineStarter";

export const dynamic = "force-dynamic";

const ONBOARDING_WIDGET_DESCRIPTIONS: Record<string, string> = {
  "recent-labs": "Latest lab results and flags.",
  "next-appointment": "Your next scheduled visit.",
  coaching: "A daily train-or-rest suggestion.",
  "coaching-observations": "Health patterns worth noticing.",
  "healthspan-pillars": "Key long-term health signals.",
  "weight-trend": "Recent weight changes.",
  "goals-habits": "Goals and weekly habits.",
  "weekly-recap": "A seven-day progress summary.",
};

const ONBOARDING_STEP_LABELS = [
  "Profile",
  "Priorities",
  "Profile details",
  "Add data",
  "Dashboard",
  "Notifications",
  "Finish",
] as const;

const ONBOARDING_STEP_TITLES = [
  "Welcome to Allos",
  "What should Allos help with first?",
  "Personalize this profile",
  "Bring in your data",
  "Choose your starting cards",
  "How should Allos keep you updated?",
  "Allos is ready",
] as const;

const ONBOARDING_STEP_SUBTITLES = [
  "Choose whose health information this profile will track.",
  "Choose one or two priorities. Everything else remains available.",
  "Add what you know now. You can leave unknown details blank and update them later.",
  "Connect a service first, import a file, or add something yourself.",
  "Keep the suggested dashboard cards or adjust the starting view.",
  "Choose what sounds useful. Delivery stays off until you enable a channel.",
  "Your starting dashboard is personalized and ready to use.",
] as const;

function OnboardingProgress({
  step,
  unlockedStep,
}: {
  step: OnboardingStep;
  unlockedStep: OnboardingStep;
}) {
  return (
    <nav className="mb-5" aria-label="Setup progress">
      <div className="mb-2 flex items-center justify-between gap-4 text-sm">
        <span className="font-medium text-slate-700 dark:text-slate-200">
          Step {step} of {ONBOARDING_STEP_COUNT}
        </span>
        <span className="text-slate-500 dark:text-slate-400">
          {ONBOARDING_STEP_LABELS[step - 1]}
        </span>
      </div>
      <ol className="grid grid-cols-7 gap-1.5">
        {ONBOARDING_STEP_LABELS.map((label, index) => {
          const itemStep = (index + 1) as OnboardingStep;
          return (
            <li key={label} className="h-11">
              {itemStep <= unlockedStep ? (
                <Link
                  href={`/onboarding?step=${itemStep}`}
                  aria-current={itemStep === step ? "step" : undefined}
                  aria-label={`${itemStep < unlockedStep ? "Completed" : "Available"} step ${itemStep}: ${label}`}
                  className="flex h-full items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/50"
                >
                  <span
                    aria-hidden="true"
                    className={`block h-1.5 w-full rounded-full transition hover:opacity-80 ${
                      itemStep === step
                        ? "bg-brand-500"
                        : itemStep < unlockedStep
                          ? "bg-emerald-500"
                          : "bg-slate-300 dark:bg-slate-600"
                    }`}
                  />
                </Link>
              ) : (
                <span
                  aria-label={`Locked step ${itemStep}: ${label}`}
                  className="flex h-full items-center"
                >
                  <span
                    aria-hidden="true"
                    className="block h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-700"
                  />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function WizardActions({
  backStep,
  children,
  showExit = true,
}: {
  backStep: OnboardingStep;
  children: React.ReactNode;
  showExit?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`/onboarding?step=${backStep}`} className="btn-ghost">
          Back
        </Link>
        {children}
      </div>
      {showExit && (
        <div
          data-testid="onboarding-exit-section"
          className="border-t border-black/5 pt-3 text-right dark:border-white/5"
        >
          <Link
            href="/"
            className="text-sm font-medium text-slate-500 hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400"
          >
            Exit setup
          </Link>
        </div>
      )}
    </div>
  );
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    step?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const { login, profile, access } = await requireSession();
  const state = getOnboardingState(profile.id) ?? initialOnboardingState();
  const units = getUnitPrefs(login.id);
  const accessible = await getAccessibleProfiles();
  const presence = {
    ...getOnboardingDataPresence(profile.id),
    caregiving: accessible.length > 1,
  };
  const hasFirstValue = hasOnboardingFirstValue(state.focuses, presence);
  const unlockedStep = nextOnboardingStep(state, hasFirstValue);
  const activeStep = resolveOnboardingStep(params.step, state, hasFirstValue);
  const readOnly = access === "read";
  const layout = getDashboardLayout(profile.id);
  const dashboardWidgetList = resolveWidgetList(
    layout,
    isTrainingRestricted(profile.id)
  );
  const visibleWidgets = new Set(
    dashboardWidgetList
      .filter((widget) => widget.visible)
      .map((widget) => widget.def.id)
  );
  const activeRoutine = state.focuses.includes("fitness")
    ? getActiveRoutine(profile.id)
    : null;
  const replaceTargets = state.focuses.includes("fitness")
    ? getTrainingTargetsToReplace(profile.id).map((target) => ({
        label: frequencyScopeLabel(target.scope_kind, target.scope_value),
        perWeek: target.per_week,
      }))
    : [];
  const hasEquipment = getEquipment(profile.id).length > 0;
  const starterRoutineTemplates = ROUTINE_TEMPLATES.filter(
    (template) => template.audience === "beginner"
  )
    .sort((a, b) => {
      if (!hasEquipment) {
        if (a.id === "bodyweight-minimal") return -1;
        if (b.id === "bodyweight-minimal") return 1;
      }
      return 0;
    })
    .map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      dayCount: template.days.length,
    }));
  const widgetChoices = dashboardWidgetList.map(({ def: widget }) => ({
    id: widget.id,
    label: widget.label,
    description:
      ONBOARDING_WIDGET_DESCRIPTIONS[widget.id] ?? widget.description,
  }));
  const selectedFocusLabels = state.focuses.map(
    (focus) => onboardingFocusDef(focus).label
  );
  const selectedNotification = ONBOARDING_NOTIFICATION_INTENT_DEFS.find(
    (intent) => intent.id === state.notificationIntent
  );

  return (
    <div className="mx-auto max-w-4xl">
      <OnboardingProgress step={activeStep} unlockedStep={unlockedStep} />
      {activeStep === 1 ? (
        <div className="mb-6">
          <h1 className="flex items-center gap-3 text-2xl font-bold text-slate-900 dark:text-slate-100">
            <LogoMark className="h-9 w-16" />
            <span>{ONBOARDING_STEP_TITLES[0]}</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {ONBOARDING_STEP_SUBTITLES[0]}
          </p>
        </div>
      ) : (
        <PageHeader
          title={
            activeStep === 7
              ? `${ONBOARDING_STEP_TITLES[6]} for ${profile.name}`
              : ONBOARDING_STEP_TITLES[activeStep - 1]
          }
          subtitle={ONBOARDING_STEP_SUBTITLES[activeStep - 1]}
        />
      )}

      {activeStep === 1 && (
        <div className="mb-6 rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm text-brand-950 dark:border-brand-500/25 dark:bg-brand-500/10 dark:text-brand-100">
          <div className="flex items-start gap-3">
            <IconLock className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">You control your data</p>
              <p className="mt-1 text-brand-800 dark:text-brand-200">
                Allos only shares information outside the app when you connect
                another service, use an AI-powered feature, or choose to share
                something. You can change reminder and sharing settings at any
                time.
              </p>
            </div>
          </div>
        </div>
      )}

      {params.error && (
        <p className="mb-4 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          {params.error}
        </p>
      )}

      {readOnly && (
        <p className="mb-4 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-600 dark:bg-ink-850 dark:text-slate-300">
          You have view-only access to this profile. A caregiver with write
          access can finish its setup.
        </p>
      )}

      <div className="space-y-5">
        {activeStep === 1 && (
          <section className="card" data-testid="onboarding-profile-path">
            <ProfilePathChoices
              selected={state.profilePath}
              readOnly={readOnly}
            />
          </section>
        )}

        {activeStep === 2 && (
          <section className="card" data-testid="onboarding-outcomes">
            <form action={saveOnboardingFocuses} className="space-y-4">
              <FocusChoices selected={state.focuses} readOnly={readOnly} />
              {!readOnly && (
                <WizardActions backStep={1}>
                  <SubmitButton
                    className="btn w-36"
                    pendingLabel="Continuing…"
                    requireSelection="focus"
                  >
                    Next
                  </SubmitButton>
                </WizardActions>
              )}
            </form>
          </section>
        )}

        {activeStep === 3 && (
          <section className="card" data-testid="onboarding-basics">
            <form
              action={saveOnboardingBasics}
              className="grid gap-4 sm:grid-cols-2"
            >
              <div className="sm:col-span-2">
                <label className="label" htmlFor="onboarding-display-name">
                  Display name
                </label>
                <input
                  id="onboarding-display-name"
                  name="display_name"
                  defaultValue={profile.name}
                  required
                  maxLength={60}
                  disabled={readOnly}
                  className="input"
                />
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                  The name used throughout Allos. A profile does not need its
                  own login.
                </p>
              </div>

              <AgeInputs
                birthdate={getUserBirthdate(profile.id)}
                age={getStoredAge(profile.id)}
                disabled={readOnly}
              />

              <div>
                <label className="label" htmlFor="onboarding-sex">
                  Sex used for clinical ranges
                </label>
                <select
                  id="onboarding-sex"
                  name="sex"
                  defaultValue={getUserSex(profile.id) ?? ""}
                  disabled={readOnly}
                  className="input"
                >
                  <option value="">Not set</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                  Used only when a clinical reference range differs by sex.
                  Leave this unset if it is unknown.
                </p>
              </div>

              <div>
                <TimezoneSelect
                  id="onboarding-timezone"
                  value={getTimezone(profile.id)}
                  disabled={readOnly}
                />
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                  Keeps the dashboard, schedules, and reminders aligned with
                  this profile’s local time.
                </p>
              </div>

              <div>
                <label className="label" htmlFor="onboarding-weight-unit">
                  Weight unit
                </label>
                <select
                  id="onboarding-weight-unit"
                  name="weight_unit"
                  defaultValue={units.weightUnit}
                  disabled={readOnly}
                  className="input"
                >
                  <option value="kg">Kilograms</option>
                  <option value="lb">Pounds</option>
                </select>
              </div>

              <div>
                <label className="label" htmlFor="onboarding-distance-unit">
                  Distance unit
                </label>
                <select
                  id="onboarding-distance-unit"
                  name="distance_unit"
                  defaultValue={units.distanceUnit}
                  disabled={readOnly}
                  className="input"
                >
                  <option value="km">Kilometers</option>
                  <option value="mi">Miles</option>
                </select>
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                  Unit preferences follow your login across every profile you
                  can access.
                </p>
              </div>

              {!readOnly && (
                <div className="sm:col-span-2">
                  <WizardActions backStep={2}>
                    <SubmitButton className="btn w-36" pendingLabel="Saving…">
                      Next
                    </SubmitButton>
                  </WizardActions>
                </div>
              )}
            </form>
          </section>
        )}

        {activeStep === 4 && (
          <section className="card" data-testid="onboarding-first-value">
            <Link
              href="/data?section=import#integrations"
              className="group mb-5 flex items-center justify-between gap-4 rounded-xl border border-brand-200 bg-brand-50 p-4 transition hover:border-brand-400 dark:border-brand-500/25 dark:bg-brand-500/10 dark:hover:border-brand-500/50"
            >
              <span>
                <span className="block text-sm font-semibold text-brand-800 dark:text-brand-200">
                  Connect an app or device
                </span>
                <span className="mt-1 block text-xs text-brand-700 dark:text-brand-300">
                  Sync supported activity, sleep, weight, and health data from
                  services you already use.
                </span>
              </span>
              <IconArrowRight className="h-5 w-5 shrink-0 text-brand-600 transition group-hover:translate-x-0.5 dark:text-brand-400" />
            </Link>

            {state.focuses.includes("fitness") && (
              <RoutineStarter
                templates={starterRoutineTemplates}
                replaceTargets={replaceTargets}
                activeRoutineName={activeRoutine?.name ?? null}
                readOnly={readOnly}
              />
            )}

            <p className="mb-3 text-xs font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
              Or import or add something yourself
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {state.focuses.map((focus) => {
                const def = onboardingFocusDef(focus);
                return (
                  <Link
                    key={focus}
                    href={def.actionHref}
                    className="group rounded-xl border border-black/10 p-4 hover:border-brand-300 dark:border-white/10 dark:hover:border-brand-500/50"
                  >
                    <span className="text-sm font-medium text-slate-800 group-hover:text-brand-700 dark:text-slate-100 dark:group-hover:text-brand-400">
                      {def.actionLabel}
                    </span>
                    <IconArrowRight className="ml-1 inline h-4 w-4" />
                    <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                      {def.description}
                    </span>
                  </Link>
                );
              })}
              {state.focuses.includes("caregiving") &&
                login.role === "admin" && (
                  <Link
                    href="/settings/family"
                    className="group rounded-xl border border-black/10 p-4 hover:border-brand-300 dark:border-white/10 dark:hover:border-brand-500/50"
                  >
                    <span className="text-sm font-medium text-slate-800 group-hover:text-brand-700 dark:text-slate-100 dark:group-hover:text-brand-400">
                      Add a profile or login
                    </span>
                    <IconArrowRight className="ml-1 inline h-4 w-4" />
                    <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                      A profile can be tracked without giving that person a
                      login.
                    </span>
                  </Link>
                )}
            </div>

            <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
              Imported medications and other reminder-sensitive details stay
              inactive until you review them. A setup banner will bring you back
              after you add or connect something. You can also continue while a
              sync runs or add data later.
            </p>

            <div className="mt-4">
              <form action={continueOnboardingData}>
                <WizardActions backStep={3}>
                  <SubmitButton className="btn w-36" pendingLabel="Continuing…">
                    Next
                  </SubmitButton>
                </WizardActions>
              </form>
            </div>
          </section>
        )}

        {activeStep === 5 && (
          <section className="card" data-testid="onboarding-dashboard">
            <form action={saveOnboardingDashboard} className="space-y-4">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Needs attention always stays at the top. You can reorder or
                change these cards from the dashboard at any time.
              </p>
              <DashboardChoices
                widgets={widgetChoices}
                initiallyVisible={[...visibleWidgets]}
                readOnly={readOnly}
              />
              {!readOnly && (
                <WizardActions backStep={4}>
                  <SubmitButton
                    className="btn w-36"
                    pendingLabel="Saving…"
                    requireSelection="widget"
                  >
                    Next
                  </SubmitButton>
                </WizardActions>
              )}
            </form>
          </section>
        )}

        {activeStep === 6 && (
          <section className="card" data-testid="onboarding-notifications">
            <form action={saveOnboardingNotifications} className="space-y-4">
              <div className="space-y-3">
                {ONBOARDING_NOTIFICATION_INTENT_DEFS.map((intent) => (
                  <label
                    key={intent.id}
                    className="relative flex cursor-pointer items-start rounded-xl border border-black/10 p-3 pr-10 transition hover:border-brand-300 has-[:checked]:border-brand-400 has-[:checked]:bg-brand-50/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-400/50 dark:border-white/10 dark:hover:border-brand-500/50 dark:has-[:checked]:border-brand-500/60 dark:has-[:checked]:bg-brand-500/10"
                  >
                    <input
                      type="radio"
                      name="notification_intent"
                      value={intent.id}
                      defaultChecked={state.notificationIntent === intent.id}
                      disabled={readOnly}
                      className="peer absolute top-3 right-3 h-5 w-5 cursor-pointer appearance-none rounded-full border border-slate-300 bg-white transition checked:border-brand-600 checked:bg-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/50 disabled:cursor-default dark:border-slate-600 dark:bg-ink-900 dark:checked:border-brand-500 dark:checked:bg-brand-500"
                    />
                    <span className="pointer-events-none absolute top-3 right-3 flex h-5 w-5 items-center justify-center text-white opacity-0 transition peer-checked:opacity-100">
                      <IconCheck
                        className="h-3.5 w-3.5"
                        stroke={2.5}
                        aria-hidden="true"
                      />
                    </span>
                    <span>
                      <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                        {intent.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                        {intent.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {!readOnly && (
                <WizardActions backStep={5}>
                  <SubmitButton
                    className="btn w-36"
                    pendingLabel="Saving…"
                    requireSelection="notification_intent"
                  >
                    Next
                  </SubmitButton>
                </WizardActions>
              )}
            </form>
          </section>
        )}

        {activeStep === 7 && (
          <section className="card" data-testid="onboarding-finish">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-slate-50 p-3 dark:bg-ink-850">
                  <p className="text-xs font-medium text-slate-400 uppercase dark:text-slate-500">
                    Priorities
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-700 dark:text-slate-200">
                    {selectedFocusLabels.join(" · ")}
                  </p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3 dark:bg-ink-850">
                  <p className="text-xs font-medium text-slate-400 uppercase dark:text-slate-500">
                    Data
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-700 dark:text-slate-200">
                    {hasFirstValue
                      ? "Starting data added"
                      : "Ready when you are"}
                  </p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3 dark:bg-ink-850">
                  <p className="text-xs font-medium text-slate-400 uppercase dark:text-slate-500">
                    Updates
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-700 dark:text-slate-200">
                    {selectedNotification?.label ?? "Decide later"}
                  </p>
                </div>
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                You can connect more services, add health information, and
                change these choices whenever you need to.
              </p>
              {!readOnly && (
                <form action={completeOnboarding}>
                  <WizardActions backStep={6} showExit={false}>
                    <SubmitButton
                      className="btn w-36"
                      pendingLabel="Finishing…"
                    >
                      View dashboard
                    </SubmitButton>
                  </WizardActions>
                </form>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
