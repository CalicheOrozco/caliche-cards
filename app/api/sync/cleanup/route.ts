import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";

import { getMongoDb } from "@/lib/mongodb";
import { getSessionFromRequest, type JsonError } from "../../auth/_shared";

export const runtime = "nodejs";

function getDeckBucket(db: Db): GridFSBucket {
  return new GridFSBucket(db, { bucketName: "deckdata" });
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

  // ── Collect all fileIds currently referenced by ANY cloudLibraries doc ────
  // This prevents us from deleting a shared file just because the original
  // uploader triggered a cleanup.
  const allReferencedRaw = await db
    .collection("cloudLibraries")
    .distinct("fileId", { fileId: { $exists: true, $ne: null } });

  const referencedFileIds = new Set<string>(
    allReferencedRaw.map((id) => String(id))
  );

  // ── Collect this user's active libraryIds ────────────────────────────────
  // Used for legacy records that have no explicit fileId.
  const userLibDocs = await db
    .collection<{ libraryId: string }>("cloudLibraries")
    .find({ userId })
    .project({ libraryId: 1 })
    .toArray();

  const activeLibraryIds = new Set(userLibDocs.map((l) => l.libraryId).filter(Boolean));

  // ── Find all deckdata GridFS files that belong to this user ───────────────
  const userFiles = await db
    .collection<GridFsFileDoc>("deckdata.files")
    .find({ "metadata.userId": userId })
    .project({ _id: 1, length: 1, uploadDate: 1, "metadata.libraryId": 1 })
    .toArray();

  // Group files by libraryId so we can keep the newest per library (legacy path).
  const byLibrary = new Map<string, GridFsFileDoc[]>();
  const noLibrary: GridFsFileDoc[] = [];

  for (const f of userFiles) {
    const lib = f.metadata?.libraryId ?? "";
    if (!lib) {
      noLibrary.push(f);
    } else {
      const arr = byLibrary.get(lib) ?? [];
      arr.push(f);
      byLibrary.set(lib, arr);
    }
  }

  const orphanCutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
  const toDelete: Array<{ id: ObjectId; length: number }> = [];

  // For each library, determine which files are safe to delete.
  for (const [lib, files] of byLibrary) {
    // Sort newest-first.
    files.sort((a, b) => {
      const ta = a.uploadDate?.getTime() ?? 0;
      const tb = b.uploadDate?.getTime() ?? 0;
      return tb - ta;
    });

    for (const f of files) {
      const fileIdStr = String(f._id);

      // Never delete a file that is referenced by any cloudLibraries doc
      // (could be another user relying on it via cross-user dedup).
      if (referencedFileIds.has(fileIdStr)) continue;

      // For active libraries, keep the newest file (index 0 after sort) and
      // delete older duplicates.  For inactive libraries (not in activeLibraryIds),
      // treat files as orphaned and delete them all.
      if (activeLibraryIds.has(lib) && files[0]?._id && String(files[0]._id) === fileIdStr) {
        continue; // keep newest
      }

      const len = Number(f.length ?? 0);
      toDelete.push({ id: f._id, length: Number.isFinite(len) && len > 0 ? len : 0 });
    }
  }

  // Files with no libraryId that are older than the cutoff are orphaned uploads.
  for (const f of noLibrary) {
    if ((f.uploadDate?.getTime() ?? 0) < orphanCutoff.getTime()) {
      const fileIdStr = String(f._id);
      if (referencedFileIds.has(fileIdStr)) continue;
      const len = Number(f.length ?? 0);
      toDelete.push({ id: f._id, length: Number.isFinite(len) && len > 0 ? len : 0 });
    }
  }

  // De-dupe by id.
  const unique = new Map<string, { id: ObjectId; length: number }>();
  for (const entry of toDelete) {
    unique.set(String(entry.id), entry);
  }

  const bucket = getDeckBucket(db);
  let deleted = 0;
  let bytesToDelete = 0;

  for (const entry of unique.values()) {
    bytesToDelete += entry.length;
    try {
      await bucket.delete(entry.id);
      deleted += 1;
    } catch { /* ignore */ }
  }

  return NextResponse.json(
    { ok: true, deletedFiles: deleted, bytesFreedEstimate: bytesToDelete },
    { status: 200 }
  );
}
