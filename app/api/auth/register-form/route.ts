import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";

import { hashPassword } from "@/lib/password";
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

function safeNextPath(input: FormDataEntryValue | null, fallback = "/"): string {
  const raw = typeof input === "string" ? input : "";
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  return raw;
}

function redirectBack(req: NextRequest, next: string, error: string) {
  const url = new URL("/register", req.url);
  url.searchParams.set("error", error);
  if (next && next !== "/") url.searchParams.set("next", next);
  return NextResponse.redirect(url, { status: 303 });
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

  const userErr = validateUsername(username);
  if (userErr) return redirectBack(req, next, userErr);

  const passErr = validatePassword(password);
  if (passErr) return redirectBack(req, next, passErr);

  let db: Awaited<ReturnType<typeof getMongoDb>>;
  try {
    db = await getMongoDb();
  } catch {
    return redirectBack(req, next, "server");
  }
  const users = db.collection<UserDoc>("users");

  await users.createIndex({ usernameLower: 1 }, { unique: true });

  const now = Date.now();
  const passwordHash = await hashPassword(password);

  const doc: UserDoc = {
    _id: new ObjectId(),
    username,
    usernameLower: username.toLowerCase(),
    passwordHash,
    createdAt: now,
  };

  try {
    await users.insertOne(doc);
  } catch (e: unknown) {
    const code =
      e && typeof e === "object" && "code" in e ? (e as { code?: unknown }).code : null;

    if (code === 11000) return redirectBack(req, next, "exists");
    return redirectBack(req, next, "server");
  }

  try {
    await setSessionCookie({ userId: String(doc._id), username: doc.username });
  } catch {
    return redirectBack(req, next, "server");
  }

  return NextResponse.redirect(new URL(next, req.url), { status: 303 });
}
