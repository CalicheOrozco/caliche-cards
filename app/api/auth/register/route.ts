import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";

import { hashPassword } from "@/lib/auth";
import { getMongoDb } from "@/lib/mongodb";
import {
  normalizeUsername,
  setSessionCookie,
  validatePassword,
  validateUsername,
  type JsonError,
} from "../_shared";

type RegisterBody = { username?: unknown; password?: unknown };

type UserDoc = {
  _id: ObjectId;
  username: string;
  usernameLower: string;
  passwordHash: string;
  createdAt: number;
};

export async function POST(req: NextRequest) {
  let body: RegisterBody;
  try {
    body = (await req.json()) as RegisterBody;
  } catch {
    return NextResponse.json<JsonError>({ error: "Invalid JSON" }, { status: 400 });
  }

  const username = normalizeUsername(body.username);
  const password = String(body.password ?? "");

  const userErr = validateUsername(username);
  if (userErr) return NextResponse.json<JsonError>({ error: userErr }, { status: 400 });

  const passErr = validatePassword(password);
  if (passErr) return NextResponse.json<JsonError>({ error: passErr }, { status: 400 });

  let db: Awaited<ReturnType<typeof getMongoDb>>;
  try {
    db = await getMongoDb();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Database misconfigured";
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
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
      e && typeof e === "object" && "code" in e
        ? (e as { code?: unknown }).code
        : null;

    // Duplicate key
    if (code === 11000) {
      return NextResponse.json<JsonError>({ error: "Username already exists" }, { status: 409 });
    }
    return NextResponse.json<JsonError>({ error: "Failed to create user" }, { status: 500 });
  }

  try {
    await setSessionCookie({ userId: String(doc._id), username: doc.username });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Auth misconfigured";
    return NextResponse.json<JsonError>({ error: msg }, { status: 500 });
  }

  return NextResponse.json(
    { user: { username: doc.username } },
    { status: 201 }
  );
}
