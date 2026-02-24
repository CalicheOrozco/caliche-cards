import { NextResponse, type NextRequest } from "next/server";

import { getMongoDb } from "@/lib/mongodb";
import { getSessionFromRequest, type JsonError } from "@/app/api/auth/_shared";

export const runtime = "nodejs";

function isProbablyUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

type CardStatePayload = {
  libraryId: string;
  cardId: number;
  deckId: number;
  noteId: number;
  state: string;
  due: number;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  stepIndex: number;
  suspended: boolean;
  buriedUntil: number | null;
  lastReview: number | null;
  createdAt: number;
  updatedAt: number;
};

type ReviewLogPayload = {
  syncKey?: string;

  libraryId: string;
  deckId: number;
  cardId: number;
  noteId: number;

  ts: number;
  result: string;
  timeTakenMs?: number;

  prevState: string;
  nextState: string;

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

type DeckConfigPayload = {
  libraryId: string;
  deckId: number;
  newPerDay: number;
  reviewsPerDay: number;
  cardInfoOpenByDefault?: boolean;
  updatedAt: number;
};

type PushBody = {
  libraryId: string;
  cardStates?: CardStatePayload[];
  reviewLogs?: ReviewLogPayload[];
  deckConfigs?: DeckConfigPayload[];
};

function computeReviewLogSyncKey(log: ReviewLogPayload): string {
  return [
    log.libraryId,
    log.deckId,
    log.cardId,
    log.noteId,
    log.ts,
    log.result,
    log.prevState,
    log.nextState,
    log.prevDue,
    log.nextDue,
    log.prevIntervalDays,
    log.nextIntervalDays,
    log.prevStepIndex,
    log.nextStepIndex,
    log.prevReps,
    log.nextReps,
    log.prevLapses,
    log.nextLapses,
    log.timeTakenMs ?? "",
  ].join("|");
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json<JsonError>({ error: "Unauthorized" }, { status: 401 });
  }

  let db;
  try {
    db = await getMongoDb();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Database misconfigured";
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
  }

  let body: PushBody;
  try {
    body = (await req.json()) as PushBody;
  } catch {
    return NextResponse.json<JsonError>({ error: "Invalid JSON" }, { status: 400 });
  }

  const libraryId = typeof body?.libraryId === "string" ? body.libraryId.trim() : "";
  if (!libraryId || libraryId.length > 100 || !isProbablyUuid(libraryId)) {
    return NextResponse.json<JsonError>({ error: "Invalid libraryId" }, { status: 400 });
  }

  const now = Date.now();
  const userId = session.user.userId;

  const cardStatesRaw = Array.isArray(body.cardStates) ? body.cardStates : [];
  const reviewLogsRaw = Array.isArray(body.reviewLogs) ? body.reviewLogs : [];
  const deckConfigsRaw = Array.isArray(body.deckConfigs) ? body.deckConfigs : [];

  // Prevent accidental huge payloads.
  if (cardStatesRaw.length > 20000 || reviewLogsRaw.length > 50000 || deckConfigsRaw.length > 5000) {
    return NextResponse.json<JsonError>({ error: "Payload too large" }, { status: 413 });
  }

  const cardStates = cardStatesRaw.filter((s) => s && s.libraryId === libraryId);
  const reviewLogs = reviewLogsRaw
    .filter((l) => l && l.libraryId === libraryId)
    .map((l) => ({ ...l, syncKey: (typeof l.syncKey === "string" && l.syncKey) ? l.syncKey : computeReviewLogSyncKey(l) }));
  const deckConfigs = deckConfigsRaw
    .filter((d) => d && d.libraryId === libraryId)
    .map((d) => ({
      ...d,
      deckId: typeof d.deckId === "number" ? d.deckId : Number(d.deckId),
      newPerDay: typeof d.newPerDay === "number" ? d.newPerDay : Number(d.newPerDay),
      reviewsPerDay: typeof d.reviewsPerDay === "number" ? d.reviewsPerDay : Number(d.reviewsPerDay),
      cardInfoOpenByDefault: Boolean((d as { cardInfoOpenByDefault?: unknown }).cardInfoOpenByDefault),
      updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : Number(d.updatedAt),
    }))
    .filter((d) => Number.isFinite(d.deckId) && d.deckId > 0)
    .filter((d) => Number.isFinite(d.updatedAt) && d.updatedAt > 0)
    .map((d) => ({
      libraryId: d.libraryId,
      deckId: Math.floor(d.deckId),
      newPerDay: Number.isFinite(d.newPerDay) ? Math.max(0, Math.floor(d.newPerDay)) : 0,
      reviewsPerDay: Number.isFinite(d.reviewsPerDay) ? Math.max(0, Math.floor(d.reviewsPerDay)) : 0,
      cardInfoOpenByDefault: Boolean(d.cardInfoOpenByDefault),
      updatedAt: d.updatedAt,
    }));

  const cardStatesColl = db.collection("cloudCardStates");
  const reviewLogsColl = db.collection("cloudReviewLogs");
  const deckConfigsColl = db.collection("cloudDeckConfigs");

  await Promise.all([
    cardStatesColl.createIndex({ userId: 1, libraryId: 1, cardId: 1 }, { unique: true }),
    cardStatesColl.createIndex({ userId: 1, libraryId: 1, uploadedAt: 1 }),
    reviewLogsColl.createIndex({ userId: 1, libraryId: 1, syncKey: 1 }, { unique: true }),
    reviewLogsColl.createIndex({ userId: 1, libraryId: 1, uploadedAt: 1 }),
    deckConfigsColl.createIndex({ userId: 1, libraryId: 1, deckId: 1 }, { unique: true }),
    deckConfigsColl.createIndex({ userId: 1, libraryId: 1, uploadedAt: 1 }),
  ]);

  if (cardStates.length > 0) {
    const ops = cardStates.map((s) => ({
      updateOne: {
        filter: {
          userId,
          libraryId,
          cardId: s.cardId,
          $or: [
            { updatedAt: { $lt: s.updatedAt } },
            { updatedAt: { $exists: false } },
            { updatedAt: s.updatedAt },
            // Recovery/clock-skew safety: if reps increased, progress advanced.
            { reps: { $lt: s.reps } },
          ],
        },
        update: {
          $set: {
            userId,
            libraryId,
            cardId: s.cardId,
            deckId: s.deckId,
            noteId: s.noteId,
            state: s.state,
            due: s.due,
            intervalDays: s.intervalDays,
            ease: s.ease,
            reps: s.reps,
            lapses: s.lapses,
            stepIndex: s.stepIndex,
            suspended: s.suspended,
            buriedUntil: s.buriedUntil ?? null,
            lastReview: s.lastReview ?? null,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            uploadedAt: now,
          },
        },
        upsert: true,
      },
    }));

    // ordered:false continues even if some ops fail.
    await cardStatesColl.bulkWrite(ops, { ordered: false });
  }

  let insertedLogs = 0;
  if (reviewLogs.length > 0) {
    const ops = reviewLogs.map((l) => ({
      updateOne: {
        filter: { userId, libraryId, syncKey: l.syncKey },
        update: {
          $setOnInsert: {
            userId,
            libraryId,
            syncKey: l.syncKey,
            deckId: l.deckId,
            cardId: l.cardId,
            noteId: l.noteId,
            ts: l.ts,
            result: l.result,
            timeTakenMs: l.timeTakenMs,
            prevState: l.prevState,
            nextState: l.nextState,
            prevDue: l.prevDue,
            nextDue: l.nextDue,
            prevIntervalDays: l.prevIntervalDays,
            nextIntervalDays: l.nextIntervalDays,
            prevStepIndex: l.prevStepIndex,
            nextStepIndex: l.nextStepIndex,
            prevReps: l.prevReps,
            nextReps: l.nextReps,
            prevLapses: l.prevLapses,
            nextLapses: l.nextLapses,
            uploadedAt: now,
          },
        },
        upsert: true,
      },
    }));

    const res = await reviewLogsColl.bulkWrite(ops, { ordered: false });
    insertedLogs = res.upsertedCount ?? 0;
  }

  if (deckConfigs.length > 0) {
    const ops = deckConfigs.map((d) => ({
      updateOne: {
        filter: {
          userId,
          libraryId,
          deckId: d.deckId,
          $or: [{ updatedAt: { $lt: d.updatedAt } }, { updatedAt: { $exists: false } }, { updatedAt: d.updatedAt }],
        },
        update: {
          $set: {
            userId,
            libraryId,
            deckId: d.deckId,
            newPerDay: d.newPerDay,
            reviewsPerDay: d.reviewsPerDay,
            cardInfoOpenByDefault: Boolean(d.cardInfoOpenByDefault),
            updatedAt: d.updatedAt,
            uploadedAt: now,
          },
        },
        upsert: true,
      },
    }));

    await deckConfigsColl.bulkWrite(ops, { ordered: false });
  }

  return NextResponse.json(
    {
      ok: true,
      serverTime: now,
      received: {
        cardStates: cardStates.length,
        reviewLogs: reviewLogs.length,
        deckConfigs: deckConfigs.length,
      },
      inserted: {
        reviewLogs: insertedLogs,
      },
    },
    { status: 200 }
  );
}
