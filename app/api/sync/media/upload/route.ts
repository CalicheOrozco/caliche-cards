import { ObjectId, type Db } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createHash } from "node:crypto";

import { getSessionFromRequest, type JsonError } from "@/app/api/auth/_shared";
import { getMongoDb } from "@/lib/mongodb";
import { getMediaBucket, isProbablyUuid, type CloudMediaDoc } from "../_shared";

export const runtime = "nodejs";

type UploadResult = {
  name: string;
  ok: boolean;
  error?: string;
  size?: number;
  sha256?: string;
};

function sanitizeName(name: string): string {
  // Keep the name stable for lookup, but avoid pathological control chars.
  return name.replace(/[\0\r\n]/g, "").trim();
}

function getContentType(file: File): string {
  const t = String(file.type || "").trim();
  return t || "application/octet-stream";
}

async function ensureIndexes(db: Db) {
  try {
    await db
      .collection<CloudMediaDoc>("cloudMedia")
      .createIndex({ userId: 1, libraryId: 1, name: 1 }, { unique: true });
  } catch {
    // ignore
  }
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json<JsonError>({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json<JsonError>({ error: "Invalid form data" }, { status: 400 });
  }

  const libraryIdRaw = form.get("libraryId");
  const libraryId = typeof libraryIdRaw === "string" ? libraryIdRaw.trim() : "";
  if (!libraryId || libraryId.length > 100 || !isProbablyUuid(libraryId)) {
    return NextResponse.json<JsonError>({ error: "Invalid libraryId" }, { status: 400 });
  }

  const filesRaw = form.getAll("file");
  const files = filesRaw.filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json<JsonError>({ error: "Missing files" }, { status: 400 });
  }

  let db;
  try {
    db = await getMongoDb();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Database misconfigured";
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
  }

  await ensureIndexes(db);

  const userId = session.user.userId;
  const bucket = getMediaBucket(db);

  const results: UploadResult[] = [];

  for (const file of files) {
    const originalName = sanitizeName(String(file.name || ""));
    if (!originalName) {
      results.push({ name: "", ok: false, error: "Invalid filename" });
      continue;
    }

    const size = Number(file.size || 0);
    if (!Number.isFinite(size) || size <= 0) {
      results.push({ name: originalName, ok: false, error: "Empty file" });
      continue;
    }

    // If we already have the exact same sha256 for this (user, library, name), skip.
    // Client-side will typically avoid re-uploading, but this makes the endpoint idempotent.
    const existing = await db
      .collection<CloudMediaDoc>("cloudMedia")
      .findOne({ userId, libraryId, name: originalName });

    const uploadedAt = Date.now();
    const contentType = getContentType(file);

    const hash = createHash("sha256");
    const hasher = new Transform({
      transform(chunk, _enc, cb) {
        try {
          hash.update(chunk as Buffer);
        } catch {
          // ignore
        }
        cb(null, chunk);
      },
    });

    const uploadStream = bucket.openUploadStream(
      `${userId}/${libraryId}/${originalName}`,
      {
        metadata: {
          userId,
          libraryId,
          name: originalName,
          contentType,
        },
      }
    );

    let fileId: ObjectId;
    let sha256: string;

    try {
      const webStream = file.stream();
      const nodeReadable = Readable.fromWeb(webStream as unknown as NodeReadableStream);
      await pipeline(nodeReadable, hasher, uploadStream);
      fileId = uploadStream.id as ObjectId;
      sha256 = hash.digest("hex");
    } catch (e: unknown) {
      try {
        uploadStream.abort();
      } catch {
        // ignore
      }
      const detail = e instanceof Error ? e.message : "";
      results.push({ name: originalName, ok: false, error: detail || "Upload failed" });
      continue;
    }

    if (existing && existing.sha256 === sha256) {
      // We uploaded but it was redundant; keep existing mapping and delete new file.
      try {
        await bucket.delete(fileId);
      } catch {
        // ignore
      }
      results.push({ name: originalName, ok: true, size, sha256 });
      continue;
    }

    try {
      await db.collection<CloudMediaDoc>("cloudMedia").updateOne(
        { userId, libraryId, name: originalName },
        {
          $set: {
            userId,
            libraryId,
            name: originalName,
            fileId,
            sha256,
            size,
            contentType,
            uploadedAt,
          },
        },
        { upsert: true }
      );
    } catch (e: unknown) {
      // Avoid orphaning the uploaded file if metadata write fails.
      try {
        await bucket.delete(fileId);
      } catch {
        // ignore
      }
      const detail = e instanceof Error ? e.message : "";
      results.push({ name: originalName, ok: false, error: detail || "Metadata write failed" });
      continue;
    }

    // Best-effort cleanup of previous GridFS file.
    if (existing && existing.fileId && String(existing.fileId) !== String(fileId)) {
      try {
        await bucket.delete(existing.fileId);
      } catch {
        // ignore
      }
    }

    results.push({ name: originalName, ok: true, size, sha256 });
  }

  return NextResponse.json({ ok: true, results }, { status: 200 });
}
