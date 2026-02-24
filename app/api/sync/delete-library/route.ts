import { GridFSBucket, type Db, type ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";

import { getSessionFromRequest, type JsonError } from "@/app/api/auth/_shared";
import { getMongoDb } from "@/lib/mongodb";

export const runtime = "nodejs";

function isProbablyUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function getBucket(db: Db, bucketName: "apkg" | "deckdata"): GridFSBucket {
  return new GridFSBucket(db, { bucketName });
}

function getMediaBucket(db: Db): GridFSBucket {
  return new GridFSBucket(db, { bucketName: "media" });
}

type DeleteLibraryBody = {
  libraryId: string;
};

type GridFsFileDoc = {
  _id: ObjectId;
  metadata?: { userId?: string; libraryId?: string };
};

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json<JsonError>({ error: "Unauthorized" }, { status: 401 });
  }

  let body: DeleteLibraryBody;
  try {
    body = (await req.json()) as DeleteLibraryBody;
  } catch {
    return NextResponse.json<JsonError>({ error: "Invalid JSON" }, { status: 400 });
  }

  const libraryId = typeof body?.libraryId === "string" ? body.libraryId.trim() : "";
  if (!libraryId || libraryId.length > 100 || !isProbablyUuid(libraryId)) {
    return NextResponse.json<JsonError>({ error: "Invalid libraryId" }, { status: 400 });
  }

  let db;
  try {
    db = await getMongoDb();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Database misconfigured";
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
  }

  const userId = session.user.userId;

  const [libsRes, cardStatesRes, reviewLogsRes, deckConfigsRes, mediaRes] = await Promise.all([
    db.collection("cloudLibraries").deleteMany({ userId, libraryId }),
    db.collection("cloudCardStates").deleteMany({ userId, libraryId }),
    db.collection("cloudReviewLogs").deleteMany({ userId, libraryId }),
    db.collection("cloudDeckConfigs").deleteMany({ userId, libraryId }),
    db.collection("cloudMedia").deleteMany({ userId, libraryId }),
  ]);

  let deletedFiles = 0;
  for (const bucketName of ["apkg", "deckdata"] as const) {
    const files = await db
      .collection<GridFsFileDoc>(`${bucketName}.files`)
      .find({ "metadata.userId": userId, "metadata.libraryId": libraryId })
      .project({ _id: 1 })
      .toArray();

    const bucket = getBucket(db, bucketName);
    await Promise.all(
      files.map(async (f) => {
        try {
          await bucket.delete(f._id);
          deletedFiles += 1;
        } catch {
          // ignore
        }
      })
    );
  }

  // Also delete extracted media files.
  {
    const files = await db
      .collection<GridFsFileDoc>("media.files")
      .find({ "metadata.userId": userId, "metadata.libraryId": libraryId })
      .project({ _id: 1 })
      .toArray();

    const bucket = getMediaBucket(db);
    await Promise.all(
      files.map(async (f) => {
        try {
          await bucket.delete(f._id);
          deletedFiles += 1;
        } catch {
          // ignore
        }
      })
    );
  }

  return NextResponse.json(
    {
      ok: true,
      deleted: {
        libraries: libsRes.deletedCount ?? 0,
        cardStates: cardStatesRes.deletedCount ?? 0,
        reviewLogs: reviewLogsRes.deletedCount ?? 0,
        deckConfigs: deckConfigsRes.deletedCount ?? 0,
        media: mediaRes.deletedCount ?? 0,
        gridFsFiles: deletedFiles,
      },
    },
    { status: 200 }
  );
}
