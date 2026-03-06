import type { ImportedDeck } from "./apkg";
import { getStudyDb } from "./studyDb";
import { DEFAULT_DECK_CONFIG, getLocalDayStart, getLocalNextDayStart } from "./scheduler";
import { scheduleAnswer } from "./scheduler";
import type {
  AnswerResult,
  CardEntity,
  CardStateEntity,
  DeckConfig,
  DeckEntity,
  DeckRef,
  NextCard,
  ReviewLogEntity,
  ReviewAnswerStyle,
  StudyState,
} from "./studyTypes";

const WAITING_WINDOW_MS = 60 * 60 * 1000;

export type DeckOverview = {
  // "Words" for this app = unique noteId in the deck.
  total: number;
  reviewed: number;

  // Remaining for today, respecting daily limits.
  newLeftToday: number;
  reviewsLeftToday: number;

  // Due counts (available & due now)
  newAvailable: number;
  learningDue: number;
  reviewDue: number;

  // Cards scheduled for later today/soon (available but not due yet)
  learningWaiting: number;

  // Earliest upcoming due timestamp among learn/relearn/review (available).
  nextDueTs: number | null;

  // Earliest time the user can study again, considering daily limits.
  // Example: if you hit new/review daily caps but there are still cards,
  // this will be the next local day start.
  nextAvailableTs: number | null;

  // What the deck list should show (due, capped by limits).
  newShown: number;
  reviewShown: number;

  config: Pick<DeckConfig, "newPerDay" | "reviewsPerDay" | "cardInfoOpenByDefault" | "answerStyles" | "writeLanguage">;
};

function sanitizeAnswerStyles(raw: unknown): ReviewAnswerStyle[] {
  const allowed: ReviewAnswerStyle[] = [
    "normal",
    "write",
    "multiple-choice",
    "reverse",
  ];
  if (!Array.isArray(raw)) return allowed;
  const picked = raw.filter((x): x is ReviewAnswerStyle => allowed.includes(x as ReviewAnswerStyle));
  const uniq = Array.from(new Set(picked));
  return uniq.length > 0 ? uniq : allowed;
}

function sanitizeWriteLanguage(raw: unknown): DeckConfig["writeLanguage"] {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "fr") return "fr";
  if (v === "es") return "es";
  return "en";
}

function isAvailable(state: CardStateEntity, now: number): boolean {
  if (state.suspended) return false;
  if (state.buriedUntil != null && state.buriedUntil > now) return false;
  return true;
}

export async function getDeckConfig(ref: DeckRef): Promise<DeckConfig> {
  const db = getStudyDb();
  const deck = await db.decks.get([ref.libraryId, ref.deckId]);
  if (!deck) return DEFAULT_DECK_CONFIG;

  return {
    ...DEFAULT_DECK_CONFIG,
    newPerDay: deck.newPerDay,
    reviewsPerDay: deck.reviewsPerDay,
    cardInfoOpenByDefault: Boolean(deck.cardInfoOpenByDefault),
    answerStyles: sanitizeAnswerStyles((deck as { answerStyles?: unknown }).answerStyles),
    writeLanguage: sanitizeWriteLanguage((deck as { writeLanguage?: unknown }).writeLanguage),
  };
}

