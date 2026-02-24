import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

import {
  createSessionToken,
  getSessionCookieName,
  getSessionMaxAgeSeconds,
  verifySessionToken,
  type Session,
  type SessionUser,
} from "@/lib/session";

export type JsonError = { error: string };

export function normalizeUsername(input: unknown): string {
  return String(input ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 32);
}

export function validateUsername(username: string): string | null {
  if (username.length < 3) return "Username must be at least 3 characters";
  if (username.length > 32) return "Username must be at most 32 characters";
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_\- ]*$/.test(username)) {
    return "Username contains invalid characters";
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 200) return "Password is too long";
  return null;
}

export async function setSessionCookie(user: SessionUser): Promise<void> {
  const token = await createSessionToken(user);
  const name = getSessionCookieName();
  const maxAge = getSessionMaxAgeSeconds();

  (await cookies()).set({
    name,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const name = getSessionCookieName();
  (await cookies()).set({
    name,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export async function getSessionFromRequest(req: NextRequest): Promise<Session | null> {
  const token = req.cookies.get(getSessionCookieName())?.value ?? "";
  if (!token) return null;
  try {
    return await verifySessionToken(token);
  } catch {
    return null;
  }
}
