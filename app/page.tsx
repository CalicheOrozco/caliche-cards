"use client";

import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { FaCog, FaPlay, FaTimes } from "react-icons/fa";

import type { ImportedCard, ImportedDeck } from "../lib/apkg";
import { importApkg } from "../lib/apkg";
import {
  clearLastState,
  loadLastState,
  saveLastState,
  type LibraryItem,
} from "../lib/deckStorage";
import { clearMedia, getMediaBlob } from "../lib/mediaStorage";

type Mode = "import" | "review";

function sanitize(html: string) {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
  });
}

type CardPart =
  | { type: "html"; value: string }
  | { type: "sound"; filename: string };

function splitBySoundTag(input: string): CardPart[] {
  const out: CardPart[] = [];
  const re = /\[sound:([^\]]+)\]/gi;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const start = match.index;
    const end = re.lastIndex;
    const filename = (match[1] ?? "").trim();

    if (start > lastIndex) {
      out.push({ type: "html", value: input.slice(lastIndex, start) });
    }

    if (filename) {
      out.push({ type: "sound", filename });
    } else {
      out.push({ type: "html", value: input.slice(start, end) });
    }

    lastIndex = end;
  }

  if (lastIndex < input.length) {
    out.push({ type: "html", value: input.slice(lastIndex) });
  }

  if (out.length === 0) {
    return [{ type: "html", value: input }];
  }

  return out;
}

function extractFirstSoundFilename(input: string): string | null {
  const re = /\[sound:([^\]]+)\]/i;
  const match = re.exec(String(input ?? ""));
  const filename = (match?.[1] ?? "").trim();
  return filename || null;
}

async function tryPlayAudioFilename(
  namespace: string,
  filename: string
): Promise<void> {
  const blob = await getMediaBlob(namespace, filename);
  if (!blob) throw new Error("blob not found");

  const url = URL.createObjectURL(blob);
  try {
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.onerror = () => URL.revokeObjectURL(url);
    await audio.play();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("play failed");
  }
}

function SoundButton({
  namespace,
  filename,
  variant = "pill",
}: {
  namespace: string;
  filename: string;
  variant?: "pill" | "icon";
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePlay() {
    setError(null);
    setIsLoading(true);
    try {
      await tryPlayAudioFilename(namespace, filename);
    } catch (e) {
      if (e instanceof Error && e.message === "blob not found") {
        setError("Audio not found");
      } else {
        setError("Couldn't play audio");
      }
    } finally {
      setIsLoading(false);
    }
  }

  if (variant === "icon") {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handlePlay}
          disabled={isLoading}
          title={filename}
          aria-label="Play"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-foreground/15 hover:bg-foreground/5 disabled:opacity-50"
        >
          <FaPlay className="h-4 w-4" aria-hidden="true" />
        </button>
        {error ? <span className="text-xs text-red-400">{error}</span> : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handlePlay}
        disabled={isLoading}
        title={filename}
        className="inline-flex items-center gap-2 rounded-full border border-foreground/15 px-3 py-2 text-sm hover:bg-foreground/5 disabled:opacity-50"
      >
        <FaPlay className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{isLoading ? "Loading…" : "Play"}</span>
      </button>
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </div>
  );
}

function CardFace({
  namespace,
  html,
  className,
  suppressFirstSoundFilename,
}: {
  namespace: string;
  html: string;
  className?: string;
  suppressFirstSoundFilename?: string | null;
}) {
  const parts = useMemo(() => {
    const base = splitBySoundTag(String(html ?? "")).map((p) => {
      if (p.type === "html") return { ...p, value: sanitize(p.value) };
      return p;
    });

    if (!suppressFirstSoundFilename) return base;
    let removed = false;
    return base.filter((p) => {
      if (
        !removed &&
        p.type === "sound" &&
        p.filename === suppressFirstSoundFilename
      ) {
        removed = true;
        return false;
      }
      return true;
    });
  }, [html, suppressFirstSoundFilename]);

  return (
    <div
      className={`text-foreground [&_a]:underline [&_a:hover]:opacity-80 [&_br]:block [&_img]:max-w-full [&_img]:h-auto [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 ${className ?? "text-base leading-7"}`}
    >
      {parts.map((p, idx) => {
        if (p.type === "sound") {
          return (
            <div key={`sound-${idx}-${p.filename}`} className="my-2">
              <SoundButton namespace={namespace} filename={p.filename} />
            </div>
          );
        }

        return (
          <div
            key={`html-${idx}`}
            dangerouslySetInnerHTML={{ __html: p.value }}
          />
        );
      })}
    </div>
  );
}

