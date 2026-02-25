import { ObjectId, type Db } from "mongodb";

function asNonEmptyString(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

function isProbablyObjectIdString(v: string): boolean {
  return /^[a-f\d]{24}$/i.test(v);
}

export async function resolveGuestUserId(db: Db): Promise<string | null> {
  const fromId =
    asNonEmptyString(process.env.GUEST_DEMO_USER_ID) ??
    asNonEmptyString(process.env.GUEST_USER_ID);

  if (fromId) {
    return isProbablyObjectIdString(fromId) ? fromId : fromId;
  }

  const fromUsername =
    asNonEmptyString(process.env.GUEST_DEMO_USERNAME) ??
    asNonEmptyString(process.env.GUEST_USERNAME);

  if (!fromUsername) return null;

  const usernameLower = fromUsername.toLowerCase();

  const user = await db
    .collection<{ _id: ObjectId; usernameLower: string }>("users")
    .findOne({ usernameLower }, { projection: { _id: 1 } });

  return user ? String(user._id) : null;
}

export function guestNotConfiguredError(): { error: string } {
  return {
    error:
      "Guest mode is not configured. Set GUEST_DEMO_USER_ID or GUEST_DEMO_USERNAME on the server.",
  };
}
