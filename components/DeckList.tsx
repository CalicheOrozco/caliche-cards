"use client";

import { useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { FaCog } from "react-icons/fa";

import type { LibraryItem } from "../lib/deckStorage";
import type { DeckOverview } from "../lib/studyApi";
import type { CardEntity, ReviewAnswerStyle } from "../lib/studyTypes";
import { getStudyDb } from "../lib/studyDb";
import { sanitizeWriteLanguage } from "../lib/cardUtils";
import { DEFAULT_DECK_CONFIG } from "../lib/scheduler";
import type { CardTypesModalState } from "./modals/CardTypesModal";
import type { LimitsModalState } from "./modals/LimitsModal";
import type { LearnedCardsModalState } from "./modals/LearnedCardsModal";
import type { FieldConfigModalState } from "./FieldConfigModals";

type EditingDeck = { libraryId: string; deckId: number; value: string };
type OpenDeckMenu = { libraryId: string; deckId: number };

export function DeckList({
  libraries,
  deckOverviews,
  activeLibraryId,
  openDeckMenu,
  setOpenDeckMenu,
  editingDeck,
  setEditingDeck,
  syncBusy,
  busy,
  fileInputRef,
  onPickFile,
  onLoadDemoDecks,
  onStartReview,
  onRename,
  onResetProgress,
  onDelete,
  onCardInfoToggle,
  onWriteLanguageChange,
  onGetFieldNames,
  onReimportApkg,
  setLimitsModal,
  setCardTypesModal,
  setLearnedCardsModal,
  setFieldConfigModal,
}: {
  libraries: LibraryItem[];
  deckOverviews: Record<string, DeckOverview>;
  activeLibraryId: string | null;
  openDeckMenu: OpenDeckMenu | null;
  setOpenDeckMenu: Dispatch<SetStateAction<OpenDeckMenu | null>>;
  editingDeck: EditingDeck | null;
  setEditingDeck: Dispatch<SetStateAction<EditingDeck | null>>;
  syncBusy: boolean;
  busy: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPickFile: (f: File) => void;
  onLoadDemoDecks: () => void;
  onStartReview: (libraryId: string, deckId: number) => void;
  onRename: (libraryId: string, deckId: number, name: string) => void;
  onResetProgress: (args: { libraryId: string; deckId: number; deckName: string }) => void;
  onDelete: (libraryId: string, deckId: number) => void;
  onCardInfoToggle: (libraryId: string, deckId: number, open: boolean) => void;
  onWriteLanguageChange: (libraryId: string, deckId: number, lang: "en" | "fr" | "es") => void;
  onGetFieldNames: (libraryId: string, deckId: number) => Promise<string[]>;
  onReimportApkg: (libraryId: string, file: File) => void;
  setLimitsModal: Dispatch<SetStateAction<LimitsModalState | null>>;
  setCardTypesModal: Dispatch<SetStateAction<CardTypesModalState | null>>;
  setLearnedCardsModal: Dispatch<SetStateAction<LearnedCardsModalState | null>>;
  setFieldConfigModal: Dispatch<SetStateAction<FieldConfigModalState | null>>;
}) {
  const reimportInputRef = useRef<HTMLInputElement | null>(null);
  const [reimportLibraryId, setReimportLibraryId] = useState<string | null>(null);

  return (
    <main className="caliche-panel rounded-3xl p-5 sm:p-6">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-semibold">Decks</div>
          <button
            type="button"
            className="caliche-primary-btn rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            Add deck
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".apkg,application/octet-stream"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              e.currentTarget.value = "";
              onPickFile(f);
            }}
          />
          <input
            ref={reimportInputRef}
            type="file"
            accept=".apkg,application/octet-stream"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f || !reimportLibraryId) return;
              e.currentTarget.value = "";
              onReimportApkg(reimportLibraryId, f);
              setReimportLibraryId(null);
            }}
          />
        </div>

        {libraries.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground/70">
              Import an <span className="font-medium">.apkg</span> to
              see your decks here. They are saved locally so you can keep
              using the app offline.
            </p>
            <button
              type="button"
              className="caliche-secondary-btn self-start rounded-full px-4 py-2 text-sm disabled:opacity-50"
              onClick={onLoadDemoDecks}
              disabled={busy || syncBusy}
            >
              Load demo decks
            </button>
          </div>
        ) : (
          <div className="rounded-2xl border border-foreground/15 bg-surface-strong/70">
            <div className="hidden sm:grid grid-cols-[1fr_80px_90px_110px_90px_130px_80px_80px_48px] gap-2 border-b border-foreground/15 px-4 py-3 text-xs font-medium text-foreground/70">
              <div>Deck</div>
              <div className="text-center">New</div>
              <div className="text-center">Learning</div>
              <div className="text-center">Review</div>
              <div className="text-center">Today</div>
              <div className="text-center">Total</div>
              <div className="text-center">Days left</div>
              <div className="text-center">Days done</div>
              <div />
            </div>

            <div className="divide-y divide-foreground/10">
              {libraries.flatMap((lib) =>
                lib.deck.decks.map((d) => {
                  const depth = Math.max(0, d.name.split("::").length - 1);
                  const display = d.name.split("::").slice(-1)[0] ?? d.name;
                  const overview = deckOverviews[`${lib.id}:${d.id}`] ?? null;
                  const deckCompleted = Boolean(overview && overview.total > 0 && overview.reviewed >= overview.total);
                  const isSelected =
                    activeLibraryId === lib.id &&
                    (lib.selectedDeckId ?? null) === d.id;
                  const menuOpen =
                    openDeckMenu?.libraryId === lib.id &&
                    openDeckMenu.deckId === d.id;
                  const isEditing =
                    editingDeck?.libraryId === lib.id &&
                    editingDeck.deckId === d.id;

                  return (
                    <div
                      key={`${lib.id}:${d.id}`}
                      className={`grid grid-cols-[1fr_48px] sm:grid-cols-[1fr_80px_90px_110px_90px_130px_80px_80px_48px] items-center gap-2 rounded-xl px-2 py-2 ${
                        isSelected ? "bg-foreground/5" : "hover:bg-foreground/5"
                      }`}
                    >
                      <button
                        type="button"
                        className={`min-w-0 text-left ${syncBusy ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                        onClick={() => onStartReview(lib.id, d.id)}
                        disabled={syncBusy}
                        aria-disabled={syncBusy}
                        title={syncBusy ? "Syncing…" : "Open deck"}
                      >
                        <div
                          className="truncate text-sm font-medium"
                          style={{ paddingLeft: depth * 14 }}
                        >
                          {isEditing ? (
                            <input
                              value={editingDeck.value}
                              onChange={(e) =>
                                setEditingDeck({
                                  libraryId: lib.id,
                                  deckId: d.id,
                                  value: e.target.value,
                                })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  onRename(lib.id, d.id, editingDeck.value);
                                  setEditingDeck(null);
                                }
                                if (e.key === "Escape") setEditingDeck(null);
                              }}
                              onBlur={() => {
                                onRename(lib.id, d.id, editingDeck.value);
                                setEditingDeck(null);
                              }}
                              className="w-full rounded-lg border border-foreground/15 bg-background px-3 py-2 text-sm"
                              autoFocus
                            />
                          ) : (
                            <span className="inline-flex items-center gap-2">
                              <span>{display}</span>
                              {deckCompleted ? (
                                <span
                                  className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                                  title="Deck completed"
                                  aria-label="Deck completed"
                                >
                                  🏆
                                </span>
                              ) : null}
                            </span>
                          )}
                        </div>
                      </button>

                      <div className="hidden sm:block text-center text-sm text-blue-400">
                        {overview ? overview.newShown : 0}
                      </div>
                      <div className="hidden sm:block text-center text-sm text-foreground/70">
                        {overview ? overview.learningDue + overview.learningWaiting : 0}
                      </div>
                      <div className="hidden sm:block text-center text-sm font-medium text-green-500">
                        {overview ? overview.reviewShown : 0}
                      </div>
                      <div className="hidden sm:block text-center text-sm font-semibold text-foreground">
                        {overview
                          ? overview.newShown + overview.reviewShown + overview.learningDue + overview.learningWaiting
                          : "—"}
                      </div>
                      <div className="hidden sm:block text-center text-sm text-foreground/70">
                        {overview ? `${overview.reviewed}/${overview.total}` : "—"}
                      </div>
                      <div className="hidden sm:block text-center text-sm text-foreground/70">
                        {overview
                          ? (() => {
                              const unseen = overview.total - overview.reviewed;
                              if (unseen <= 0) return "✓";
                              const rate = overview.config.newPerDay;
                              if (!rate) return "—";
                              return String(Math.ceil(unseen / rate));
                            })()
                          : "—"}
                      </div>
                      <div className="hidden sm:block text-center text-sm text-foreground/70">
                        {overview ? overview.daysStudied || "—" : "—"}
                      </div>

                      <div className="relative flex justify-end" data-deck-menu-root="true">
                        <button
                          type="button"
                          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-foreground/15 hover:bg-foreground/5 cursor-pointer"
                          aria-label="Settings"
                          title="Settings"
                          onClick={() => {
                            if (menuOpen) { setOpenDeckMenu(null); return; }
                            setOpenDeckMenu({ libraryId: lib.id, deckId: d.id });
                          }}
                        >
                          <FaCog className="h-4 w-4" aria-hidden="true" />
                        </button>

                        {menuOpen ? (
                          <div className="absolute right-0 top-12 z-10 w-56 rounded-xl border border-foreground/15 bg-background p-1 shadow-sm">
                            <button
                              type="button"
                              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-foreground/5"
                              onClick={() => {
                                setOpenDeckMenu(null);
                                setEditingDeck({ libraryId: lib.id, deckId: d.id, value: d.name });
                              }}
                            >
                              Rename
                            </button>

                            <button
                              type="button"
                              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-foreground/5"
                              onClick={() => {
                                setOpenDeckMenu(null);
                                void (async () => {
                                  const db = getStudyDb();
                                  const allStates = await db.cardStates
                                    .where("[libraryId+deckId+state+due]")
                                    .between([lib.id, d.id, " ", -Infinity], [lib.id, d.id, "￿", Infinity])
                                    .filter((s) => s.state !== "new")
                                    .toArray();
                                  const cardKeys = allStates.map((s) => [lib.id, s.cardId] as [string, number]);
                                  const cards = await db.cards.bulkGet(cardKeys);
                                  const pairs: Array<{ card: CardEntity; state: string; intervalDays: number; due: number }> = [];
                                  for (let i = 0; i < allStates.length; i++) {
                                    const c = cards[i];
                                    if (!c) continue;
                                    const s = allStates[i]!;
                                    pairs.push({ card: c, state: s.state, intervalDays: s.intervalDays, due: s.due });
                                  }
                                  setLearnedCardsModal({ libraryId: lib.id, deckId: d.id, tab: "all", cards: pairs });
                                })();
                              }}
                            >
                              Studied cards
                            </button>

                            <button
                              type="button"
                              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-foreground/5"
                              onClick={() => {
                                setLimitsModal({
                                  libraryId: lib.id,
                                  deckId: d.id,
                                  newPerDay: String(overview?.config.newPerDay ?? 10),
                                  reviewsPerDay: String(overview?.config.reviewsPerDay ?? 200),
                                  easeFactor: String(overview?.config.easeFactor ?? 2.0),
                                  originalEaseFactor: String(overview?.config.easeFactor ?? 2.0),
                                });
                                setOpenDeckMenu(null);
                              }}
                            >
                              Edit limits
                            </button>

                            <button
                              type="button"
                              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-foreground/5"
                              onClick={() => {
                                const current = (overview?.config.answerStyles ?? [
                                  "normal", "write", "multiple-choice", "reverse", "match",
                                ]) as ReviewAnswerStyle[];
                                setCardTypesModal({ libraryId: lib.id, deckId: d.id, styles: current });
                                setOpenDeckMenu(null);
                              }}
                            >
                              Edit type of cards
                            </button>

                            <div className="px-3 py-2">
                              <label className="flex items-center justify-between gap-3 text-xs text-foreground/70">
                                <span>Card info open</span>
                                <input
                                  type="checkbox"
                                  className="h-4 w-4"
                                  checked={Boolean(overview?.config.cardInfoOpenByDefault)}
                                  onChange={(e) => onCardInfoToggle(lib.id, d.id, e.currentTarget.checked)}
                                />
                              </label>
                            </div>

                            <div className="px-3 py-2">
                              <div className="text-xs text-foreground/70">Write language</div>
                              <select
                                className="mt-1 w-full rounded-lg border border-foreground/15 bg-background px-3 py-2 text-sm"
                                value={overview?.config.writeLanguage ?? DEFAULT_DECK_CONFIG.writeLanguage}
                                onChange={(e) => {
                                  const next = sanitizeWriteLanguage(e.currentTarget.value);
                                  onWriteLanguageChange(lib.id, d.id, next);
                                }}
                              >
                                <option value="en">English</option>
                                <option value="fr">Français</option>
                                <option value="es">Español</option>
                              </select>
                            </div>

                            <button
                              type="button"
                              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-foreground/5"
                              onClick={() => {
                                setOpenDeckMenu(null);
                                void onGetFieldNames(lib.id, d.id).then((allFields) => {
                                  setFieldConfigModal({
                                    type: "hidden",
                                    libraryId: lib.id,
                                    deckId: d.id,
                                    allFields,
                                    current: overview?.config.hiddenFieldLabels ?? [],
                                  });
                                });
                              }}
                            >
                              Hidden fields
                            </button>

                            <button
                              type="button"
                              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-foreground/5"
                              onClick={() => {
                                setOpenDeckMenu(null);
                                void onGetFieldNames(lib.id, d.id).then((allFields) => {
                                  setFieldConfigModal({
                                    type: "pinned",
                                    libraryId: lib.id,
                                    deckId: d.id,
                                    allFields,
                                    current: overview?.config.pinnedBackFieldLabels ?? [],
                                  });
                                });
                              }}
                            >
                              Pinned back fields
                            </button>

                            <button
                              type="button"
                              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-foreground/5"
                              onClick={() => {
                                setOpenDeckMenu(null);
                                setReimportLibraryId(lib.id);
                                reimportInputRef.current?.click();
                              }}
                              disabled={busy}
                            >
                              Re-import .apkg
                            </button>

                            <button
                              type="button"
                              className="w-full rounded-lg px-3 py-2 text-left text-sm text-red-500 hover:bg-foreground/5"
                              onClick={() => {
                                setOpenDeckMenu(null);
                                onResetProgress({ libraryId: lib.id, deckId: d.id, deckName: d.name });
                              }}
                              disabled={busy}
                            >
                              Reset progress
                            </button>

                            <button
                              type="button"
                              className="w-full rounded-lg px-3 py-2 text-left text-sm text-red-500 hover:bg-foreground/5"
                              onClick={() => {
                                setOpenDeckMenu(null);
                                const ok = confirm(`Delete "${d.name}" and its subdecks?`);
                                if (!ok) return;
                                onDelete(lib.id, d.id);
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        ) : null}
                      </div>

                      <div className="col-span-2 sm:hidden pb-1 text-xs text-foreground/70">
                        <span className="text-blue-400">New {overview ? overview.newShown : 0}</span>
                        <span> • </span>
                        <span>Learning {overview ? overview.learningDue : 0}</span>
                        <span> • </span>
                        <span className="text-green-500">Review {overview ? overview.reviewShown : 0}</span>
                        <span> • </span>
                        <span>Total {overview ? `${overview.reviewed}/${overview.total}` : "—"}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
