import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";

import { verifyPassword } from "@/lib/password";
import { getMongoDb } from "@/lib/mongodb";
import {
  normalizeUsername,
  setSessionCookie,
  validatePassword,
  validateUsername,
} from "../_shared";

type UserDoc = {
  _id: ObjectId;
  username: string;
  usernameLower: string;
  passwordHash: string;
  createdAt: number;
};

export const runtime = "nodejs";

function redirectBack(req: NextRequest, next: string, error: "invalid" | "server") {
  const url = new URL("/login", req.url);
  url.searchParams.set("error", error);
  if (next && next !== "/") url.searchParams.set("next", next);
  return NextResponse.redirect(url, { status: 303 });
}

function safeNextPath(input: FormDataEntryValue | null, fallback = "/"): string {
  const raw = typeof input === "string" ? input : "";
  if (!raw) return fallback;
  // Prevent open redirects.
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  return raw;
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return redirectBack(req, "/", "server");
  }

  const username = normalizeUsername(form.get("username"));
  const password = String(form.get("password") ?? "");
  const next = safeNextPath(form.get("next"), "/");

  // Same validation to avoid user enumeration via format.
  const userErr = validateUsername(username);
  if (userErr) return redirectBack(req, next, "invalid");

  const passErr = validatePassword(password);
  if (passErr) return redirectBack(req, next, "invalid");

  let db: Awaited<ReturnType<typeof getMongoDb>>;
  try {
    db = await getMongoDb();
  } catch {
    return redirectBack(req, next, "server");
  }

  const users = db.collection<UserDoc>("users");

  const user = await users.findOne({ usernameLower: username.toLowerCase() });
  if (!user) return redirectBack(req, next, "invalid");

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return redirectBack(req, next, "invalid");

  try {
    await setSessionCookie({ userId: String(user._id), username: user.username });
  } catch {
    return redirectBack(req, next, "server");
  }

  return NextResponse.redirect(new URL(next, req.url), { status: 303 });
}