function FieldsList({
  namespace,
  fields,
  names,
}: {
  namespace: string;
  fields: string[] | undefined;
  names: string[] | undefined;
}) {
  const list = (fields ?? []).map((v) => String(v ?? ""));
  const labelList = (names ?? []).map((n) => String(n ?? "").trim());

  function normalizeLabel(s: string) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // quita tildes
}

function shouldHideFieldLabel(label: string, hiddenLabels: string[]) {
  const target = normalizeLabel(label);
  if (!target) return false;

  const hidden = new Set(hiddenLabels.map(normalizeLabel));
  return hidden.has(target);
}

  const HIDDEN_FIELD_LABELS = ["Índice", "Sort Index"];

  const nonEmpty = list
    .map((value, index) => ({
      index,
      value: value.trim(),
      label: labelList[index] || "",
    }))
    .filter((x) => x.value !== "")
    .filter((x) => !shouldHideFieldLabel(x.label, HIDDEN_FIELD_LABELS));

  if (nonEmpty.length === 0) return null;

  return (
    <div className="rounded-2xl border border-foreground/15 p-4">
      <div className="mb-3 text-xs font-medium text-foreground/70">Card info</div>
      <div className="flex flex-col gap-3">
        {nonEmpty.map(({ index, value, label }) => (
          <div key={index} className="rounded-xl border border-foreground/10 p-3">
            {label ? (
              <div className="mb-1 text-[11px] font-medium text-foreground/60">
                {label}
              </div>
            ) : null}
            <CardFace namespace={namespace} html={value} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("import");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [libraries, setLibraries] = useState<LibraryItem[]>([]);
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [queue, setQueue] = useState<ImportedCard[]>([]);
  const [showAnswer, setShowAnswer] = useState(false);

  const autoPlayedCardIds = useRef<Set<number>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const { state, clearedOld } = await loadLastState();
        if (clearedOld) {
          setError(
            "Saved data format was updated. Re-import your .apkg to apply the changes."
          );
        }
        if (!state) return;
        setLibraries(state.libraries ?? []);
        setActiveLibraryId(state.activeLibraryId ?? null);
      } catch {
        // ignore
      }
    })();
  }, []);

  const activeLibrary = useMemo(() => {
    if (libraries.length === 0) return null;
    const found = libraries.find((l) => l.id === activeLibraryId);
    return found ?? libraries[0] ?? null;
  }, [libraries, activeLibraryId]);

  const activeNamespace = activeLibrary?.id ?? "default";
  const activeDeck = activeLibrary?.deck ?? null;
  const selectedDeckId = activeLibrary?.selectedDeckId ?? null;

  const selectedDeckName = useMemo(() => {
    if (!activeDeck || selectedDeckId == null) return null;
    return activeDeck.decks.find((d) => d.id === selectedDeckId)?.name ?? null;
  }, [activeDeck, selectedDeckId]);

  async function onPickFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const id = crypto.randomUUID();
      const baseName = file.name.replace(/\.[^.]+$/u, "").trim();
      const name = baseName || "Deck";

      const imported = await importApkg(file, { mediaNamespace: id });

      // If the export contains exactly one top-level deck, rename it to the
      // filename (sans extension) so the list matches what you imported.
      const topLevelDecks = imported.decks.filter((d) => !d.name.includes("::"));
      const shouldRenameTopLevel = baseName && topLevelDecks.length === 1;
      const importedWithRenamedTopLevel: ImportedDeck = shouldRenameTopLevel
        ? {
            ...imported,
            decks: imported.decks.map((d) =>
              d.id === topLevelDecks[0]?.id ? { ...d, name: baseName } : d
            ),
          }
        : imported;

      const defaultDeckId = importedWithRenamedTopLevel.decks[0]?.id ?? null;

      const nextItem: LibraryItem = {
        id,
        name,
        deck: importedWithRenamedTopLevel,
        selectedDeckId: defaultDeckId,
        savedAt: Date.now(),
      };

      setLibraries((prev) => {
        const next = [...prev, nextItem];
        void saveLastState({
          libraries: next,
          activeLibraryId: id,
          savedAt: Date.now(),
        });
        return next;
      });

      setActiveLibraryId(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error importing .apkg";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function onClearSaved() {
    await clearLastState();
    await clearMedia();
    setLibraries([]);
    setActiveLibraryId(null);
    setMode("import");
    setQueue([]);
    setShowAnswer(false);
  }

  const [openDeckMenu, setOpenDeckMenu] = useState<
    { libraryId: string; deckId: number } | null
  >(null);
  const [editingDeck, setEditingDeck] = useState<
    { libraryId: string; deckId: number; value: string } | null
  >(null);

  useEffect(() => {
    if (!openDeckMenu) return;

    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (!(target instanceof Element)) {
        setOpenDeckMenu(null);
        return;
      }

      if (target.closest('[data-deck-menu-root="true"]')) return;
      setOpenDeckMenu(null);
    }

    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [openDeckMenu]);

  function updateLibrary(libraryId: string, updater: (item: LibraryItem) => LibraryItem) {
    setLibraries((prev) => {
      const next = prev.map((l) => (l.id === libraryId ? updater(l) : l));
      void saveLastState({
        libraries: next,
        activeLibraryId: activeLibraryId ?? libraryId,
        savedAt: Date.now(),
      });
      return next;
    });
  }

  function pickDeck(libraryId: string, deckId: number) {
    setActiveLibraryId(libraryId);
    updateLibrary(libraryId, (item) => ({ ...item, selectedDeckId: deckId }));
  }

  function renameDeck(libraryId: string, deckId: number, nextName: string) {
    const trimmed = nextName.trim();
    if (!trimmed) return;
    updateLibrary(libraryId, (item) => ({
      ...item,
      deck: {
        ...item.deck,
        decks: item.deck.decks.map((d) =>
          d.id === deckId ? { ...d, name: trimmed } : d
        ),
      },
    }));
  }

  function deleteDeck(libraryId: string, deckId: number) {
    const lib = libraries.find((l) => l.id === libraryId);
    if (!lib) return;
    const deck = lib.deck.decks.find((d) => d.id === deckId);
    if (!deck) return;
    const name = deck.name;
    const toDeleteNames = new Set<string>([name]);
    for (const d of lib.deck.decks) {
      if (d.name.startsWith(`${name}::`)) toDeleteNames.add(d.name);
    }
    const toDeleteIds = new Set<number>(
      lib.deck.decks.filter((d) => toDeleteNames.has(d.name)).map((d) => d.id)
    );

    updateLibrary(libraryId, (item) => {
      const nextDecks = item.deck.decks.filter((d) => !toDeleteIds.has(d.id));
      const nextCards = item.deck.cards.filter((c) => !toDeleteIds.has(c.deckId));
      const nextSelected =
        item.selectedDeckId != null && toDeleteIds.has(item.selectedDeckId)
          ? (nextDecks[0]?.id ?? null)
          : item.selectedDeckId;

      return {
        ...item,
        selectedDeckId: nextSelected,
        deck: { decks: nextDecks, cards: nextCards },
      };
    });
  }

  function startReview() {
    setError(null);
    if (!activeLibrary || !activeDeck) return;
    if (selectedDeckId == null) {
      setError("Select a deck.");
      return;
    }

    const cards = activeDeck.cards.filter((c) => c.deckId === selectedDeckId);
    if (cards.length === 0) {
      setError("That deck has no cards.");
      return;
    }

    setQueue(cards);
    setShowAnswer(false);
    setMode("review");
  }

  function startReviewFor(libraryId: string, deckId: number) {
    setError(null);
    const lib = libraries.find((l) => l.id === libraryId) ?? null;
    if (!lib) return;

    setActiveLibraryId(libraryId);
    updateLibrary(libraryId, (item) => ({ ...item, selectedDeckId: deckId }));

    const cards = lib.deck.cards.filter((c) => c.deckId === deckId);
    if (cards.length === 0) {
      setError("That deck has no cards.");
      return;
    }

    setQueue(cards);
    setShowAnswer(false);
    setMode("review");
  }

  function passCard() {
    setQueue((q) => q.slice(1));
    setShowAnswer(false);
  }

  function failCard() {
    setQueue((q) => {
      const [current, ...rest] = q;
      if (!current) return q;
      return [...rest, current];
    });
    setShowAnswer(false);
  }

  const current = queue[0] ?? null;
  const currentId = current?.id ?? null;
  const currentMissingFields =
    !!current &&
    (!Array.isArray(current.fieldsHtml) || current.fieldsHtml.length === 0);

  const promotedSound = useMemo(() => {
    if (!current) return null;
    const fromFront = extractFirstSoundFilename(current.frontHtml);
    if (fromFront) return { filename: fromFront, source: "front" as const };
    const fromBack = extractFirstSoundFilename(current.backHtml);
    if (fromBack) return { filename: fromBack, source: "back" as const };
    return null;
  }, [current]);

  useEffect(() => {
    if (mode !== "review") return;
    if (currentId == null) return;
    if (showAnswer) return;
    const filename = promotedSound?.filename;
    if (!filename) return;
    if (autoPlayedCardIds.current.has(currentId)) return;
    autoPlayedCardIds.current.add(currentId);

    // Autoplay can be blocked by the browser; ignore failures.
    void (async () => {
      try {
        await tryPlayAudioFilename(activeNamespace, filename);
      } catch {
        // ignore
      }
    })();
  }, [mode, currentId, promotedSound?.filename, showAnswer, activeNamespace]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-10">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Caliche Cards
            </h1>
            <p className="text-sm text-foreground/70">
              Import an Anki .apkg and review with Fail/Pass.
            </p>
          </div>
          {libraries.length > 0 ? (
            <button
              type="button"
              className="rounded-full border border-foreground/15 px-4 py-2 text-sm hover:bg-foreground/5"
              onClick={onClearSaved}
            >
              Clear all
            </button>
          ) : null}
        </header>

        {error ? (
          <div className="rounded-2xl border border-foreground/15 bg-foreground/5 px-4 py-3 text-sm">
            {error}
          </div>
        ) : null}

        {mode === "import" ? (
          <main className="rounded-3xl border border-foreground/15 bg-background p-5">
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold">Decks</div>
                <button
                  type="button"
                  className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
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
                    void onPickFile(f);
                  }}
                />
              </div>

              {libraries.length === 0 ? (
                <p className="text-sm text-foreground/70">
                  Import an <span className="font-medium">.apkg</span> to
                  see your decks here. They are saved locally so you can keep
                  using the app offline.
                </p>
              ) : (
                <div className="rounded-2xl border border-foreground/15">
                  <div className="grid grid-cols-[1fr_80px_90px_110px_48px] gap-2 border-b border-foreground/15 px-4 py-3 text-xs font-medium text-foreground/70">
                    <div>Deck</div>
                    <div className="text-center">New</div>
                    <div className="text-center">Learning</div>
                    <div className="text-center">Review</div>
                    <div />
                  </div>

                  <div className="divide-y divide-foreground/10">
                    {libraries.flatMap((lib) => {
                      const countsByDeckId = new Map<number, number>();
                      for (const c of lib.deck.cards) {
                        countsByDeckId.set(
                          c.deckId,
                          (countsByDeckId.get(c.deckId) ?? 0) + 1
                        );
                      }

                      return lib.deck.decks.map((d) => {
                        const depth = Math.max(
                          0,
                          d.name.split("::").length - 1
                        );
                        const display =
                          d.name.split("::").slice(-1)[0] ?? d.name;
                        const scheduled = countsByDeckId.get(d.id) ?? 0;
                        const isSelected =
                          (activeLibrary?.id ?? null) === lib.id &&
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
                            className={`grid grid-cols-[1fr_80px_90px_110px_48px] items-center gap-2 rounded-xl px-2 py-2 ${
                              isSelected
                                ? "bg-foreground/5"
                                : "hover:bg-foreground/5"
                            }`}
                          >
                            <button
                              type="button"
                              className="min-w-0 cursor-pointer text-left"
                              onClick={() => startReviewFor(lib.id, d.id)}
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
                                        renameDeck(
                                          lib.id,
                                          d.id,
                                          editingDeck.value
                                        );
                                        setEditingDeck(null);
                                      }
                                      if (e.key === "Escape") {
                                        setEditingDeck(null);
                                      }
                                    }}
                                    onBlur={() => {
                                      renameDeck(
                                        lib.id,
                                        d.id,
                                        editingDeck.value
                                      );
                                      setEditingDeck(null);
                                    }}
                                    className="w-full rounded-lg border border-foreground/15 bg-background px-3 py-2 text-sm"
                                    autoFocus
                                  />
                                ) : (
                                  display
                                )}
                              </div>
                            </button>

                            <div className="text-center text-sm text-blue-400">0</div>
                            <div className="text-center text-sm text-foreground/40">0</div>
                            <div className="text-center text-sm font-medium text-green-500">
                              {scheduled}
                            </div>

                            <div
                              className="relative flex justify-end"
                              data-deck-menu-root="true"
                            >
                              <button
                                type="button"
                                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-foreground/15 hover:bg-foreground/5 cursor-pointer"
                                aria-label="Settings"
                                title="Settings"
                                onClick={() =>
                                  setOpenDeckMenu(
                                    menuOpen
                                      ? null
                                      : { libraryId: lib.id, deckId: d.id }
                                  )
                                }
                              >
                                <FaCog className="h-4 w-4" aria-hidden="true" />
                              </button>

                              {menuOpen ? (
                                <div className="absolute right-0 top-12 z-10 w-40 rounded-xl border border-foreground/15 bg-background p-1 shadow-sm">
                                  <button
                                    type="button"
                                    className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-foreground/5"
                                    onClick={() => {
                                      setOpenDeckMenu(null);
                                      setEditingDeck({
                                        libraryId: lib.id,
                                        deckId: d.id,
                                        value: d.name,
                                      });
                                    }}
                                  >
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-red-500 hover:bg-foreground/5"
                                    onClick={() => {
                                      setOpenDeckMenu(null);
                                      const ok = confirm(
                                        `Delete “${d.name}” and its subdecks?`
                                      );
                                      if (!ok) return;
                                      deleteDeck(lib.id, d.id);
                                    }}
                                  >
                                    Delete
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        );
                      });
                    })}
                  </div>
                </div>
              )}
            </div>
          </main>
        ) : null}

        {mode === "review" ? (
          <main className="rounded-3xl border border-foreground/15 bg-background p-5">
            <div className="flex flex-col gap-4">
              {currentMissingFields ? (
                <div className="rounded-2xl border border-foreground/15 bg-foreground/5 px-4 py-3 text-sm">
                  This deck was saved with an older version and is missing some
                  fields. Click <span className="font-medium">Clear all</span>{" "}
                  and re-import the <span className="font-medium">.apkg</span>.
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs text-foreground/70">Deck</div>
                  <div className="text-sm font-medium">
                    {selectedDeckName ?? "(unnamed)"}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-sm text-foreground/70">
                    {queue.length} left
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setMode("import");
                      setQueue([]);
                      setShowAnswer(false);
                    }}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-foreground/15 hover:bg-foreground/5"
                    title="Exit"
                    aria-label="Exit"
                  >
                    <FaTimes className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>

              {current ? (
                <div className="relative overflow-hidden rounded-3xl border border-foreground/15 bg-foreground/5 p-6">
                  {promotedSound?.filename ? (
                    <div className="absolute right-4 top-4">
                      <SoundButton
                        namespace={activeNamespace}
                        filename={promotedSound.filename}
                        variant="icon"
                      />
                    </div>
                  ) : null}

                  <div className="flex flex-col gap-6">
                    <div className="py-10">
                      <CardFace
                        namespace={activeNamespace}
                        html={current.frontHtml}
                        suppressFirstSoundFilename={
                          promotedSound?.source === "front"
                            ? promotedSound.filename
                            : null
                        }
                        className="text-center text-4xl font-semibold leading-tight tracking-tight"
                      />
                    </div>

                    {showAnswer ? (
                      <div className="border-t border-foreground/15 pt-6">
                        <CardFace
                          namespace={activeNamespace}
                          html={current.backHtml}
                          suppressFirstSoundFilename={
                            promotedSound?.source === "back"
                              ? promotedSound.filename
                              : null
                          }
                          className="text-center text-xl leading-8"
                        />
                      </div>
                    ) : null}

                    {showAnswer ? (
                      <FieldsList
                        namespace={activeNamespace}
                        fields={current.fieldsHtml}
                        names={current.fieldNames}
                      />
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-foreground/15 bg-foreground/5 px-4 py-6 text-center">
                  <div className="text-lg font-semibold">All done for today!</div>
                  <div className="mt-1 text-sm text-foreground/70">
                    No cards left in the queue.
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-3 sm:flex-row">
                {current ? (
                  !showAnswer ? (
                    <button
                      type="button"
                      className="h-12 flex-1 rounded-full bg-foreground px-5 text-sm font-medium text-background hover:opacity-90"
                      onClick={() => setShowAnswer(true)}
                    >
                      Show answer
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="h-12 flex-1 rounded-full border border-red-500 px-5 text-sm font-medium text-red-500 hover:bg-red-500 hover:text-background"
                        onClick={failCard}
                      >
                        Fail
                      </button>
                      <button
                        type="button"
                        className="h-12 flex-1 rounded-full border border-green-500 px-5 text-sm font-medium text-green-500 hover:bg-green-500 hover:text-background"
                        onClick={passCard}
                      >
                        Pass
                      </button>
                    </>
                  )
                ) : (
                  <button
                    type="button"
                    className="h-12 flex-1 rounded-full bg-foreground px-5 text-sm font-medium text-background hover:opacity-90"
                    onClick={() => {
                      setMode("import");
                      setQueue([]);
                      setShowAnswer(false);
                    }}
                  >
                    Back
                  </button>
                )}
              </div>
            </div>
          </main>
        ) : null}
      </div>
    </div>
  );
}