export async function setDeckWriteLanguage(
  ref: DeckRef,
  writeLanguage: DeckConfig["writeLanguage"]
): Promise<void> {
  const db = getStudyDb();
  const next = sanitizeWriteLanguage(writeLanguage);
  const now = Date.now();

  const updated = await db.decks.update([ref.libraryId, ref.deckId], {
    writeLanguage: next,
    updatedAt: now,
  });

  // If the deck row doesn't exist yet (race with initial seeding), create it.
  if (updated === 0) {
    await db.decks.put({
      libraryId: ref.libraryId,
      deckId: ref.deckId,
      name: "",
      newPerDay: DEFAULT_DECK_CONFIG.newPerDay,
      reviewsPerDay: DEFAULT_DECK_CONFIG.reviewsPerDay,
      cardInfoOpenByDefault: DEFAULT_DECK_CONFIG.cardInfoOpenByDefault,
      answerStyles: DEFAULT_DECK_CONFIG.answerStyles,
      writeLanguage: next,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function setDeckCardInfoOpenByDefault(
  ref: DeckRef,
  cardInfoOpenByDefault: boolean
): Promise<void> {
  const db = getStudyDb();
  const next = Boolean(cardInfoOpenByDefault);
  const now = Date.now();

  const updated = await db.decks.update([ref.libraryId, ref.deckId], {
    cardInfoOpenByDefault: next,
    updatedAt: now,
  });

  // If the deck row doesn't exist yet (race with initial seeding), create it.
  if (updated === 0) {
    await db.decks.put({
      libraryId: ref.libraryId,
      deckId: ref.deckId,
      name: "",
      newPerDay: DEFAULT_DECK_CONFIG.newPerDay,
      reviewsPerDay: DEFAULT_DECK_CONFIG.reviewsPerDay,
      cardInfoOpenByDefault: next,
      answerStyles: DEFAULT_DECK_CONFIG.answerStyles,
      writeLanguage: DEFAULT_DECK_CONFIG.writeLanguage,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function setDeckNewPerDay(ref: DeckRef, newPerDay: number): Promise<void> {
  const db = getStudyDb();
  const next = Number.isFinite(newPerDay) ? Math.max(0, Math.floor(newPerDay)) : 0;
  const now = Date.now();

  const updated = await db.decks.update([ref.libraryId, ref.deckId], {
    newPerDay: next,
    updatedAt: now,
  });

  // If the deck row doesn't exist yet (race with initial seeding), create it.
  if (updated === 0) {
    await db.decks.put({
      libraryId: ref.libraryId,
      deckId: ref.deckId,
      name: "",
      newPerDay: next,
      reviewsPerDay: DEFAULT_DECK_CONFIG.reviewsPerDay,
      cardInfoOpenByDefault: DEFAULT_DECK_CONFIG.cardInfoOpenByDefault,
      answerStyles: DEFAULT_DECK_CONFIG.answerStyles,
      writeLanguage: DEFAULT_DECK_CONFIG.writeLanguage,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function setDeckAnswerStyles(ref: DeckRef, styles: ReviewAnswerStyle[]): Promise<void> {
  const db = getStudyDb();
  const next = sanitizeAnswerStyles(styles);
  const now = Date.now();

  // Local-only UI preference: intentionally do NOT bump updatedAt.
  const updated = await db.decks.update([ref.libraryId, ref.deckId], {
    answerStyles: next,
  });

  // If the deck row doesn't exist yet (race with initial seeding), create it.
  if (updated === 0) {
    await db.decks.put({
      libraryId: ref.libraryId,
      deckId: ref.deckId,
      name: "",
      newPerDay: DEFAULT_DECK_CONFIG.newPerDay,
      reviewsPerDay: DEFAULT_DECK_CONFIG.reviewsPerDay,
      cardInfoOpenByDefault: DEFAULT_DECK_CONFIG.cardInfoOpenByDefault,
      answerStyles: next,
      writeLanguage: DEFAULT_DECK_CONFIG.writeLanguage,
      createdAt: now,
      updatedAt: 0,
    });
  }
}

export async function upsertImportedDeck(libraryId: string, imported: ImportedDeck): Promise<void> {
  const db = getStudyDb();
  const now = Date.now();

  await db.transaction("rw", db.decks, db.cards, db.cardStates, async () => {
    const deckKeys = imported.decks.map((d) => [libraryId, d.id] as [string, number]);
    const existingDecks = await db.decks.bulkGet(deckKeys);

    const decks: DeckEntity[] = imported.decks.map((d, idx) => {
      const prev = existingDecks[idx] ?? null;

      return {
        libraryId,
        deckId: d.id,
        name: d.name,
        newPerDay: prev?.newPerDay ?? DEFAULT_DECK_CONFIG.newPerDay,
        reviewsPerDay: prev?.reviewsPerDay ?? DEFAULT_DECK_CONFIG.reviewsPerDay,
        cardInfoOpenByDefault:
          prev?.cardInfoOpenByDefault ?? DEFAULT_DECK_CONFIG.cardInfoOpenByDefault,
        answerStyles: sanitizeAnswerStyles((prev as { answerStyles?: unknown } | null)?.answerStyles),
        writeLanguage: sanitizeWriteLanguage((prev as { writeLanguage?: unknown } | null)?.writeLanguage),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
    });

    await db.decks.bulkPut(decks);

    const cards: CardEntity[] = imported.cards.map((c) => ({
      libraryId,
      cardId: c.id,
      deckId: c.deckId,
      noteId: c.noteId,
      frontHtml: c.frontHtml,
      backHtml: c.backHtml,
      fieldsHtml: c.fieldsHtml,
      fieldNames: c.fieldNames,
      createdAt: now,
      updatedAt: now,
    }));

    await db.cards.bulkPut(cards);

    const keys = imported.cards.map((c) => [libraryId, c.id] as [string, number]);
    const existing = await db.cardStates.bulkGet(keys);

    const toPut: CardStateEntity[] = imported.cards.map((c, idx) => {
      const prev = existing[idx] ?? null;

      // Preserve scheduling if it already exists.
      if (prev) {
        return {
          ...prev,
          deckId: c.deckId,
          noteId: c.noteId,
          // Important: keep updatedAt as the scheduling/progress timestamp.
          // Re-importing or downloading deck data shouldn't make this look
          // like a newer progress update than what's in the cloud.
          updatedAt: prev.updatedAt,
        };
      }

      const initial: CardStateEntity = {
        libraryId,
        cardId: c.id,
        deckId: c.deckId,
        noteId: c.noteId,
        state: "new",
        due: 0,
        intervalDays: 0,
        ease: DEFAULT_DECK_CONFIG.easeFactor,
        reps: 0,
        lapses: 0,
        stepIndex: 0,
        suspended: false,
        buriedUntil: null,
        lastReview: null,
        createdAt: now,
        // Seeded state: treat as "unknown/never-synced" progress so it doesn't
        // overwrite real progress when syncing on a new device.
        updatedAt: 0,
      };
      return initial;
    });

    await db.cardStates.bulkPut(toPut);
  });
}

async function getTodayCounts(ref: DeckRef, now: number): Promise<{ newDone: number; reviewDone: number }> {
  const db = getStudyDb();
  const dayStart = getLocalDayStart(now);

  const logs = await db.reviewLogs
    .where("[libraryId+deckId+ts]")
    .between([ref.libraryId, ref.deckId, dayStart], [ref.libraryId, ref.deckId, now], true, true)
    .toArray();

  let newDone = 0;
  let reviewDone = 0;

  for (const l of logs) {
    if (l.prevState === "new") newDone += 1;
    if (l.prevState === "review") reviewDone += 1;
  }

  return { newDone, reviewDone };
}

async function pickDue(ref: DeckRef, state: StudyState, now: number): Promise<CardStateEntity | null> {
  const db = getStudyDb();

  const batch = await db.cardStates
    .where("[libraryId+deckId+state+due]")
    .between([ref.libraryId, ref.deckId, state, 0], [ref.libraryId, ref.deckId, state, now], true, true)
    .limit(50)
    .toArray();

  for (const s of batch) {
    if (isAvailable(s, now)) return s;
  }

  return null;
}

type GetNextCardOptions = {
  // If set, treat learn/relearn cards with due <= now + window as available.
  // This is a UX choice to avoid waiting screens.
  learnAheadMs?: number;

  // Controls which learning states can be pulled ahead of time.
  // Default keeps prior behavior; UI can tighten this.
  learnAheadMode?: "learn+relearn" | "relearn-only";

  // Avoid immediately repeating the same card when using learn-ahead.
  excludeCardId?: number;
};

async function pickDueUpTo(
  ref: DeckRef,
  state: StudyState,
  now: number,
  maxDue: number,
  options?: { randomPick?: boolean; excludeCardId?: number }
): Promise<CardStateEntity | null> {
  const db = getStudyDb();

  const batch = await db.cardStates
    .where("[libraryId+deckId+state+due]")
    .between(
      [ref.libraryId, ref.deckId, state, 0],
      [ref.libraryId, ref.deckId, state, maxDue],
      true,
      true
    )
    .limit(50)
    .toArray();

  const candidates = batch
    .filter((s) => isAvailable(s, now))
    .filter((s) => (options?.excludeCardId != null ? s.cardId !== options.excludeCardId : true));
  if (candidates.length === 0) return null;

  if (options?.randomPick) {
    const idx = Math.floor(Math.random() * candidates.length);
    return candidates[idx] ?? null;
  }

  return candidates[0] ?? null;
}

async function countDue(ref: DeckRef, state: StudyState, now: number): Promise<number> {
  const db = getStudyDb();
  const batch = await db.cardStates
    .where("[libraryId+deckId+state+due]")
    .between([ref.libraryId, ref.deckId, state, 0], [ref.libraryId, ref.deckId, state, now], true, true)
    .toArray();

  let count = 0;
  for (const s of batch) {
    if (isAvailable(s, now)) count += 1;
  }
  return count;
}

async function countWaiting(ref: DeckRef, state: StudyState, now: number): Promise<{ count: number; nextDueTs: number | null }> {
  const db = getStudyDb();
  const maxDue = now + WAITING_WINDOW_MS;
  const batch = await db.cardStates
    .where("[libraryId+deckId+state+due]")
    .between(
      [ref.libraryId, ref.deckId, state, now + 1],
      [ref.libraryId, ref.deckId, state, maxDue],
      true,
      true
    )
    .limit(200)
    .toArray();

  let count = 0;
  let nextDueTs: number | null = null;

  for (const s of batch) {
    if (!isAvailable(s, now)) continue;
    count += 1;
    if (nextDueTs == null || s.due < nextDueTs) nextDueTs = s.due;
  }

  return { count, nextDueTs };
}

async function findNextDueAfter(
  ref: DeckRef,
  state: StudyState,
  now: number
): Promise<number | null> {
  const db = getStudyDb();

  // The compound index ends with `due`, so this query is ordered by due asc.
  // We scan in chunks to skip suspended/buried cards efficiently.
  const LIMIT = 500;
  let start = now + 1;
  const MAX = Number.MAX_SAFE_INTEGER;

  for (let i = 0; i < 20; i += 1) {
    const batch = await db.cardStates
      .where("[libraryId+deckId+state+due]")
      .between(
        [ref.libraryId, ref.deckId, state, start],
        [ref.libraryId, ref.deckId, state, MAX],
        true,
        true
      )
      .limit(LIMIT)
      .toArray();

    if (batch.length === 0) return null;

    for (const s of batch) {
      if (isAvailable(s, now)) return s.due;
    }

    if (batch.length < LIMIT) return null;
    const lastDue = batch[batch.length - 1]?.due ?? null;
    if (typeof lastDue !== "number" || !Number.isFinite(lastDue)) return null;
    start = Math.max(start, lastDue + 1);
  }

  return null;
}

export async function getDeckOverview(ref: DeckRef): Promise<DeckOverview> {
  const db = getStudyDb();
  const now = Date.now();

  const [cfg, today, cardsInDeck, statesInDeck] = await Promise.all([
    getDeckConfig(ref),
    getTodayCounts(ref, now),
    db.cards.where("[libraryId+deckId]").equals([ref.libraryId, ref.deckId]).toArray(),
    db.cardStates
      .where("[libraryId+deckId+due]")
      .between(
        [ref.libraryId, ref.deckId, 0],
        [ref.libraryId, ref.deckId, Number.MAX_SAFE_INTEGER],
        true,
        true
      )
      .toArray(),
  ]);

  const totalNoteIds = new Set<number>();
  for (const c of cardsInDeck) totalNoteIds.add(c.noteId);
  const total = totalNoteIds.size;

  const [newAvailable, learnDue, relearnDue, reviewDue] = await Promise.all([
    countDue(ref, "new", now),
    countDue(ref, "learn", now),
    countDue(ref, "relearn", now),
    countDue(ref, "review", now),
  ]);

  const [learnWaiting, relearnWaiting] = await Promise.all([
    countWaiting(ref, "learn", now),
    countWaiting(ref, "relearn", now),
  ]);

  const learningWaiting = learnWaiting.count + relearnWaiting.count;

  const [nextLearnTs, nextRelearnTs, nextReviewTs] = await Promise.all([
    findNextDueAfter(ref, "learn", now),
    findNextDueAfter(ref, "relearn", now),
    findNextDueAfter(ref, "review", now),
  ]);

  const nextDueTs = (() => {
    const candidates = [nextLearnTs, nextRelearnTs, nextReviewTs].filter(
      (x): x is number => typeof x === "number" && Number.isFinite(x) && x > now
    );
    if (candidates.length === 0) return null;
    return Math.min(...candidates);
  })();

  // Reviewed = unique notes that have been answered at least once.
  const reviewedNoteIds = new Set<number>();
  for (const s of statesInDeck) {
    if (s.reps > 0) reviewedNoteIds.add(s.noteId);
  }
  const reviewed = reviewedNoteIds.size;

  const newLeftToday = Math.max(0, cfg.newPerDay - today.newDone);
  const reviewsLeftToday = Math.max(0, cfg.reviewsPerDay - today.reviewDone);

  const learningDue = learnDue + relearnDue;
  const newShown = Math.min(newAvailable, newLeftToday);
  const reviewShown = Math.min(reviewDue, reviewsLeftToday);

  const nextAvailableTs = (() => {
    const candidates: number[] = [];

    // Learning is never limited by daily caps.
    if (typeof nextLearnTs === "number" && nextLearnTs > now) candidates.push(nextLearnTs);
    if (typeof nextRelearnTs === "number" && nextRelearnTs > now) candidates.push(nextRelearnTs);

    const dayResetTs = getLocalNextDayStart(now);

    const hasMoreNewButCapped = newLeftToday === 0 && newAvailable > 0;
    if (hasMoreNewButCapped) candidates.push(dayResetTs);

    const hasAnyReviewUpcomingOrDue =
      reviewDue > 0 || (typeof nextReviewTs === "number" && nextReviewTs > now);

    const reviewsCapped = reviewsLeftToday === 0;
    if (reviewsCapped && hasAnyReviewUpcomingOrDue) {
      // Even if reviews are due sooner, they won't show until the cap resets.
      candidates.push(dayResetTs);
    } else if (!reviewsCapped && typeof nextReviewTs === "number" && nextReviewTs > now) {
      candidates.push(nextReviewTs);
    }

    if (candidates.length === 0) return null;
    return Math.min(...candidates);
  })();

  return {
    total,
    reviewed,
    newLeftToday,
    reviewsLeftToday,
    newAvailable,
    learningDue,
    reviewDue,
    learningWaiting,
    nextDueTs,
    nextAvailableTs,
    newShown,
    reviewShown,
    config: {
      newPerDay: cfg.newPerDay,
      reviewsPerDay: cfg.reviewsPerDay,
      cardInfoOpenByDefault: cfg.cardInfoOpenByDefault,
      answerStyles: cfg.answerStyles,
      writeLanguage: cfg.writeLanguage,
    },
  };
}

export async function getNextCard(ref: DeckRef, options: GetNextCardOptions = {}): Promise<NextCard | null> {
  const db = getStudyDb();
  const now = Date.now();
  const cfg = await getDeckConfig(ref);
  const { newDone, reviewDone } = await getTodayCounts(ref, now);

  const learnAheadMs = Math.max(0, options.learnAheadMs ?? 0);
  const learnMaxDue = now + learnAheadMs;
  const learnAheadMode = options.learnAheadMode ?? "learn+relearn";
  const excludeCardId = options.excludeCardId ?? null;

  // a) learn/relearn due NOW (never use learn-ahead here)
  const learn =
    (await pickDueUpTo(ref, "learn", now, now)) ??
    (await pickDueUpTo(ref, "relearn", now, now));
  if (learn) {
    const card = await db.cards.get([ref.libraryId, learn.cardId]);
    if (!card) return null;
    return { card, state: learn };
  }

  // b/c) review + new (both respect daily limits) — interleave instead of exhausting reviews first.
  const canReview = reviewDone < cfg.reviewsPerDay;
  const canNew = newDone < cfg.newPerDay;

  const tryPickReview = async (): Promise<NextCard | null> => {
    if (!canReview) return null;
    const review = await pickDue(ref, "review", now);
    if (!review) return null;
    const card = await db.cards.get([ref.libraryId, review.cardId]);
    if (!card) return null;
    return { card, state: review };
  };

  const tryPickNew = async (): Promise<NextCard | null> => {
    if (!canNew) return null;
    const nextNew = await pickDue(ref, "new", now);
    if (!nextNew) return null;
    const card = await db.cards.get([ref.libraryId, nextNew.cardId]);
    if (!card) return null;
    return { card, state: nextNew };
  };

  if (canReview || canNew) {
    const progressNew = cfg.newPerDay > 0 ? newDone / cfg.newPerDay : 1;
    const progressReview = cfg.reviewsPerDay > 0 ? reviewDone / cfg.reviewsPerDay : 1;
    const preferNew = canNew && (!canReview || progressNew < progressReview);

    const first = preferNew ? await tryPickNew() : await tryPickReview();
    if (first) return first;

    const second = preferNew ? await tryPickReview() : await tryPickNew();
    if (second) return second;
  }

  // d) learn-ahead: if enabled and nothing else is available, treat soon learn/relearn as available.
  if (learnAheadMs > 0) {
    const randomizeLearning = true;

    const soonRelearn = await pickDueUpTo(ref, "relearn", now, learnMaxDue, {
      randomPick: randomizeLearning,
      excludeCardId: excludeCardId ?? undefined,
    });

    const soonLearn =
      learnAheadMode === "learn+relearn"
        ? await pickDueUpTo(ref, "learn", now, learnMaxDue, {
            randomPick: randomizeLearning,
            excludeCardId: excludeCardId ?? undefined,
          })
        : null;

    const soon = soonRelearn ?? soonLearn;

    if (soon) {
      const card = await db.cards.get([ref.libraryId, soon.cardId]);
      if (!card) return null;
      return { card, state: soon };
    }
  }

  return null;
}

export async function answerCard(
  ref: DeckRef,
  cardId: number,
  result: AnswerResult,
  timeTakenMs?: number
): Promise<void> {
  const db = getStudyDb();
  const now = Date.now();
  const cfg = await getDeckConfig(ref);

  await db.transaction("rw", db.cardStates, db.reviewLogs, async () => {
    const state = await db.cardStates.get([ref.libraryId, cardId]);
    if (!state) {
      throw new Error("Card state not found. Did you seed the study DB?");
    }

    const prev: CardStateEntity = state;
    const scheduled = scheduleAnswer(prev, result, now, cfg);

    const next: CardStateEntity = {
      ...prev,
      state: scheduled.nextState,
      due: scheduled.nextDue,
      intervalDays: scheduled.nextIntervalDays,
      stepIndex: scheduled.nextStepIndex,
      reps: scheduled.nextReps,
      lapses: scheduled.nextLapses,
      lastReview: now,
      updatedAt: now,
    };

    await db.cardStates.put(next);

    // Bury siblings (same note) until tomorrow.
    const buryUntil = getLocalNextDayStart(now);
    const siblings = await db.cardStates.where("[libraryId+noteId]").equals([ref.libraryId, prev.noteId]).toArray();

    const siblingUpdates = siblings
      .filter((s) => s.cardId !== prev.cardId)
      .filter((s) => !s.suspended)
      .map((s) => ({
        ...s,
        buriedUntil: Math.max(s.buriedUntil ?? 0, buryUntil) || buryUntil,
        updatedAt: now,
      }));

    if (siblingUpdates.length > 0) {
      await db.cardStates.bulkPut(siblingUpdates);
    }

    const logBase = {
      libraryId: ref.libraryId,
      deckId: ref.deckId,
      cardId: prev.cardId,
      noteId: prev.noteId,
      ts: now,
      result,
      timeTakenMs,
      prevState: prev.state,
      nextState: next.state,
      prevDue: prev.due,
      nextDue: next.due,
      prevIntervalDays: prev.intervalDays,
      nextIntervalDays: next.intervalDays,
      prevStepIndex: prev.stepIndex,
      nextStepIndex: next.stepIndex,
      prevReps: prev.reps,
      nextReps: next.reps,
      prevLapses: prev.lapses,
      nextLapses: next.lapses,
    };

    const syncKey = [
      logBase.libraryId,
      logBase.deckId,
      logBase.cardId,
      logBase.noteId,
      logBase.ts,
      logBase.result,
      logBase.prevState,
      logBase.nextState,
      logBase.prevDue,
      logBase.nextDue,
      logBase.prevIntervalDays,
      logBase.nextIntervalDays,
      logBase.prevStepIndex,
      logBase.nextStepIndex,
      logBase.prevReps,
      logBase.nextReps,
      logBase.prevLapses,
      logBase.nextLapses,
      logBase.timeTakenMs ?? "",
    ].join("|");

    const log: ReviewLogEntity = {
      ...logBase,
      syncKey,
    };

    await db.reviewLogs.add(log);
  });
}

export async function suspendCard(ref: DeckRef, cardId: number): Promise<void> {
  const db = getStudyDb();
  await db.cardStates.update([ref.libraryId, cardId], { suspended: true, updatedAt: Date.now() });
}

export async function buryCard(ref: DeckRef, cardId: number): Promise<void> {
  const db = getStudyDb();
  const now = Date.now();
  await db.cardStates.update([ref.libraryId, cardId], {
    buriedUntil: getLocalNextDayStart(now),
    updatedAt: now,
  });
}

export async function reschedule(ref: DeckRef, cardId: number, due: number): Promise<void> {
  const db = getStudyDb();
  await db.cardStates.update([ref.libraryId, cardId], { due, updatedAt: Date.now() });
}

export async function startStudySession(ref: DeckRef): Promise<void> {
  // Minimal: currently a no-op, but it's a good place to expire buries.
  const db = getStudyDb();
  const now = Date.now();

  // Unbury any cards whose buriedUntil has passed.
  // (No index-friendly query yet; keep it minimal.)
  await db.cardStates
    .where("[libraryId+deckId+due]")
    .between([ref.libraryId, ref.deckId, 0], [ref.libraryId, ref.deckId, Number.MAX_SAFE_INTEGER], true, true)
    .modify((s) => {
      if (s.buriedUntil != null && s.buriedUntil <= now) {
        s.buriedUntil = null;
        s.updatedAt = now;
      }
    });
}

export async function getDeckStats(
  ref: DeckRef,
  dateRange: { fromTs: number; toTs: number }
): Promise<{ reviews: number; passes: number; fails: number; newIntroduced: number }> {
  const db = getStudyDb();
  const logs = await db.reviewLogs
    .where("[libraryId+deckId+ts]")
    .between([ref.libraryId, ref.deckId, dateRange.fromTs], [ref.libraryId, ref.deckId, dateRange.toTs], true, true)
    .toArray();

  let passes = 0;
  let fails = 0;
  let newIntroduced = 0;

  for (const l of logs) {
    if (l.result === "pass") passes += 1;
    if (l.result === "fail") fails += 1;
    if (l.prevState === "new") newIntroduced += 1;
  }

  return { reviews: logs.length, passes, fails, newIntroduced };
}

export async function getTodayRemaining(ref: DeckRef): Promise<{ newLeft: number; reviewsLeft: number }> {
  const now = Date.now();
  const cfg = await getDeckConfig(ref);
  const { newDone, reviewDone } = await getTodayCounts(ref, now);

  return {
    newLeft: Math.max(0, cfg.newPerDay - newDone),
    reviewsLeft: Math.max(0, cfg.reviewsPerDay - reviewDone),
  };
}

export async function resetDeckProgress(ref: DeckRef): Promise<void> {
  const db = getStudyDb();
  const now = Date.now();

  await db.transaction("rw", db.cardStates, db.reviewLogs, async () => {
    const states = await db.cardStates
      .where("[libraryId+deckId+due]")
      .between(
        [ref.libraryId, ref.deckId, 0],
        [ref.libraryId, ref.deckId, Number.MAX_SAFE_INTEGER],
        true,
        true
      )
      .toArray();

    const resetStates: CardStateEntity[] = states.map((s) => ({
      ...s,
      state: "new",
      due: 0,
      intervalDays: 0,
      ease: DEFAULT_DECK_CONFIG.easeFactor,
      reps: 0,
      lapses: 0,
      stepIndex: 0,
      suspended: false,
      buriedUntil: null,
      lastReview: null,
      updatedAt: now,
    }));

    if (resetStates.length > 0) {
      await db.cardStates.bulkPut(resetStates);
    }

    const logs = await db.reviewLogs
      .where("[libraryId+deckId+ts]")
      .between(
        [ref.libraryId, ref.deckId, 0],
        [ref.libraryId, ref.deckId, Number.MAX_SAFE_INTEGER],
        true,
        true
      )
      .toArray();

    const ids = logs.map((l) => l.id).filter((x): x is number => typeof x === "number" && x > 0);
    if (ids.length === 0) return;

    const CHUNK = 1000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      await db.reviewLogs.bulkDelete(ids.slice(i, i + CHUNK));
    }
  });
}
