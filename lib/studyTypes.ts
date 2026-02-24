export type StudyState = "new" | "learn" | "review" | "relearn";

export type AnswerResult = "pass" | "fail";

export type DeckRef = {
  libraryId: string;
  deckId: number;
};

export type DeckConfig = {
  newPerDay: number;
  reviewsPerDay: number;

  // Learning / relearning delays after a PASS while in learn/relearn.
  learnStepsMs: number[];
  relearnStepsMs: number[];

  // Interval (days) once a card graduates from learn -> review.
  graduatingIntervalDays: number;

  // Review growth factor on PASS.
  easeFactor: number;

  // Interval multiplier applied on FAIL in review before relearn.
  lapseIntervalMultiplier: number;

  // When failing in learn/relearn, how soon to see it again.
  learnFailDelayMs: number;

  // Minimum interval used when scheduling review.
  minIntervalDays: number;
};

export type DeckEntity = {
  libraryId: string;
  deckId: number;
  name: string;

  newPerDay: number;
  reviewsPerDay: number;

  createdAt: number;
  updatedAt: number;
};

export type CardEntity = {
  libraryId: string;
  cardId: number;
  deckId: number;
  noteId: number;

  frontHtml: string;
  backHtml: string;
  fieldsHtml: string[];
  fieldNames: string[];

  createdAt: number;
  updatedAt: number;
};

export type CardStateEntity = {
  libraryId: string;
  cardId: number;
  deckId: number;
  noteId: number;

  state: StudyState;

  // Epoch ms
  due: number;

  // For review cards
  intervalDays: number;
  ease: number;

  reps: number;
  lapses: number;

  // For learn/relearn: number of successful steps completed so far.
  stepIndex: number;

  suspended: boolean;
  buriedUntil: number | null;

  lastReview: number | null;

  createdAt: number;
  updatedAt: number;
};

export type ReviewLogEntity = {
  id?: number;

  // Stable id used for cloud sync deduplication.
  // (The local primary key is auto-incremented and device-specific.)
  syncKey: string;

  libraryId: string;
  deckId: number;
  cardId: number;
  noteId: number;

  ts: number;
  result: AnswerResult;
  timeTakenMs?: number;

  prevState: StudyState;
  nextState: StudyState;

  prevDue: number;
  nextDue: number;

  prevIntervalDays: number;
  nextIntervalDays: number;

  prevStepIndex: number;
  nextStepIndex: number;

  prevReps: number;
  nextReps: number;

  prevLapses: number;
  nextLapses: number;
};

export type NextCard = {
  card: CardEntity;
  state: CardStateEntity;
};
