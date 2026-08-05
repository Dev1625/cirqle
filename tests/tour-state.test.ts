import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completedTourIds,
  initialTourDecision,
  readTourProgress,
  tourSettlementUpdate,
  tourStartUpdate,
  tourStepUpdate,
} from '../src/contexts/tourState.ts';

const TOUR_ID = 'getting_started';
const STEPS = 5;
const timestamp = { seconds: 42, nanoseconds: 0 };

test('a fresh account starts onboarding at the first step', () => {
  assert.deepEqual(initialTourDecision({}, TOUR_ID, STEPS), {
    action: 'start',
    stepIndex: 0,
  });
});

test('opening a tour records only its start and current step', () => {
  const deleteSentinel = Symbol('delete');
  const update = tourStartUpdate(TOUR_ID, 0, timestamp, deleteSentinel);

  assert.deepEqual(update, {
    [`tourProgress.${TOUR_ID}.startedAt`]: timestamp,
    [`tourProgress.${TOUR_ID}.lastStep`]: 0,
    [`tourProgress.${TOUR_ID}.skippedAt`]: deleteSentinel,
    updatedAt: timestamp,
  });
  assert.equal('hasSeenInitialTour' in update, false);
  assert.equal('completedTours' in update, false);
});

test('step persistence only advances the resumable position', () => {
  assert.deepEqual(tourStepUpdate(TOUR_ID, 2, timestamp), {
    [`tourProgress.${TOUR_ID}.lastStep`]: 2,
    updatedAt: timestamp,
  });
});

test('an interrupted tour resumes from its last displayed step', () => {
  const data = {
    tourProgress: {
      [TOUR_ID]: { startedAt: timestamp, lastStep: 3 },
    },
  };

  assert.deepEqual(initialTourDecision(data, TOUR_ID, STEPS), {
    action: 'resume',
    stepIndex: 3,
  });
});

test('persisted step indexes are clamped to the current tour length', () => {
  const data = {
    tourProgress: {
      [TOUR_ID]: { startedAt: timestamp, lastStep: 99 },
    },
  };

  assert.equal(readTourProgress(data, TOUR_ID, STEPS)?.lastStep, 4);
  assert.equal(initialTourDecision(data, TOUR_ID, STEPS).stepIndex, 4);
});

test('explicitly skipped onboarding stays distinct from completion and does not relaunch', () => {
  const data = {
    completedTours: [],
    tourProgress: {
      [TOUR_ID]: {
        startedAt: timestamp,
        skippedAt: timestamp,
        lastStep: 2,
      },
    },
  };

  assert.deepEqual(completedTourIds(data, [TOUR_ID]), []);
  assert.deepEqual(initialTourDecision(data, TOUR_ID, STEPS), {
    action: 'none',
    stepIndex: 0,
  });
});

test('skip and completion produce distinct terminal writes', () => {
  const skipped = tourSettlementUpdate(TOUR_ID, 'skipped', 2, timestamp, []);
  const completed = tourSettlementUpdate(TOUR_ID, 'completed', 4, timestamp, [TOUR_ID]);

  assert.deepEqual(skipped, {
    [`tourProgress.${TOUR_ID}.skippedAt`]: timestamp,
    [`tourProgress.${TOUR_ID}.lastStep`]: 2,
    hasSeenInitialTour: true,
    updatedAt: timestamp,
  });
  assert.deepEqual(completed, {
    [`tourProgress.${TOUR_ID}.completedAt`]: timestamp,
    [`tourProgress.${TOUR_ID}.lastStep`]: 4,
    completedTours: [TOUR_ID],
    hasSeenInitialTour: true,
    updatedAt: timestamp,
  });
});

test('completed lifecycle state suppresses onboarding even after a partial legacy-list write', () => {
  const data = {
    completedTours: [],
    tourProgress: {
      [TOUR_ID]: {
        startedAt: timestamp,
        completedAt: timestamp,
        lastStep: 4,
      },
    },
  };

  assert.deepEqual(completedTourIds(data, [TOUR_ID]), [TOUR_ID]);
  assert.deepEqual(initialTourDecision(data, TOUR_ID, STEPS), {
    action: 'none',
    stepIndex: 0,
  });
});

test('legacy completedTours and hasSeenInitialTour accounts remain compatible', () => {
  assert.deepEqual(
    initialTourDecision({ completedTours: [TOUR_ID] }, TOUR_ID, STEPS),
    { action: 'none', stepIndex: 0 },
  );
  assert.deepEqual(
    initialTourDecision({ completedTours: [], hasSeenInitialTour: true }, TOUR_ID, STEPS),
    { action: 'none', stepIndex: 0 },
  );
});

test('malformed persisted data fails safely without inventing completion', () => {
  const data = {
    completedTours: [TOUR_ID, 123, 'unknown'],
    tourProgress: {
      [TOUR_ID]: { startedAt: timestamp, lastStep: Number.NaN },
    },
  };

  assert.deepEqual(completedTourIds(data, [TOUR_ID]), [TOUR_ID]);
  assert.equal(readTourProgress(data, TOUR_ID, STEPS)?.lastStep, 0);
  assert.equal(readTourProgress({ tourProgress: [] }, TOUR_ID, STEPS), null);
});
