import { NextResponse } from "next/server";

import { getMongoDb } from "@/lib/mongodb";
import type { CloudLibraryMeta } from "../../sync/_types";
import { guestNotConfiguredError, resolveGuestUserId } from "../_shared";

export const runtime = "nodejs";

type CloudLibraryDoc = CloudLibraryMeta & {
  userId: string;
};

export async function GET() {
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

  const docs = await db
    .collection<CloudLibraryDoc>("cloudLibraries")
    .find({ userId: guestUserId })
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
