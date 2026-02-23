"use client";

import DOMPurify from "dompurify";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaCog, FaPlay, FaTimes } from "react-icons/fa";

import type { ImportedDeck } from "../lib/apkg";
import { importApkg } from "../lib/apkg";
import {
  clearLastState,
  loadLastState,
  saveLastState,
  type LibraryItem,
} from "../lib/deckStorage";
import { clearMedia, getMediaBlob } from "../lib/mediaStorage";
import type { DeckRef, NextCard } from "../lib/studyTypes";
import {
  answerCard,
  getDeckConfig,
  getDeckOverview,
  getNextCard,
  setDeckNewPerDay,
  startStudySession,
  upsertImportedDeck,
  type DeckOverview,
} from "../lib/studyApi";
import { deleteStudyDb } from "../lib/studyDb";
import type { DeckConfig } from "../lib/studyTypes";
import { scheduleAnswer } from "../lib/scheduler";

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

function localMediaCandidatesFromSrc(src: string): string[] {
  const raw = String(src ?? "").trim();
  if (!raw) return [];

  // Ignore remote/inline sources.
  if (/^(?:https?:|data:|blob:|file:|about:)/i.test(raw)) return [];

  const noQuery = raw.split(/[?#]/)[0] ?? raw;
  const name = String(noQuery)
    .replace(/^collection\.media\//i, "")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .trim();

  if (!name) return [];

  const candidates: string[] = [name];

  // Some decks URL-encode media filenames.
  try {
    const decoded = decodeURIComponent(name);
    if (decoded && decoded !== name) candidates.push(decoded);
  } catch {
    // ignore
  }

  // Some templates use + for spaces.
  if (name.includes("+")) candidates.push(name.replace(/\+/g, " "));

  return Array.from(new Set(candidates.map((s) => s.trim()).filter(Boolean)));
}

function preprocessHtmlForLocalImages(html: string): string {
  const input = String(html ?? "");
  if (!input) return input;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(input, "text/html");
    const imgs = Array.from(doc.querySelectorAll("img"));

    for (const img of imgs) {
      const src = img.getAttribute("src") ?? "";
      const candidates = localMediaCandidatesFromSrc(src);
      if (candidates.length === 0) continue;

      // Prevent the browser from requesting `/<filename>` immediately.
      img.setAttribute("data-caliche-orig-src", src);
      img.setAttribute("data-caliche-src", candidates[0] ?? src);
      img.setAttribute("src", "data:,");
    }

    return doc.body.innerHTML;
  } catch {
    return input;
  }
}

function HtmlWithMedia({
  namespace,
  html,
}: {
  namespace: string;
  html: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    const revokeAll = () => {
      for (const url of objectUrlsRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      objectUrlsRef.current = [];
    };

    revokeAll();
    const root = ref.current;
    if (!root) {
      return () => {
        cancelled = true;
        revokeAll();
      };
    }

    // Important: set innerHTML imperatively so React won't overwrite any
    // attribute changes we apply (like swapping img src to blob: URLs).
    root.innerHTML = html;

    const imgs = Array.from(root.querySelectorAll("img"));
    if (imgs.length === 0) {
      return () => {
        cancelled = true;
        revokeAll();
      };
    }

    void (async () => {
      let resolvedCount = 0;
      let missingCount = 0;

      for (const img of imgs) {
        if (cancelled) return;

        const rawSrc =
          img.getAttribute("data-caliche-src") ??
          img.getAttribute("data-caliche-orig-src") ??
          img.getAttribute("src") ??
          "";
        const candidates = localMediaCandidatesFromSrc(rawSrc);
        if (candidates.length === 0) continue;

        let blob: Blob | null = null;
        let resolved: string | null = null;
        for (const cand of candidates) {
          blob = await getMediaBlob(namespace, cand);
          if (blob) {
            resolved = cand;
            break;
          }
        }
        if (!blob) {
          missingCount += 1;
          img.setAttribute("data-caliche-missing", "1");
          continue;
        }

        const url = URL.createObjectURL(blob);
        objectUrlsRef.current.push(url);

        if (cancelled) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore
          }
          continue;
        }

        img.setAttribute("src", url);
        if (resolved) img.setAttribute("data-caliche-media", resolved);
        img.removeAttribute("data-caliche-missing");
        resolvedCount += 1;
      }

      if (process.env.NODE_ENV !== "production") {
        if (resolvedCount > 0 || missingCount > 0) {
          console.info(
            "[media] images resolved=",
            resolvedCount,
            "missing=",
            missingCount,
            "namespace=",
            namespace
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      revokeAll();
    };
  }, [namespace, html]);

  return <div ref={ref} />;
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
      if (p.type === "html") {
        const safe = sanitize(p.value);
        return { ...p, value: preprocessHtmlForLocalImages(safe) };
      }
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
      className={`text-foreground [&_a]:underline [&_a:hover]:opacity-80 [&_br]:block [&_img]:block [&_img]:mx-auto [&_img]:max-w-full [&_img]:h-auto [&_img]:max-h-[45vh] sm:[&_img]:max-h-[60vh] [&_img]:object-contain [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 ${className ?? "text-base leading-7"}`}
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
          <HtmlWithMedia
            key={`html-${idx}`}
            namespace={namespace}
            html={p.value}
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

  const HIDDEN_FIELD_LABELS = ["Índice", "Sort Index","Image"];

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

  const [showAnswer, setShowAnswer] = useState(false);
  const [reviewRef, setReviewRef] = useState<DeckRef | null>(null);
  const [current, setCurrent] = useState<NextCard | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewOverview, setReviewOverview] = useState<DeckOverview | null>(null);
  const [deckOverviews, setDeckOverviews] = useState<Record<string, DeckOverview>>({});
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [reviewDeckConfig, setReviewDeckConfig] = useState<DeckConfig | null>(null);

  // Prevent double autoplay from re-renders; reset when card changes.
  const lastAutoPlayedCardIdRef = useRef<number | null>(null);

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
        deck: {
          decks: importedWithRenamedTopLevel.decks.map((d) => ({ id: d.id, name: d.name })),
        },
        selectedDeckId: defaultDeckId,
        savedAt: Date.now(),
      };

      // Seed scheduler persistence (CardState / logs) for this import.
      await upsertImportedDeck(id, importedWithRenamedTopLevel);

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
    await deleteStudyDb();
    setLibraries([]);
    setActiveLibraryId(null);
    setMode("import");
    setShowAnswer(false);
    setReviewRef(null);
    setCurrent(null);
    setReviewOverview(null);
    setDeckOverviews({});
  }

  const [openDeckMenu, setOpenDeckMenu] = useState<
    { libraryId: string; deckId: number } | null
  >(null);
  const [editingDeck, setEditingDeck] = useState<
    { libraryId: string; deckId: number; value: string } | null
  >(null);
  const [editingNewPerDay, setEditingNewPerDay] = useState<
    { libraryId: string; deckId: number; value: string } | null
  >(null);

  const commitNewPerDay = useCallback(
    async (libraryId: string, deckId: number, raw: string) => {
      const next = Number(raw);
      await setDeckNewPerDay({ libraryId, deckId }, next);

      // Optimistically reflect in UI even if overview refresh lags.
      setDeckOverviews((prev) => {
        const key = `${libraryId}:${deckId}`;
        const existing = prev[key];
        if (!existing) return prev;
        return {
          ...prev,
          [key]: {
            ...existing,
            config: {
              ...existing.config,
              newPerDay: Math.max(0, Math.floor(next || 0)),
            },
          },
        };
      });

      const ov = await getDeckOverview({ libraryId, deckId });
      setDeckOverviews((prev) => ({ ...prev, [`${libraryId}:${deckId}`]: ov }));

      if (reviewRef?.libraryId === libraryId && reviewRef.deckId === deckId) {
        setReviewOverview(ov);
        const cfg = await getDeckConfig({ libraryId, deckId });
        setReviewDeckConfig(cfg);
      }
    },
    [reviewRef]
  );

  useEffect(() => {
    if (!openDeckMenu) return;

    const menu = openDeckMenu;

    function maybeSaveNewPerDay() {
      if (!editingNewPerDay) return;
      if (
        editingNewPerDay.libraryId === menu.libraryId &&
        editingNewPerDay.deckId === menu.deckId
      ) {
        void commitNewPerDay(
          editingNewPerDay.libraryId,
          editingNewPerDay.deckId,
          editingNewPerDay.value
        );
        setEditingNewPerDay(null);
      }
    }

    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (!(target instanceof Element)) {
        maybeSaveNewPerDay();
        setOpenDeckMenu(null);
        return;
      }

      if (target.closest('[data-deck-menu-root="true"]')) return;

      maybeSaveNewPerDay();
      setOpenDeckMenu(null);
    }

    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [openDeckMenu, editingNewPerDay, commitNewPerDay]);

  useEffect(() => {
    if (libraries.length === 0) return;

    let cancelled = false;
    void (async () => {
      const pairs = libraries.flatMap((lib) =>
        lib.deck.decks.map((d) => ({
          key: `${lib.id}:${d.id}`,
          ref: { libraryId: lib.id, deckId: d.id } satisfies DeckRef,
        }))
      );

      const entries = await Promise.all(
        pairs.map(async ({ key, ref }) => {
          try {
            const ov = await getDeckOverview(ref);
            return [key, ov] as const;
          } catch {
            return null;
          }
        })
      );

      if (cancelled) return;
      const next: Record<string, DeckOverview> = {};
      for (const e of entries) {
        if (!e) continue;
        next[e[0]] = e[1];
      }
      setDeckOverviews(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [libraries]);

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
      const nextSelected =
        item.selectedDeckId != null && toDeleteIds.has(item.selectedDeckId)
          ? (nextDecks[0]?.id ?? null)
          : item.selectedDeckId;

      return {
        ...item,
        selectedDeckId: nextSelected,
        deck: { decks: nextDecks },
      };
    });
  }

  async function loadNext(ref: DeckRef, excludeCardId?: number) {
    const [next, ov] = await Promise.all([
      getNextCard(ref, {
        learnAheadMs: 60 * 60 * 1000,
        learnAheadMode: "learn+relearn",
        excludeCardId,
      }),
      getDeckOverview(ref),
    ]);
    setCurrent(next);
    setReviewOverview(ov);
    setDeckOverviews((prev) => ({ ...prev, [`${ref.libraryId}:${ref.deckId}`]: ov }));
    setShowAnswer(false);
  }

  // Keep a lightweight clock for countdown UI.
  useEffect(() => {
    if (mode !== "review") return;
    const id = window.setInterval(() => setNowTs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [mode]);

  // If nothing is due right now but we have a next due timestamp, auto-refresh
  // when it becomes due so the user doesn't need to exit/re-enter.
  useEffect(() => {
    if (mode !== "review") return;
    if (!reviewRef) return;
    if (current) return;
    const ts = reviewOverview?.nextDueTs ?? null;
    if (ts == null) return;

    const delayMs = Math.max(250, ts - Date.now());
    const id = window.setTimeout(() => {
      void loadNext(reviewRef);
    }, delayMs);

    return () => window.clearTimeout(id);
  }, [mode, reviewRef, current, reviewOverview?.nextDueTs]);

  async function beginReview(libraryId: string, deckId: number) {
    setError(null);
    setReviewBusy(true);

    const ref: DeckRef = { libraryId, deckId };
    try {
      const ov = await getDeckOverview(ref);
      if (ov.total === 0) {
        setError("That deck has no cards.");
        return;
      }

      const cfg = await getDeckConfig(ref);
      setReviewDeckConfig(cfg);

      setReviewRef(ref);
      setMode("review");
      await startStudySession(ref);
      await loadNext(ref);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error starting review";
      setError(msg);
    } finally {
      setReviewBusy(false);
    }
  }

  function startReviewFor(libraryId: string, deckId: number) {
    const lib = libraries.find((l) => l.id === libraryId) ?? null;
    if (!lib) return;

    setActiveLibraryId(libraryId);
    updateLibrary(libraryId, (item) => ({ ...item, selectedDeckId: deckId }));
    void beginReview(libraryId, deckId);
  }

  async function onAnswer(result: "fail" | "pass") {
    if (!reviewRef || !current) return;
    setReviewBusy(true);
    try {
      const answeredId = current.card.cardId;
      await answerCard(reviewRef, answeredId, result);
      await loadNext(reviewRef, answeredId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error saving answer";
      setError(msg);
    } finally {
      setReviewBusy(false);
    }
  }

  function formatIn(ts: number, now: number): string {
    const ms = ts - now;
    if (ms <= 0) return "now";
    const totalSec = Math.ceil(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const totalMin = Math.ceil(totalSec / 60);
    if (totalMin < 60) return `${totalMin}m`;
    const totalHr = Math.ceil(totalMin / 60);
    if (totalHr < 24) return `${totalHr}h`;
    const totalDay = Math.ceil(totalHr / 24);
    return `${totalDay}d`;
  }

  const nextDueLabels = useMemo(() => {
    if (!current || !reviewDeckConfig) return null;

    const fail = scheduleAnswer(current.state, "fail", nowTs, reviewDeckConfig);
    const pass = scheduleAnswer(current.state, "pass", nowTs, reviewDeckConfig);

    return {
      fail: formatIn(fail.nextDue, nowTs),
      pass: formatIn(pass.nextDue, nowTs),
    };
  }, [current, reviewDeckConfig, nowTs]);

  const currentId = current?.card.cardId ?? null;
  const currentMissingFields =
    !!current &&
    (!Array.isArray(current.card.fieldsHtml) || current.card.fieldsHtml.length === 0);

  const promotedSound = useMemo(() => {
    if (!current) return null;
    const fromFront = extractFirstSoundFilename(current.card.frontHtml);
    if (fromFront) return { filename: fromFront, source: "front" as const };
    const fromBack = extractFirstSoundFilename(current.card.backHtml);
    if (fromBack) return { filename: fromBack, source: "back" as const };
    return null;
  }, [current]);

  useEffect(() => {
    if (mode !== "review") return;
    if (currentId == null) return;
    if (showAnswer) return;
    const filename = promotedSound?.filename;
    if (!filename) return;
    if (lastAutoPlayedCardIdRef.current === currentId) return;
    lastAutoPlayedCardIdRef.current = currentId;

    // Autoplay can be blocked by the browser; ignore failures.
    void (async () => {
      try {
        await tryPlayAudioFilename(activeNamespace, filename);
      } catch {
        // ignore
      }
    })();
  }, [mode, currentId, promotedSound?.filename, showAnswer, activeNamespace]);

  useEffect(() => {
    if (mode !== "review") {
      lastAutoPlayedCardIdRef.current = null;
    }
  }, [mode]);

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
                  <div className="hidden sm:grid grid-cols-[1fr_80px_90px_110px_130px_48px] gap-2 border-b border-foreground/15 px-4 py-3 text-xs font-medium text-foreground/70">
                    <div>Deck</div>
                    <div className="text-center">New</div>
                    <div className="text-center">Learning</div>
                    <div className="text-center">Review</div>
                    <div className="text-center">Total</div>
                    <div />
                  </div>

                  <div className="divide-y divide-foreground/10">
                    {libraries.flatMap((lib) => {
                      return lib.deck.decks.map((d) => {
                        const depth = Math.max(
                          0,
                          d.name.split("::").length - 1
                        );
                        const display =
                          d.name.split("::").slice(-1)[0] ?? d.name;
                        const overview = deckOverviews[`${lib.id}:${d.id}`] ?? null;
                        const isSelected =
                          (activeLibrary?.id ?? null) === lib.id &&
                          (lib.selectedDeckId ?? null) === d.id;

                        const menuOpen =
                          openDeckMenu?.libraryId === lib.id &&
                          openDeckMenu.deckId === d.id;

                        const isEditing =
                          editingDeck?.libraryId === lib.id &&
                          editingDeck.deckId === d.id;

                        const isEditingNewPerDay =
                          editingNewPerDay?.libraryId === lib.id &&
                          editingNewPerDay.deckId === d.id;

                        return (
                          <div
                            key={`${lib.id}:${d.id}`}
                            className={`grid grid-cols-[1fr_48px] sm:grid-cols-[1fr_80px_90px_110px_130px_48px] items-center gap-2 rounded-xl px-2 py-2 ${
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

                            <div className="hidden sm:block text-center text-sm text-blue-400">
                              {overview ? overview.newShown : 0}
                            </div>
                            <div className="hidden sm:block text-center text-sm text-foreground/70">
                              {overview ? overview.learningDue : 0}
                            </div>
                            <div className="hidden sm:block text-center text-sm font-medium text-green-500">
                              {overview ? overview.reviewShown : 0}
                            </div>
                            <div className="hidden sm:block text-center text-sm text-foreground/70">
                              {overview
                                ? `${overview.reviewed}/${overview.total}`
                                : "—"}
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
                                onClick={() => {
                                  if (menuOpen) {
                                    if (
                                      editingNewPerDay &&
                                      editingNewPerDay.libraryId === lib.id &&
                                      editingNewPerDay.deckId === d.id
                                    ) {
                                      void commitNewPerDay(
                                        editingNewPerDay.libraryId,
                                        editingNewPerDay.deckId,
                                        editingNewPerDay.value
                                      );
                                      setEditingNewPerDay(null);
                                    }
                                    setOpenDeckMenu(null);
                                    return;
                                  }

                                  setOpenDeckMenu({ libraryId: lib.id, deckId: d.id });
                                }}
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

                                  <div className="px-3 py-2">
                                    <div className="text-xs text-foreground/70">New/day</div>
                                    <input
                                      type="number"
                                      min={0}
                                      inputMode="numeric"
                                      value={
                                        isEditingNewPerDay
                                          ? editingNewPerDay.value
                                          : String(overview?.config.newPerDay ?? 10)
                                      }
                                      onFocus={() => {
                                        setEditingNewPerDay({
                                          libraryId: lib.id,
                                          deckId: d.id,
                                          value: String(overview?.config.newPerDay ?? 10),
                                        });
                                      }}
                                      onChange={(e) => {
                                        setEditingNewPerDay({
                                          libraryId: lib.id,
                                          deckId: d.id,
                                          value: e.target.value,
                                        });
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key !== "Enter") return;
                                        const raw = e.currentTarget.value;
                                        void (async () => {
                                          await commitNewPerDay(lib.id, d.id, raw);
                                          setEditingNewPerDay(null);
                                        })();
                                      }}
                                      onBlur={() => {
                                        const raw = isEditingNewPerDay
                                          ? editingNewPerDay.value
                                          : String(overview?.config.newPerDay ?? 10);
                                        void (async () => {
                                          await commitNewPerDay(lib.id, d.id, raw);
                                          setEditingNewPerDay(null);
                                        })();
                                      }}
                                      className="mt-1 w-full rounded-lg border border-foreground/15 bg-background px-3 py-2 text-sm"
                                    />

                                    <button
                                      type="button"
                                      className="mt-2 w-full rounded-lg border border-foreground/15 px-3 py-2 text-sm hover:bg-foreground/5"
                                      onClick={() => {
                                        const raw = isEditingNewPerDay
                                          ? editingNewPerDay.value
                                          : String(overview?.config.newPerDay ?? 10);
                                        void (async () => {
                                          await commitNewPerDay(lib.id, d.id, raw);
                                          setEditingNewPerDay(null);
                                          setOpenDeckMenu(null);
                                        })();
                                      }}
                                    >
                                      Save
                                    </button>
                                  </div>

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

                            <div className="col-span-2 sm:hidden pb-1 text-xs text-foreground/70">
                              <span className="text-blue-400">New {overview ? overview.newShown : 0}</span>
                              <span> • </span>
                              <span>Learning {overview ? overview.learningDue : 0}</span>
                              <span> • </span>
                              <span className="text-green-500">Review {overview ? overview.reviewShown : 0}</span>
                              <span> • </span>
                              <span>
                                Total {overview ? `${overview.reviewed}/${overview.total}` : "—"}
                              </span>
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
                  <div className="mt-1 text-xs text-foreground/70">
                    New/day: {reviewOverview?.config.newPerDay ?? "—"}
                    {reviewOverview
                      ? ` • Words: ${reviewOverview.reviewed}/${reviewOverview.total}`
                      : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-sm text-foreground/70">
                    Due: {reviewOverview ? reviewOverview.newShown + reviewOverview.learningDue + reviewOverview.reviewShown : 0}
                    {reviewOverview && reviewOverview.learningWaiting > 0
                      ? ` • Waiting: ${reviewOverview.learningWaiting}`
                      : ""}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setMode("import");
                      setShowAnswer(false);
                      setReviewRef(null);
                      setCurrent(null);
                      setReviewOverview(null);
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
                        html={current.card.frontHtml}
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
                          html={current.card.backHtml}
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
                        fields={current.card.fieldsHtml}
                        names={current.card.fieldNames}
                      />
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-foreground/15 bg-foreground/5 px-4 py-6 text-center">
                  <div className="text-lg font-semibold">All done for today!</div>
                  <div className="mt-1 text-sm text-foreground/70">
                    {reviewOverview?.nextDueTs ? (
                      (() => {
                        const ms = Math.max(0, reviewOverview.nextDueTs - nowTs);
                        const totalSec = Math.ceil(ms / 1000);
                        const m = Math.floor(totalSec / 60);
                        const s = totalSec % 60;
                        const mmss = `${m}:${String(s).padStart(2, "0")}`;
                        const waiting = reviewOverview.learningWaiting;
                        return (
                          <>
                            Next card in <span className="font-medium">{mmss}</span>
                            {waiting > 0 ? (
                              <>
                                {" "}• Waiting: <span className="font-medium">{waiting}</span>
                              </>
                            ) : null}
                          </>
                        );
                      })()
                    ) : (
                      <>No more cards due (or you hit today’s limits).</>
                    )}
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
                      disabled={reviewBusy}
                    >
                      Show answer
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="h-12 flex-1 rounded-full border border-red-500 px-5 text-sm font-medium text-red-500 hover:bg-red-500 hover:text-background"
                        onClick={() => void onAnswer("fail")}
                        disabled={reviewBusy}
                      >
                        Fail{nextDueLabels ? ` • ${nextDueLabels.fail}` : ""}
                      </button>
                      <button
                        type="button"
                        className="h-12 flex-1 rounded-full border border-green-500 px-5 text-sm font-medium text-green-500 hover:bg-green-500 hover:text-background"
                        onClick={() => void onAnswer("pass")}
                        disabled={reviewBusy}
                      >
                        Pass{nextDueLabels ? ` • ${nextDueLabels.pass}` : ""}
                      </button>
                    </>
                  )
                ) : (
                  <button
                    type="button"
                    className="h-12 flex-1 rounded-full bg-foreground px-5 text-sm font-medium text-background hover:opacity-90"
                    onClick={() => {
                      setMode("import");
                      setShowAnswer(false);
                      setReviewRef(null);
                      setCurrent(null);
                      setReviewOverview(null);
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