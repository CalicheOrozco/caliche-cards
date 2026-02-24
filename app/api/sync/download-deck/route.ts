import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { Readable } from "node:stream";

import { getMongoDb } from "@/lib/mongodb";
import { getSessionFromRequest, type JsonError } from "../../auth/_shared";

export const runtime = "nodejs";

const BUCKET_NAME = "deckdata";

function getBucket(db: Db): GridFSBucket {
  return new GridFSBucket(db, { bucketName: BUCKET_NAME });
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json<JsonError>({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const libraryId = (url.searchParams.get("libraryId") ?? "").trim();
  if (!libraryId) {
    return NextResponse.json<JsonError>({ error: "Missing libraryId" }, { status: 400 });
  }

  let db;
  try {
    db = await getMongoDb();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Database misconfigured";
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
  }

  const fileDoc = await db
    .collection<{ _id: ObjectId; contentType?: string; metadata?: { originalFilename?: string } }>(
      `${BUCKET_NAME}.files`
    )
    .find({
      "metadata.userId": session.user.userId,
      "metadata.libraryId": libraryId,
    })
    .sort({ uploadDate: -1 })
    .limit(1)
    .next();

  if (!fileDoc) {
    return NextResponse.json<JsonError>({ error: "Not found" }, { status: 404 });
  }

  const bucket = getBucket(db);
  const nodeStream = bucket.openDownloadStream(fileDoc._id);
  const stream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  const filename =
    fileDoc.metadata?.originalFilename?.replace(/[\r\n"]/g, "") ||
    "deck.json";

  const inferredType = (() => {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".gz")) return "application/gzip";
    if (lower.endsWith(".json")) return "application/json";
    return "application/octet-stream";
  })();

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "content-type": fileDoc.contentType || inferredType,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
