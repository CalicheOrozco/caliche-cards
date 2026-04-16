import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createHash } from "node:crypto";

import { getMongoDb } from "@/lib/mongodb";
import { getSessionFromRequest, type JsonError } from "../../auth/_shared";

export const runtime = "nodejs";

type CloudLibraryDoc = {
  _id: ObjectId;
  userId: string;
  libraryId: string;
  name: string;
  originalFilename: string;
  uploadedAt: number;
  size: number;
  storageType?: "apkg" | "deckdata";
  /** Explicit GridFS file reference — new field, absent on legacy records. */
  fileId?: ObjectId;
  /** SHA-256 of the uploaded file bytes — used for cross-user deduplication. */
  sha256?: string;
};

const BUCKET_NAME = "deckdata";

function getBucket(db: Db): GridFSBucket {
  return new GridFSBucket(db, { bucketName: BUCKET_NAME });
}

function isProbablyUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function gridFsFileExists(db: Db, fileId: ObjectId): Promise<boolean> {
  const doc = await db
    .collection<{ _id: ObjectId }>(`${BUCKET_NAME}.files`)
    .findOne({ _id: fileId }, { projection: { _id: 1 } });
  return Boolean(doc);
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session) {
      return NextResponse.json<JsonError>({ error: "Unauthorized" }, { status: 401 });
    }

    const isDev = process.env.NODE_ENV !== "production";
    const t0 = isDev ? Date.now() : 0;

    let db;
    try {
      db = await getMongoDb();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Database misconfigured";
      return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
    }

    let form: FormData;
    try {
      if (isDev) console.info("[sync upload-deck] parsing formData");
      form = await req.formData();
      if (isDev) console.info("[sync upload-deck] formData parsed");
    } catch {
      return NextResponse.json<JsonError>({ error: "Invalid form data" }, { status: 400 });
    }

    const libraryIdRaw = form.get("libraryId");
    const nameRaw = form.get("name");
    const fileRaw = form.get("file");

    const libraryId = typeof libraryIdRaw === "string" ? libraryIdRaw.trim() : "";
    const name = typeof nameRaw === "string" ? nameRaw.trim() : "";

    if (!libraryId || libraryId.length > 100 || !isProbablyUuid(libraryId)) {
      return NextResponse.json<JsonError>({ error: "Invalid libraryId" }, { status: 400 });
    }
    if (!name || name.length > 200) {
      return NextResponse.json<JsonError>({ error: "Invalid name" }, { status: 400 });
    }
    if (!(fileRaw instanceof File)) {
      return NextResponse.json<JsonError>({ error: "Missing file" }, { status: 400 });
    }

    const originalFilename = String(fileRaw.name || "deck.json");
    const uploadedAt = Date.now();
    const size = Number(fileRaw.size || 0);

    if (!Number.isFinite(size) || size <= 0) {
      return NextResponse.json<JsonError>({ error: "Empty file" }, { status: 400 });
    }

    if (isDev) {
      console.info(
        `[sync upload-deck] start user=${session.user.userId} libraryId=${libraryId}` +
          ` name=${JSON.stringify(name)} filename=${JSON.stringify(originalFilename)} size=${size}`
      );
    }

    // Ensure indexes (best-effort).
    try {
      await db
        .collection<CloudLibraryDoc>("cloudLibraries")
        .createIndex({ userId: 1, libraryId: 1 }, { unique: true });
    } catch { /* ignore */ }
    try {
      await db
        .collection<CloudLibraryDoc>("cloudLibraries")
        .createIndex({ sha256: 1, size: 1 });
    } catch { /* ignore */ }

    const userId = session.user.userId;
    const bucket = getBucket(db);

    // Stream the upload through a SHA-256 hasher so we can detect duplicates
    // without buffering the whole file in memory.
    const hash = createHash("sha256");
    const hasher = new Transform({
      transform(chunk, _enc, cb) {
        try { hash.update(chunk as Buffer); } catch { /* ignore */ }
        cb(null, chunk);
      },
    });

    const uploadStream = bucket.openUploadStream(`${userId}/${libraryId}`, {
      metadata: { userId, libraryId, originalFilename },
    });

    let uploadedFileId: ObjectId;
    let sha256: string;

    try {
      const webStream = fileRaw.stream();
      const nodeReadable = Readable.fromWeb(webStream as unknown as NodeReadableStream);
      await pipeline(nodeReadable, hasher, uploadStream);
      uploadedFileId = uploadStream.id as ObjectId;
      sha256 = hash.digest("hex");
    } catch (e: unknown) {
      try { uploadStream.abort(); } catch { /* ignore */ }
      const detail = e instanceof Error ? e.message : "";
      const msg =
        process.env.NODE_ENV === "production"
          ? "Failed to upload"
          : `Failed to upload${detail ? `: ${detail}` : ""}`;
      return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
    }

    if (isDev) console.info(`[sync upload-deck] gridfs upload complete sha256=${sha256}`);

    // Cross-user dedup: if any cloudLibraries doc already references a file with
    // the exact same sha256 + size, reuse that GridFS fileId and discard the new
    // upload.  This means two users uploading the same deck only store one copy.
    let fileId = uploadedFileId;
    let deduped = false;

    try {
      const candidates = await db
        .collection<CloudLibraryDoc>("cloudLibraries")
        .find({ sha256, size })
        .sort({ uploadedAt: -1 })
        .project({ fileId: 1 })
        .limit(5)
        .toArray();

      const sharedFileId =
        candidates
          .map((d) => d.fileId)
          .find((id) => id && String(id) !== String(uploadedFileId)) ?? null;

      if (sharedFileId && (await gridFsFileExists(db, sharedFileId))) {
        try { await bucket.delete(uploadedFileId); } catch { /* ignore */ }
        fileId = sharedFileId;
        deduped = true;
        if (isDev) {
          console.info(
            `[sync upload-deck] dedup: reusing existing fileId ${String(sharedFileId)}`
          );
        }
      }
    } catch {
      // Dedup is best-effort; proceed with the freshly uploaded file.
    }

    // Save/update the cloudLibraries record with explicit fileId + sha256.
    try {
      await db.collection<CloudLibraryDoc>("cloudLibraries").updateOne(
        { userId, libraryId },
        {
          $set: {
            userId,
            libraryId,
            name,
            originalFilename,
            uploadedAt,
            size,
            storageType: "deckdata",
            fileId,
            sha256,
          },
        },
        { upsert: true }
      );
    } catch (e: unknown) {
      // If metadata write failed and we own the file (not deduped), clean it up.
      if (!deduped) {
        try { await bucket.delete(fileId); } catch { /* ignore */ }
      }
      const detail = e instanceof Error ? e.message : "";
      const msg =
        process.env.NODE_ENV === "production"
          ? "Failed to save cloud metadata"
          : `Failed to save cloud metadata${detail ? `: ${detail}` : ""}`;
      return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
    }

    if (isDev) {
      console.info(
        `[sync upload-deck] done in ${Date.now() - t0}ms deduped=${deduped}`
      );
    }

    return NextResponse.json({ ok: true, uploadedAt, size }, { status: 200 });
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : "";
    const msg =
      process.env.NODE_ENV === "production"
        ? "Upload failed"
        : `Upload failed${detail ? `: ${detail}` : ""}`;
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
  }
}
