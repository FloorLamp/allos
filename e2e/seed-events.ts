// Extra e2e fixture rows layered on top of the normal sample seed (scripts/seed.ts):
// a few integration sync events so the Data → Review inbox has content to render,
// including one currently-failing provider (Strava) that must surface under
// "Needs attention" and drive the profile-menu badge. Runs against the same
// ALLOS_DB_PATH e2e/global-setup.ts seeds the worker TEMPLATE with (#1538).
//
// THIS FILE IS A THIN COMPOSER (issue #1511). The fixtures themselves live in
// per-domain modules under e2e/seed/ — add a new fixture to the module that owns
// its domain (or add a module + one call below), so two PRs seeding different
// domains no longer conflict on one 6.5k-line file. The ORDER of the calls below
// is the original execution order and is load-bearing: fixtures build on rows
// earlier calls insert, and row ids follow insertion order. Append a NEW domain's
// call at the end unless it must run earlier.

import "../scripts/load-env";

import { seedPrelude } from "./seed/prelude";
import {
  seedJournalCard,
  seedTrainingZones,
  seedActivityFormPaths,
  seedEndurancePlans,
  seedTrainingRollup,
  seedLabValueGoal,
  seedLoadContexts,
} from "./seed/training";
import {
  seedIntegrationSyncEvents,
  seedQuietStream,
  seedStreamLifecycle,
  seedSyncHistoryDay,
} from "./seed/integrations";
import { seedPortalHouseholds } from "./seed/portals";
import { seedMergeFixtures } from "./seed/merge";
import {
  seedImportFeed,
  seedDropReport,
  seedExtractionConfidence,
  seedTriageLinks,
  seedRecordsBrowser,
} from "./seed/imports";
import {
  seedHouseholdRollup,
  seedToasterIsolation,
  seedMultiProfile,
  seedGrantMatrix,
  seedTelegramDoseRound,
} from "./seed/household";
import {
  seedWeeklyRecap,
  seedTodayPanel,
  seedNowStrip,
  seedDailyLoop,
  seedNavGating,
  seedWhatsNew,
  seedHouseholdFolds,
} from "./seed/dashboard";
import {
  seedRestEpisode,
  seedRestCard,
  seedWellDayTilt,
} from "./seed/coaching";
import { seedSleep, seedSleepWaiting } from "./seed/sleep";
import {
  seedMultiSourceMetric,
  seedSourceCompare,
  seedLegacyCelsius,
  seedSunOutdoor,
  seedIntradayPanel,
  seedVitalsToday,
  seedBulkCorrection,
} from "./seed/metrics";
import {
  seedGoalPacing,
  seedRuleDomains,
  seedSuppressedCenter,
} from "./seed/findings";
import {
  seedMedicationCards,
  seedPrnLedger,
  seedLowSupply,
  seedDrugAllergyCrosscheck,
  seedPrnCounter,
  seedSafetyCoverage,
  seedUpcomingAggregate,
  seedSharedSupplyPools,
} from "./seed/intake";
import {
  seedPassportSmalls,
  seedDuplicateImmunization,
  seedFlaggedFollowups,
  seedPreventiveSatisfaction,
  seedDataQualityGaps,
  seedVisitLinking,
  seedRecordsEnrichment,
  seedLesionAllergyVisitLinks,
  seedPanelGroups,
  seedPanelIndex,
  seedReportPanes,
  seedLongevityStalePanel,
} from "./seed/medical";
import { seedCoverageGaps } from "./seed/coverage-gaps";
import {
  seedNutritionTrio,
  seedFoodSlots,
  seedFoodPinSplit,
} from "./seed/nutrition";
import { seedProviderMergePair, seedProviderCloseout } from "./seed/providers";
import { seedIllness, seedSymptomVideoEpisode } from "./seed/illness";
import { seedCycleAndDerived, seedWindowAnalytics } from "./seed/situations";
import {
  seedDigestTune,
  seedEmailNotify,
  seedHaConfig,
  seedNotifSweep,
  seedNotifyScope,
  seedNotifyTickLog,
} from "./seed/notifications";
import { seedTimelineChrome, seedTimelineEmpty } from "./seed/timeline";
import {
  seedBodyMobile,
  seedCuratedOverview,
  seedTrendsReadings,
  seedCompareFold,
  seedFitnessLens,
  seedRankedCardOrder,
  seedBiomarkerPickerRank,
  seedDayOneAverages,
  seedPinnedCardOrder,
  seedMetricJudgment,
  seedMetricFold,
  seedLongRange,
  seedPeakFlow,
} from "./seed/trends";

