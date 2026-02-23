import Dexie, { type Table } from "dexie";

import type {
  CardEntity,
  CardStateEntity,
  DeckEntity,
  ReviewLogEntity,
} from "./studyTypes";

const DB_NAME = "caliche-cards-study";

export class StudyDb extends Dexie {
  decks!: Table<DeckEntity, [string, number]>;
  cards!: Table<CardEntity, [string, number]>;
  cardStates!: Table<CardStateEntity, [string, number]>;
  reviewLogs!: Table<ReviewLogEntity, number>;

  constructor() {
    super(DB_NAME);

    this.version(1).stores({
      decks: "[libraryId+deckId], libraryId, deckId",
      cards:
        "[libraryId+cardId], [libraryId+deckId], [libraryId+noteId], libraryId, deckId, noteId",
      cardStates:
        "[libraryId+cardId], [libraryId+deckId+state+due], [libraryId+deckId+due], [libraryId+noteId], libraryId, deckId, state, due, suspended, buriedUntil",
      reviewLogs:
        "++id, [libraryId+deckId+ts], [libraryId+cardId+ts], libraryId, deckId, cardId, ts",
    });
  }
}

let singleton: StudyDb | null = null;

export function getStudyDb(): StudyDb {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }

  if (!singleton) {
    singleton = new StudyDb();
  }

  return singleton;
}

export function closeStudyDb(): void {
  if (!singleton) return;
  singleton.close();
  singleton = null;
}

export async function deleteStudyDb(): Promise<void> {
  if (singleton) {
    singleton.close();
    singleton = null;
  }

  await Dexie.delete(DB_NAME);
}
