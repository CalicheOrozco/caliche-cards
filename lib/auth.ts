import bcrypt from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";

const SESSION_COOKIE = "caliche_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Missing AUTH_SECRET in environment. Set AUTH_SECRET in .env.local (no spaces around '=') and restart `npm run dev`."
    );
  }
  return secret;
}

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(getAuthSecret());
}

export type SessionUser = {
  userId: string;
  username: string;
};

export type Session = {
  user: SessionUser;
  expiresAt: number; // epoch ms
};

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function getSessionMaxAgeSeconds(): number {
  return SESSION_MAX_AGE_SECONDS;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  passwordHash: string
): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_MAX_AGE_SECONDS;

  return new SignJWT({ username: user.username })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.userId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      algorithms: ["HS256"],
    });

    const userId = typeof payload.sub === "string" ? payload.sub : "";
    const username = typeof payload.username === "string" ? payload.username : "";
    const exp = typeof payload.exp === "number" ? payload.exp : null;

    if (!userId || !username || exp == null) return null;

    return {
      user: { userId, username },
      expiresAt: exp * 1000,
    };
  } catch {
    return null;
  }
}
