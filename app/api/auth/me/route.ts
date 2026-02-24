import { NextResponse, type NextRequest } from "next/server";

import { getSessionFromRequest } from "../_shared";

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ user: null }, { status: 200 });

  return NextResponse.json(
    { user: { username: session.user.username } },
    { status: 200 }
  );
}
