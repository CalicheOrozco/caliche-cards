import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";

import { verifyPassword } from "@/lib/password";
import { getMongoDb } from "@/lib/mongodb";
import {
  normalizeUsername,
  setSessionCookie,
  validatePassword,
  validateUsername,
  type JsonError,
} from "../_shared";

type LoginBody = { username?: unknown; password?: unknown };

type UserDoc = {
  _id: ObjectId;
  username: string;
  usernameLower: string;
  passwordHash: string;
  createdAt: number;
};

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return NextResponse.json<JsonError>({ error: "Invalid JSON" }, { status: 400 });
  }

  const username = normalizeUsername(body.username);
  const password = String(body.password ?? "");

  // Same validation to avoid user enumeration via format.
  const userErr = validateUsername(username);
  if (userErr) return NextResponse.json<JsonError>({ error: "Invalid username or password" }, { status: 401 });

  const passErr = validatePassword(password);
  if (passErr) return NextResponse.json<JsonError>({ error: "Invalid username or password" }, { status: 401 });

  let db: Awaited<ReturnType<typeof getMongoDb>>;
  try {
    db = await getMongoDb();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Database misconfigured";
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
  }
  const users = db.collection<UserDoc>("users");

  const user = await users.findOne({ usernameLower: username.toLowerCase() });
  if (!user) {
    return NextResponse.json<JsonError>({ error: "Invalid username or password" }, { status: 401 });
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return NextResponse.json<JsonError>({ error: "Invalid username or password" }, { status: 401 });
  }

  try {
    await setSessionCookie({ userId: String(user._id), username: user.username });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Auth misconfigured";
    return NextResponse.json<JsonError>(
      { error: msg },
      { status: 500 }
    );
  }
  return NextResponse.json({ user: { username: user.username } }, { status: 200 });
}
