import { openDB, type DBSchema } from "idb";

import type { ImportedDeck } from "./apkg";

const STATE_SCHEMA_VERSION = 6;

export type LibraryItem = {
  id: string;
  name: string;
  deck: ImportedDeck;
  selectedDeckId: number | null;
  savedAt: number;
};

type StoredState = {
  schemaVersion: number;
  libraries: LibraryItem[];
  activeLibraryId: string | null;
  savedAt: number;
};

type StoredStateInput = Omit<StoredState, "schemaVersion">;

export type LoadStateResult = {
  state: StoredState | null;
  clearedOld: boolean;
};

interface CalicheCardsDb extends DBSchema {
  state: {
    key: "last";
    value: StoredState;
  };
  media: {
    key: string;
    value: Blob;
  };
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

export async function saveLastState(state: StoredStateInput): Promise<void> {
  const db = await getDb();

  const value: StoredState = {
    ...state,
    schemaVersion: STATE_SCHEMA_VERSION,
  };

  await db.put("state", value, "last");
}

export async function loadLastState(): Promise<LoadStateResult> {
  const db = await getDb();
  const value = await db.get("state", "last");
  if (!value) return { state: null, clearedOld: false };

  if (value.schemaVersion !== STATE_SCHEMA_VERSION) {
    await db.delete("state", "last");
    return { state: null, clearedOld: true };
  }

  return { state: value, clearedOld: false };
}

export async function clearLastState(): Promise<void> {
  const db = await getDb();
  await db.delete("state", "last");
}
