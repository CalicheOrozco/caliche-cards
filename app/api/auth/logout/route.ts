import { NextResponse } from "next/server";

import { clearSessionCookie } from "../_shared";

export async function POST() {
  await clearSessionCookie();
  return NextResponse.json({ ok: true }, { status: 200 });
}
