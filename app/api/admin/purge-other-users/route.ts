import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";

import { getSessionFromRequest, type JsonError } from "@/app/api/auth/_shared";
import { getMongoDb } from "@/lib/mongodb";

export const runtime = "nodejs";

type PurgeBody = {
  confirm?: unknown;
};

type GridFsFileDoc = {
  _id: ObjectId;
};

type CloudMediaDoc = {
  fileId: ObjectId;
};

function getBucket(db: Db, bucketName: "apkg" | "deckdata" | "media"): GridFSBucket {
  return new GridFSBucket(db, { bucketName });
}

async function deleteGridFsFilesByUserId(args: {
  db: Db;
  bucketName: "apkg" | "deckdata";
  keepUserId: string;
}): Promise<{ deleted: number }> {
  const { db, bucketName, keepUserId } = args;
  const bucket = getBucket(db, bucketName);

  const cursor = db
    .collection<GridFsFileDoc>(`${bucketName}.files`)
    .find({ "metadata.userId": { $ne: keepUserId } })
    .project({ _id: 1 });

  let deleted = 0;
  for await (const f of cursor) {
    try {
      await bucket.delete(f._id);
      deleted += 1;
    } catch {
      // ignore
    }
  }

  return { deleted };
}

async function deleteUnreferencedMediaGridFsFiles(db: Db): Promise<{ deleted: number }> {
  const bucket = getBucket(db, "media");

  const referenced = new Set<string>();
  const refCursor = db
    .collection<CloudMediaDoc>("cloudMedia")
    .find({})
    .project({ _id: 0, fileId: 1 });

  for await (const doc of refCursor) {
    if (doc?.fileId) referenced.add(String(doc.fileId));
  }

  let deleted = 0;
  const filesCursor = db
    .collection<GridFsFileDoc>("media.files")
    .find({})
    .project({ _id: 1 });

  for await (const f of filesCursor) {
    const idStr = String(f._id);
    if (referenced.has(idStr)) continue;

    try {
      const remaining = await db
        .collection<CloudMediaDoc>("cloudMedia")
        .countDocuments({ fileId: f._id }, { limit: 1 });
      if (remaining > 0) continue;
      await bucket.delete(f._id);
      deleted += 1;
    } catch {
      // ignore
    }
  }

  return { deleted };
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json<JsonError>({ error: "Not found" }, { status: 404 });
  }

  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json<JsonError>({ error: "Unauthorized" }, { status: 401 });
  }

  const adminUserIdOrUsername = String(process.env.ADMIN_USER_ID || "").trim();
  const adminUsername = String(process.env.ADMIN_USERNAME || "").trim();
  if (!adminUserIdOrUsername && !adminUsername) {
    return NextResponse.json<JsonError>(
      { error: "Missing ADMIN_USER_ID or ADMIN_USERNAME" },
      { status: 500 }
    );
  }

  const isAdmin = [adminUserIdOrUsername, adminUsername]
    .filter(Boolean)
    .some((v) => session.user.userId === v || session.user.username === v);

  if (!isAdmin) {
    return NextResponse.json<JsonError>({ error: "Forbidden" }, { status: 403 });
  }

  let body: PurgeBody;
  try {
    body = (await req.json()) as PurgeBody;
  } catch {
    return NextResponse.json<JsonError>({ error: "Invalid JSON" }, { status: 400 });
  }

  const confirm = String(body?.confirm ?? "").trim();
  if (confirm !== "PURGE_OTHER_USERS") {
    return NextResponse.json<JsonError>(
      { error: "Confirmation required" },
      { status: 400 }
    );
  }

  let db;
  try {
    db = await getMongoDb();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Database misconfigured";
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
  }

  const keepUserId = session.user.userId;

  const collections = [
    "cloudLibraries",
    "cloudCardStates",
    "cloudReviewLogs",
    "cloudDeckConfigs",
    "cloudMedia",
  ] as const;

  const deletedDocs: Record<string, number> = {};
  for (const collName of collections) {
    try {
      const res = await db.collection(collName).deleteMany({ userId: { $ne: keepUserId } });
      deletedDocs[collName] = res.deletedCount ?? 0;
    } catch {
      deletedDocs[collName] = deletedDocs[collName] ?? 0;
    }
  }

  try {
    if (ObjectId.isValid(keepUserId)) {
      const keepId = new ObjectId(keepUserId);
      const res = await db.collection("users").deleteMany({ _id: { $ne: keepId } });
      deletedDocs.users = res.deletedCount ?? 0;
    }
  } catch {
    // ignore
  }

  const apkgDel = await deleteGridFsFilesByUserId({ db, bucketName: "apkg", keepUserId });
  const deckdataDel = await deleteGridFsFilesByUserId({ db, bucketName: "deckdata", keepUserId });
  const mediaDel = await deleteUnreferencedMediaGridFsFiles(db);

  return NextResponse.json(
    {
      ok: true,
      keepUserId,
      deletedDocs,
      deletedGridFsFiles: {
        apkg: apkgDel.deleted,
        deckdata: deckdataDel.deleted,
        media: mediaDel.deleted,
      },
    },
    { status: 200 }
  );
}
