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
  seedLoadContexts,
} from "./seed/training";
import { seedIntegrationSyncEvents } from "./seed/integrations";
import { seedMergeFixtures } from "./seed/merge";
import {
  seedImportFeed,
  seedDropReport,
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
import { seedSleep } from "./seed/sleep";
import {
  seedMultiSourceMetric,
  seedSourceCompare,
  seedLegacyCelsius,
  seedSunOutdoor,
  seedIntradayPanel,
  seedVitalsToday,
} from "./seed/metrics";
import { seedRuleDomains, seedSuppressedCenter } from "./seed/findings";
import {
  seedMedicationCards,
  seedPrnLedger,
  seedLowSupply,
  seedDrugAllergyCrosscheck,
  seedPrnCounter,
  seedSafetyCoverage,
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
  seedPanelGroups,
  seedPanelIndex,
} from "./seed/medical";
import { seedCoverageGaps } from "./seed/coverage-gaps";
import { seedNutritionTrio, seedFoodSlots } from "./seed/nutrition";
import { seedProviderMergePair, seedProviderCloseout } from "./seed/providers";
import { seedIllness } from "./seed/illness";
import { seedCycleAndDerived, seedWindowAnalytics } from "./seed/situations";
import { seedHaConfig } from "./seed/notifications";
import { seedTimelineChrome } from "./seed/timeline";
import {
  seedBodyMobile,
  seedCuratedOverview,
  seedTrendsReadings,
  seedCompareFold,
  seedFitnessLens,
  seedRankedCardOrder,
} from "./seed/trends";

seedPrelude();
seedJournalCard();
seedIntegrationSyncEvents();
seedMergeFixtures();
seedImportFeed();
seedHouseholdRollup();
seedWeeklyRecap();
seedRestEpisode();
seedSleep();
seedMultiSourceMetric();
seedTrainingZones();
seedRuleDomains();
seedDropReport();
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
seedIllness();
seedFoodSlots();
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
seedDataQualityGaps();
seedVisitLinking();
seedToasterIsolation();
seedProviderCloseout();
seedBodyMobile();
seedRestCard();
seedSuppressedCenter();
seedMultiProfile();
seedWindowAnalytics();
seedWellDayTilt();
seedRecordsEnrichment();
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
seedTrainingRollup();
seedLoadContexts();
seedTimelineChrome();
