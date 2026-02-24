import { NextResponse, type NextRequest } from "next/server";

import { getMongoDb } from "@/lib/mongodb";
import { getSessionFromRequest, type JsonError } from "@/app/api/auth/_shared";

export const runtime = "nodejs";

function isProbablyUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json<JsonError>({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const libraryId = (url.searchParams.get("libraryId") ?? "").trim();
  const sinceRaw = (url.searchParams.get("since") ?? "").trim();
  const since = Number(sinceRaw || 0);

  if (!libraryId || libraryId.length > 100 || !isProbablyUuid(libraryId)) {
    return NextResponse.json<JsonError>({ error: "Invalid libraryId" }, { status: 400 });
  }
  if (!Number.isFinite(since) || since < 0) {
    return NextResponse.json<JsonError>({ error: "Invalid since" }, { status: 400 });
  }

  let db;
  try {
    db = await getMongoDb();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Database misconfigured";
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
  }

  const now = Date.now();
  const userId = session.user.userId;

  const cardStates = await db
    .collection("cloudCardStates")
    .find({ userId, libraryId, uploadedAt: { $gte: since } })
    .project({ _id: 0, userId: 0, uploadedAt: 0 })
    .toArray();

  const reviewLogs = await db
    .collection("cloudReviewLogs")
    .find({ userId, libraryId, uploadedAt: { $gte: since } })
    .project({ _id: 0, userId: 0, uploadedAt: 0 })
    .toArray();

  const deckConfigs = await db
    .collection("cloudDeckConfigs")
    .find({ userId, libraryId, uploadedAt: { $gte: since } })
    .project({ _id: 0, userId: 0, uploadedAt: 0 })
    .toArray();

  return NextResponse.json(
    {
      ok: true,
      serverTime: now,
      cardStates,
      reviewLogs,
      deckConfigs,
    },
    { status: 200 }
  );
}
