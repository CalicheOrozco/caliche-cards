import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";

import { getMongoDb } from "@/lib/mongodb";
import { getSessionFromRequest, type JsonError } from "../../auth/_shared";

export const runtime = "nodejs";

const BUCKET_NAMES = ["apkg", "deckdata"] as const;

function getBucket(db: Db, name: (typeof BUCKET_NAMES)[number]): GridFSBucket {
  return new GridFSBucket(db, { bucketName: name });
}

type GridFsFileDoc = {
  _id: ObjectId;
  length?: number;
  uploadDate?: Date;
  metadata?: {
    userId?: string;
    libraryId?: string;
  };
};

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

  const userId = session.user.userId;

  // Load known libraries for this user.
  const libs = await db
    .collection<{ libraryId: string }>("cloudLibraries")
    .find({ userId })
    .project({ libraryId: 1 })
    .toArray();

  const libraryIds = new Set(libs.map((l) => l.libraryId).filter(Boolean));

  // For each bucket and library, keep only the newest GridFS file.
  const toDelete: Array<{ bucketName: (typeof BUCKET_NAMES)[number]; id: ObjectId; length: number }> = [];
  let bytesToDelete = 0;

  for (const bucketName of BUCKET_NAMES) {
    for (const libraryId of libraryIds) {
      const files = await db
        .collection<GridFsFileDoc>(`${bucketName}.files`)
        .find({ "metadata.userId": userId, "metadata.libraryId": libraryId })
        .sort({ uploadDate: -1 })
        .project({ _id: 1, length: 1 })
        .toArray();

      const older = files.slice(1);
      for (const f of older) {
        const len = Number(f.length ?? 0);
        toDelete.push({ bucketName, id: f._id, length: Number.isFinite(len) && len > 0 ? len : 0 });
        if (Number.isFinite(len) && len > 0) bytesToDelete += len;
      }
    }
  }

  // Delete orphaned files (no matching cloudLibraries libraryId) older than 1 hour.
  const orphanCutoff = new Date(Date.now() - 60 * 60 * 1000);
  for (const bucketName of BUCKET_NAMES) {
    const orphans = await db
      .collection<GridFsFileDoc>(`${bucketName}.files`)
      .find({
        "metadata.userId": userId,
        $or: [
          { "metadata.libraryId": { $exists: false } },
          { "metadata.libraryId": { $nin: Array.from(libraryIds) } },
        ],
        uploadDate: { $lt: orphanCutoff },
      })
      .project({ _id: 1, length: 1 })
      .toArray();

    for (const f of orphans) {
      const len = Number(f.length ?? 0);
      toDelete.push({ bucketName, id: f._id, length: Number.isFinite(len) && len > 0 ? len : 0 });
      if (Number.isFinite(len) && len > 0) bytesToDelete += len;
    }
  }

  // De-dupe by (bucketName, id).
  const unique = new Map<string, { bucketName: (typeof BUCKET_NAMES)[number]; id: ObjectId; length: number }>();
  for (const entry of toDelete) {
    unique.set(`${entry.bucketName}:${String(entry.id)}`, entry);
  }

  let deleted = 0;
  for (const entry of unique.values()) {
    const bucket = getBucket(db, entry.bucketName);
    try {
      await bucket.delete(entry.id);
      deleted += 1;
    } catch {
      // ignore
    }
  }

  return NextResponse.json(
    { ok: true, deletedFiles: deleted, bytesFreedEstimate: bytesToDelete },
    { status: 200 }
  );
}
