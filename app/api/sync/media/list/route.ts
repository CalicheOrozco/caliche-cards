import { NextResponse, type NextRequest } from "next/server";

import { getSessionFromRequest, type JsonError } from "@/app/api/auth/_shared";
import { getMongoDb } from "@/lib/mongodb";
import { isProbablyUuid, type CloudMediaDoc } from "../_shared";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json<JsonError>({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const libraryId = (url.searchParams.get("libraryId") ?? "").trim();
  if (!libraryId || libraryId.length > 100 || !isProbablyUuid(libraryId)) {
    return NextResponse.json<JsonError>({ error: "Invalid libraryId" }, { status: 400 });
  }

  let db;
  try {
    db = await getMongoDb();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Database misconfigured";
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
  }

  const userId = session.user.userId;

  try {
    await db
      .collection<CloudMediaDoc>("cloudMedia")
      .createIndex({ userId: 1, libraryId: 1, name: 1 }, { unique: true });
  } catch {
    // ignore
  }

  const items = await db
    .collection<CloudMediaDoc>("cloudMedia")
    .find({ userId, libraryId })
    .project({ _id: 0, name: 1, sha256: 1, size: 1, contentType: 1, uploadedAt: 1 })
    .sort({ uploadedAt: -1 })
    .toArray();

  return NextResponse.json({ ok: true, items }, { status: 200 });
}
