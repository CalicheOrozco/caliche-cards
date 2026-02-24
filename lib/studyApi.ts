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

  // Earliest upcoming due timestamp among learn/relearn (available).
  nextDueTs: number | null;

  // What the deck list should show (due, capped by limits).
  newShown: number;
  reviewShown: number;

  config: Pick<DeckConfig, "newPerDay" | "reviewsPerDay" | "cardInfoOpenByDefault">;
};

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
  };
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
      createdAt: now,
      updatedAt: now,
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
          updatedAt: now,
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
        updatedAt: now,
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
  const nextDueTs =
    learnWaiting.nextDueTs == null
      ? relearnWaiting.nextDueTs
      : relearnWaiting.nextDueTs == null
        ? learnWaiting.nextDueTs
        : Math.min(learnWaiting.nextDueTs, relearnWaiting.nextDueTs);

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
    newShown,
    reviewShown,
    config: {
      newPerDay: cfg.newPerDay,
      reviewsPerDay: cfg.reviewsPerDay,
      cardInfoOpenByDefault: cfg.cardInfoOpenByDefault,
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

  // b) review due (respect daily limit)
  if (reviewDone < cfg.reviewsPerDay) {
    const review = await pickDue(ref, "review", now);
    if (review) {
      const card = await db.cards.get([ref.libraryId, review.cardId]);
      if (!card) return null;
      return { card, state: review };
    }
  }

  // c) new (respect daily limit)
  if (newDone < cfg.newPerDay) {
    const batch = await db.cardStates
      .where("[libraryId+deckId+state+due]")
      .between([ref.libraryId, ref.deckId, "new", 0], [ref.libraryId, ref.deckId, "new", now], true, true)
      .limit(50)
      .toArray();

    const nextNew = batch.find((s) => isAvailable(s, now)) ?? null;
    if (nextNew) {
      const card = await db.cards.get([ref.libraryId, nextNew.cardId]);
      if (!card) return null;
      return { card, state: nextNew };
    }
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
