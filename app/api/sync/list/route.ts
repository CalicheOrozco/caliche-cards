import { NextResponse, type NextRequest } from "next/server";

import { getMongoDb } from "@/lib/mongodb";
import type { CloudLibraryMeta } from "../_types";
import { getSessionFromRequest, type JsonError } from "../../auth/_shared";

export const runtime = "nodejs";

type CloudLibraryDoc = CloudLibraryMeta & {
  userId: string;
};

export async function GET(req: NextRequest) {
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

  const docs = await db
    .collection<CloudLibraryDoc>("cloudLibraries")
    .find({ userId: session.user.userId })
    .sort({ uploadedAt: -1 })
    .toArray();

  const libraries: CloudLibraryMeta[] = docs.map((d) => ({
    libraryId: d.libraryId,
    name: d.name,
    originalFilename: d.originalFilename,
    uploadedAt: d.uploadedAt,
    size: d.size,
  }));

  return NextResponse.json({ libraries }, { status: 200 });
}
