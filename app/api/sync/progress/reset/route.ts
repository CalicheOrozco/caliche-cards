import { NextResponse, type NextRequest } from "next/server";

import { getMongoDb } from "@/lib/mongodb";
import { getSessionFromRequest, type JsonError } from "@/app/api/auth/_shared";

export const runtime = "nodejs";

function isProbablyUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

type ResetBody = {
  libraryId: string;
  deckId: number;
};

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json<JsonError>({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ResetBody;
  try {
    body = (await req.json()) as ResetBody;
  } catch {
    return NextResponse.json<JsonError>({ error: "Invalid JSON" }, { status: 400 });
  }

  const libraryId = typeof body?.libraryId === "string" ? body.libraryId.trim() : "";
  const deckId = typeof body?.deckId === "number" ? body.deckId : Number(body?.deckId);

  if (!libraryId || libraryId.length > 100 || !isProbablyUuid(libraryId)) {
    return NextResponse.json<JsonError>({ error: "Invalid libraryId" }, { status: 400 });
  }
  if (!Number.isFinite(deckId) || deckId <= 0) {
    return NextResponse.json<JsonError>({ error: "Invalid deckId" }, { status: 400 });
  }

  let db;
  try {
    db = await getMongoDb();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Database misconfigured";
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
  }

  const userId = session.user.userId;

  const [cardStatesRes, reviewLogsRes] = await Promise.all([
    db.collection("cloudCardStates").deleteMany({ userId, libraryId, deckId }),
    db.collection("cloudReviewLogs").deleteMany({ userId, libraryId, deckId }),
  ]);

  return NextResponse.json(
    {
      ok: true,
      deleted: {
        cardStates: cardStatesRes.deletedCount ?? 0,
        reviewLogs: reviewLogsRes.deletedCount ?? 0,
      },
    },
    { status: 200 }
  );
}
