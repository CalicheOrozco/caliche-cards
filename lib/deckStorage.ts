import { openDB, type DBSchema } from "idb";

const STATE_SCHEMA_VERSION = 7;

export type StoredDeckMeta = {
  decks: Array<{ id: number; name: string }>;
};

export type LibraryItem = {
  id: string;
  name: string;
  deck: StoredDeckMeta;
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
    // Best-effort migration: older versions stored full ImportedDeck including cards.
    try {
      function parseDeckMetas(input: unknown): Array<{ id: number; name: string }> {
        if (!input || typeof input !== "object") return [];
        if (!("decks" in input)) return [];
        const decksRaw = (input as { decks?: unknown }).decks;
        if (!Array.isArray(decksRaw)) return [];

        const out: Array<{ id: number; name: string }> = [];
        for (const d of decksRaw) {
          if (!d || typeof d !== "object") continue;
          const idRaw = (d as { id?: unknown }).id;
          const nameRaw = (d as { name?: unknown }).name;
          const id = typeof idRaw === "number" ? idRaw : Number(idRaw);
          const name = typeof nameRaw === "string" ? nameRaw : String(nameRaw ?? "");
          const trimmed = name.trim();
          if (!Number.isFinite(id) || trimmed.length === 0) continue;
          out.push({ id, name: trimmed });
        }
        return out;
      }

      const raw = value as unknown as {
        schemaVersion?: number;
        libraries?: Array<{
          id?: unknown;
          name?: unknown;
          deck?: unknown;
          selectedDeckId?: unknown;
          savedAt?: unknown;
        }>;
        activeLibraryId?: unknown;
        savedAt?: unknown;
      };

      const librariesRaw = Array.isArray(raw.libraries) ? raw.libraries : [];
      const migratedLibraries: LibraryItem[] = librariesRaw
        .map((lib) => {
          const id = typeof lib.id === "string" ? lib.id : "";
          const name = typeof lib.name === "string" ? lib.name : "Deck";

          const decks = parseDeckMetas(lib.deck);

          const selectedDeckId =
            typeof lib.selectedDeckId === "number" && Number.isFinite(lib.selectedDeckId)
              ? lib.selectedDeckId
              : null;
          const savedAt = typeof lib.savedAt === "number" ? lib.savedAt : Date.now();

          if (!id) return null;
          return {
            id,
            name,
            deck: { decks },
            selectedDeckId,
            savedAt,
          } satisfies LibraryItem;
        })
        .filter((x): x is LibraryItem => Boolean(x));

      const migrated: StoredState = {
        schemaVersion: STATE_SCHEMA_VERSION,
        libraries: migratedLibraries,
        activeLibraryId:
          typeof raw.activeLibraryId === "string" ? raw.activeLibraryId : null,
        savedAt: typeof raw.savedAt === "number" ? raw.savedAt : Date.now(),
      };

      await db.put("state", migrated, "last");
      return { state: migrated, clearedOld: false };
    } catch {
      await db.delete("state", "last");
      return { state: null, clearedOld: true };
    }
  }

  return { state: value, clearedOld: false };
}

export async function clearLastState(): Promise<void> {
  const db = await getDb();
  await db.delete("state", "last");
}
