import { openDB, type DBSchema } from "idb";

type StoredApkg = {
  blob: Blob;
  filename: string;
  size: number;
  savedAt: number;
};

interface CalicheCardsDb extends DBSchema {
  state: {
    key: "last";
    value: unknown;
  };
  media: {
    key: string;
    value: Blob;
  };
  apkg: {
    key: string; // libraryId
    value: StoredApkg;
  };
}

function getDb() {
  return openDB<CalicheCardsDb>("caliche-cards", 4, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("state")) {
        db.createObjectStore("state");
      }
      if (!db.objectStoreNames.contains("media")) {
        db.createObjectStore("media");
      }
      if (!db.objectStoreNames.contains("apkg")) {
        db.createObjectStore("apkg");
      }
    },
  });
}

export async function saveApkgFile(args: {
  libraryId: string;
  file: File;
}): Promise<void> {
  const libraryId = String(args.libraryId ?? "").trim();
  if (!libraryId) return;

  const db = await getDb();
  const value: StoredApkg = {
    blob: args.file,
    filename: args.file.name || "deck.apkg",
    size: args.file.size,
    savedAt: Date.now(),
  };
  await db.put("apkg", value, libraryId);
}

export async function getApkgFile(libraryId: string): Promise<StoredApkg | null> {
  const id = String(libraryId ?? "").trim();
  if (!id) return null;
  const db = await getDb();
  const value = await db.get("apkg", id);
  return value ?? null;
}

export async function clearApkg(libraryId?: string): Promise<void> {
  const db = await getDb();
  if (!libraryId) {
    await db.clear("apkg");
    return;
  }
  await db.delete("apkg", String(libraryId));
}
