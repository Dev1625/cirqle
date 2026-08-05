export type TourProgress = {
  startedAt?: unknown;
  completedAt?: unknown;
  skippedAt?: unknown;
  lastStep: number;
};

export type InitialTourDecision =
  | { action: 'none'; stepIndex: 0 }
  | { action: 'start'; stepIndex: 0 }
  | { action: 'resume'; stepIndex: number };

export type TourOutcome = 'completed' | 'skipped';

type UserTourData = {
  completedTours?: unknown;
  hasSeenInitialTour?: unknown;
  tourProgress?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasPersistedTimestamp(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function clampStep(value: unknown, stepCount: number): number {
  if (stepCount <= 1 || typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), stepCount - 1);
}

export function tourStartUpdate(
  tourId: string,
  lastStep: number,
  startedAt: unknown,
  clearPreviousSkip?: unknown,
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    [`tourProgress.${tourId}.startedAt`]: startedAt,
    [`tourProgress.${tourId}.lastStep`]: lastStep,
    updatedAt: startedAt,
  };
  // A user may deliberately restart a tour they skipped earlier. Clearing the
  // previous terminal marker makes that new attempt resumable after a reload.
  if (clearPreviousSkip !== undefined) {
    update[`tourProgress.${tourId}.skippedAt`] = clearPreviousSkip;
  }
  return update;
}

export function tourStepUpdate(
  tourId: string,
  lastStep: number,
  updatedAt: unknown,
): Record<string, unknown> {
  return {
    [`tourProgress.${tourId}.lastStep`]: lastStep,
    updatedAt,
  };
}

export function tourSettlementUpdate(
  tourId: string,
  outcome: TourOutcome,
  lastStep: number,
  occurredAt: unknown,
  completedTours: string[],
): Record<string, unknown> {
  const lifecycleField = outcome === 'completed' ? 'completedAt' : 'skippedAt';
  const update: Record<string, unknown> = {
    [`tourProgress.${tourId}.${lifecycleField}`]: occurredAt,
    [`tourProgress.${tourId}.lastStep`]: lastStep,
    updatedAt: occurredAt,
  };

  if (outcome === 'completed') update.completedTours = completedTours;
  // Preserve suppression for older app versions, but only after an explicit
  // terminal action. Opening or resuming a tour never writes this flag.
  if (tourId === 'getting_started') update.hasSeenInitialTour = true;

  return update;
}

/**
 * Reads persisted progress defensively. Firestore timestamps deliberately stay
 * opaque here; the tour only needs to know whether each lifecycle marker
 * exists.
 */
export function readTourProgress(data: UserTourData, tourId: string, stepCount: number): TourProgress | null {
  if (!isRecord(data.tourProgress)) return null;

  const raw = data.tourProgress[tourId];
  if (!isRecord(raw)) return null;

  return {
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    skippedAt: raw.skippedAt,
    lastStep: clampStep(raw.lastStep, stepCount),
  };
}

/**
 * Keeps the legacy `completedTours` list authoritative while also recognizing
 * a completed lifecycle record if a prior write only partially succeeded.
 */
export function completedTourIds(data: UserTourData, knownTourIds: string[]): string[] {
  const known = new Set(knownTourIds);
  const completed = new Set(
    Array.isArray(data.completedTours)
      ? data.completedTours.filter((value): value is string => typeof value === 'string' && known.has(value))
      : [],
  );

  if (isRecord(data.tourProgress)) {
    for (const tourId of knownTourIds) {
      const raw = data.tourProgress[tourId];
      if (isRecord(raw) && hasPersistedTimestamp(raw.completedAt)) completed.add(tourId);
    }
  }

  return Array.from(completed);
}

/**
 * Decides whether the initial tour should auto-launch.
 *
 * `hasSeenInitialTour` is retained only as a compatibility signal. Older
 * accounts received that flag as soon as the tour opened, so automatically
 * replaying it would surprise existing users. New accounts use lifecycle
 * markers and can resume an interrupted run precisely.
 */
export function initialTourDecision(
  data: UserTourData,
  tourId: string,
  stepCount: number,
): InitialTourDecision {
  const done = completedTourIds(data, [tourId]).includes(tourId);
  if (done) return { action: 'none', stepIndex: 0 };

  const progress = readTourProgress(data, tourId, stepCount);
  if (progress && hasPersistedTimestamp(progress.skippedAt)) {
    return { action: 'none', stepIndex: 0 };
  }
  if (progress && hasPersistedTimestamp(progress.startedAt)) {
    return { action: 'resume', stepIndex: progress.lastStep };
  }

  // Backward compatibility for accounts created before lifecycle persistence.
  if (data.hasSeenInitialTour === true) return { action: 'none', stepIndex: 0 };

  return { action: 'start', stepIndex: 0 };
}
