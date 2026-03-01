import { NextResponse, type NextRequest } from "next/server";

import { getMongoDb } from "@/lib/mongodb";
import { getSessionFromRequest, type JsonError } from "@/app/api/auth/_shared";

export const runtime = "nodejs";

function isDevEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return /^(1|true)$/i.test(String(process.env.NEXT_PUBLIC_ENABLE_DEV_PURGE || ""));
}

export async function GET(req: NextRequest) {
  if (!isDevEnabled()) {
    return NextResponse.json<JsonError>({ error: "Not available" }, { status: 404 });
  }

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

  const userId = session.user.userId;
  const { searchParams } = new URL(req.url);
  const libraryId = (searchParams.get("libraryId") || "").trim();
  const filterLibrary = libraryId ? { libraryId } : {};

  const cardStatesColl = db.collection("cloudCardStates");
  const reviewLogsColl = db.collection("cloudReviewLogs");
  const deckConfigsColl = db.collection("cloudDeckConfigs");
  const librariesColl = db.collection("cloudLibraries");

  const [libraries, deckConfigs, cardStates, reviewLogs] = await Promise.all([
    librariesColl.countDocuments({ userId, ...filterLibrary }),
    deckConfigsColl.countDocuments({ userId, ...filterLibrary }),
    cardStatesColl.countDocuments({ userId, ...filterLibrary }),
    reviewLogsColl.countDocuments({ userId, ...filterLibrary }),
  ]);

  const [latestState, latestLog] = await Promise.all([
    cardStatesColl.find({ userId, ...filterLibrary }).sort({ uploadedAt: -1 }).limit(1).toArray(),
    reviewLogsColl.find({ userId, ...filterLibrary }).sort({ uploadedAt: -1 }).limit(1).toArray(),
  ]);

  const latest = {
    cardStateUploadedAt:
      latestState[0] && typeof latestState[0] === "object" && "uploadedAt" in latestState[0]
        ? (latestState[0] as { uploadedAt?: unknown }).uploadedAt
        : null,
    reviewLogUploadedAt:
      latestLog[0] && typeof latestLog[0] === "object" && "uploadedAt" in latestLog[0]
        ? (latestLog[0] as { uploadedAt?: unknown }).uploadedAt
        : null,
  };

  return NextResponse.json(
    {
      ok: true,
      userId,
      libraryId: libraryId || null,
      counts: {
        cloudLibraries: libraries,
        cloudDeckConfigs: deckConfigs,
        cloudCardStates: cardStates,
        cloudReviewLogs: reviewLogs,
      },
      latest,
    },
    { status: 200 }
  );
}
