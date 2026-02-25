import { type ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { Readable } from "node:stream";

import { getMongoDb } from "@/lib/mongodb";
import { guestNotConfiguredError, resolveGuestUserId } from "../../_shared";
import { getMediaBucket, isProbablyUuid, MEDIA_BUCKET_NAME, type CloudMediaDoc } from "../../../sync/media/_shared";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const libraryId = (url.searchParams.get("libraryId") ?? "").trim();
  const name = (url.searchParams.get("name") ?? "").trim();

  if (!libraryId || libraryId.length > 100 || !isProbablyUuid(libraryId)) {
    return NextResponse.json({ error: "Invalid libraryId" }, { status: 400 });
  }
  if (!name || name.length > 300) {
    return NextResponse.json({ error: "Invalid name" }, { status: 400 });
  }

  let db;
  try {
    db = await getMongoDb();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Database misconfigured";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const guestUserId = await resolveGuestUserId(db);
  if (!guestUserId) {
    return NextResponse.json(guestNotConfiguredError(), { status: 503 });
  }

  const doc = await db
    .collection<CloudMediaDoc>("cloudMedia")
    .findOne({ userId: guestUserId, libraryId, name });

  if (!doc) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
