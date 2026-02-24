import { NextResponse } from "next/server";

import { clearSessionCookie } from "../_shared";

export const runtime = "nodejs";

export async function POST() {
  await clearSessionCookie();
  return NextResponse.json({ ok: true }, { status: 200 });
}