seedPrelude();
seedJournalCard();
seedIntegrationSyncEvents();
seedQuietStream();
seedStreamLifecycle();
seedSyncHistoryDay();
seedMergeFixtures();
seedImportFeed();
seedHouseholdRollup();
seedWeeklyRecap();
seedRestEpisode();
seedSleep();
seedSleepWaiting();
seedMultiSourceMetric();
seedTrainingZones();
seedRuleDomains();
seedGoalPacing();
seedDropReport();
seedExtractionConfidence();
seedTriageLinks();
seedMedicationCards();
seedPrnLedger();
seedRecordsBrowser();
seedTodayPanel();
seedLowSupply();
seedPassportSmalls();
seedCoverageGaps();
seedNutritionTrio();
seedNowStrip();
seedActivityFormPaths();
seedDuplicateImmunization();
seedProviderMergePair();
seedSourceCompare();
seedBulkCorrection();
seedIllness();
seedFoodSlots();
seedFoodPinSplit();
seedEndurancePlans();
seedFlaggedFollowups();
seedPanelGroups();
seedPanelIndex();
seedCycleAndDerived();
seedDailyLoop();
seedNavGating();
seedLegacyCelsius();
seedPreventiveSatisfaction();
seedDrugAllergyCrosscheck();
seedPrnCounter();
seedSafetyCoverage();
seedHaConfig();
seedDigestTune();
seedNotifSweep();
seedEmailNotify();
seedDataQualityGaps();
seedVisitLinking();
seedToasterIsolation();
seedProviderCloseout();
seedBodyMobile();
seedMetricJudgment();
seedMetricFold();
seedPeakFlow();
seedRestCard();
seedSuppressedCenter();
seedMultiProfile();
seedWindowAnalytics();
seedWellDayTilt();
seedRecordsEnrichment();
seedLesionAllergyVisitLinks();
seedSunOutdoor();
seedGrantMatrix();
seedSharedSupplyPools();
seedWhatsNew();
seedHouseholdFolds();
seedIntradayPanel();
seedVitalsToday();
seedTelegramDoseRound();
seedCuratedOverview();
seedTrendsReadings();
seedCompareFold();
seedFitnessLens();
seedRankedCardOrder();
seedPinnedCardOrder();
seedTrainingRollup();
seedLabValueGoal();
seedLoadContexts();
seedTimelineChrome();
seedTimelineEmpty();
// Appended LAST on purpose (#1598): both fixtures introduce profiles and rows, so
// running them after every existing seeder leaves every other fixture's row ids
// exactly where they were.
seedSymptomVideoEpisode();
seedReportPanes();
seedLongRange();
seedLongevityStalePanel();
// Appended after those for the same reason (#1504): a new profile plus its own intake
// rows, so every existing fixture's row ids stay exactly where they were.
seedUpcomingAggregate();
seedPortalHouseholds();
// Appended LAST (#1675): a new profile plus its own lab rows, so every existing
// fixture's row ids stay exactly where they were.
seedBiomarkerPickerRank();
seedDayOneAverages();
// Appended LAST (#2209): two new profiles plus a direct write of data/logs/
// notify.jsonl, so every existing fixture's row ids stay exactly where they were.
seedNotifyTickLog();
// Appended LAST (#2345): one admin login + two new profiles, so every existing
// fixture's row ids stay exactly where they were.
seedNotifyScope();
