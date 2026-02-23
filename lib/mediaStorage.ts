import { openDB, type DBSchema } from "idb";

interface CalicheCardsDb extends DBSchema {
  state: {
    key: "last";
    value: unknown;
  };
  media: {
    key: string; // filename (e.g. ENPV_goon_verb.flac)
    value: Blob;
  };
}

function makeMediaKey(namespace: string, name: string): string {
  const ns = String(namespace ?? "");
  const n = String(name ?? "");
  return `${ns}:${n}`;
}

function getDb() {
  return openDB<CalicheCardsDb>("caliche-cards", 3, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("state")) {
        db.createObjectStore("state");
      }
      if (!db.objectStoreNames.contains("media")) {
        db.createObjectStore("media");
      }
    },
  });
}

export async function saveMediaItems(
  namespace: string,
  items: Array<{ name: string; blob: Blob }>
): Promise<void> {
  if (items.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("media", "readwrite");
  await Promise.all(
    items.map((it) => tx.store.put(it.blob, makeMediaKey(namespace, it.name)))
  );
  await tx.done;
}

export async function getMediaBlob(
  namespace: string,
  name: string
): Promise<Blob | null> {
  const db = await getDb();
  const blob = await db.get("media", makeMediaKey(namespace, name));
  return (blob as Blob | undefined) ?? null;
}

export async function clearMedia(namespace?: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("media", "readwrite");

  if (!namespace) {
    await tx.store.clear();
    await tx.done;
    return;
  }

  const prefix = `${String(namespace)}:`;
  let cursor = await tx.store.openCursor();
  while (cursor) {
    if (String(cursor.key).startsWith(prefix)) {
      await cursor.delete();
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}
