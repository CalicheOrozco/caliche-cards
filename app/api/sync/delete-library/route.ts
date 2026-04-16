import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";

import { getSessionFromRequest, type JsonError } from "@/app/api/auth/_shared";
import { getMongoDb } from "@/lib/mongodb";

export const runtime = "nodejs";

function isProbablyUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function getDeckBucket(db: Db): GridFSBucket {
  return new GridFSBucket(db, { bucketName: "deckdata" });
}

function getMediaBucket(db: Db): GridFSBucket {
  return new GridFSBucket(db, { bucketName: "media" });
}

type CloudLibraryDoc = {
  _id: ObjectId;
  userId: string;
  libraryId: string;
  fileId?: ObjectId;
};

type CloudMediaDoc = {
  userId: string;
  libraryId: string;
  fileId: ObjectId;
};

type DeleteLibraryBody = {
  libraryId: string;
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
  let deletedFiles = 0;

  // ── Deck file (deckdata GridFS) ───────────────────────────────────────────
  // Read the fileId BEFORE deleting the cloudLibraries record so we can do a
  // reference-count check afterward.  A fileId may be shared with other users,
  // so we only delete the GridFS file when no one else references it.
  const libDoc = await db
    .collection<CloudLibraryDoc>("cloudLibraries")
    .findOne({ userId, libraryId }, { projection: { fileId: 1 } });

  const [libsRes, cardStatesRes, reviewLogsRes, deckConfigsRes] = await Promise.all([
    db.collection("cloudLibraries").deleteMany({ userId, libraryId }),
    db.collection("cloudCardStates").deleteMany({ userId, libraryId }),
    db.collection("cloudReviewLogs").deleteMany({ userId, libraryId }),
    db.collection("cloudDeckConfigs").deleteMany({ userId, libraryId }),
  ]);

  // Delete the GridFS deck file only when no cloudLibraries doc references it.
  if (libDoc?.fileId) {
    const refs = await db
      .collection("cloudLibraries")
      .countDocuments({ fileId: libDoc.fileId }, { limit: 1 });

    if (refs === 0) {
      try {
        await getDeckBucket(db).delete(libDoc.fileId);
        deletedFiles += 1;
      } catch { /* ignore — file may already be gone */ }
    }
  } else {
    // Legacy records have no explicit fileId — fall back to metadata-based lookup.
    // These files are per-user (old format), so safe to delete unconditionally.
    const legacyFiles = await db
      .collection<{ _id: ObjectId }>("deckdata.files")
      .find({ "metadata.userId": userId, "metadata.libraryId": libraryId })
      .project({ _id: 1 })
      .toArray();

    const bucket = getDeckBucket(db);
    await Promise.all(
      legacyFiles.map(async (f) => {
        try {
          await bucket.delete(f._id);
          deletedFiles += 1;
        } catch { /* ignore */ }
      })
    );
  }

  // ── Media files ───────────────────────────────────────────────────────────
  // Collect all unique fileIds BEFORE deleting the cloudMedia metadata rows.
  // A single GridFS file may be referenced by multiple users (cross-user dedup),
  // so we delete it from GridFS only when the last reference is gone.
  const mediaDocs = await db
    .collection<CloudMediaDoc>("cloudMedia")
    .find({ userId, libraryId }, { projection: { fileId: 1 } })
    .toArray();

  // Gather unique fileIds
  const uniqueMediaFileIds = [
    ...new Map(
      mediaDocs
        .filter((d) => d.fileId)
        .map((d) => [String(d.fileId), d.fileId])
    ).values(),
  ];

  const mediaRes = await db.collection("cloudMedia").deleteMany({ userId, libraryId });

  // For each fileId, check if any other cloudMedia doc still references it.
  const mediaBucket = getMediaBucket(db);
  await Promise.all(
    uniqueMediaFileIds.map(async (fileId) => {
      try {
        const refs = await db
          .collection("cloudMedia")
          .countDocuments({ fileId }, { limit: 1 });

        if (refs === 0) {
          await mediaBucket.delete(fileId);
          deletedFiles += 1;
        }
      } catch { /* ignore */ }
    })
  );

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
