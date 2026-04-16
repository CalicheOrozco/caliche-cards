import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { Readable } from "node:stream";

import { getMongoDb } from "@/lib/mongodb";
import { getSessionFromRequest, type JsonError } from "../../auth/_shared";

export const runtime = "nodejs";

const BUCKET_NAME = "deckdata";

type CloudLibraryDoc = {
  _id: ObjectId;
  userId: string;
  libraryId: string;
  originalFilename?: string;
  /** Present on records written by the new upload-deck route. */
  fileId?: ObjectId;
};

type GridFsFileDoc = {
  _id: ObjectId;
  contentType?: string;
  metadata?: { originalFilename?: string };
};

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

  // First look up the cloudLibraries record — this is the authoritative pointer
  // to the deck file and handles cross-user deduplication transparently.
  const libDoc = await db
    .collection<CloudLibraryDoc>("cloudLibraries")
    .findOne({ userId: session.user.userId, libraryId });

  if (!libDoc) {
    return NextResponse.json<JsonError>({ error: "Not found" }, { status: 404 });
  }

  const bucket = getBucket(db);

  let fileId: ObjectId;
  let filename = "deck.json";
  let contentType: string | undefined;

  if (libDoc.fileId) {
    // New-style: cloudLibraries stores an explicit fileId (may be shared).
    fileId = libDoc.fileId;
    filename = libDoc.originalFilename ?? "deck.json";
  } else {
    // Legacy fallback: find newest GridFS file by metadata.
    const fileDoc = await db
      .collection<GridFsFileDoc>(`${BUCKET_NAME}.files`)
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

    fileId = fileDoc._id;
    filename = fileDoc.metadata?.originalFilename ?? "deck.json";
    contentType = fileDoc.contentType;
  }

  const nodeStream = bucket.openDownloadStream(fileId);
  const stream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  const safeFilename = filename.replace(/[\r\n"]/g, "");
  const inferredType = (() => {
    const lower = safeFilename.toLowerCase();
    if (lower.endsWith(".gz")) return "application/gzip";
    if (lower.endsWith(".json")) return "application/json";
    return "application/octet-stream";
  })();

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "content-type": contentType || inferredType,
      "content-disposition": `attachment; filename="${safeFilename}"`,
      "cache-control": "no-store",
    },
  });
}
