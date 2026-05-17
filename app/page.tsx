"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  loadLastState,
  saveLastState,
  type LibraryItem,
} from "../lib/deckStorage";
import type {
  CardEntity,
  DeckConfig,
  DeckRef,
  NextCard,
  ReviewAnswerStyle,
} from "../lib/studyTypes";
import {
  answerCard,
  getDeckConfig,
  getDeckOverview,
  getNextCard,
  resetDeckProgress,
  startStudySession,
  type DeckOverview,
} from "../lib/studyApi";
import { getStudyDb } from "../lib/studyDb";
import { DEFAULT_DECK_CONFIG, scheduleAnswer } from "../lib/scheduler";
import { useDeckConfigActions } from "../lib/useDeckConfigActions";
import { useCloudSync } from "../lib/useCloudSync";
import { fetchWithTimeout } from "../lib/syncUtils";
import {
  capitalizeFirstLetter,
  escapeRegExp,
  extractFirstSoundFilename,
  extractMultipleChoiceAnswerFromCard,
  extractReverseChoiceFromFrontHtml,
  formatIn,
  htmlToText,
  inferFieldLabelsForHtml,
  inferFieldSectionsForHtml,
  normalizeChoiceText,
  normalizeLabel,
  pickFieldSectionsByLabel,
  pickWriteTargetFromCard,
  seededShuffle,
  toWriteChars,
} from "../lib/cardUtils";
import { LOCAL_ONLY_MODE, tryPlayAudioFilename } from "../lib/mediaUtils";
import { AppHeader } from "../components/AppHeader";
import { DeckList } from "../components/DeckList";
import { ReviewPanel } from "../components/ReviewPanel";
import { FieldConfigModal, type FieldConfigModalState } from "../components/FieldConfigModals";
import { CardTypesModal, type CardTypesModalState } from "../components/modals/CardTypesModal";
import { CountersInfoModal } from "../components/modals/CountersInfoModal";
import { LimitsModal, type LimitsModalState } from "../components/modals/LimitsModal";
import { LearnedCardsModal, type LearnedCardsModalState } from "../components/modals/LearnedCardsModal";
import { CardPreviewModal } from "../components/modals/CardPreviewModal";
import {
  preloadMcAnswerPool,
  preloadReverseFrontPool,
  preloadMatchPool,
} from "../lib/reviewPreloaders";
import type { MatchItem } from "../lib/reviewPreloaders";


// AURAFORGE_COIN_PATCH_V122: local persistent coin balance bridge for deck-completion rewards.
const AURAFORGE_COIN_BALANCE_KEY = "caliche-cards:coin-balance";
const AURAFORGE_DECK_COMPLETION_AWARDS_KEY = "caliche-cards:deck-completion-awards";

type AuraForgeCoinAwardResult = {
  awarded: boolean;
  previousBalance: number;
  nextBalance: number;
};

