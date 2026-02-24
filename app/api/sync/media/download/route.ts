import { type ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { Readable } from "node:stream";

import { getSessionFromRequest, type JsonError } from "@/app/api/auth/_shared";
import { getMongoDb } from "@/lib/mongodb";
import { getMediaBucket, isProbablyUuid, MEDIA_BUCKET_NAME, type CloudMediaDoc } from "../_shared";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json<JsonError>({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const libraryId = (url.searchParams.get("libraryId") ?? "").trim();
  const name = (url.searchParams.get("name") ?? "").trim();

  if (!libraryId || libraryId.length > 100 || !isProbablyUuid(libraryId)) {
    return NextResponse.json<JsonError>({ error: "Invalid libraryId" }, { status: 400 });
  }
  if (!name || name.length > 300) {
    return NextResponse.json<JsonError>({ error: "Invalid name" }, { status: 400 });
  }

  let db;
  try {
    db = await getMongoDb();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Database misconfigured";
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
  }

  const userId = session.user.userId;

  const doc = await db
    .collection<CloudMediaDoc>("cloudMedia")
    .findOne({ userId, libraryId, name });

  if (!doc) {
    return NextResponse.json<JsonError>({ error: "Not found" }, { status: 404 });
  }

  const bucket = getMediaBucket(db);
  const nodeStream = bucket.openDownloadStream(doc.fileId as unknown as ObjectId);
  const stream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  const safeFilename = name.replace(/[\r\n"]/g, "");

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "content-type": doc.contentType || "application/octet-stream",
      "content-disposition": `attachment; filename="${safeFilename}"`,
      "cache-control": "no-store",
      "x-caliche-media-bucket": MEDIA_BUCKET_NAME,
      "x-caliche-media-sha256": doc.sha256,
    },
  });
}
