import type { AnswerResult, CardStateEntity, DeckConfig, StudyState } from "./studyTypes";

export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_DECK_CONFIG: DeckConfig = {
  newPerDay: 10,
  reviewsPerDay: 200,
  cardInfoOpenByDefault: false,
  answerStyles: ["normal", "write", "multiple-choice", "reverse"],
  writeLanguage: "en",
  learnStepsMs: [10 * 60 * 1000, 1 * DAY_MS],
  relearnStepsMs: [10 * 60 * 1000],
  graduatingIntervalDays: 3,
  easeFactor: 2.5,
  lapseIntervalMultiplier: 0.5,
  learnFailDelayMs: 60 * 1000,
  minIntervalDays: 1,
};

export function getLocalDayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function getLocalNextDayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

function getLocalDayStartPlusDays(ts: number, days: number): number {
  const d = new Date(getLocalDayStart(ts));
  d.setDate(d.getDate() + Math.max(0, Math.floor(days)));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function snapDue(now: number, due: number): number {
  const delay = due - now;
  // For waits of 24h+ we schedule on the local day boundary (midnight)
  // instead of “exactly N hours from now”.
  if (delay >= DAY_MS) return getLocalDayStart(due);
  return due;
}

function clampMinInterval(intervalDays: number, cfg: DeckConfig): number {
  return Math.max(cfg.minIntervalDays, Math.round(intervalDays));
}

export type ScheduleResult = {
  nextState: StudyState;
  nextDue: number;
  nextIntervalDays: number;
  nextStepIndex: number;
  nextReps: number;
  nextLapses: number;
};

export function scheduleAnswer(
  prev: CardStateEntity,
  result: AnswerResult,
  now: number,
  cfg: DeckConfig
): ScheduleResult {
  const prevState = prev.state;

  const base = {
    nextIntervalDays: prev.intervalDays,
    nextStepIndex: prev.stepIndex,
    nextReps: prev.reps + 1,
    nextLapses: prev.lapses,
  };

  const learnSteps = cfg.learnStepsMs;
  const relearnSteps = cfg.relearnStepsMs;

  const graduateToReview = (intervalDays: number) => {
    const nextIntervalDays = clampMinInterval(intervalDays, cfg);
    const due = getLocalDayStartPlusDays(now, nextIntervalDays);
    return {
      ...base,
      nextState: "review" as const,
      nextStepIndex: 0,
      nextIntervalDays,
      nextDue: due,
    };
  };

  const scheduleLearnLike = (mode: "learn" | "relearn", stepsMs: number[]) => {
    const stepIndex = Math.max(0, prev.stepIndex);

    if (result === "fail") {
      return {
        ...base,
        nextState: mode,
        nextStepIndex: 0,
        nextDue: now + cfg.learnFailDelayMs,
      };
    }

    // PASS
    // Anki-like behavior: each PASS schedules the *current* step delay; only
    // after all delays have been scheduled and you PASS again do you graduate.
    if (stepsMs.length === 0) {
      return graduateToReview(cfg.graduatingIntervalDays);
    }

    if (stepIndex < stepsMs.length) {
      const delay = stepsMs[stepIndex] ?? 0;
      const due = snapDue(now, now + delay);
      return {
        ...base,
        nextState: mode,
        nextStepIndex: stepIndex + 1,
        nextDue: due,
      };
    }

    // stepIndex >= stepsMs.length => graduate
    const intervalDays =
      mode === "relearn"
        ? clampMinInterval(Math.max(1, prev.intervalDays), cfg)
        : cfg.graduatingIntervalDays;

    return graduateToReview(intervalDays);
  };

  if (prevState === "new") {
    // Treat NEW like entering learn.
    return scheduleLearnLike("learn", learnSteps);
  }

  if (prevState === "learn") {
    return scheduleLearnLike("learn", learnSteps);
  }

  if (prevState === "relearn") {
    return scheduleLearnLike("relearn", relearnSteps);
  }

  // REVIEW
  if (result === "pass") {
    const grown = prev.intervalDays > 0 ? prev.intervalDays * cfg.easeFactor : cfg.graduatingIntervalDays;
    const nextIntervalDays = clampMinInterval(grown, cfg);
    const due = getLocalDayStartPlusDays(now, nextIntervalDays);
    return {
      ...base,
      nextState: "review",
      nextStepIndex: 0,
      nextIntervalDays,
      nextDue: due,
    };
  }

  // FAIL in review => lapse + relearn
  const reduced = prev.intervalDays > 0 ? prev.intervalDays * cfg.lapseIntervalMultiplier : cfg.minIntervalDays;
  const nextIntervalDays = clampMinInterval(reduced, cfg);
  const firstRelearnDelay = (relearnSteps[0] ?? cfg.learnFailDelayMs);

  return {
    ...base,
    nextState: "relearn",
    nextStepIndex: 0,
    nextIntervalDays,
    nextDue: now + firstRelearnDelay,
    nextLapses: prev.lapses + 1,
  };
}