function readAuraForgeCoinBalance(): number {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(AURAFORGE_COIN_BALANCE_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function awardAuraForgeDeckCompletionCoins(deckId: string, coins: number): AuraForgeCoinAwardResult {
  if (typeof window === "undefined" || !deckId || coins <= 0) {
    const current = readAuraForgeCoinBalance();
    return { awarded: false, previousBalance: current, nextBalance: current };
  }

  const previousBalance = readAuraForgeCoinBalance();
  const rawAwards = window.localStorage.getItem(AURAFORGE_DECK_COMPLETION_AWARDS_KEY);
  const awards: Record<string, boolean> = rawAwards ? JSON.parse(rawAwards) : {};

  if (awards[deckId]) {
    return { awarded: false, previousBalance, nextBalance: previousBalance };
  }

  const nextBalance = previousBalance + coins;
  awards[deckId] = true;
  window.localStorage.setItem(AURAFORGE_DECK_COMPLETION_AWARDS_KEY, JSON.stringify(awards));
  window.localStorage.setItem(AURAFORGE_COIN_BALANCE_KEY, String(nextBalance));
  return { awarded: true, previousBalance, nextBalance };
}

type Mode = "import" | "review";

export default function Home() {
  const [mode, setMode] = useState<Mode>("import");

  const [coinBalance, setCoinBalance] = useState<number>(0);

  useEffect(() => {
    setCoinBalance(readAuraForgeCoinBalance());
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const devPurgeEnabled =
    process.env.NODE_ENV !== "production" &&
    /^(1|true)$/i.test(String(process.env.NEXT_PUBLIC_ENABLE_DEV_PURGE || ""));

  const [authUser, setAuthUser] = useState<{ username: string } | null | undefined>(undefined);

  const [syncBusy, setSyncBusy] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [lastPushAtLocal, setLastPushAtLocal] = useState<number | null>(null);
  const [syncProgress, setSyncProgress] = useState<
    | {
        done: number;
        total: number;
        phase: string;
      }
    | null
  >(null);

  const [libraries, setLibraries] = useState<LibraryItem[]>([]);
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [showAnswer, setShowAnswer] = useState(false);
  const [cardAppearanceToken, setCardAppearanceToken] = useState(0);
  const [reviewAnswerStyle, setReviewAnswerStyle] = useState<ReviewAnswerStyle>("normal");
  const [writePicked, setWritePicked] = useState<Array<{ index: number; ch: string }>>([]);
  const [writeOutcome, setWriteOutcome] = useState<"correct" | "wrong" | null>(null);
  type WriteDrag = { fromIdx: number; ch: string; x: number; y: number; dropIdx: number };
  const [writeDrag, setWriteDrag] = useState<WriteDrag | null>(null);
  const writeDragRef = useRef<WriteDrag | null>(null);
  const writePickedRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [mcOutcome, setMcOutcome] = useState<"correct" | "wrong" | null>(null);
  const [mcSelectedIndex, setMcSelectedIndex] = useState<number | null>(null);
  const [reverseOutcome, setReverseOutcome] = useState<"correct" | "wrong" | null>(null);
  const [reverseSelectedIndex, setReverseSelectedIndex] = useState<number | null>(null);
  const [mcAnswerPool, setMcAnswerPool] = useState<string[]>([]);
  const [mcReviewedPool, setMcReviewedPool] = useState<string[]>([]);
  const [mcAnswerPoolKey, setMcAnswerPoolKey] = useState<string | null>(null);
  const [reverseFrontPool, setReverseFrontPool] = useState<string[]>([]);
  const [reverseFrontPoolKey, setReverseFrontPoolKey] = useState<string | null>(null);
  const [reviewRef, setReviewRef] = useState<DeckRef | null>(null);
  const [current, setCurrent] = useState<NextCard | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewOverview, setReviewOverview] = useState<DeckOverview | null>(null);
  const [deckOverviews, setDeckOverviews] = useState<Record<string, DeckOverview>>({});
  const [deckCompletionMilestone, setDeckCompletionMilestone] = useState<{
    libraryId: string;
    deckId: number;
    deckName: string;
    total: number;
    coins: number;
    completedAt: number;
  } | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [reviewDeckConfig, setReviewDeckConfig] = useState<DeckConfig | null>(null);

  const activeHiddenNorm = useMemo<Set<string>>(() => {
    const labels = reviewDeckConfig?.hiddenFieldLabels ?? [];
    return new Set<string>(labels.map(normalizeLabel));
  }, [reviewDeckConfig]);

  const activePinnedNorm = useMemo<string[]>(() => {
    const labels = reviewDeckConfig?.pinnedBackFieldLabels ?? [];
    return labels.map(normalizeLabel);
  }, [reviewDeckConfig]);

  // ── Match answer-style state ─────────────────────────────────────────────
  const [matchPool, setMatchPool] = useState<MatchItem[]>([]);
  const [matchPoolKey, setMatchPoolKey] = useState<string | null>(null);
  const [matchItems, setMatchItems] = useState<MatchItem[]>([]);
  const [matchRightOrder, setMatchRightOrder] = useState<number[]>([]);
  const [matchOutcome, setMatchOutcome] = useState<"correct" | "wrong" | null>(null);
  // matchAssigned[wordSlot] = bottom-answer-index or null (sequential assignment)
  const [matchAssigned, setMatchAssigned] = useState<(number | null)[]>([]);
  const [matchSubmitted, setMatchSubmitted] = useState(false);
  // matchCardResults[slot] = true if that slot was correctly matched (set on submit)
  const [matchCardResults, setMatchCardResults] = useState<boolean[]>([]);
  const [matchCardPreview, setMatchCardPreview] = useState<{ item: MatchItem; card: CardEntity } | null>(null);
  const [learnedCardsModal, setLearnedCardsModal] = useState<LearnedCardsModalState | null>(null);

  // Prevent double autoplay from re-renders; reset when the card appearance changes.
  const lastAutoPlayedCardAppearanceTokenRef = useRef<number | null>(null);

  // Reverse: autoplay once when user reveals (showAnswer becomes true).
  const lastReverseRevealAutoPlayedCardAppearanceTokenRef = useRef<number | null>(null);

  // The per-card style is chosen in an effect; keep the chosen value in a ref so
  // other effects (like autoplay) can avoid running with stale style state.
  const chosenAnswerStyleForCardIdRef = useRef<
    { cardId: number; style: ReviewAnswerStyle } | null
  >(null);

  // Prevent slow/stale async updates when rapidly advancing cards.
  const loadNextSeqRef = useRef(0);
  const lastOverviewRefreshAtRef = useRef(0);

  // Randomize per-card answer style (50/50) when a new card is shown.

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
        setLastSyncAt(state.lastSyncAt ?? null);
        setLastPushAtLocal(() => {
          const raw = (state as { lastPushAtLocal?: unknown }).lastPushAtLocal;
          const n = typeof raw === "number" ? raw : Number(raw);
          return Number.isFinite(n) && n > 0 ? n : null;
        });
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        const data: unknown = await res.json().catch(() => null);
        const user = (() => {
          if (!data || typeof data !== "object") return null;
          if (!("user" in data)) return null;
          const raw = (data as { user?: unknown }).user;
          if (raw == null) return null;
          if (!raw || typeof raw !== "object") return null;
          const username = (raw as { username?: unknown }).username;
          if (typeof username !== "string" || !username.trim()) return null;
          return { username };
        })();
        if (!cancelled) setAuthUser(user);
      } catch {
        if (!cancelled) setAuthUser(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const uiLibraries = useMemo(() => {
    if (authUser) {
      return libraries.filter((l) => (l as { source?: unknown }).source !== "guest");
    }
    return libraries;
  }, [authUser, libraries]);


  const {
    uploadLibraryDeckDataToCloudNow,
    deleteLibraryFromCloudNow,
    onLogout,
    onDevPurgeOtherUsers,
    onDevResetMyCloud,
    onDevDebugLocalProgress,
    onDevDebugCloudProgress,
    onPickFile,
    onLoadDemoDecks,
    onSyncFromCloud,
    onClearSaved,
    onReimportApkg,
  } = useCloudSync({
    libraries,
    uiLibraries,
    activeLibraryId,
    lastSyncAt,
    lastPushAtLocal,
    authUser,
    devPurgeEnabled,
    reviewRef,
    setError,
    setBusy,
    setSyncBusy,
    setSyncProgress,
    setLastSyncAt,
    setLastPushAtLocal,
    setLibraries,
    setActiveLibraryId,
    setMode,
    setShowAnswer,
    setReviewRef,
    setCurrent,
    setReviewOverview,
    setReviewDeckConfig,
    setDeckOverviews,
  });

  const activeLibrary = useMemo(() => {
    if (uiLibraries.length === 0) return null;
    const found = uiLibraries.find((l) => l.id === activeLibraryId);
    return found ?? uiLibraries[0] ?? null;
  }, [uiLibraries, activeLibraryId]);

  const activeNamespace = activeLibrary?.id ?? "default";
  const activeDeck = activeLibrary?.deck ?? null;
  const selectedDeckId = activeLibrary?.selectedDeckId ?? null;

  const selectedDeckName = useMemo(() => {
    if (!activeDeck || selectedDeckId == null) return null;
    return activeDeck.decks.find((d) => d.id === selectedDeckId)?.name ?? null;
  }, [activeDeck, selectedDeckId]);

  const [openDeckMenu, setOpenDeckMenu] = useState<
    { libraryId: string; deckId: number } | null
  >(null);
  const [editingDeck, setEditingDeck] = useState<
    { libraryId: string; deckId: number; value: string } | null
  >(null);
  const [limitsModal, setLimitsModal] = useState<LimitsModalState | null>(null);
  const [cardTypesModal, setCardTypesModal] = useState<CardTypesModalState | null>(null);
  const [fieldConfigModal, setFieldConfigModal] = useState<FieldConfigModalState | null>(null);
  const [showCountersInfo, setShowCountersInfo] = useState(false);

  async function getDeckFieldNames(libraryId: string, deckId: number): Promise<string[]> {
    const db = getStudyDb();
    const cards = await db.cards.where("[libraryId+deckId]").equals([libraryId, deckId]).toArray();
    const seen = new Set<string>();
    for (const card of cards) {
      for (const name of card.fieldNames) {
        if (name) seen.add(name);
      }
    }
    return [...seen];
  }

  const {
    commitNewPerDay,
    commitReviewsPerDay,
    commitCardInfoDefaultOpen,
    commitDeckEaseFactor,
    commitDeckAnswerStyles,
    commitDeckWriteLanguage,
    commitDeckHiddenFieldLabels,
    commitDeckPinnedBackFieldLabels,
  } = useDeckConfigActions({ reviewRef, setDeckOverviews, setReviewOverview, setReviewDeckConfig });

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

    // Persist rename in StudyDB.
    void (async () => {
      try {
        const now = Date.now();
        const db = getStudyDb();
        const updated = await db.decks.update([libraryId, deckId], {
          name: trimmed,
          updatedAt: now,
        });
        if (updated === 0) {
          await db.decks.put({
            libraryId,
            deckId,
            name: trimmed,
            newPerDay: DEFAULT_DECK_CONFIG.newPerDay,
            reviewsPerDay: DEFAULT_DECK_CONFIG.reviewsPerDay,
            cardInfoOpenByDefault: DEFAULT_DECK_CONFIG.cardInfoOpenByDefault,
            answerStyles: DEFAULT_DECK_CONFIG.answerStyles,
            writeLanguage: DEFAULT_DECK_CONFIG.writeLanguage,
            createdAt: now,
            updatedAt: now,
          });
        }

      } catch {
        setError("Renamed locally, but failed to save the rename.");
      }
    })();
  }

  async function deleteDeck(libraryId: string, deckId: number) {
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

    const remainingDecks = lib.deck.decks.filter((d) => !toDeleteIds.has(d.id));

    setError(null);
    setBusy(true);
    try {
      const ids = Array.from(toDeleteIds);
      const db = getStudyDb();

      // Delete all study DB rows tied to these deckIds.
      await db.transaction("rw", db.decks, db.cards, db.cardStates, db.reviewLogs, async () => {
        // Cards + states
        const cardKeysToDelete: Array<[string, number]> = [];
        for (const id of ids) {
          const cards = await db.cards
            .where("[libraryId+deckId]")
            .equals([libraryId, id])
            .toArray();

          for (const c of cards) {
            cardKeysToDelete.push([libraryId, c.cardId]);
          }
        }

        if (cardKeysToDelete.length > 0) {
          await Promise.all([
            db.cardStates.bulkDelete(cardKeysToDelete),
            db.cards.bulkDelete(cardKeysToDelete),
          ]);
        }

        // Review logs (primary key is auto-incremented numeric id)
        for (const id of ids) {
          const logs = await db.reviewLogs
            .where("[libraryId+deckId+ts]")
            .between(
              [libraryId, id, 0],
              [libraryId, id, Number.MAX_SAFE_INTEGER],
              true,
              true
            )
            .toArray();
          const logIds = logs
            .map((l) => l.id)
            .filter((x): x is number => typeof x === "number");
          if (logIds.length > 0) {
            await db.reviewLogs.bulkDelete(logIds);
          }
        }

        // Deck rows
        await db.decks.bulkDelete(ids.map((id) => [libraryId, id] as [string, number]));
      });

      // If the currently open review deck got deleted, exit review to avoid inconsistent state.
      if (reviewRef && reviewRef.libraryId === libraryId && toDeleteIds.has(reviewRef.deckId)) {
        setMode("import");
        setShowAnswer(false);
        setReviewRef(null);
        setCurrent(null);
        setReviewOverview(null);
      }

      // Update UI + persisted state.
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

      // Remove cached overviews for deleted decks.
      setDeckOverviews((prev) => {
        const next = { ...prev };
        for (const id of toDeleteIds) {
          delete next[`${libraryId}:${id}`];
        }
        return next;
      });

      if (!LOCAL_ONLY_MODE) {
        // Best-effort: reflect deletes in cloud.
        try {
          for (const id of Array.from(toDeleteIds)) {
            const res = await fetchWithTimeout(
              "/api/sync/progress/reset",
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ libraryId, deckId: id }),
              },
              30_000,
              "Cloud reset"
            );
            if (res.status !== 401 && !res.ok) throw new Error("Cloud reset failed");
          }

          if (remainingDecks.length === 0) {
            await deleteLibraryFromCloudNow(libraryId);
          } else {
            // Upload updated deck data (deck list + cards) so other devices stop seeing deleted decks.
            await uploadLibraryDeckDataToCloudNow({ libraryId, libraryName: lib.name });
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Cloud update failed";
          setError(`Deleted locally, but failed to update cloud. (${msg})`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to delete deck";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  const onResetDeckProgress = useCallback(
    async (args: { libraryId: string; deckId: number; deckName: string }) => {
      const { libraryId, deckId, deckName } = args;
      const ok = confirm(
        `Reset progress for “${deckName}”?\n\nThis will clear scheduling and review history for this deck.`
      );
      if (!ok) return;

      setError(null);
      setBusy(true);
      try {
        await resetDeckProgress({ libraryId, deckId });

        const ov = await getDeckOverview({ libraryId, deckId });
        setDeckOverviews((prev) => ({ ...prev, [`${libraryId}:${deckId}`]: ov }));

        if (reviewRef?.libraryId === libraryId && reviewRef.deckId === deckId) {
          // Exit review to avoid inconsistent state.
          setMode("import");
          setShowAnswer(false);
          setReviewRef(null);
          setCurrent(null);
          setReviewOverview(null);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to reset progress";
        setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [reviewRef]
  );

  async function loadNext(ref: DeckRef, excludeCardId?: number) {
    // Show the next card ASAP; refresh overview in the background.
    const seq = (loadNextSeqRef.current += 1);
    const key = `${ref.libraryId}:${ref.deckId}`;

    let next = await getNextCard(ref, {
      learnAheadMs: 60 * 60 * 1000,
      learnAheadMode: "learn+relearn",
      excludeCardId,
    });

    // If nothing was found while excluding the just-answered card, retry without
    // the exclusion — it may be the only card available (single learn/relearn card
    // due soon). The exclude is a soft preference, not a hard rule.
    if (next == null && excludeCardId != null) {
      if (loadNextSeqRef.current !== seq) return;
      next = await getNextCard(ref, {
        learnAheadMs: 60 * 60 * 1000,
        learnAheadMode: "learn+relearn",
      });
    }

    if (loadNextSeqRef.current !== seq) return;
    setCurrent(next);
    setShowAnswer(false);
    if (next) setCardAppearanceToken((t) => t + 1);

    // Avoid heavy overview scans on every card; it can stall the UI.
    // Refresh occasionally (and always when we run out of cards).
    const now = Date.now();
    const shouldRefreshOverview = next == null || now - lastOverviewRefreshAtRef.current > 1500;
    if (!shouldRefreshOverview) return;
    lastOverviewRefreshAtRef.current = now;

    void getDeckOverview(ref)
      .then((ov) => {
        if (loadNextSeqRef.current !== seq) return;
        setReviewOverview(ov);
        setDeckOverviews((prev) => ({ ...prev, [key]: ov }));
      })
      .catch(() => {
        // Ignore: overview is best-effort UI state.
      });
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
    const ts = reviewOverview?.nextAvailableTs ?? reviewOverview?.nextDueTs ?? null;
    if (ts == null) return;

    const MAX_TIMEOUT_MS = 2_147_483_647; // setTimeout max (~24.8 days)
    const delayMs = Math.min(MAX_TIMEOUT_MS, Math.max(250, ts - Date.now()));
    const id = window.setTimeout(() => {
      void loadNext(reviewRef);
    }, delayMs);

    return () => window.clearTimeout(id);
  }, [mode, reviewRef, current, reviewOverview?.nextAvailableTs, reviewOverview?.nextDueTs]);

  async function beginReview(libraryId: string, deckId: number) {
    if (syncBusy) return;
    setError(null);
    setReviewBusy(true);

    const ref: DeckRef = { libraryId, deckId };
    try {
      const db = getStudyDb();
      const cardsCount = await db.cards.where("[libraryId+deckId]").equals([libraryId, deckId]).count();
      if (cardsCount === 0) {
        setError("That deck has no cards.");
        return;
      }

      const cfg = await getDeckConfig(ref);
      setReviewDeckConfig(cfg);

      // Derive pinnedNorm directly from cfg — avoids the stale activePinnedNorm
      // closure that would still reflect the previous render's reviewDeckConfig.
      const cfgPinnedNorm = (cfg.pinnedBackFieldLabels ?? [])
        .map(normalizeLabel)
        .filter(Boolean);

      const mcEnabled = cfg.answerStyles.includes("multiple-choice");
      if (mcEnabled) {
        try {
          const { all, reviewed } = await preloadMcAnswerPool(ref, cfgPinnedNorm);
          setMcAnswerPool(all);
          setMcReviewedPool(reviewed);
          setMcAnswerPoolKey(`${ref.libraryId}:${ref.deckId}`);
        } catch {
          setMcAnswerPool([]);
          setMcReviewedPool([]);
          setMcAnswerPoolKey(null);
        }
      } else {
        setMcAnswerPool([]);
        setMcReviewedPool([]);
        setMcAnswerPoolKey(null);
      }

      const reverseEnabled = cfg.answerStyles.includes("reverse");
      if (reverseEnabled) {
        try {
          const pool = await preloadReverseFrontPool(ref);
          setReverseFrontPool(pool);
          setReverseFrontPoolKey(`${ref.libraryId}:${ref.deckId}`);
        } catch {
          setReverseFrontPool([]);
          setReverseFrontPoolKey(null);
        }
      } else {
        setReverseFrontPool([]);
        setReverseFrontPoolKey(null);
      }

      if (cfg.answerStyles.includes("match")) {
        try {
          const pool = await preloadMatchPool(ref, cfgPinnedNorm);
          setMatchPool(pool);
          setMatchPoolKey(`${ref.libraryId}:${ref.deckId}`);
        } catch {
          setMatchPool([]);
          setMatchPoolKey(null);
        }
      } else {
        setMatchPool([]);
        setMatchPoolKey(null);
      }

      setReviewRef(ref);
      setMode("review");

      // Show the first card ASAP. `startStudySession` can be expensive (it scans
      // card states to unbury), so run it in the background.
      await loadNext(ref);
      window.setTimeout(() => {
        void startStudySession(ref).catch(() => {
          // Best-effort cleanup; ignore failures.
        });
      }, 0);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error starting review";
      setError(msg);
    } finally {
      setReviewBusy(false);
    }
  }

  function startReviewFor(libraryId: string, deckId: number) {
    if (syncBusy) return;
    const lib = libraries.find((l) => l.id === libraryId) ?? null;
    if (!lib) return;

    setActiveLibraryId(libraryId);
    updateLibrary(libraryId, (item) => ({ ...item, selectedDeckId: deckId }));
    void beginReview(libraryId, deckId);
  }


  function deckCompletionStorageKey(ref: DeckRef) {
    return `caliche:deck-completion:${ref.libraryId}:${ref.deckId}`;
  }

  function deckCompletionRewardCoins(total: number) {
    if (total >= 500) return 300;
    if (total >= 100) return 150;
    return 50;
  }

  function deckCompletionDeckName(ref: DeckRef) {
    const lib = libraries.find((item) => item.id === ref.libraryId);
    return lib?.deck.decks.find((deck) => deck.id === ref.deckId)?.name ?? "Deck";
  }

  async function refreshDeckCompletionMilestone(ref: DeckRef, beforeOverview: DeckOverview | null) {
    let afterOverview: DeckOverview;
    try {
      afterOverview = await getDeckOverview(ref);
    } catch {
      return;
    }

    setReviewOverview(afterOverview);
    setDeckOverviews((prev) => ({ ...prev, [`${ref.libraryId}:${ref.deckId}`]: afterOverview }));

    const total = afterOverview.total;
    const justCompleted = Boolean(
      beforeOverview &&
        beforeOverview.total > 0 &&
        beforeOverview.reviewed < beforeOverview.total &&
        total > 0 &&
        afterOverview.reviewed >= total
    );
    if (!justCompleted) return;

    const key = deckCompletionStorageKey(ref);
    if (typeof window !== "undefined" && window.localStorage.getItem(key)) return;

    const coins = deckCompletionRewardCoins(total);
    const coinAwardResult = awardAuraForgeDeckCompletionCoins(key, coins);
    setCoinBalance(coinAwardResult.nextBalance);

    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        key,
        JSON.stringify({ libraryId: ref.libraryId, deckId: ref.deckId, total, coins, completedAt: Date.now() })
      );
    }

    setDeckCompletionMilestone({
      libraryId: ref.libraryId,
      deckId: ref.deckId,
      deckName: deckCompletionDeckName(ref),
      total,
      coins,
      completedAt: Date.now(),
    });
  }

  async function onAnswer(result: "fail" | "pass") {
    if (!reviewRef || !current) return;
    setReviewBusy(true);
    const beforeCompletionOverview = await getDeckOverview(reviewRef).catch(() => null);
    try {
      if (
        reviewAnswerStyle === "match" &&
        matchItems.length > 0 &&
        matchCardResults.length === matchItems.length
      ) {
        // Score every card shown in the match game with its individual result.
        for (let i = 0; i < matchItems.length; i++) {
          const item = matchItems[i]!;
          const cardResult: "pass" | "fail" = matchCardResults[i] ? "pass" : "fail";
          await answerCard(reviewRef, item.cardId, cardResult);
        }
        await loadNext(reviewRef, current.card.cardId);
        await refreshDeckCompletionMilestone(reviewRef, beforeCompletionOverview);
      } else {
        const answeredId = current.card.cardId;
        await answerCard(reviewRef, answeredId, result);
        await loadNext(reviewRef, answeredId);
        await refreshDeckCompletionMilestone(reviewRef, beforeCompletionOverview);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error saving answer";
      setError(msg);
    } finally {
      setReviewBusy(false);
    }
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

  const writeExpected = useMemo(() => {
    if (!current) return null;
    return pickWriteTargetFromCard({
      frontHtml: current.card.frontHtml,
      backHtml: current.card.backHtml,
      fieldsHtml: current.card.fieldsHtml,
      fieldNames: current.card.fieldNames,
    });
  }, [current]);

  const writeExpectedChars = useMemo(() => {
    if (!writeExpected) return [];
    return toWriteChars(writeExpected);
  }, [writeExpected]);

  const mcCorrectAnswer = useMemo(() => {
    if (!current) return null;
    return extractMultipleChoiceAnswerFromCard({
      frontHtml: current.card.frontHtml,
      backHtml: current.card.backHtml,
      fieldsHtml: current.card.fieldsHtml,
      fieldNames: current.card.fieldNames,
    }, activePinnedNorm);
  }, [current, activePinnedNorm]);

  const mcDecoysForCard = useMemo(() => {
    if (!mcCorrectAnswer) return [];
    const wantsKey = reviewRef ? `${reviewRef.libraryId}:${reviewRef.deckId}` : null;
    if (mcAnswerPoolKey !== wantsKey) return [];
    const correctKey = normalizeChoiceText(mcCorrectAnswer);
    return mcAnswerPool.filter((x) => normalizeChoiceText(x) !== correctKey);
  }, [mcAnswerPool, mcCorrectAnswer, mcAnswerPoolKey, reviewRef]);

  const mcOptions = useMemo(() => {
    if (!currentId) return [];
    if (!mcCorrectAnswer) return [];

    const seed = `${currentId}:${normalizeChoiceText(mcCorrectAnswer)}`;
    const correctKey = normalizeChoiceText(mcCorrectAnswer);

    // Pick 1–2 from reviewed cards (harder distractors)
    const reviewedDecoys = seededShuffle(
      mcReviewedPool.filter((x) => normalizeChoiceText(x) !== correctKey),
      `${seed}:reviewed`
    );
    const nReviewed = reviewedDecoys.length === 0 ? 0 : 1 + Math.floor(Math.random() * Math.min(2, reviewedDecoys.length));
    const pickedReviewed = reviewedDecoys.slice(0, nReviewed);
    const pickedReviewedKeys = new Set(pickedReviewed.map((x) => normalizeChoiceText(x)));

    // Fill remaining slots to always reach 3 decoys total
    const fillPool = seededShuffle(
      mcDecoysForCard.filter((x) => !pickedReviewedKeys.has(normalizeChoiceText(x))),
      `${seed}:fill`
    );
    const pickedDecoys = [...pickedReviewed, ...fillPool.slice(0, 3 - pickedReviewed.length)];

    const uniq: Array<{ label: string; key: string }> = [];
    const seen = new Set<string>();
    const add = (label: string) => {
      const key = normalizeChoiceText(label);
      if (!key || seen.has(key)) return;
      seen.add(key);
      uniq.push({ label, key });
    };

    add(mcCorrectAnswer);
    for (const d of pickedDecoys) add(d);

    if (uniq.length < 2) return [];

    const shuffled = seededShuffle(uniq, `${seed}:options`);
    return shuffled.map((o) => ({
      label: o.label,
      isCorrect: o.key === correctKey,
    }));
  }, [currentId, mcCorrectAnswer, mcDecoysForCard, mcReviewedPool]);

  const answerFieldSections = useMemo(() => {
    if (!current) return [];
    return inferFieldSectionsForHtml({
      html: current.card.backHtml,
      fieldsHtml: current.card.fieldsHtml,
      fieldNames: current.card.fieldNames,
      hiddenNorm: activeHiddenNorm,
    });
  }, [current, activeHiddenNorm]);

  const pinnedBackSections = useMemo(() => {
    if (!current) return [];
    return pickFieldSectionsByLabel({
      fieldsHtml: current.card.fieldsHtml,
      fieldNames: current.card.fieldNames,
      labelNormalizedInOrder: activePinnedNorm,
    });
  }, [current, activePinnedNorm]);

  const reversePromptHtml = useMemo(() => {
    if (!current) return null;

    // Prefer the first pinned field (Definitions 1, etc). Otherwise, use the
    // first inferred back section; else fallback to raw backHtml.
    const pinnedFirst = pinnedBackSections[0]?.valueHtml ?? null;
    const inferredFirst = answerFieldSections[0]?.valueHtml ?? null;
    const raw = pinnedFirst ?? inferredFirst ?? current.card.backHtml;
    const s = String(raw ?? "");
    return s.trim() ? s : null;
  }, [current, pinnedBackSections, answerFieldSections]);

  const reverseCorrectFront = useMemo(() => {
    if (!current) return null;
    return extractReverseChoiceFromFrontHtml(current.card.frontHtml);
  }, [current]);

  const reverseDecoysForCard = useMemo(() => {
    if (!reverseCorrectFront) return [];
    const wantsKey = reviewRef ? `${reviewRef.libraryId}:${reviewRef.deckId}` : null;
    if (reverseFrontPoolKey !== wantsKey) return [];
    const correctKey = normalizeChoiceText(reverseCorrectFront);
    return reverseFrontPool.filter((x) => normalizeChoiceText(x) !== correctKey);
  }, [reverseCorrectFront, reverseFrontPool, reverseFrontPoolKey, reviewRef]);

  const reverseOptions = useMemo(() => {
    if (!currentId) return [];
    if (!reverseCorrectFront) return [];
    if (!reversePromptHtml) return [];

    const seed = `${currentId}:${normalizeChoiceText(reverseCorrectFront)}`;

    // Partition into confusable (share ≥1 word with correct) vs other,
    // using a seeded shuffle only to distribute ties consistently within each group.
    const correctWords = new Set(
      normalizeChoiceText(reverseCorrectFront)
        .split(/\s+/)
        .filter((w) => w.length >= 2)
    );
    const confusable: string[] = [];
    const other: string[] = [];
    for (const d of seededShuffle(reverseDecoysForCard, `${seed}:decoys`)) {
      const dWords = normalizeChoiceText(d).split(/\s+/);
      const overlaps = dWords.some((w) => w.length >= 2 && correctWords.has(w));
      if (overlaps) confusable.push(d);
      else other.push(d);
    }

    // Pick randomly from each group every time the card is shown so distractors
    // vary across reviews. Take up to 3 from confusable first, fill with other.
    const randShuffle = <T,>(arr: T[]): T[] => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    };
    const pickedDecoys = [...randShuffle(confusable), ...randShuffle(other)].slice(0, 3);

    const correctKey = normalizeChoiceText(reverseCorrectFront);
    const uniq: Array<{ label: string; key: string }> = [];
    const seen = new Set<string>();
    const add = (label: string) => {
      const key = normalizeChoiceText(label);
      if (!key) return;
      if (seen.has(key)) return;
      seen.add(key);
      uniq.push({ label: capitalizeFirstLetter(label), key });
    };

    add(reverseCorrectFront);
    for (const d of pickedDecoys) add(d);

    if (uniq.length < 2) return [];

    const shuffled = seededShuffle(uniq, `${seed}:options`);
    return shuffled.map((o) => ({
      label: o.label,
      isCorrect: o.key === correctKey,
    }));
  }, [currentId, reverseCorrectFront, reverseDecoysForCard, reversePromptHtml]);

  const writeBank = useMemo(() => {
    if (writeExpectedChars.length === 0) return [];
    const seed = `${currentId ?? ""}:${writeExpectedChars.join("")}`;

    // Add extra "noise" letters so the answer isn't trivial.
    const extraCount = Math.min(10, Math.max(4, Math.ceil(writeExpectedChars.length * 0.75)));

    const expectedSet = new Set(
      writeExpectedChars
        .map((c) => c.normalize("NFKC").toLowerCase())
        .filter(Boolean)
    );

    const baseAlphabet = Array.from("abcdefghijklmnopqrstuvwxyz");
    const writeLanguage: DeckConfig["writeLanguage"] =
      reviewDeckConfig?.writeLanguage ?? DEFAULT_DECK_CONFIG.writeLanguage;
    const extrasAlphabet =
      writeLanguage === "fr"
        ? Array.from("àâäæçéèêëîïôœùûüÿ")
        : writeLanguage === "es"
          ? Array.from("áéíóúüñ")
          : [];
    const poolLower = baseAlphabet.concat(extrasAlphabet);

    const wantsUpper = writeExpectedChars.length > 0 && writeExpectedChars.every((c) => c === c.toUpperCase());
    const pool = poolLower
      .filter((c) => !expectedSet.has(c.normalize("NFKC").toLowerCase()))
      .map((c) => (wantsUpper ? c.toUpperCase() : c));

    let decoys: string[] = [];
    if (pool.length > 0) {
      // If we need more than pool size, repeat with different seeds.
      let remaining = extraCount;
      let round = 0;
      while (remaining > 0) {
        const batch = seededShuffle(pool, `${seed}:decoys:${round}`);
        decoys = decoys.concat(batch.slice(0, remaining));
        remaining -= Math.min(remaining, batch.length);
        round += 1;
        if (round > 5) break;
      }
    }

    const all = writeExpectedChars.concat(decoys);
    const shuffled = seededShuffle(all, `${seed}:bank`);

    // Avoid the trivial "not scrambled" case when possible.
    const same = shuffled.length === writeExpectedChars.length && shuffled.every((ch, i) => ch === writeExpectedChars[i]);
    return same ? seededShuffle(all, `${seed}:bank:alt`) : shuffled;
  }, [currentId, writeExpectedChars, reviewDeckConfig?.writeLanguage]);

  const writeUsed = useMemo(() => {
    return new Set(writePicked.map((p) => p.index));
  }, [writePicked]);

  const writeIsAvailable = reviewAnswerStyle === "write" && writeExpectedChars.length > 0;
  const mcCanRun = Boolean(mcCorrectAnswer) && mcDecoysForCard.length > 0;
  const reverseCanRun = Boolean(reversePromptHtml) && Boolean(reverseCorrectFront) && reverseDecoysForCard.length > 0;


  useEffect(() => {
    if (mode !== "review") return;
    if (currentId == null) return;

    const rand01 = () => {
      try {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return (buf[0] ?? 0) / 4294967296;
      } catch {
        return Math.random();
      }
    };

    const enabledStyles: ReviewAnswerStyle[] =
      reviewDeckConfig?.answerStyles?.length
        ? reviewDeckConfig.answerStyles
        : ["normal", "write", "multiple-choice", "reverse", "match"];

    const canWrite = writeExpectedChars.length > 0;
    const canMc = Boolean(mcCorrectAnswer) && mcDecoysForCard.length > 0;
    const canReverse = Boolean(reversePromptHtml) && Boolean(reverseCorrectFront) && reverseDecoysForCard.length > 0;
    const canMatch =
      current?.state.state !== "new" &&
      Boolean(mcCorrectAnswer) &&
      matchPoolKey === `${reviewRef?.libraryId}:${reviewRef?.deckId}` &&
      matchPool.filter((p) => p.cardId !== current?.card.cardId).length >= 1;

    // Build a weighted pool where every enabled style always occupies its fair
    // share of slots. Styles that can't run for this card collapse to "normal"
    // so that match never gets a higher-than-intended share just because
    // write/mc/reverse lack distractors for this specific card.
    const weightedPool: ReviewAnswerStyle[] = enabledStyles.map((s) => {
      if (s === "write") return canWrite ? "write" : "normal";
      if (s === "multiple-choice") return canMc ? "multiple-choice" : "normal";
      if (s === "reverse") return canReverse ? "reverse" : "normal";
      if (s === "match") return canMatch ? "match" : "normal";
      return "normal";
    });

    if (weightedPool.length === 0) weightedPool.push("normal");

    const idx = Math.min(weightedPool.length - 1, Math.floor(rand01() * weightedPool.length));
    const chosen = weightedPool[idx] ?? "normal";

    chosenAnswerStyleForCardIdRef.current = { cardId: currentId, style: chosen };
    setReviewAnswerStyle(chosen);

    // Always start a new card unflipped.
    setShowAnswer(false);
  }, [
    mode,
    currentId,
    reviewDeckConfig?.answerStyles,
    writeExpectedChars.length,
    mcCorrectAnswer,
    mcDecoysForCard.length,
    reversePromptHtml,
    reverseCorrectFront,
    reverseDecoysForCard.length,
    current?.state.state,
    current?.card.cardId,
    matchPool,
    matchPoolKey,
    reviewRef?.libraryId,
    reviewRef?.deckId,
  ]);

  useEffect(() => {
    // Reset all answer-style state when the card or style changes.
    setWritePicked([]);
    setWriteOutcome(null);
    writeDragRef.current = null;
    setWriteDrag(null);
    setMcOutcome(null);
    setMcSelectedIndex(null);
    setReverseOutcome(null);
    setReverseSelectedIndex(null);
    setMatchItems([]);
    setMatchRightOrder([]);
    setMatchOutcome(null);
    setMatchAssigned([]);
    setMatchSubmitted(false);
    setMatchCardResults([]);
    setMatchCardPreview(null);
  }, [currentId, reviewAnswerStyle, cardAppearanceToken]);

  // Build the per-card match game when style is "match".
  useEffect(() => {
    if (mode !== "review") return;
    if (reviewAnswerStyle !== "match") return;
    if (!current || !mcCorrectAnswer || !reviewRef) return;
    const wantsKey = `${reviewRef.libraryId}:${reviewRef.deckId}`;
    if (matchPoolKey !== wantsKey) return;

    const currentFront = htmlToText(current.card.frontHtml).replace(/\[sound:[^\]]+\]/gi, "").trim();
    const currentBack = mcCorrectAnswer;
    const currentSoundMatch =
      /\[sound:([^\]]+)\]/i.exec(current.card.backHtml) ??
      /\[sound:([^\]]+)\]/i.exec(current.card.frontHtml);
    const currentItem: MatchItem = {
      cardId: current.card.cardId,
      front: currentFront,
      back: currentBack,
      soundFile: currentSoundMatch?.[1]?.trim() ?? undefined,
    };

    const seed = `${current.card.cardId}:match`;
    const currentBackKey = normalizeChoiceText(currentBack);
    const candidates = seededShuffle(
      matchPool.filter(
        (p) => p.cardId !== current.card.cardId && normalizeChoiceText(p.back) !== currentBackKey
      ),
      `${seed}:cands`
    );

    if (candidates.length === 0) return;

    // Pick a random count between 2 and min(10, total available)
    const maxCount = Math.min(10, 1 + candidates.length);
    const n = maxCount <= 2 ? 2 : 2 + Math.floor(Math.random() * (maxCount - 1));
    const distractors = candidates.slice(0, n - 1);

    const items: MatchItem[] = [currentItem, ...distractors];
    const rightOrder = seededShuffle(items.map((_, i) => i), `${seed}:right`);

    setMatchItems(items);
    setMatchRightOrder(rightOrder);
    setMatchAssigned(items.map(() => null));
    setMatchCardResults(items.map(() => false));
    setMatchSubmitted(false);
  }, [mode, reviewAnswerStyle, currentId, current, matchPool, matchPoolKey, reviewRef, mcCorrectAnswer]);

  useEffect(() => {
    if (mode !== "review") return;
    if (reviewAnswerStyle !== "write") return;
    if (!current) return;
    if (showAnswer) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Backspace") return;
      if (writePicked.length === 0) return;
      e.preventDefault();
      writeDragRef.current = null;
      setWriteDrag(null);
      setWritePicked((prev) => prev.slice(0, -1));
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, reviewAnswerStyle, currentId, current, showAnswer, writePicked.length]);

  // Drag-and-drop reordering for write mode picked letters.
  useEffect(() => {
    if (!writeDrag) return;

    const onMove = (e: PointerEvent) => {
      const cur = writeDragRef.current;
      if (!cur) return;
      const x = e.clientX;
      const y = e.clientY;

      const refs = writePickedRefs.current;
      let dropIdx = refs.length;
      let bestDist = Infinity;
      for (let i = 0; i < refs.length; i++) {
        const el = refs[i];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dist = Math.hypot(x - cx, y - cy);
        if (dist < bestDist) {
          bestDist = dist;
          dropIdx = x <= cx ? i : i + 1;
        }
      }

      const next = { ...cur, x, y, dropIdx };
      writeDragRef.current = next;
      setWriteDrag(next);
    };

    const onUp = () => {
      const cur = writeDragRef.current;
      if (!cur) return;
      const { fromIdx, dropIdx } = cur;
      setWritePicked((prev) => {
        if (dropIdx === fromIdx || dropIdx === fromIdx + 1) return prev;
        const moving = prev[fromIdx];
        const without = prev.filter((_, i) => i !== fromIdx);
        const adj = dropIdx > fromIdx ? dropIdx - 1 : dropIdx;
        return [...without.slice(0, adj), moving, ...without.slice(adj)];
      });
      writeDragRef.current = null;
      setWriteDrag(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writeDrag !== null]);

  // Write evaluation happens only on explicit Submit.

  const promotedSound = useMemo(() => {
    if (!current) return null;
    const fromFront = extractFirstSoundFilename(current.card.frontHtml);
    if (fromFront) return { filename: fromFront, source: "front" as const };
    const fromBack = extractFirstSoundFilename(current.card.backHtml);
    if (fromBack) return { filename: fromBack, source: "back" as const };
    return null;
  }, [current]);

  const isReverseAudioLocked = mode === "review" && reviewAnswerStyle === "reverse" && !showAnswer;

  const currentTimingTag = useMemo(() => {
    if (!current) return null;

    const isNew = current.state?.state === "new";
    if (isNew) {
      return { kind: "new" as const, label: "New", detail: null };
    }

    const due = typeof current.state?.due === "number" ? current.state.due : 0;
    if (!Number.isFinite(due)) return { kind: "due", label: "Due", detail: null };
    const isWaiting = due > nowTs;
    return {
      kind: isWaiting ? "waiting" : "due",
      label: isWaiting ? "Waiting" : "Due",
      detail: isWaiting ? `in ${formatIn(due, nowTs)}` : null,
    };
  }, [current, nowTs]);

  const answerFieldLabels = useMemo(() => {
    if (!current) return [];
    return inferFieldLabelsForHtml({
      html: current.card.backHtml,
      fieldsHtml: current.card.fieldsHtml,
      fieldNames: current.card.fieldNames,
      hiddenNorm: activeHiddenNorm,
    });
  }, [current, activeHiddenNorm]);

  const answerFieldLabelsWithoutPinned = useMemo(() => {
    if (answerFieldLabels.length === 0) return [];
    const pinned = new Set(activePinnedNorm);
    return answerFieldLabels.filter((l) => !pinned.has(normalizeLabel(l)));
  }, [answerFieldLabels, activePinnedNorm]);

  const pinnedBackSectionIndexes = useMemo(() => {
    return new Set(pinnedBackSections.map((s) => s.index));
  }, [pinnedBackSections]);

  const answerFieldSectionsWithoutPinned = useMemo(() => {
    if (pinnedBackSectionIndexes.size === 0) return answerFieldSections;
    return answerFieldSections.filter((sec) => !pinnedBackSectionIndexes.has(sec.index));
  }, [answerFieldSections, pinnedBackSectionIndexes]);

  const pinnedBackRender = useMemo(() => {
    const filename =
      promotedSound?.source === "back" ? promotedSound.filename : null;
    if (!filename) {
      return {
        didSuppressPromotedBackSound: false,
        sections: pinnedBackSections.map((s) => ({
          ...s,
          suppressFirstSoundFilename: null as string | null,
        })) as Array<
          {
            index: number;
            label: string;
            valueHtml: string;
            suppressFirstSoundFilename: string | null;
          }
        >,
      };
    }

    const re = new RegExp(`\\[sound:\\s*${escapeRegExp(filename)}\\s*\\]`, "i");
    let suppressed = false;

    const sections: Array<{
      index: number;
      label: string;
      valueHtml: string;
      suppressFirstSoundFilename: string | null;
    }> = pinnedBackSections.map((s) => {
      const contains = re.test(String(s.valueHtml ?? ""));
      const suppressFirstSoundFilename = !suppressed && contains ? filename : null;
      if (suppressFirstSoundFilename) suppressed = true;
      return { ...s, suppressFirstSoundFilename };
    });

    return { didSuppressPromotedBackSound: suppressed, sections };
  }, [pinnedBackSections, promotedSound?.filename, promotedSound?.source]);

  useEffect(() => {
    if (mode !== "review") return;
    if (currentId == null) return;
    const chosen = chosenAnswerStyleForCardIdRef.current;
    const effectiveStyle =
      chosen?.cardId === currentId ? chosen.style : reviewAnswerStyle;

    // Wait until state has caught up with the chosen style.
    if (effectiveStyle !== reviewAnswerStyle) return;
    if (effectiveStyle === "reverse") return;
    if (showAnswer) return;
    const filename = promotedSound?.filename;
    if (!filename) return;
    if (lastAutoPlayedCardAppearanceTokenRef.current === cardAppearanceToken) return;
    lastAutoPlayedCardAppearanceTokenRef.current = cardAppearanceToken;

    // Autoplay can be blocked by the browser; ignore failures.
    void (async () => {
      try {
        await tryPlayAudioFilename(activeNamespace, filename);
      } catch {
        // ignore
      }
    })();
  }, [mode, currentId, promotedSound?.filename, showAnswer, activeNamespace, reviewAnswerStyle, cardAppearanceToken]);

  useEffect(() => {
    if (mode !== "review") return;
    if (currentId == null) return;
    const chosen = chosenAnswerStyleForCardIdRef.current;
    const effectiveStyle =
      chosen?.cardId === currentId ? chosen.style : reviewAnswerStyle;

    // Wait until state has caught up with the chosen style.
    if (effectiveStyle !== reviewAnswerStyle) return;
    if (effectiveStyle !== "reverse") return;
    if (!showAnswer) return;
    const filename = promotedSound?.filename;
    if (!filename) return;
    if (lastReverseRevealAutoPlayedCardAppearanceTokenRef.current === cardAppearanceToken) return;
    lastReverseRevealAutoPlayedCardAppearanceTokenRef.current = cardAppearanceToken;

    // Autoplay can be blocked by the browser; ignore failures.
    void (async () => {
      try {
        await tryPlayAudioFilename(activeNamespace, filename);
      } catch {
        // ignore
      }
    })();
  }, [mode, currentId, promotedSound?.filename, showAnswer, activeNamespace, reviewAnswerStyle, cardAppearanceToken]);

  useEffect(() => {
    if (mode !== "review") {
      lastAutoPlayedCardAppearanceTokenRef.current = null;
      lastReverseRevealAutoPlayedCardAppearanceTokenRef.current = null;
      chosenAnswerStyleForCardIdRef.current = null;
    }
  }, [mode]);


  return (
    <div className="caliche-shell min-h-screen bg-background text-foreground">
      <div className="caliche-container mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-10 sm:py-12">
        <AppHeader
          authUser={authUser}
          devPurgeEnabled={devPurgeEnabled}
          syncBusy={syncBusy}
          syncProgress={syncProgress}
          busy={busy}
          hasLibraries={uiLibraries.length > 0}
          onSync={() => void onSyncFromCloud()}
          onLogout={onLogout}
          onClearSaved={onClearSaved}
          onDevDebugLocal={onDevDebugLocalProgress}
          onDevDebugCloud={onDevDebugCloudProgress}
          onDevResetCloud={onDevResetMyCloud}
          onDevPurgeOthers={onDevPurgeOtherUsers}
        />

        {error ? (
          <div className="caliche-alert rounded-2xl px-4 py-3 text-sm">
            {error}
          </div>
        ) : null}

        {deckCompletionMilestone ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="deck-completion-title"
          >
            {/* AURAFORGE_CELEBRATION_PATCH_V126: full-screen celebration; motion-safe classes respect prefers-reduced-motion. */}
            <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
              {[
                { icon: "🎉", left: "8%", top: "16%", delay: "0ms" },
                { icon: "✨", left: "18%", top: "72%", delay: "120ms" },
                { icon: "🏆", left: "78%", top: "18%", delay: "240ms" },
                { icon: "⭐", left: "88%", top: "68%", delay: "360ms" },
                { icon: "🎊", left: "48%", top: "10%", delay: "480ms" },
                { icon: "💫", left: "42%", top: "82%", delay: "600ms" },
              ].map((piece) => (
                <span
                  key={`${piece.icon}-${piece.left}-${piece.top}`}
                  className="absolute text-3xl motion-safe:animate-bounce sm:text-4xl"
                  style={{ left: piece.left, top: piece.top, animationDelay: piece.delay }}
                >
                  {piece.icon}
                </span>
              ))}
            </div>

            <div className="relative w-full max-w-lg rounded-3xl border border-amber-300/70 bg-white p-6 text-center text-slate-950 shadow-2xl dark:border-amber-400/40 dark:bg-slate-950 dark:text-slate-50">
              <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-4xl dark:bg-amber-950" aria-hidden="true">
                🏆
              </div>
              <div className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-700 dark:text-amber-300">
                Deck milestone reached
              </div>
              <h2 id="deck-completion-title" className="mt-2 text-2xl font-bold">
                Deck completed
              </h2>
              <p className="mt-3 text-sm text-slate-700 dark:text-slate-200">
                You reviewed all {deckCompletionMilestone.total} cards in “{deckCompletionMilestone.deckName}”.
              </p>
              <div className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-amber-950 dark:bg-amber-950/50 dark:text-amber-100" aria-live="polite">
                <div className="text-sm font-semibold">Reward: +{deckCompletionMilestone.coins} coins</div>
                <div className="mt-1 text-xs">Coin balance: {coinBalance.toLocaleString()}</div>
              </div>
              <button
                type="button"
                className="mt-5 rounded-full bg-amber-500 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-2 dark:focus:ring-offset-slate-950"
                onClick={() => setDeckCompletionMilestone(null)}
              >
                Continue studying
              </button>
            </div>
          </div>
        ) : null}

        {mode === "import" ? (
          <DeckList
            libraries={uiLibraries}
            deckOverviews={deckOverviews}
            activeLibraryId={activeLibraryId}
            openDeckMenu={openDeckMenu}
            setOpenDeckMenu={setOpenDeckMenu}
            editingDeck={editingDeck}
            setEditingDeck={setEditingDeck}
            syncBusy={syncBusy}
            busy={busy}
            fileInputRef={fileInputRef}
            onPickFile={(f) => void onPickFile(f)}
            onLoadDemoDecks={() => void onLoadDemoDecks()}
            onStartReview={startReviewFor}
            onRename={renameDeck}
            onResetProgress={onResetDeckProgress}
            onDelete={(lid, did) => void deleteDeck(lid, did)}
            onCardInfoToggle={(lid, did, open) => void commitCardInfoDefaultOpen(lid, did, open)}
            onWriteLanguageChange={(lid, did, lang) => void commitDeckWriteLanguage(lid, did, lang)}
            onGetFieldNames={getDeckFieldNames}
            onReimportApkg={(lid, file) => void onReimportApkg(lid, file)}
            setLimitsModal={setLimitsModal}
            setCardTypesModal={setCardTypesModal}
            setLearnedCardsModal={setLearnedCardsModal}
            setFieldConfigModal={setFieldConfigModal}
          />
        ) : null}

        {mode === "review" ? (
          <ReviewPanel
            currentMissingFields={currentMissingFields}
            selectedDeckName={selectedDeckName}
            reviewOverview={reviewOverview}
            nowTs={nowTs}
            current={current}
            currentId={currentId}
            showAnswer={showAnswer}
            setShowAnswer={setShowAnswer}
            reviewAnswerStyle={reviewAnswerStyle}
            reviewBusy={reviewBusy}
            reviewDeckConfig={reviewDeckConfig}
            activeHiddenNorm={activeHiddenNorm}
            activeNamespace={activeNamespace}
            reviewRef={reviewRef}
            nextDueLabels={nextDueLabels}
            currentTimingTag={currentTimingTag}
            promotedSound={promotedSound}
            isReverseAudioLocked={isReverseAudioLocked}
            writeIsAvailable={writeIsAvailable}
            writePicked={writePicked}
            setWritePicked={setWritePicked}
            writeDrag={writeDrag}
            setWriteDrag={setWriteDrag}
            writeDragRef={writeDragRef}
            writePickedRefs={writePickedRefs}
            writeOutcome={writeOutcome}
            setWriteOutcome={setWriteOutcome}
            writeBank={writeBank}
            writeUsed={writeUsed}
            writeExpectedChars={writeExpectedChars}
            mcOptions={mcOptions}
            mcOutcome={mcOutcome}
            mcSelectedIndex={mcSelectedIndex}
            setMcSelectedIndex={setMcSelectedIndex}
            setMcOutcome={setMcOutcome}
            mcCanRun={mcCanRun}
            reverseOptions={reverseOptions}
            reverseOutcome={reverseOutcome}
            reverseSelectedIndex={reverseSelectedIndex}
            setReverseSelectedIndex={setReverseSelectedIndex}
            setReverseOutcome={setReverseOutcome}
            reverseCanRun={reverseCanRun}
            reversePromptHtml={reversePromptHtml}
            matchItems={matchItems}
            matchRightOrder={matchRightOrder}
            matchAssigned={matchAssigned}
            setMatchAssigned={setMatchAssigned}
            matchSubmitted={matchSubmitted}
            setMatchSubmitted={setMatchSubmitted}
            matchOutcome={matchOutcome}
            setMatchOutcome={setMatchOutcome}
            matchCardResults={matchCardResults}
            setMatchCardResults={setMatchCardResults}
            setMatchCardPreview={setMatchCardPreview}
            pinnedBackRender={pinnedBackRender}
            pinnedBackSections={pinnedBackSections}
            answerFieldSectionsWithoutPinned={answerFieldSectionsWithoutPinned}
            answerFieldLabelsWithoutPinned={answerFieldLabelsWithoutPinned}
            onAnswer={onAnswer}
            onExit={() => {
              setMode("import");
              setShowAnswer(false);
              setReviewRef(null);
              setCurrent(null);
              setReviewOverview(null);
            }}
            onShowCountersInfo={() => setShowCountersInfo(true)}
          />
        ) : null}
      </div>

      <CardTypesModal
        modal={cardTypesModal}
        setModal={setCardTypesModal}
        onSave={(lid, did, styles) => void commitDeckAnswerStyles(lid, did, styles)}
      />

      <LimitsModal
        modal={limitsModal}
        setModal={setLimitsModal}
        onSave={(m) => {
          void commitNewPerDay(m.libraryId, m.deckId, m.newPerDay);
          void commitReviewsPerDay(m.libraryId, m.deckId, m.reviewsPerDay);
          void commitDeckEaseFactor(m.libraryId, m.deckId, m.easeFactor);
          const newFactor = Number(m.easeFactor);
          const oldFactor = Number(m.originalEaseFactor);
          if (newFactor !== oldFactor && Number.isFinite(newFactor) && Number.isFinite(oldFactor) && oldFactor > 0) {
            void (async () => {
              const db = getStudyDb();
              const reviewStates = await db.cardStates
                .where("[libraryId+deckId+state+due]")
                .between([m.libraryId, m.deckId, "review", -Infinity], [m.libraryId, m.deckId, "review", Infinity])
                .toArray();
              if (reviewStates.length === 0) return;
              const ok = confirm(
                `Tienes ${reviewStates.length} cards programadas con el factor anterior (${oldFactor}×).\n\n¿Quieres recalcular sus fechas con el nuevo factor (${newFactor}×)?`
              );
              if (!ok) return;
              const DAY_MS_L = 24 * 60 * 60 * 1000;
              const now = Date.now();
              const updated = reviewStates
                .filter((s) => s.intervalDays > 0)
                .map((s) => {
                  const newInterval = Math.max(1, Math.round(s.intervalDays * (newFactor / oldFactor)));
                  const base = s.lastReview ?? (s.due - s.intervalDays * DAY_MS_L);
                  const newDue = new Date(base + newInterval * DAY_MS_L);
                  newDue.setHours(0, 0, 0, 0);
                  return { ...s, intervalDays: newInterval, due: newDue.getTime(), updatedAt: now };
                });
              await db.cardStates.bulkPut(updated);
              const ov = await getDeckOverview({ libraryId: m.libraryId, deckId: m.deckId });
              setDeckOverviews((prev) => ({ ...prev, [`${m.libraryId}:${m.deckId}`]: ov }));
            })();
          }
        }}
      />

      <LearnedCardsModal
        modal={learnedCardsModal}
        setModal={setLearnedCardsModal}
        onPreviewCard={(item, card) => setMatchCardPreview({ item, card })}
      />

      <CardPreviewModal
        preview={matchCardPreview}
        onClose={() => setMatchCardPreview(null)}
        namespace={activeNamespace}
        learnedCardsLibraryId={learnedCardsModal?.libraryId}
        pinnedNorm={activePinnedNorm}
        hiddenNorm={activeHiddenNorm}
        cardInfoOpenByDefault={Boolean(reviewDeckConfig?.cardInfoOpenByDefault)}
      />

      <CountersInfoModal open={showCountersInfo} onClose={() => setShowCountersInfo(false)} />

      <FieldConfigModal
        modal={fieldConfigModal}
        setModal={setFieldConfigModal}
        onSaveHidden={(lid, did, next) => { void commitDeckHiddenFieldLabels(lid, did, next); }}
        onSavePinned={(lid, did, next) => { void commitDeckPinnedBackFieldLabels(lid, did, next); }}
      />
    </div>
  );
}

