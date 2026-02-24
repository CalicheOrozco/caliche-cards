import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

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
};

const BUCKET_NAME = "apkg";

function getBucket(db: Db): GridFSBucket {
  return new GridFSBucket(db, { bucketName: BUCKET_NAME });
}

function isProbablyUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export async function POST(req: NextRequest) {
  try {
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

    let form: FormData;
    try {
      form = await req.formData();
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

    const originalFilename = String(fileRaw.name || "deck.apkg");
    const uploadedAt = Date.now();

    const size = Number(fileRaw.size || 0);
    if (!Number.isFinite(size) || size <= 0) {
      return NextResponse.json<JsonError>({ error: "Empty file" }, { status: 400 });
    }

    const bucket = getBucket(db);

    const uploadStream = bucket.openUploadStream(`${session.user.userId}/${libraryId}.apkg`, {
      metadata: {
        userId: session.user.userId,
        libraryId,
        originalFilename,
      },
    });

    try {
      const webStream = fileRaw.stream();
      const nodeReadable = Readable.fromWeb(webStream as unknown as NodeReadableStream);
      await pipeline(nodeReadable, uploadStream);
    } catch (e: unknown) {
      try {
        uploadStream.abort();
      } catch {
        // ignore
      }
      const detail = e instanceof Error ? e.message : "";
      const msg = process.env.NODE_ENV === "production" ? "Failed to upload" : `Failed to upload${detail ? `: ${detail}` : ""}`;
      return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
    }

    const fileId = uploadStream.id as ObjectId;

    // Best-effort: ensure uniqueness, but don't fail sync if the index can't be built.
    try {
      await db
        .collection<CloudLibraryDoc>("cloudLibraries")
        .createIndex({ userId: 1, libraryId: 1 }, { unique: true });
    } catch {
      // ignore
    }

    try {
      await db.collection<CloudLibraryDoc>("cloudLibraries").updateOne(
        { userId: session.user.userId, libraryId },
        {
          $set: {
            userId: session.user.userId,
            libraryId,
            name,
            originalFilename,
            uploadedAt,
            size,
          },
        },
        { upsert: true }
      );
    } catch (e: unknown) {
      // Avoid orphaning the uploaded file if we can't save metadata.
      try {
        await bucket.delete(fileId);
      } catch {
        // ignore
      }
      const detail = e instanceof Error ? e.message : "";
      const msg =
        process.env.NODE_ENV === "production"
          ? "Failed to save cloud metadata"
          : `Failed to save cloud metadata${detail ? `: ${detail}` : ""}`;
      return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
    }

    // Keep only the newest file for this library.
    try {
      const files = await db
        .collection<{ _id: ObjectId }>(`${BUCKET_NAME}.files`)
        .find({
          "metadata.userId": session.user.userId,
          "metadata.libraryId": libraryId,
          _id: { $ne: fileId },
        })
        .project({ _id: 1 })
        .toArray();

      await Promise.all(
        files.map(async (f) => {
          try {
            await bucket.delete(f._id);
          } catch {
            // ignore
          }
        })
      );
    } catch {
      // ignore
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
