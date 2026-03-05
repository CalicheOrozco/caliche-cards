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
import { clearMedia, getMediaBlob, saveMediaItems } from "../lib/mediaStorage";
import { clearApkg, getApkgFile, saveApkgFile } from "../lib/apkgStorage";
import type {
  CardStateEntity,
  DeckConfig,
  DeckRef,
  NextCard,
  ReviewAnswerStyle,
  ReviewLogEntity,
} from "../lib/studyTypes";
import {
  answerCard,
  getDeckConfig,
  getDeckOverview,
  getNextCard,
  resetDeckProgress,
  setDeckAnswerStyles,
  setDeckCardInfoOpenByDefault,
  setDeckNewPerDay,
  startStudySession,
  upsertImportedDeck,
  type DeckOverview,
} from "../lib/studyApi";
import { deleteStudyDb, getStudyDb } from "../lib/studyDb";
import { DEFAULT_DECK_CONFIG, scheduleAnswer } from "../lib/scheduler";

type Mode = "import" | "review";

type LocalReviewLogRow = Omit<ReviewLogEntity, "syncKey"> & { syncKey?: string };
type ReviewLogPushPayload = Omit<ReviewLogEntity, "id">;
type ProgressPullResponse = {
  ok: boolean;
  cardStates: CardStateEntity[];
  reviewLogs: ReviewLogPushPayload[];
  deckConfigs: Array<{
    libraryId: string;
    deckId: number;
    newPerDay: number;
    reviewsPerDay: number;
    cardInfoOpenByDefault?: boolean;
    updatedAt: number;
  }>;
};

function computeReviewLogSyncKey(log: {
  libraryId: string;
  deckId: number;
  cardId: number;
  noteId: number;
  ts: number;
  result: string;
  timeTakenMs?: number;
  prevState: string;
  nextState: string;
  prevDue: number;
  nextDue: number;
  prevIntervalDays: number;
  nextIntervalDays: number;
  prevStepIndex: number;
  nextStepIndex: number;
  prevReps: number;
  nextReps: number;
  prevLapses: number;
  nextLapses: number;
}): string {
  return [
    log.libraryId,
    log.deckId,
    log.cardId,
    log.noteId,
    log.ts,
    log.result,
    log.prevState,
    log.nextState,
    log.prevDue,
    log.nextDue,
    log.prevIntervalDays,
    log.nextIntervalDays,
    log.prevStepIndex,
    log.nextStepIndex,
    log.prevReps,
    log.nextReps,
    log.prevLapses,
    log.nextLapses,
    log.timeTakenMs ?? "",
  ].join("|");
}

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

function soundCandidatesFromFilename(raw: string): string[] {
  const trimmedRaw = String(raw ?? "").trim();
  if (!trimmedRaw) return [];

  let decoded: string | null = null;
  try {
    decoded = decodeURIComponent(trimmedRaw);
  } catch {
    decoded = null;
  }

  const plusAsSpace = trimmedRaw.includes("+")
    ? trimmedRaw.replace(/\+/g, " ")
    : null;
  const decodedPlusAsSpace = decoded && decoded.includes("+")
    ? decoded.replace(/\+/g, " ")
    : null;

  return Array.from(
    new Set(
      [trimmedRaw, decoded ?? "", plusAsSpace ?? "", decodedPlusAsSpace ?? ""]
        .map((s) => String(s ?? "").trim())
        .filter((s) => s.length > 0)
    )
  );
}

const inFlightCloudMediaFetch = new Map<string, Promise<Blob | null>>();

async function downloadMediaBlobFromCloud(
  libraryId: string,
  name: string
): Promise<Blob | null> {
  const safeLibraryId = String(libraryId ?? "").trim();
  const safeName = String(name ?? "").trim();
  if (!safeLibraryId || !safeName) return null;

  const key = `${safeLibraryId}:${safeName}`;
  const existing = inFlightCloudMediaFetch.get(key);
  if (existing) return existing;

  const p = (async () => {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), 30_000);
    try {
      const url = (base: "/api/sync" | "/api/guest") =>
        `${base}/media/download?libraryId=${encodeURIComponent(
          safeLibraryId
        )}&name=${encodeURIComponent(safeName)}`;

      const res = await fetch(url("/api/sync"), { method: "GET", signal: ctrl.signal });
      if (res.status === 401) {
        const guestRes = await fetch(url("/api/guest"), {
          method: "GET",
          signal: ctrl.signal,
        });
        if (!guestRes.ok) return null;
        const blob = await guestRes.blob();
        if (!blob || blob.size <= 0) return null;
        return blob;
      }

      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob || blob.size <= 0) return null;
      return blob;
    } catch {
      return null;
    } finally {
      window.clearTimeout(t);
    }
  })();

  inFlightCloudMediaFetch.set(key, p);
  try {
    return await p;
  } finally {
    inFlightCloudMediaFetch.delete(key);
  }
}

async function tryPlayAudioFilename(
  namespace: string,
  filename: string
): Promise<void> {
  const ensureMediaFromCloud = async (): Promise<boolean> => {
    const blob = await downloadMediaBlobFromCloud(namespace, filename);
    if (!blob) return false;
    try {
      await saveMediaItems(namespace, [{ name: filename, blob }]);
      return true;
    } catch {
      return false;
    }
  };

  const ensureMediaFromCachedApkg = async (): Promise<boolean> => {
    // Best-effort: if media wasn't stored (quota/bug), attempt to re-extract it
    // from the locally cached .apkg for this library.
    const stored = await getApkgFile(namespace).catch(() => null);
    if (!stored) return false;
    const file = new File([stored.blob], stored.filename || "deck.apkg", {
      type: "application/octet-stream",
    });
    try {
      await importApkg(file, { mediaNamespace: namespace });
      return true;
    } catch {
      return false;
    }
  };

  let blob = await getMediaBlob(namespace, filename);
  if (!blob) {
    const fromCloud = await ensureMediaFromCloud();
    if (fromCloud) blob = await getMediaBlob(namespace, filename);
  }
  if (!blob) {
    const repaired = await ensureMediaFromCachedApkg();
    if (repaired) blob = await getMediaBlob(namespace, filename);
  }
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
  disabled = false,
}: {
  namespace: string;
  filename: string;
  variant?: "pill" | "icon";
  disabled?: boolean;
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
          disabled={isLoading || disabled}
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
    <div className="flex items-center justify-center gap-2">
      <button
        type="button"
        onClick={handlePlay}
        disabled={isLoading || disabled}
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

function extractMediaCandidatesFromHtml(html: string): string[] {
  const input = String(html ?? "");
  if (!input) return [];

  const out = new Set<string>();

  // Sound tags: [sound:filename.mp3]
  {
    const re = /\[sound:([^\]]+)\]/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
      const raw = String(match[1] ?? "").trim();
      if (!raw) continue;
      for (const cand of soundCandidatesFromFilename(raw)) out.add(cand);
    }
  }

  // Image tags: <img src="...">
  {
    const re = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
      const src = String(match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (!src) continue;
      for (const cand of localMediaCandidatesFromSrc(src)) out.add(cand);
    }
  }

  return Array.from(out);
}

function extractDeckMediaCandidates(deck: ImportedDeck): string[] {
  const out = new Set<string>();
  for (const card of deck.cards) {
    for (const cand of extractMediaCandidatesFromHtml(card.frontHtml)) out.add(cand);
    for (const cand of extractMediaCandidatesFromHtml(card.backHtml)) out.add(cand);
    for (const fieldHtml of card.fieldsHtml) {
      for (const cand of extractMediaCandidatesFromHtml(fieldHtml)) out.add(cand);
    }
  }
  return Array.from(out);
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

function htmlToText(inputHtml: string): string {
  const input = String(inputHtml ?? "");
  if (!input) return "";

  try {
    const doc = new DOMParser().parseFromString(input, "text/html");
    return String(doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  } catch {
    // Very small fallback; good enough for label inference.
    return input
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

function htmlToTextWithBreaks(inputHtml: string): string {
  const input = String(inputHtml ?? "");
  if (!input) return "";

  try {
    const doc = new DOMParser().parseFromString(input, "text/html");
    // `innerText` preserves <br> and block element line breaks in browsers.
    const raw = String((doc.body as unknown as { innerText?: unknown })?.innerText ?? "");
    return raw.replace(/\r\n?/gu, "\n").replace(/[\t\f\v]+/gu, " ").trim();
  } catch {
    // Fallback: approximate breaks by replacing <br> tags.
    return input
      .replace(/<br\s*\/?\s*>/giu, "\n")
      .replace(/<[^>]*>/gu, " ")
      .replace(/\s+\n\s+/gu, "\n")
      .trim();
  }
}

function normalizeLabel(s: string) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function escapeRegExp(input: string): string {
  return String(input ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toWriteChars(input: string): string[] {
  const normalized = String(input ?? "")
    .trim()
    .normalize("NFKC")
    .replace(/\s+/gu, " ");
  if (!normalized) return [];

  // Keep letters (including accents), spaces, and common word punctuation.
  const chars = Array.from(normalized);
  return chars.filter((ch) => /\p{L}/u.test(ch) || ch === " " || ch === "'" || ch === "-");
}

function extractWriteWordFromText(text: string): string | null {
  const t = String(text ?? "").trim();
  if (!t) return null;

  // Find the first "phrase-like" token containing letters, allowing spaces between words.
  // Example: "go on with"
  const re = /[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)*/gu;
  const match = re.exec(t);
  const picked = String(match?.[0] ?? "");
  const chars = toWriteChars(picked);
  return chars.length > 0 ? chars.join("") : null;
}

function normalizeChoiceText(input: string): string {
  return String(input ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function extractMultipleChoiceAnswerFromBackHtml(backHtml: string): string | null {
  const t = htmlToTextWithBreaks(backHtml);
  if (!t) return null;

  // "First element" heuristic: first non-empty line, then before common separators.
  const firstLine =
    t
      .split("\n")
      .map((s) => s.trim())
      .find(Boolean) ?? "";
  if (!firstLine) return null;

  const beforeSep = firstLine
    .split(/\s*(?:•|\||;|,|\/|·)\s*/u)[0]
    ?.trim();

  const picked = String(beforeSep ?? firstLine).replace(/\s+/gu, " ").trim();
  return picked ? picked : null;
}

function extractReverseChoiceFromFrontHtml(frontHtml: string): string | null {
  const t = htmlToTextWithBreaks(frontHtml);
  if (!t) return null;

  // Remove literal sound tags that survive HTML parsing.
  const cleaned = t.replace(/\[sound:[^\]]+\]/giu, " ");

  const firstLine =
    cleaned
      .split("\n")
      .map((s) => s.trim())
      .find(Boolean) ?? "";
  if (!firstLine) return null;

  const beforeSep = firstLine
    .split(/\s*(?:•|\||;|,|\/|·)\s*/u)[0]
    ?.trim();

  const picked = String(beforeSep ?? firstLine).replace(/\s+/gu, " ").trim();
  return picked ? picked : null;
}

function capitalizeFirstLetter(s: string): string {
  const t = String(s ?? "").trim();
  if (!t) return "";
  return t.charAt(0).toLocaleUpperCase() + t.slice(1);
}

function extractMultipleChoiceAnswerFromCard(card: {
  frontHtml: string;
  backHtml: string;
  fieldsHtml?: unknown;
  fieldNames?: unknown;
}): string | null {
  const fieldsHtml = Array.isArray(card.fieldsHtml)
    ? (card.fieldsHtml as unknown[]).map((x) => String(x ?? ""))
    : undefined;
  const fieldNames = Array.isArray(card.fieldNames)
    ? (card.fieldNames as unknown[]).map((x) => String(x ?? ""))
    : undefined;

  // If the deck defines pinned back fields (Definitions 1/2, etc) and the note
  // has them populated, prefer the FIRST pinned field as the MC source.
  const pinned = pickFieldSectionsByLabel({
    fieldsHtml,
    fieldNames,
    labelNormalizedInOrder: PINNED_BACK_FIELD_LABELS_NORMALIZED,
  });
  const pinnedFirstHtml = pinned[0]?.valueHtml ?? null;

  const sections = inferFieldSectionsForHtml({
    html: card.backHtml,
    fieldsHtml,
    fieldNames,
  });

  const firstHtml = pinnedFirstHtml ?? sections[0]?.valueHtml ?? card.backHtml;
  return extractMultipleChoiceAnswerFromBackHtml(firstHtml);
}

function pickWriteTargetFromCard(card: {
  frontHtml: string;
  backHtml: string;
  fieldsHtml?: unknown;
  fieldNames?: unknown;
}): string | null {
  // Per product requirement: Write expects the word from the FRONT.
  const fromFront = extractWriteWordFromText(htmlToText(card.frontHtml));
  return fromFront;
}

function seededShuffle<T>(items: T[], seed: string): T[] {
  const arr = items.slice();
  if (arr.length <= 1) return arr;

  // xmur3 + mulberry32 (tiny deterministic PRNG)
  const xmur3 = (str: string) => {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i += 1) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  };

  const mulberry32 = (a: number) => {
    return () => {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  const seedFn = xmur3(seed);
  const rand = mulberry32(seedFn());

  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j] as T;
    arr[j] = tmp as T;
  }

  return arr;
}

const HIDDEN_FIELD_LABELS = [
  "Índice",
  "Sort Index",
  "Image",
  "Front of Card",
  "Word",
  "word_audio",
  "phrasal_verb_audio",
  "Anverso de la tarjeta",
  "Palabra",
  "Índice de ordenación",
  "audio_de_la_palabra",
];

// If these fields exist on the note, render them at the very top of the back
// (answer) view, even though they also remain visible in Card info.
//
// Add more labels here as needed; matching is accent/spacing-insensitive.
const PINNED_BACK_FIELD_LABELS = [
  "Definiciones 1",
  "Definiciones 2",
  "Definiciones 3",
  "Definitions 1",
  "Definitions 2",
  "Definitions 3",
  "Formas irregulares 1",
  "Formas irregulares 2",
  "Formas irregulares 3",
  "Irregular Forms 1",
  "Irregular Forms 2",
  "Irregular Forms 3",
  "Imagen",
];

const PINNED_BACK_FIELD_LABELS_NORMALIZED = PINNED_BACK_FIELD_LABELS.map(
  normalizeLabel
);

const HIDDEN_FIELD_LABELS_NORMALIZED = new Set(
  HIDDEN_FIELD_LABELS.map(normalizeLabel)
);

function shouldHideFieldLabel(label: string) {
  const target = normalizeLabel(label);
  if (!target) return false;
  return HIDDEN_FIELD_LABELS_NORMALIZED.has(target);
}

function inferFieldLabelsForHtml(args: {
  html: string;
  fieldsHtml?: string[];
  fieldNames?: string[];
}): string[] {
  const htmlText = htmlToText(args.html).toLowerCase();
  if (!htmlText) return [];

  const fields = Array.isArray(args.fieldsHtml) ? args.fieldsHtml : [];
  const names = Array.isArray(args.fieldNames) ? args.fieldNames : [];

  const out: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const fieldText = htmlToText(String(fields[i] ?? "")).toLowerCase();
    if (!fieldText) continue;

    // Avoid silly matches for ultra-short values.
    const isShort = fieldText.length < 4;
    const matches = isShort ? htmlText === fieldText : htmlText.includes(fieldText);
    if (!matches) continue;

    const label = String(names[i] ?? "").trim() || `Field ${i + 1}`;
    if (shouldHideFieldLabel(label)) continue;
    if (!out.includes(label)) out.push(label);
  }

  return out;
}
 
function inferFieldSectionsForHtml(args: {
  html: string;
  fieldsHtml?: string[];
  fieldNames?: string[];
}): Array<{ index: number; label: string; valueHtml: string }> {
  const htmlText = htmlToText(args.html).toLowerCase();
  if (!htmlText) return [];

  const fields = Array.isArray(args.fieldsHtml) ? args.fieldsHtml : [];
  const names = Array.isArray(args.fieldNames) ? args.fieldNames : [];

  const out: Array<{ index: number; label: string; valueHtml: string }> = [];
  for (let i = 0; i < fields.length; i += 1) {
    const valueHtml = String(fields[i] ?? "");
    const fieldText = htmlToText(valueHtml).toLowerCase();
    if (!fieldText) continue;

    // Avoid silly matches for ultra-short values.
    const isShort = fieldText.length < 4;
    const matches = isShort ? htmlText === fieldText : htmlText.includes(fieldText);
    if (!matches) continue;

    const label = String(names[i] ?? "").trim() || `Field ${i + 1}`;
    if (shouldHideFieldLabel(label)) continue;
    out.push({ index: i, label, valueHtml });
  }

  return out;
}

function pickFieldSectionsByLabel(args: {
  fieldsHtml?: string[];
  fieldNames?: string[];
  labelNormalizedInOrder: string[];
}): Array<{ index: number; label: string; valueHtml: string }> {
  const fields = Array.isArray(args.fieldsHtml) ? args.fieldsHtml : [];
  const names = Array.isArray(args.fieldNames) ? args.fieldNames : [];
  if (fields.length === 0 || names.length === 0) return [];

  const normNames = names.map(normalizeLabel);
  const out: Array<{ index: number; label: string; valueHtml: string }> = [];

  for (const wantedNorm of args.labelNormalizedInOrder) {
    if (!wantedNorm) continue;
    const idx = normNames.findIndex((n) => n === wantedNorm);
    if (idx < 0) continue;
    const valueHtml = String(fields[idx] ?? "");
    if (!valueHtml.trim()) continue;

    const label = String(names[idx] ?? "").trim() || `Field ${idx + 1}`;
    out.push({ index: idx, label, valueHtml });
  }

  return out;
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

      let attemptedRepair = false;
      let attemptedCloud = false;

      const ensureMediaFromCloud = async (name: string): Promise<Blob | null> => {
        if (attemptedCloud) {
          // Still allow multiple names, but avoid hammering if user is offline.
        }

        const blob = await downloadMediaBlobFromCloud(namespace, name);
        attemptedCloud = true;
        if (!blob) return null;

        try {
          await saveMediaItems(namespace, [{ name, blob }]);
          return blob;
        } catch {
          return null;
        }
      };

      const ensureMediaFromCachedApkg = async (): Promise<boolean> => {
        if (attemptedRepair) return false;
        attemptedRepair = true;

        const stored = await getApkgFile(namespace).catch(() => null);
        if (!stored) return false;

        const file = new File([stored.blob], stored.filename || "deck.apkg", {
          type: "application/octet-stream",
        });

        try {
          await importApkg(file, { mediaNamespace: namespace });
          return true;
        } catch {
          return false;
        }
      };

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
          // Try cloud first so media works cross-device.
          for (const cand of candidates) {
            const cloudBlob = await ensureMediaFromCloud(cand);
            if (cloudBlob) {
              blob = cloudBlob;
              resolved = cand;
              break;
            }
          }

          const repaired = await ensureMediaFromCachedApkg();
          if (repaired) {
            for (const cand of candidates) {
              blob = await getMediaBlob(namespace, cand);
              if (blob) {
                resolved = cand;
                break;
              }
            }
          }

          if (blob) {
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
            continue;
          }

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
  soundDisabled,
}: {
  namespace: string;
  html: string;
  className?: string;
  suppressFirstSoundFilename?: string | null;
  soundDisabled?: boolean;
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
              <SoundButton
                namespace={namespace}
                filename={p.filename}
                disabled={Boolean(soundDisabled)}
              />
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
  defaultOpen,
}: {
  namespace: string;
  fields: string[] | undefined;
  names: string[] | undefined;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(() => Boolean(defaultOpen));

  const list = (fields ?? []).map((v) => String(v ?? ""));
  const labelList = (names ?? []).map((n) => String(n ?? "").trim());

  const nonEmpty = list
    .map((value, index) => ({
      index,
      value: value.trim(),
      label: labelList[index] || `Field ${index + 1}`,
    }))
    .filter((x) => x.value !== "")
    .filter((x) => !shouldHideFieldLabel(x.label));

  if (nonEmpty.length === 0) return null;

  return (
    <div className="rounded-2xl border border-foreground/15 p-4">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-3 text-left text-xs font-medium text-foreground/70"
      >
        <span>Card info</span>
        <span className="flex items-center gap-2 text-[11px] font-medium text-foreground/60">
          <span>{isOpen ? "Hide" : "Show"}</span>
          <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
        </span>
      </button>

      {isOpen ? (
        <div className="mt-3 flex flex-col gap-3">
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
      ) : null}
    </div>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("import");
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
  const [reviewAnswerStyle, setReviewAnswerStyle] = useState<ReviewAnswerStyle>("normal");
  const [writePicked, setWritePicked] = useState<Array<{ index: number; ch: string }>>([]);
  const [writeOutcome, setWriteOutcome] = useState<"correct" | "wrong" | null>(null);
  const [mcOutcome, setMcOutcome] = useState<"correct" | "wrong" | null>(null);
  const [reverseOutcome, setReverseOutcome] = useState<"correct" | "wrong" | null>(null);
  const [mcAnswerPool, setMcAnswerPool] = useState<string[]>([]);
  const [mcAnswerPoolKey, setMcAnswerPoolKey] = useState<string | null>(null);
  const [reverseFrontPool, setReverseFrontPool] = useState<string[]>([]);
  const [reverseFrontPoolKey, setReverseFrontPoolKey] = useState<string | null>(null);
  const [reviewRef, setReviewRef] = useState<DeckRef | null>(null);
  const [current, setCurrent] = useState<NextCard | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewOverview, setReviewOverview] = useState<DeckOverview | null>(null);
  const [deckOverviews, setDeckOverviews] = useState<Record<string, DeckOverview>>({});
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [reviewDeckConfig, setReviewDeckConfig] = useState<DeckConfig | null>(null);

  // Prevent double autoplay from re-renders; reset when card changes.
  const lastAutoPlayedCardIdRef = useRef<number | null>(null);

  // Reverse: autoplay once when user reveals (showAnswer becomes true).
  const lastReverseRevealAutoPlayedCardIdRef = useRef<number | null>(null);

  // Auto-load demo decks once when in Guest/Test mode.
  const attemptedGuestAutoLoadRef = useRef(false);

  // Prevent slow/stale async updates when rapidly advancing cards.
  const loadNextSeqRef = useRef(0);
  const lastOverviewRefreshAtRef = useRef(0);

  // Randomize per-card answer style (50/50) when a new card is shown.

  const onLoadDemoDecksRef = useRef<() => Promise<void>>(onLoadDemoDecks);
  onLoadDemoDecksRef.current = onLoadDemoDecks;

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

  const isGuestMode = authUser === null;

  // If the user logs in, hide any previously-loaded guest/demo libraries.
  useEffect(() => {
    if (!authUser) return;
    if (libraries.length === 0) return;
    const hasGuest = libraries.some((l) => (l as { source?: unknown }).source === "guest");
    if (!hasGuest) return;

    const nextLibraries = libraries.filter((l) => (l as { source?: unknown }).source !== "guest");
    const nextActive = nextLibraries.some((l) => l.id === activeLibraryId)
      ? activeLibraryId
      : (nextLibraries[0]?.id ?? null);

    setLibraries(nextLibraries);
    setActiveLibraryId(nextActive);
    void saveLastState({
      libraries: nextLibraries,
      activeLibraryId: nextActive,
      savedAt: Date.now(),
      lastSyncAt,
      lastPushAtLocal,
    });
  }, [authUser, libraries, activeLibraryId, lastSyncAt, lastPushAtLocal]);

  const uiLibraries = useMemo(() => {
    if (authUser) {
      return libraries.filter((l) => (l as { source?: unknown }).source !== "guest");
    }
    return libraries;
  }, [authUser, libraries]);

  useEffect(() => {
    if (!isGuestMode) {
      attemptedGuestAutoLoadRef.current = false;
      return;
    }
    if (attemptedGuestAutoLoadRef.current) return;
    if (busy || syncBusy) return;
    const hasGuestAlready = libraries.some((l) => (l as { source?: unknown }).source === "guest");
    if (hasGuestAlready) {
      attemptedGuestAutoLoadRef.current = true;
      return;
    }

    attemptedGuestAutoLoadRef.current = true;
    void onLoadDemoDecksRef.current();
  }, [isGuestMode, libraries, busy, syncBusy]);

  type DeckDataEnvelopeV1 = {
    version: 1;
    deck: ImportedDeck;
  };

  const fetchWithTimeout = useCallback(
    async (
      input: RequestInfo | URL,
      init: RequestInit | undefined,
      timeoutMs: number,
      label: string
    ): Promise<Response> => {
      const controller = new AbortController();
      const existingSignal = init?.signal;

      if (existingSignal) {
        if (existingSignal.aborted) controller.abort();
        else {
          existingSignal.addEventListener("abort", () => controller.abort(), {
            once: true,
          });
        }
      }

      const id = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(input, { ...init, signal: controller.signal });
      } catch (e: unknown) {
        const aborted =
          controller.signal.aborted ||
          (e instanceof DOMException && e.name === "AbortError");
        if (aborted) {
          throw new Error(`${label} timed out. Please try again.`);
        }
        throw e;
      } finally {
        window.clearTimeout(id);
      }
    },
    []
  );

  async function uploadLibraryMediaToCloudNow(args: {
    libraryId: string;
    deck: ImportedDeck;
  }): Promise<void> {
    const libraryId = String(args.libraryId ?? "").trim();
    if (!libraryId) return;

    const candidates = extractDeckMediaCandidates(args.deck);
    if (candidates.length === 0) return;

    // If we don't have any local blobs at all, skip quickly.
    // (Common on a fresh device that only downloaded deck data.)
    {
      const sample = candidates.slice(0, 25);
      let hasAnyLocal = false;
      for (const name of sample) {
        if (!name) continue;
        const blob = await getMediaBlob(libraryId, name);
        if (blob && blob.size > 0) {
          hasAnyLocal = true;
          break;
        }
      }
      if (!hasAnyLocal) return;
    }

    // Best-effort: if user isn't logged in, just skip.
    const listRes = await fetchWithTimeout(
      `/api/sync/media/list?libraryId=${encodeURIComponent(libraryId)}`,
      { cache: "no-store" },
      30_000,
      "Media list"
    );

    if (listRes.status === 401) return;
    if (!listRes.ok) return;

    const listData: unknown = await listRes.json().catch(() => null);
    const cloudNames = (() => {
      if (!listData || typeof listData !== "object") return new Set<string>();
      if (!("items" in listData)) return new Set<string>();
      const raw = (listData as { items?: unknown }).items;
      if (!Array.isArray(raw)) return new Set<string>();
      const names = raw
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const name = (x as { name?: unknown }).name;
          return typeof name === "string" ? name : null;
        })
        .filter((x): x is string => Boolean(x));
      return new Set(names);
    })();

    const toUpload: Array<{ name: string; blob: Blob }> = [];
    for (const name of candidates) {
      if (!name) continue;
      if (cloudNames.has(name)) continue;
      const blob = await getMediaBlob(libraryId, name);
      if (!blob) continue;
      if (blob.size <= 0) continue;
      toUpload.push({ name, blob });
    }

    if (toUpload.length === 0) return;

    // Keep batches small to reduce timeouts on slower connections.
    const MAX_FILES_PER_REQ = 6;
    const MAX_BYTES_PER_REQ = 6 * 1024 * 1024;

    let batch: Array<{ name: string; blob: Blob }> = [];
    let batchBytes = 0;

    const flush = async (): Promise<boolean> => {
      if (batch.length === 0) return true;

      const form = new FormData();
      form.set("libraryId", libraryId);
      for (const it of batch) {
        const type = String(it.blob.type || "application/octet-stream");
        form.append("file", new File([it.blob], it.name, { type }));
      }

      const res = await fetchWithTimeout(
        "/api/sync/media/upload",
        { method: "POST", body: form },
        180_000,
        "Media upload"
      );

      // If unauthenticated/offline/server error, stop silently.
      if (res.status === 401) return false;
      if (!res.ok) return false;
      batch = [];
      batchBytes = 0;
      return true;
    };

    for (const it of toUpload) {
      const size = Number(it.blob.size || 0);
      const wouldOverflowFiles = batch.length >= MAX_FILES_PER_REQ;
      const wouldOverflowBytes = batchBytes > 0 && batchBytes + size > MAX_BYTES_PER_REQ;

      if (wouldOverflowFiles || wouldOverflowBytes) {
        const ok = await flush();
        if (ok === false) return;
      }

      batch.push(it);
      batchBytes += size;

      if (batch.length >= MAX_FILES_PER_REQ || batchBytes >= MAX_BYTES_PER_REQ) {
        const ok = await flush();
        if (ok === false) return;
      }
    }

    await flush();
  }

  async function exportDeckDataFromStudyDb(libraryId: string): Promise<ImportedDeck> {
    const db = getStudyDb();

    const [decks, cards] = await Promise.all([
      db.decks.where("libraryId").equals(libraryId).toArray(),
      db.cards.where("libraryId").equals(libraryId).toArray(),
    ]);

    if (decks.length === 0 || cards.length === 0) {
      throw new Error(
        "This deck isn't available locally yet. Try opening it once, or re-import the .apkg."
      );
    }

    return {
      decks: decks
        .map((d) => ({ id: d.deckId, name: d.name }))
        .sort((a, b) => a.id - b.id),
      cards: cards
        .map((c) => ({
          id: c.cardId,
          deckId: c.deckId,
          noteId: c.noteId,
          frontHtml: c.frontHtml,
          backHtml: c.backHtml,
          fieldsHtml: c.fieldsHtml,
          fieldNames: c.fieldNames,
        }))
        .sort((a, b) => a.id - b.id),
    } satisfies ImportedDeck;
  }

  async function gzipBytes(bytes: Uint8Array, timeoutMs = 8_000): Promise<Uint8Array | null> {
    if (typeof CompressionStream === "undefined") return null;

    const compress = async (): Promise<Uint8Array> => {
      const cs = new CompressionStream("gzip");
      const writer = cs.writable.getWriter();
      const copied = new Uint8Array(bytes);
      await writer.write(copied);
      await writer.close();
      const outBuf = await new Response(cs.readable).arrayBuffer();
      return new Uint8Array(outBuf);
    };

    try {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return await compress();
      }

      const timed = await Promise.race<Uint8Array | null>([
        compress(),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), timeoutMs)),
      ]);

      return timed;
    } catch {
      return null;
    }
  }

  async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
    if (typeof DecompressionStream === "undefined") return null;
    try {
      const ds = new DecompressionStream("gzip");
      const writer = ds.writable.getWriter();
      const copied = new Uint8Array(bytes);
      await writer.write(copied);
      await writer.close();
      const outBuf = await new Response(ds.readable).arrayBuffer();
      return new Uint8Array(outBuf);
    } catch {
      return null;
    }
  }

  async function encodeDeckDataFile(deck: ImportedDeck): Promise<File> {
    const envelope: DeckDataEnvelopeV1 = { version: 1, deck };
    const json = JSON.stringify(envelope);
    const raw = new TextEncoder().encode(json);
    const gz = await gzipBytes(raw, 8_000);

    if (gz) {
      const copied = new Uint8Array(gz);
      return new File([copied], "deck.json.gz", { type: "application/gzip" });
    }

    const copied = new Uint8Array(raw);
    return new File([copied], "deck.json", { type: "application/json" });
  }

  async function uploadDeckDataFileToCloud(args: {
    libraryId: string;
    name: string;
    file: File;
    _attempt?: number;
  }): Promise<void> {
    const form = new FormData();
    form.set("libraryId", args.libraryId);
    form.set("name", args.name);
    form.set("file", args.file);

    const res = await fetchWithTimeout(
      "/api/sync/upload-deck",
      {
        method: "POST",
        body: form,
      },
      120_000,
      "Upload"
    );

    if (!res.ok) {
      const data: unknown = await res.json().catch(() => null);
      const jsonMsg = (() => {
        if (!data || typeof data !== "object") return null;
        if (!("error" in data)) return null;
        const err = (data as { error?: unknown }).error;
        return typeof err === "string" ? err : null;
      })();

      if (jsonMsg) {
        const attempt = args._attempt ?? 0;
        const isQuota = /space quota|over your space quota|quota/i.test(jsonMsg);
        if (isQuota && attempt < 1) {
          try {
            await fetch("/api/sync/cleanup", { method: "POST" });
          } catch {
            // ignore
          }
          await uploadDeckDataFileToCloud({ ...args, _attempt: attempt + 1 });
          return;
        }

        throw new Error(jsonMsg);
      }

      const text = await res.text().catch(() => "");
      const trimmed = text.trim();
      const maybeHtml = /^<!doctype html/i.test(trimmed) || /^<html/i.test(trimmed);
      const fallbackDetail = !maybeHtml && trimmed ? trimmed.slice(0, 200) : "";

      throw new Error(
        `Failed to sync to cloud (HTTP ${res.status})${fallbackDetail ? `: ${fallbackDetail}` : ""}`
      );
    }
  }

  async function decodeDeckDataBlob(blob: Blob): Promise<ImportedDeck> {
    const ct = (blob.type || "").toLowerCase();
    const buf = new Uint8Array(await blob.arrayBuffer());

    let jsonText: string;
    if (ct.includes("gzip") || ct.includes("x-gzip")) {
      const raw = await gunzipBytes(buf);
      if (!raw) {
        throw new Error(
          "Your browser can't decompress this deck format. Please update your browser or re-import the .apkg on this device."
        );
      }
      jsonText = new TextDecoder().decode(raw);
    } else {
      jsonText = new TextDecoder().decode(buf);
    }

    const parsed: unknown = JSON.parse(jsonText);
    const deck = (() => {
      if (parsed && typeof parsed === "object" && "deck" in parsed) {
        return (parsed as { deck?: unknown }).deck;
      }
      return parsed;
    })();

    if (!deck || typeof deck !== "object") {
      throw new Error("Invalid deck data");
    }

    const decksRaw = (deck as { decks?: unknown }).decks;
    const cardsRaw = (deck as { cards?: unknown }).cards;
    if (!Array.isArray(decksRaw) || !Array.isArray(cardsRaw)) {
      throw new Error("Invalid deck data");
    }

    return deck as ImportedDeck;
  }

  async function uploadDeckDataToCloud(args: {
    libraryId: string;
    name: string;
    deck: ImportedDeck;
    _attempt?: number;
  }): Promise<void> {
    const file = await encodeDeckDataFile(args.deck);

    await uploadDeckDataFileToCloud({
      libraryId: args.libraryId,
      name: args.name,
      file,
      _attempt: args._attempt,
    });
  }

  async function uploadLibraryDeckDataToCloudNow(args: {
    libraryId: string;
    libraryName: string;
  }): Promise<void> {
    let deck: ImportedDeck | null = null;
    try {
      deck = await exportDeckDataFromStudyDb(args.libraryId);
    } catch (e: unknown) {
      if (isMissingLocalDeckDataError(e)) {
        deck = await recoverDeckDataFromCachedApkg(args.libraryId);
      } else {
        throw e;
      }
    }

    if (!deck) {
      throw new Error(
        "This deck isn't available locally yet. Re-import the .apkg to restore it."
      );
    }

    const file = await encodeDeckDataFile(deck);
    const res = await fetchWithTimeout(
      "/api/sync/upload-deck",
      (() => {
        const form = new FormData();
        form.set("libraryId", args.libraryId);
        form.set("name", args.libraryName);
        form.set("file", file);
        return { method: "POST", body: form };
      })(),
      120_000,
      "Upload"
    );

    if (res.status === 401) return;
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => null);
      const jsonMsg = (() => {
        if (!data || typeof data !== "object") return null;
        if (!("error" in data)) return null;
        const err = (data as { error?: unknown }).error;
        return typeof err === "string" ? err : null;
      })();
      throw new Error(jsonMsg ?? "Failed to upload deck data");
    }
  }

  async function deleteLibraryFromCloudNow(libraryId: string): Promise<void> {
    const res = await fetchWithTimeout(
      "/api/sync/delete-library",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ libraryId }),
      },
      30_000,
      "Cloud delete"
    );

    if (res.status === 401) return;
    if (!res.ok) {
      const errData: unknown = await res.json().catch(() => null);
      const msg = (() => {
        if (!errData || typeof errData !== "object") return null;
        if (!("error" in errData)) return null;
        const err = (errData as { error?: unknown }).error;
        return typeof err === "string" ? err : null;
      })();
      throw new Error(msg ?? "Cloud delete failed");
    }
  }

  async function importApkgAsLibrary(args: {
    libraryId: string;
    libraryName: string;
    file: File;
  }): Promise<{ item: LibraryItem; imported: ImportedDeck }> {
    const { libraryId: id, libraryName: name, file } = args;

    const baseName = file.name.replace(/\.[^.]+$/u, "").trim();
    const imported = await importApkg(file, { mediaNamespace: id });

    // Cache the original .apkg locally so we can recover/re-upload later if the
    // study IndexedDB is cleared or partially missing.
    try {
      await saveApkgFile({ libraryId: id, file });
    } catch {
      // ignore (quota / private mode)
    }

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

    await upsertImportedDeck(id, importedWithRenamedTopLevel);
    return { item: nextItem, imported: importedWithRenamedTopLevel };
  }

  function isMissingLocalDeckDataError(e: unknown): boolean {
    return (
      e instanceof Error &&
      /isn't available locally yet/i.test(e.message)
    );
  }

  async function recoverDeckDataFromCachedApkg(libraryId: string): Promise<ImportedDeck | null> {
    const stored = await getApkgFile(libraryId).catch(() => null);
    if (!stored) return null;

    const file = new File([stored.blob], stored.filename || "deck.apkg", {
      type: "application/octet-stream",
    });

    const imported = await importApkg(file, { mediaNamespace: libraryId });
    // Re-seed StudyDB to restore local availability.
    await upsertImportedDeck(libraryId, imported);
    return imported;
  }

  async function importDeckDataAsLibrary(args: {
    libraryId: string;
    libraryName: string;
    deck: ImportedDeck;
  }): Promise<LibraryItem> {
    const { libraryId: id, libraryName: name, deck } = args;

    const defaultDeckId = deck.decks[0]?.id ?? null;
    const nextItem: LibraryItem = {
      id,
      name,
      deck: {
        decks: deck.decks.map((d) => ({ id: d.id, name: d.name })),
      },
      selectedDeckId: defaultDeckId,
      savedAt: Date.now(),
    };

    await upsertImportedDeck(id, deck);
    return nextItem;
  }

  const onLogout = useCallback(async () => {
    const ok = confirm("Are you sure you want to log out?");
    if (!ok) return;
    try {
      try {
        await onClearSaved();
      } catch {
        // ignore
      }

      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } catch {
        // ignore
      }
    } finally {
      window.location.href = "/login";
    }
  }, []);

  const onDevPurgeOtherUsers = useCallback(async () => {
    if (!devPurgeEnabled) return;
    if (!authUser) return;

    const typed = window.prompt(
      "DEV ONLY. This will delete all cloud data for OTHER userIds (and then delete unreferenced media files).\n\nType PURGE_OTHER_USERS to confirm."
    );
    if (typed !== "PURGE_OTHER_USERS") return;

    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/purge-other-users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "PURGE_OTHER_USERS" }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          data && typeof data === "object" && "error" in data
            ? String((data as { error?: unknown }).error ?? "Purge failed")
            : "Purge failed";
        throw new Error(msg);
      }

      const deleted =
        data && typeof data === "object" && "deletedGridFsFiles" in data
          ? (data as { deletedGridFsFiles?: unknown }).deletedGridFsFiles
          : null;

      window.alert(
        `Purge complete.\n\nGridFS deleted:\n${JSON.stringify(deleted, null, 2)}`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Purge failed";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [devPurgeEnabled, authUser]);

  const onDevResetMyCloud = useCallback(async () => {
    if (!devPurgeEnabled) return;
    if (!authUser) return;

    const typed = window.prompt(
      "DEV ONLY. This will DELETE ALL your cloud data (libraries, progress, and media) for your current user.\n\nYour local data stays. After this, click Sync to re-upload from this device.\n\nType RESET_MY_CLOUD to confirm."
    );
    if (typed !== "RESET_MY_CLOUD") return;

    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/reset-my-cloud", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESET_MY_CLOUD" }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          data && typeof data === "object" && "error" in data
            ? String((data as { error?: unknown }).error ?? "Reset failed")
            : "Reset failed";
        throw new Error(msg);
      }

      const deleted =
        data && typeof data === "object" && "deletedGridFsFiles" in data
          ? (data as { deletedGridFsFiles?: unknown }).deletedGridFsFiles
          : null;

      window.alert(
        `Cloud reset complete.\n\nGridFS deleted:\n${JSON.stringify(deleted, null, 2)}\n\nNow click Sync to re-upload from this device.`
      );

      // IMPORTANT: after cloud reset, force a full progress push next sync.
      // Otherwise, lastSyncAt might cause the client to skip uploading older local progress.
      setLastSyncAt(null);
      setLastPushAtLocal(null);
      void saveLastState({
        libraries,
        activeLibraryId,
        savedAt: Date.now(),
        lastSyncAt: null,
        lastPushAtLocal: null,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Reset failed";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [devPurgeEnabled, authUser, libraries, activeLibraryId]);

  const onDevDebugLocalProgress = useCallback(async () => {
    if (!devPurgeEnabled) return;

    try {
      const db = getStudyDb();
      const MAX_TS = Number.MAX_SAFE_INTEGER;

      const rows: Array<{
        libraryId: string;
        name: string;
        cardStatesTotal: number;
        cardStatesUpdated: number;
        reviewLogsTotal: number;
        decksTotal: number;
      }> = [];

      for (const lib of uiLibraries) {
        const cardStatesTotal = await db.cardStates.where("libraryId").equals(lib.id).count();
        const cardStatesUpdated = await db.cardStates
          .where("[libraryId+updatedAt]")
          .between([lib.id, 1], [lib.id, MAX_TS], true, true)
          .count();
        const reviewLogsTotal = await db.reviewLogs.where("libraryId").equals(lib.id).count();
        const decksTotal = await db.decks.where("libraryId").equals(lib.id).count();

        rows.push({
          libraryId: lib.id,
          name: lib.name,
          cardStatesTotal,
          cardStatesUpdated,
          reviewLogsTotal,
          decksTotal,
        });
      }

      window.alert(`Local progress snapshot:\n\n${JSON.stringify(rows, null, 2)}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Debug failed";
      setError(msg);
    }
  }, [devPurgeEnabled, uiLibraries]);

  const onDevDebugCloudProgress = useCallback(async () => {
    if (!devPurgeEnabled) return;
    if (!authUser) return;

    try {
      const res = await fetch("/api/admin/debug-my-cloud-progress", { cache: "no-store" });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          data && typeof data === "object" && "error" in data
            ? String((data as { error?: unknown }).error ?? "Debug failed")
            : "Debug failed";
        throw new Error(msg);
      }

      window.alert(`Cloud progress snapshot:\n\n${JSON.stringify(data, null, 2)}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Debug failed";
      setError(msg);
    }
  }, [devPurgeEnabled, authUser]);

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

  async function onPickFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const id = crypto.randomUUID();
      const baseName = file.name.replace(/\.[^.]+$/u, "").trim();
      const name = baseName || "Deck";

      const { item: nextItem } = await importApkgAsLibrary({
        libraryId: id,
        libraryName: name,
        file,
      });

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

  async function onLoadDemoDecks() {
    setError(null);
    setSyncBusy(true);
    setSyncProgress({ done: 0, total: 1, phase: "Listing demo decks…" });
    try {
      const res = await fetchWithTimeout(
        "/api/guest/list",
        { cache: "no-store" },
        30_000,
        "Guest list"
      );

      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (() => {
          if (!data || typeof data !== "object") return null;
          if (!("error" in data)) return null;
          const err = (data as { error?: unknown }).error;
          return typeof err === "string" ? err : null;
        })();
        throw new Error(msg ?? "Failed to list demo decks");
      }

      const libs = (() => {
        if (!data || typeof data !== "object") return [];
        if (!("libraries" in data)) return [];
        const raw = (data as { libraries?: unknown }).libraries;
        if (!Array.isArray(raw)) return [];
        return raw
          .map((x) => {
            if (!x || typeof x !== "object") return null;
            const libraryId = (x as { libraryId?: unknown }).libraryId;
            const name = (x as { name?: unknown }).name;
            const originalFilename = (x as { originalFilename?: unknown }).originalFilename;
            if (typeof libraryId !== "string" || typeof name !== "string") return null;
            return {
              libraryId,
              name,
              originalFilename:
                typeof originalFilename === "string" ? originalFilename : "deck.apkg",
            };
          })
          .filter(
            (x): x is { libraryId: string; name: string; originalFilename: string } =>
              Boolean(x)
          );
      })();

      if (libs.length === 0) {
        setSyncProgress({ done: 1, total: 1, phase: "No demo decks found." });
        return;
      }

      const localById = new Map(libraries.map((l) => [l.id, l] as const));
      const toDownload = libs.filter((l) => !localById.has(l.libraryId));

      const totalSteps = 1 + Math.max(1, toDownload.length) * 2;
      setSyncProgress({ done: 1, total: totalSteps, phase: "Loading demo decks…" });

      const advance = (phase: string) => {
        setSyncProgress((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            done: Math.min(prev.total, prev.done + 1),
            phase,
          };
        });
      };

      const importedItems: LibraryItem[] = [];
      for (const lib of toDownload) {
        advance(`Downloading “${lib.name}”…`);
        const dl = await fetchWithTimeout(
          `/api/guest/download-deck?libraryId=${encodeURIComponent(lib.libraryId)}`,
          { cache: "no-store" },
          120_000,
          "Guest download"
        );

        if (!dl.ok) {
          const errData: unknown = await dl.json().catch(() => null);
          const msg = (() => {
            if (!errData || typeof errData !== "object") return null;
            if (!("error" in errData)) return null;
            const err = (errData as { error?: unknown }).error;
            return typeof err === "string" ? err : null;
          })();
          throw new Error(msg ?? `Failed to download “${lib.name}”`);
        }

        const blob = await dl.blob();
        const deck = await decodeDeckDataBlob(blob);
        advance(`Importing “${lib.name}”…`);
        const item = await importDeckDataAsLibrary({
          libraryId: lib.libraryId,
          libraryName: lib.name,
          deck,
        });
        importedItems.push({ ...item, source: "guest" } as LibraryItem);
      }

      if (importedItems.length > 0) {
        setLibraries((prev) => {
          const next = [...prev, ...importedItems];
          void saveLastState({
            libraries: next,
            activeLibraryId: activeLibraryId ?? importedItems[0]?.id ?? null,
            savedAt: Date.now(),
            lastSyncAt,
          });
          return next;
        });
        if (!activeLibraryId) {
          setActiveLibraryId(importedItems[0]?.id ?? null);
        }
      }

      setSyncProgress({
        done: totalSteps,
        total: totalSteps,
        phase: "Demo decks loaded.",
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load demo decks";
      setError(msg);
    } finally {
      setSyncBusy(false);
      window.setTimeout(() => setSyncProgress(null), 1_500);
    }
  }

  async function onSyncFromCloud(opts?: { silent?: boolean }) {
    const silent = Boolean(opts?.silent);
    const reportError = (msg: string) => {
      if (!silent) setError(msg);
    };

    if (!silent) setError(null);
    setSyncBusy(true);
    setSyncProgress({ done: 0, total: 1, phase: "Listing cloud decks…" });
    try {
      const res = await fetchWithTimeout(
        "/api/sync/list",
        { cache: "no-store" },
        30_000,
        "Cloud list"
      );
      const data: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const msg = (() => {
          if (!data || typeof data !== "object") return null;
          if (!("error" in data)) return null;
          const err = (data as { error?: unknown }).error;
          return typeof err === "string" ? err : null;
        })();
        throw new Error(msg ?? "Failed to list cloud decks");
      }

      const libs = (() => {
        if (!data || typeof data !== "object") return [];
        if (!("libraries" in data)) return [];
        const raw = (data as { libraries?: unknown }).libraries;
        if (!Array.isArray(raw)) return [];
        return raw
          .map((x) => {
            if (!x || typeof x !== "object") return null;
            const libraryId = (x as { libraryId?: unknown }).libraryId;
            const name = (x as { name?: unknown }).name;
            const originalFilename = (x as { originalFilename?: unknown }).originalFilename;
            if (typeof libraryId !== "string" || typeof name !== "string") return null;
            return {
              libraryId,
              name,
              originalFilename: typeof originalFilename === "string" ? originalFilename : "deck.apkg",
            };
          })
          .filter((x): x is { libraryId: string; name: string; originalFilename: string } => Boolean(x));
      })();

      const cloudById = new Map(libs.map((l) => [l.libraryId, l] as const));
      const localById = new Map(libraries.map((l) => [l.id, l] as const));

      const toUpload = libraries.filter((l) => !cloudById.has(l.id));
      const toDownload = libs.filter((l) => !localById.has(l.libraryId));

      const plannedMergedCount = libraries.length + toDownload.length;
      const uploadSteps = toUpload.length * 3;
      const totalSteps =
        1 + uploadSteps + toDownload.length + plannedMergedCount * 2 + 1;

      setSyncProgress({
        done: 1,
        total: Math.max(1, totalSteps),
        phase: "Syncing decks…",
      });

      const advance = (phase: string) => {
        setSyncProgress((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            done: Math.min(prev.total, prev.done + 1),
            phase,
          };
        });
      };

      const setPhase = (phase: string) => {
        setSyncProgress((prev) => (prev ? { ...prev, phase } : prev));
      };

      // Upload locals missing in cloud.
      const uploadWarnings: string[] = [];
      for (const local of toUpload) {
        setPhase(`Exporting “${local.name}”…`);

        let deck: ImportedDeck | null = null;
        try {
          deck = await exportDeckDataFromStudyDb(local.id);
        } catch (e: unknown) {
          if (isMissingLocalDeckDataError(e)) {
            setPhase(`Recovering “${local.name}” from cached .apkg…`);
            deck = await recoverDeckDataFromCachedApkg(local.id);
            if (!deck) {
              uploadWarnings.push(
                `“${local.name}” couldn't upload because the deck data isn't stored locally on this device. Re-import the .apkg to restore it.`
              );
            }
          } else {
            throw e;
          }
        }

        if (!deck) {
          // Keep progress consistent with the planned 3 steps for upload.
          advance(`Skipped “${local.name}” export.`);
          advance(`Skipped “${local.name}” encoding.`);
          advance(`Skipped “${local.name}” upload.`);
          continue;
        }

        advance(`Exported “${local.name}”.`);

        setPhase(`Encoding “${local.name}”…`);
        const file = await encodeDeckDataFile(deck);
        advance(`Encoded “${local.name}”.`);

        setPhase(`Uploading “${local.name}”…`);
        await uploadDeckDataFileToCloud({ libraryId: local.id, name: local.name, file });
        advance(`Uploaded “${local.name}”.`);

        // Best-effort: upload media in background (deduped by cloud list).
        void (async () => {
          try {
            await uploadLibraryMediaToCloudNow({ libraryId: local.id, deck });
          } catch {
            // ignore
          }
        })();
      }

      // Best-effort: also retry uploading referenced media for existing local decks.
      // This helps recover from prior partial media uploads (e.g. audio uploaded but
      // images didn't) without requiring a re-import.
      void (async () => {
        if (!authUser) return;
        for (const lib of libraries) {
          try {
            let deck: ImportedDeck | null = null;
            try {
              deck = await exportDeckDataFromStudyDb(lib.id);
            } catch (e: unknown) {
              if (isMissingLocalDeckDataError(e)) {
                deck = await recoverDeckDataFromCachedApkg(lib.id);
              } else {
                throw e;
              }
            }

            if (!deck) continue;
            await uploadLibraryMediaToCloudNow({ libraryId: lib.id, deck });
          } catch {
            // ignore
          }
        }
      })();

      // Download clouds missing locally.
      const importedItems: LibraryItem[] = [];
      for (const lib of toDownload) {
        setPhase(`Downloading “${lib.name}”…`);
        // Prefer the extracted "deck data" format (smaller than uploading full .apkg).
        const dlDeck = await fetchWithTimeout(
          `/api/sync/download-deck?libraryId=${encodeURIComponent(lib.libraryId)}`,
          { cache: "no-store" },
          120_000,
          "Deck download"
        );

        let shouldFallbackToApkg = false;

        if (dlDeck.ok) {
          const blob = await dlDeck.blob();
          const deck = await decodeDeckDataBlob(blob);

          // Back-compat guard: if the cloud deck-data is an older/partial format
          // (missing fields arrays), fall back to downloading the full .apkg.
          const sample = (deck.cards ?? []).slice(0, 25);
          const hasLegacyShape = sample.some((c) => {
            const anyCard = c as unknown as {
              fieldsHtml?: unknown;
              fieldNames?: unknown;
            };
            return !Array.isArray(anyCard.fieldsHtml) || !Array.isArray(anyCard.fieldNames);
          });

          if (!hasLegacyShape) {
            const item = await importDeckDataAsLibrary({
              libraryId: lib.libraryId,
              libraryName: lib.name,
              deck,
            });
            importedItems.push(item);
            advance(`Downloaded “${lib.name}”.`);
            continue;
          }

          shouldFallbackToApkg = true;
        } else {
          // Back-compat: older cloud entries store only the .apkg.
          if (dlDeck.status !== 404) {
            const errData: unknown = await dlDeck.json().catch(() => null);
            const msg = (() => {
              if (!errData || typeof errData !== "object") return null;
              if (!("error" in errData)) return null;
              const err = (errData as { error?: unknown }).error;
              return typeof err === "string" ? err : null;
            })();
            throw new Error(msg ?? "Failed to download deck");
          }
        }

        if (shouldFallbackToApkg === false && dlDeck.status === 404) {
          // Continue to .apkg fallback below.
        }

        const dlApkg = await fetchWithTimeout(
          `/api/sync/download?libraryId=${encodeURIComponent(lib.libraryId)}`,
          { cache: "no-store" },
          180_000,
          "APKG download"
        );
        if (!dlApkg.ok) {
          const errData: unknown = await dlApkg.json().catch(() => null);
          const msg = (() => {
            if (!errData || typeof errData !== "object") return null;
            if (!("error" in errData)) return null;
            const err = (errData as { error?: unknown }).error;
            return typeof err === "string" ? err : null;
          })();
          throw new Error(msg ?? "Failed to download deck");
        }

        const blob = await dlApkg.blob();
        const file = new File([blob], lib.originalFilename, {
          type: "application/octet-stream",
        });

        const { item, imported } = await importApkgAsLibrary({
          libraryId: lib.libraryId,
          libraryName: lib.name,
          file,
        });
        importedItems.push(item);

        // Best-effort: migrate this cloud deck to the smaller deck-data format.
        void (async () => {
          try {
            await uploadDeckDataToCloud({ libraryId: lib.libraryId, name: lib.name, deck: imported });
          } catch {
            // ignore
          }
        })();

        advance(`Downloaded “${lib.name}”.`);
      }

      const mergedLibraries = [...libraries, ...importedItems];
      setLibraries(mergedLibraries);

      if (!activeLibraryId && mergedLibraries.length > 0) {
        setActiveLibraryId(mergedLibraries[0]?.id ?? null);
      }

      // Sync study progress (card states + review logs) bidirectionally.
      // Use cloud time (uploadedAt/serverTime) for incremental pulls.
      // Subtract 1ms to avoid missing entries exactly on the boundary.
      // Use server time for pull (cloud writes use uploadedAt/serverTime).
      const sincePull = Math.max(0, (lastSyncAt ?? 0) - 1);
      let maxServerTime = sincePull;

      // Use local time for push (local writes use Date.now()) to avoid clock-skew.
      const sincePush = Math.max(0, (lastPushAtLocal ?? 0) - 1);
      const db = getStudyDb();
      const MAX_TS = Number.MAX_SAFE_INTEGER;

      for (const lib of mergedLibraries) {
        setPhase(`Preparing progress for “${lib.name}”…`);
        // Pull deckIds from local metadata for efficient IndexedDB queries.
        // If the in-memory deck isn't present, fall back to IndexedDB.
        const deckIdsFromLib = lib.deck?.decks?.map((d) => d.id) ?? [];
        const deckIds =
          deckIdsFromLib.length > 0
            ? deckIdsFromLib
            : (await db.decks.where("libraryId").equals(lib.id).toArray()).map((d) => d.deckId);

        // Backfill missing timestamps for older local rows.
        // If `updatedAt` is missing, IndexedDB compound-index queries won't return the row,
        // causing an empty push even though local progress exists.
        if (sincePush === 0) {
          await db.transaction("rw", db.decks, db.cardStates, async () => {
            await db.decks
              .where("libraryId")
              .equals(lib.id)
              .modify((d) => {
                const row = d as unknown as { updatedAt?: unknown; createdAt?: unknown };
                if (typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)) {
                  (d as unknown as { updatedAt: number }).updatedAt = 0;
                }
                if (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)) {
                  (d as unknown as { createdAt: number }).createdAt = 0;
                }
              });

            await db.cardStates
              .where("libraryId")
              .equals(lib.id)
              .modify((s) => {
                const row = s as unknown as { updatedAt?: unknown; createdAt?: unknown };
                if (typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)) {
                  (s as unknown as { updatedAt: number }).updatedAt = 0;
                }
                if (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)) {
                  (s as unknown as { createdAt: number }).createdAt = 0;
                }
              });
          });
        }

        const deckConfigs = await db.decks
          .where("[libraryId+updatedAt]")
          .between([lib.id, sincePush], [lib.id, MAX_TS], true, true)
          .toArray();

        const cardStates = await db.cardStates
          .where("[libraryId+updatedAt]")
          .between([lib.id, sincePush], [lib.id, MAX_TS], true, true)
          .toArray();

        // Never upload seeded states (updatedAt=0). Those are not real progress and
        // can cause duplicate-key write errors on new devices (cloud already has rows).
        const cardStatesForPush = cardStates.filter(
          (s) => typeof (s as { updatedAt?: unknown }).updatedAt === "number" && (s as { updatedAt: number }).updatedAt > 0
        );

        const reviewLogs: LocalReviewLogRow[] = [];
        for (const deckId of deckIds) {
          const batch = await db.reviewLogs
            .where("[libraryId+deckId+ts]")
            .between([lib.id, deckId, sincePush], [lib.id, deckId, MAX_TS], true, true)
            .toArray();
          reviewLogs.push(...(batch as unknown as LocalReviewLogRow[]));
        }

        // Best-effort: backfill missing syncKey for older local logs.
        const logsWithSyncKey = reviewLogs.map((l) => {
          const hadSyncKey = typeof l.syncKey === "string" && l.syncKey;
          const syncKey = hadSyncKey
            ? l.syncKey
            : computeReviewLogSyncKey({
                  libraryId: l.libraryId,
                  deckId: l.deckId,
                  cardId: l.cardId,
                  noteId: l.noteId,
                  ts: l.ts,
                  result: l.result,
                  timeTakenMs: l.timeTakenMs,
                  prevState: l.prevState,
                  nextState: l.nextState,
                  prevDue: l.prevDue,
                  nextDue: l.nextDue,
                  prevIntervalDays: l.prevIntervalDays,
                  nextIntervalDays: l.nextIntervalDays,
                  prevStepIndex: l.prevStepIndex,
                  nextStepIndex: l.nextStepIndex,
                  prevReps: l.prevReps,
                  nextReps: l.nextReps,
                  prevLapses: l.prevLapses,
                  nextLapses: l.nextLapses,
                });
          return { ...l, syncKey, hadSyncKey } as LocalReviewLogRow & { syncKey: string; hadSyncKey: boolean };
        });

        const reviewLogsForPush: ReviewLogPushPayload[] = logsWithSyncKey.map((l) => ({
          syncKey: l.syncKey,
          libraryId: l.libraryId,
          deckId: l.deckId,
          cardId: l.cardId,
          noteId: l.noteId,
          ts: l.ts,
          result: l.result,
          timeTakenMs: l.timeTakenMs,
          prevState: l.prevState,
          nextState: l.nextState,
          prevDue: l.prevDue,
          nextDue: l.nextDue,
          prevIntervalDays: l.prevIntervalDays,
          nextIntervalDays: l.nextIntervalDays,
          prevStepIndex: l.prevStepIndex,
          nextStepIndex: l.nextStepIndex,
          prevReps: l.prevReps,
          nextReps: l.nextReps,
          prevLapses: l.prevLapses,
          nextLapses: l.nextLapses,
        }));

        // Persist backfilled keys so future sync is fast/dedupable.
        await db.transaction("rw", db.reviewLogs, async () => {
          const toUpdate = logsWithSyncKey
            .filter((l) => !l.hadSyncKey)
            .filter((l) => typeof l.id === "number" && l.id > 0);
          if (toUpdate.length === 0) return;
          await Promise.all(
            toUpdate.map((l) => db.reviewLogs.update(l.id as number, { syncKey: l.syncKey }))
          );
        });

        // Push local changes to cloud.
        setPhase(`Pushing progress for “${lib.name}”…`);
        const pushRes = await fetchWithTimeout(
          "/api/sync/progress/push",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              libraryId: lib.id,
              cardStates: cardStatesForPush,
              reviewLogs: reviewLogsForPush,
              deckConfigs: deckConfigs
                .filter((d) => typeof (d as { updatedAt?: unknown }).updatedAt === "number" && (d as { updatedAt: number }).updatedAt > 0)
                .map((d) => ({
                libraryId: d.libraryId,
                deckId: d.deckId,
                newPerDay: d.newPerDay,
                reviewsPerDay: d.reviewsPerDay,
                cardInfoOpenByDefault: Boolean((d as { cardInfoOpenByDefault?: unknown }).cardInfoOpenByDefault),
                updatedAt: d.updatedAt,
              })),
            }),
          },
          120_000,
          "Progress push"
        );

        if (!pushRes.ok) {
          const errData: unknown = await pushRes.json().catch(() => null);
          const msg = (() => {
            if (!errData || typeof errData !== "object") return null;
            if (!("error" in errData)) return null;
            const err = (errData as { error?: unknown }).error;
            return typeof err === "string" ? err : null;
          })();
          throw new Error(msg ?? "Failed to sync progress to cloud");
        }

        if (devPurgeEnabled) {
          const pushData: unknown = await pushRes.json().catch(() => null);
          const received = (() => {
            if (!pushData || typeof pushData !== "object") return null;
            const raw = (pushData as { received?: unknown }).received;
            if (!raw || typeof raw !== "object") return null;
            const cs = (raw as { cardStates?: unknown }).cardStates;
            const rl = (raw as { reviewLogs?: unknown }).reviewLogs;
            return {
              cardStates: typeof cs === "number" ? cs : Number(cs),
              reviewLogs: typeof rl === "number" ? rl : Number(rl),
            };
          })();

          if (received && Number.isFinite(received.cardStates) && Number.isFinite(received.reviewLogs)) {
            advance(
              `Pushed progress for “${lib.name}”. (server received: ${received.cardStates} states, ${received.reviewLogs} logs)`
            );
          } else {
            advance(`Pushed progress for “${lib.name}”.`);
          }
        } else {
          advance(`Pushed progress for “${lib.name}”.`);
        }

        // Pull remote changes since last sync.
        setPhase(`Pulling progress for “${lib.name}”…`);
        const pullRes = await fetchWithTimeout(
          `/api/sync/progress/pull?libraryId=${encodeURIComponent(lib.id)}&since=${encodeURIComponent(
            String(sincePull)
          )}`,
          { cache: "no-store" },
          120_000,
          "Progress pull"
        );

        if (!pullRes.ok) {
          const errData: unknown = await pullRes.json().catch(() => null);
          const msg = (() => {
            if (!errData || typeof errData !== "object") return null;
            if (!("error" in errData)) return null;
            const err = (errData as { error?: unknown }).error;
            return typeof err === "string" ? err : null;
          })();
          throw new Error(msg ?? "Failed to sync progress from cloud");
        }

        const pullData: unknown = await pullRes.json().catch(() => null);

        const serverTime = (() => {
          if (!pullData || typeof pullData !== "object") return null;
          const raw = (pullData as { serverTime?: unknown }).serverTime;
          const n = typeof raw === "number" ? raw : Number(raw);
          return Number.isFinite(n) && n > 0 ? n : null;
        })();
        if (serverTime != null) maxServerTime = Math.max(maxServerTime, serverTime);

        const remoteCardStates: CardStateEntity[] = (() => {
          if (!pullData || typeof pullData !== "object") return [];
          const raw = (pullData as Partial<ProgressPullResponse>).cardStates;
          return Array.isArray(raw) ? (raw as CardStateEntity[]) : [];
        })();
        const remoteReviewLogs: ReviewLogPushPayload[] = (() => {
          if (!pullData || typeof pullData !== "object") return [];
          const raw = (pullData as Partial<ProgressPullResponse>).reviewLogs;
          return Array.isArray(raw) ? (raw as ReviewLogPushPayload[]) : [];
        })();

        const remoteDeckConfigs: ProgressPullResponse["deckConfigs"] = (() => {
          if (!pullData || typeof pullData !== "object") return [];
          const raw = (pullData as Partial<ProgressPullResponse>).deckConfigs;
          return Array.isArray(raw) ? (raw as ProgressPullResponse["deckConfigs"]) : [];
        })();

        const changedConfigDeckIds = new Set<number>();

        await db.transaction("rw", db.decks, db.cardStates, db.reviewLogs, async () => {
          if (remoteDeckConfigs.length > 0) {
            for (const cfg of remoteDeckConfigs) {
              if (!cfg || cfg.libraryId !== lib.id) continue;
              const deckId = typeof cfg.deckId === "number" ? cfg.deckId : Number(cfg.deckId);
              const updatedAt = typeof cfg.updatedAt === "number" ? cfg.updatedAt : Number(cfg.updatedAt);
              if (!Number.isFinite(deckId) || deckId <= 0) continue;
              if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;

              const local = await db.decks.get([lib.id, deckId]);
              const localUpdated = local?.updatedAt ?? 0;
              if (updatedAt <= localUpdated) continue;

              const name =
                local?.name ??
                (lib.deck?.decks?.find((d) => d.id === deckId)?.name ?? "");

              await db.decks.put({
                libraryId: lib.id,
                deckId,
                name,
                newPerDay: Math.max(0, Math.floor(Number(cfg.newPerDay) || 0)),
                reviewsPerDay: Math.max(0, Math.floor(Number(cfg.reviewsPerDay) || 0)),
                cardInfoOpenByDefault: Boolean((cfg as { cardInfoOpenByDefault?: unknown }).cardInfoOpenByDefault),
                answerStyles:
                  Array.isArray(local?.answerStyles) && local.answerStyles.length > 0
                    ? local.answerStyles
                    : DEFAULT_DECK_CONFIG.answerStyles,
                createdAt: local?.createdAt ?? updatedAt,
                updatedAt,
              });

              changedConfigDeckIds.add(deckId);
            }
          }

          if (remoteCardStates.length > 0) {
            const keys = remoteCardStates.map((s) => [s.libraryId, s.cardId] as [string, number]);
            const existing = await db.cardStates.bulkGet(keys);
            const toPut: CardStateEntity[] = [];
            for (let i = 0; i < remoteCardStates.length; i += 1) {
              const remote = remoteCardStates[i];
              const local = existing[i] ?? null;

              const shouldTakeRemote = (() => {
                if (!local) return true;

                const remoteUpdated = typeof remote.updatedAt === "number" ? remote.updatedAt : 0;
                const localUpdated = typeof local.updatedAt === "number" ? local.updatedAt : 0;
                if (remoteUpdated > localUpdated) return true;

                const remoteReps = typeof remote.reps === "number" ? remote.reps : 0;
                const localReps = typeof local.reps === "number" ? local.reps : 0;
                if (remoteReps > localReps) return true;

                const remoteLast = typeof remote.lastReview === "number" ? remote.lastReview : 0;
                const localLast = typeof local.lastReview === "number" ? local.lastReview : 0;
                if (remoteLast > localLast) return true;

                return false;
              })();

              if (shouldTakeRemote) toPut.push(remote);
            }
            if (toPut.length > 0) await db.cardStates.bulkPut(toPut);
          }

          if (remoteReviewLogs.length > 0) {
            const remote = remoteReviewLogs
              .map((l) => ({
                ...l,
                syncKey:
                  typeof l.syncKey === "string" && l.syncKey
                    ? l.syncKey
                    : computeReviewLogSyncKey(l),
              }))
              .filter((l) => l.libraryId === lib.id);

            const CHUNK = 500;
            const toAdd: ReviewLogPushPayload[] = [];

            for (let i = 0; i < remote.length; i += CHUNK) {
              const chunk = remote.slice(i, i + CHUNK);
              const keys = chunk.map((l) => [lib.id, l.syncKey] as [string, string]);
              const existing = await db.reviewLogs
                .where("[libraryId+syncKey]")
                .anyOf(keys)
                .toArray();
              const existingKeys = new Set(existing.map((e) => String(e.syncKey ?? "")));

              for (const l of chunk) {
                if (!existingKeys.has(l.syncKey)) toAdd.push(l);
              }
            }

            if (toAdd.length > 0) {
              await db.reviewLogs.bulkAdd(toAdd);
            }
          }
        });

        // Refresh cached UI overview for changed deck configs.
        if (changedConfigDeckIds.size > 0) {
          setPhase(`Applying deck settings for “${lib.name}”…`);
          const refs = Array.from(changedConfigDeckIds).map((deckId) => ({
            libraryId: lib.id,
            deckId,
          }));

          const overviews = await Promise.all(
            refs.map(async (ref) => {
              try {
                const ov = await getDeckOverview(ref);
                return [ref, ov] as const;
              } catch {
                return null;
              }
            })
          );

          setDeckOverviews((prev) => {
            const next = { ...prev };
            for (const entry of overviews) {
              if (!entry) continue;
              const key = `${entry[0].libraryId}:${entry[0].deckId}`;
              next[key] = entry[1];
            }
            return next;
          });

          if (reviewRef && reviewRef.libraryId === lib.id && changedConfigDeckIds.has(reviewRef.deckId)) {
            try {
              const cfg = await getDeckConfig(reviewRef);
              setReviewDeckConfig(cfg);
            } catch {
              // ignore
            }
          }
        }

        advance(`Pulled progress for “${lib.name}”.`);
      }

      // Refresh deck list stats now that IndexedDB has been updated.
      setPhase("Refreshing deck stats…");
      const pairs = mergedLibraries.flatMap((lib) =>
        (lib.deck?.decks ?? []).map((d) => ({
          key: `${lib.id}:${d.id}`,
          ref: { libraryId: lib.id, deckId: d.id } satisfies DeckRef,
        }))
      );

      const refreshed: Record<string, DeckOverview> = {};
      const CHUNK = 25;
      for (let i = 0; i < pairs.length; i += CHUNK) {
        const chunk = pairs.slice(i, i + CHUNK);
        const entries = await Promise.all(
          chunk.map(async ({ key, ref }) => {
            try {
              const ov = await getDeckOverview(ref);
              return [key, ov] as const;
            } catch {
              return null;
            }
          })
        );
        for (const e of entries) {
          if (!e) continue;
          refreshed[e[0]] = e[1];
        }
      }

      if (pairs.length > 0) {
        setDeckOverviews((prev) => ({ ...prev, ...refreshed }));
      }

      setPhase("Finalizing sync…");
      const serverTs = maxServerTime;
      const localTs = Date.now();
      setLastSyncAt(serverTs);
      setLastPushAtLocal(localTs);
      await saveLastState({
        libraries: mergedLibraries,
        activeLibraryId: activeLibraryId ?? (mergedLibraries[0]?.id ?? null),
        savedAt: Date.now(),
        lastSyncAt: serverTs,
        lastPushAtLocal: localTs,
      });

      advance("Sync complete.");

      if (uploadWarnings.length > 0) {
        reportError(uploadWarnings.join("\n"));
      }

      if (mergedLibraries.length === 0) {
        reportError("No decks found in cloud.");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Sync failed";
      reportError(msg);
    } finally {
      setSyncBusy(false);
      setSyncProgress(null);
    }
  }

  async function onClearSaved() {
    await clearLastState();
    await clearMedia();
    await clearApkg();
    await deleteStudyDb();
    setLibraries([]);
    setActiveLibraryId(null);
    setLastSyncAt(null);
    setLastPushAtLocal(null);
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

  const commitCardInfoDefaultOpen = useCallback(
    async (libraryId: string, deckId: number, next: boolean) => {
      await setDeckCardInfoOpenByDefault({ libraryId, deckId }, next);

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
              cardInfoOpenByDefault: Boolean(next),
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

  const commitDeckAnswerStyles = useCallback(
    async (libraryId: string, deckId: number, next: ReviewAnswerStyle[]) => {
      await setDeckAnswerStyles({ libraryId, deckId }, next);

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
              answerStyles: next,
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

    const nextPromise = getNextCard(ref, {
      learnAheadMs: 60 * 60 * 1000,
      learnAheadMode: "learn+relearn",
      excludeCardId,
    });

    const next = await nextPromise;
    if (loadNextSeqRef.current !== seq) return;
    setCurrent(next);
    setShowAnswer(false);

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

      const mcEnabled = cfg.answerStyles.includes("multiple-choice");
      if (mcEnabled) {
        try {
          const pool = await preloadMcAnswerPool(ref);
          setMcAnswerPool(pool);
          setMcAnswerPoolKey(`${ref.libraryId}:${ref.deckId}`);
        } catch {
          setMcAnswerPool([]);
          setMcAnswerPoolKey(null);
        }
      } else {
        setMcAnswerPool([]);
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
    });
  }, [current]);

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
    const shuffledDecoys = seededShuffle(mcDecoysForCard, `${seed}:decoys`);
    const pickedDecoys = shuffledDecoys.slice(0, 3);

    const correctKey = normalizeChoiceText(mcCorrectAnswer);
    const uniq: Array<{ label: string; key: string }> = [];
    const seen = new Set<string>();
    const add = (label: string) => {
      const key = normalizeChoiceText(label);
      if (!key) return;
      if (seen.has(key)) return;
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
  }, [currentId, mcCorrectAnswer, mcDecoysForCard]);

  const answerFieldSections = useMemo(() => {
    if (!current) return [];
    return inferFieldSectionsForHtml({
      html: current.card.backHtml,
      fieldsHtml: current.card.fieldsHtml,
      fieldNames: current.card.fieldNames,
    });
  }, [current]);

  const pinnedBackSections = useMemo(() => {
    if (!current) return [];
    return pickFieldSectionsByLabel({
      fieldsHtml: current.card.fieldsHtml,
      fieldNames: current.card.fieldNames,
      labelNormalizedInOrder: PINNED_BACK_FIELD_LABELS_NORMALIZED,
    });
  }, [current]);

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
    const shuffledDecoys = seededShuffle(reverseDecoysForCard, `${seed}:decoys`);
    const pickedDecoys = shuffledDecoys.slice(0, 3);

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
    const extrasAlphabet = Array.from("áéíóúüñ");
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
  }, [currentId, writeExpectedChars]);

  const writeUsed = useMemo(() => {
    return new Set(writePicked.map((p) => p.index));
  }, [writePicked]);

  const writeIsAvailable = reviewAnswerStyle === "write" && writeExpectedChars.length > 0;
  const mcCanRun = Boolean(mcCorrectAnswer) && mcDecoysForCard.length > 0;
  const reverseCanRun = Boolean(reversePromptHtml) && Boolean(reverseCorrectFront) && reverseDecoysForCard.length > 0;

  async function preloadMcAnswerPool(ref: DeckRef): Promise<string[]> {
    const db = getStudyDb();
    const cards = await db.cards
      .where("[libraryId+deckId]")
      .equals([ref.libraryId, ref.deckId])
      .limit(400)
      .toArray();

    const answers: string[] = [];
    const seen = new Set<string>();
    for (const c of cards) {
      const a = extractMultipleChoiceAnswerFromCard({
        frontHtml: c.frontHtml,
        backHtml: c.backHtml,
        fieldsHtml: c.fieldsHtml,
        fieldNames: c.fieldNames,
      });
      if (!a) continue;
      const key = normalizeChoiceText(a);
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      answers.push(a);
      if (answers.length >= 160) break;
    }
    return answers;
  }

  async function preloadReverseFrontPool(ref: DeckRef): Promise<string[]> {
    const db = getStudyDb();
    const cards = await db.cards
      .where("[libraryId+deckId]")
      .equals([ref.libraryId, ref.deckId])
      .limit(400)
      .toArray();

    const fronts: string[] = [];
    const seen = new Set<string>();
    for (const c of cards) {
      const a = extractReverseChoiceFromFrontHtml(c.frontHtml);
      if (!a) continue;
      const key = normalizeChoiceText(a);
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      fronts.push(a);
      if (fronts.length >= 220) break;
    }
    return fronts;
  }

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
        : ["normal", "write", "multiple-choice", "reverse"];

    const canWrite = writeExpectedChars.length > 0;
    const canMc = Boolean(mcCorrectAnswer) && mcDecoysForCard.length > 0;
    const canReverse = Boolean(reversePromptHtml) && Boolean(reverseCorrectFront) && reverseDecoysForCard.length > 0;

    const available: ReviewAnswerStyle[] = [];
    for (const s of enabledStyles) {
      if (s === "normal") available.push("normal");
      else if (s === "write" && canWrite) available.push("write");
      else if (s === "multiple-choice" && canMc) available.push("multiple-choice");
      else if (s === "reverse" && canReverse) available.push("reverse");
    }

    // Fallback: never block review just because a style can't run.
    if (available.length === 0) available.push("normal");

    const idx = Math.min(available.length - 1, Math.floor(rand01() * available.length));
    const chosen = available[idx] ?? "normal";
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
  ]);

  useEffect(() => {
    // Reset write state when the card changes or the user changes style.
    setWritePicked([]);
    setWriteOutcome(null);
    setMcOutcome(null);
    setReverseOutcome(null);
  }, [currentId, reviewAnswerStyle]);

  useEffect(() => {
    if (mode !== "review") return;
    if (reviewAnswerStyle !== "write") return;
    if (!current) return;
    if (showAnswer) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Backspace") return;
      if (writePicked.length === 0) return;
      e.preventDefault();
      setWritePicked((prev) => prev.slice(0, -1));
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, reviewAnswerStyle, currentId, current, showAnswer, writePicked.length]);

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
    });
  }, [current]);

  const answerFieldLabelsWithoutPinned = useMemo(() => {
    if (answerFieldLabels.length === 0) return [];
    const pinned = new Set(PINNED_BACK_FIELD_LABELS_NORMALIZED);
    return answerFieldLabels.filter((l) => !pinned.has(normalizeLabel(l)));
  }, [answerFieldLabels]);

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
    if (reviewAnswerStyle === "reverse") return;
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
  }, [mode, currentId, promotedSound?.filename, showAnswer, activeNamespace, reviewAnswerStyle]);

  useEffect(() => {
    if (mode !== "review") return;
    if (currentId == null) return;
    if (reviewAnswerStyle !== "reverse") return;
    if (!showAnswer) return;
    const filename = promotedSound?.filename;
    if (!filename) return;
    if (lastReverseRevealAutoPlayedCardIdRef.current === currentId) return;
    lastReverseRevealAutoPlayedCardIdRef.current = currentId;

    // Autoplay can be blocked by the browser; ignore failures.
    void (async () => {
      try {
        await tryPlayAudioFilename(activeNamespace, filename);
      } catch {
        // ignore
      }
    })();
  }, [mode, currentId, promotedSound?.filename, showAnswer, activeNamespace, reviewAnswerStyle]);

  useEffect(() => {
    if (mode !== "review") {
      lastAutoPlayedCardIdRef.current = null;
      lastReverseRevealAutoPlayedCardIdRef.current = null;
    }
  }, [mode]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-10">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Caliche Cards
            </h1>
            <p className="text-sm text-foreground/70">
              Import an Anki .apkg and review with Fail/Pass.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {authUser ? (
              <>
                <div className="rounded-full border border-foreground/15 px-3 py-2 text-xs text-foreground/70">
                  Last sync: {lastSyncAt ? new Date(lastSyncAt).toLocaleString() : "Never"}
                </div>

                {syncBusy && syncProgress ? (
                  <div className="max-w-55 truncate text-xs text-foreground/60" title={syncProgress.phase}>
                    {syncProgress.phase}
                  </div>
                ) : null}

                <button
                  type="button"
                  className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
                  onClick={() => void onSyncFromCloud()}
                  disabled={syncBusy || busy}
                  title={
                    syncBusy && syncProgress
                      ? syncProgress.phase
                      : "Download your decks from the cloud and rebuild local storage"
                  }
                >
                  {(() => {
                    if (!syncBusy) return "Sync";
                    const total = syncProgress?.total ?? 1;
                    const done = syncProgress?.done ?? 0;
                    const pct = Math.max(
                      0,
                      Math.min(100, Math.floor((done / Math.max(1, total)) * 100))
                    );
                    return `Syncing… ${pct}%`;
                  })()}
                </button>

                {devPurgeEnabled ? (
                  <button
                    type="button"
                    className="rounded-full border border-foreground/15 px-4 py-2 text-sm hover:bg-red-500/5 hover:border-red-500 hover:text-red-500"
                    onClick={onDevPurgeOtherUsers}
                    disabled={busy || syncBusy}
                    title="DEV ONLY: purge other userIds from MongoDB"
                  >
                    Purge other users
                  </button>
                ) : null}

                {devPurgeEnabled ? (
                  <button
                    type="button"
                    className="rounded-full border border-foreground/15 px-4 py-2 text-sm hover:bg-red-500/5 hover:border-red-500 hover:text-red-500"
                    onClick={onDevResetMyCloud}
                    disabled={busy || syncBusy}
                    title="DEV ONLY: delete ALL cloud data for your current user"
                  >
                    Reset my cloud
                  </button>
                ) : null}

                {devPurgeEnabled ? (
                  <button
                    type="button"
                    className="rounded-full border border-foreground/15 px-4 py-2 text-sm hover:bg-foreground/5"
                    onClick={onDevDebugLocalProgress}
                    disabled={busy || syncBusy}
                    title="DEV ONLY: show local progress counts"
                  >
                    Debug local progress
                  </button>
                ) : null}

                {devPurgeEnabled ? (
                  <button
                    type="button"
                    className="rounded-full border border-foreground/15 px-4 py-2 text-sm hover:bg-foreground/5"
                    onClick={onDevDebugCloudProgress}
                    disabled={busy || syncBusy}
                    title="DEV ONLY: show cloud progress counts for the current user"
                  >
                    Debug cloud progress
                  </button>
                ) : null}

                <button
                  type="button"
                  className="rounded-full border border-foreground/15 px-4 py-2 text-sm hover:bg-red-500/5 hover:border-red-500 hover:text-red-500"
                  onClick={onLogout}
                >
                  Logout
                </button>
              </>
            ) : authUser === null ? (
              <>
                <div className="rounded-full border border-foreground/30 bg-foreground/5 px-3 py-2 text-xs font-semibold uppercase tracking-wide">
                  Guest / Test mode
                </div>
                <button
                  type="button"
                  className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
                  onClick={() => void onLoadDemoDecks()}
                  disabled={syncBusy || busy}
                  title="Load demo decks from the test account"
                >
                  {syncBusy ? "Loading…" : "Load demo decks"}
                </button>
                <button
                  type="button"
                  className="rounded-full border border-foreground/15 px-4 py-2 text-sm hover:bg-foreground/5"
                  onClick={() => {
                    window.location.href = "/login";
                  }}
                >
                  Log in
                </button>
              </>
            ) : (
              <div className="rounded-full border border-foreground/15 px-3 py-2 text-xs text-foreground/70">
                Checking session…
              </div>
            )}

            {uiLibraries.length > 0 ? (
              <button
                type="button"
                className="rounded-full border border-foreground/15 px-4 py-2 text-sm text-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                onClick={onClearSaved}
              >
                Clear all
              </button>
            ) : null}
          </div>
        </header>

        {authUser === null ? (
          <div className="rounded-2xl border border-foreground/30 bg-foreground/5 px-4 py-3 text-sm">
            <div className="font-semibold uppercase tracking-wide">Guest / Test mode</div>
            <div className="mt-1 text-foreground/70">
              You’re viewing demo decks from a test account. Your progress stays on this device only.
            </div>
          </div>
        ) : null}

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

              {uiLibraries.length === 0 ? (
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
                    {uiLibraries.flatMap((lib) => {
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
                              className={`min-w-0 text-left ${syncBusy ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
                              onClick={() => startReviewFor(lib.id, d.id)}
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
                                <div className="absolute right-0 top-12 z-10 w-56 rounded-xl border border-foreground/15 bg-background p-1 shadow-sm">
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

                                  <div className="px-3 py-2">
                                    <label className="flex items-center justify-between gap-3 text-xs text-foreground/70">
                                      <span>Card info open</span>
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4"
                                        checked={Boolean(overview?.config.cardInfoOpenByDefault)}
                                        onChange={(e) => {
                                          void commitCardInfoDefaultOpen(
                                            lib.id,
                                            d.id,
                                            e.currentTarget.checked
                                          );
                                        }}
                                      />
                                    </label>
                                  </div>

                                  <div className="px-3 py-2">
                                    <div className="text-xs text-foreground/70">Type of cards</div>
                                    {(
                                      [
                                        { id: "normal" as const, label: "Normal" },
                                        { id: "write" as const, label: "Write" },
                                        { id: "multiple-choice" as const, label: "Multiple-choice" },
                                        { id: "reverse" as const, label: "Reverse" },
                                      ] satisfies Array<{ id: ReviewAnswerStyle; label: string }>
                                    ).map((opt) => {
                                      const currentStyles = (overview?.config.answerStyles ?? [
                                        "normal",
                                        "write",
                                        "multiple-choice",
                                        "reverse",
                                      ]) as ReviewAnswerStyle[];
                                      const checked = currentStyles.includes(opt.id);

                                      return (
                                        <label
                                          key={opt.id}
                                          className="mt-2 flex items-center justify-between gap-3 text-xs text-foreground/70"
                                        >
                                          <span>{opt.label}</span>
                                          <input
                                            type="checkbox"
                                            className="h-4 w-4"
                                            checked={checked}
                                            onChange={(e) => {
                                              const wants = e.currentTarget.checked;
                                              const next = (() => {
                                                const base = new Set<ReviewAnswerStyle>(currentStyles);
                                                if (wants) base.add(opt.id);
                                                else base.delete(opt.id);
                                                const arr = Array.from(base);
                                                return arr.length > 0 ? arr : (["normal"] as ReviewAnswerStyle[]);
                                              })();
                                              void commitDeckAnswerStyles(lib.id, d.id, next);
                                            }}
                                          />
                                        </label>
                                      );
                                    })}
                                  </div>

                                  <button
                                    type="button"
                                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-red-500 hover:bg-foreground/5"
                                    onClick={() => {
                                      setOpenDeckMenu(null);
                                      void onResetDeckProgress({
                                        libraryId: lib.id,
                                        deckId: d.id,
                                        deckName: d.name,
                                      });
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
                                      const ok = confirm(
                                        `Delete “${d.name}” and its subdecks?`
                                      );
                                      if (!ok) return;
                                      void deleteDeck(lib.id, d.id);
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
                    New/day: {reviewOverview?.config.newPerDay ?? "—"} • Review/day: {reviewOverview?.config.reviewsPerDay ?? "—"}
                    {reviewOverview
                      ? ` • Words: ${reviewOverview.reviewed}/${reviewOverview.total}`
                      : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-sm text-foreground/70">
                    Due:{" "}
                    {reviewOverview
                      ? reviewOverview.learningDue + reviewOverview.reviewShown
                      : 0}
                    {reviewOverview ? (
                      <>
                        {" "}• New: {reviewOverview.newShown}
                        {" "}• Learning: {reviewOverview.learningDue}
                        {" "}• Review: {reviewOverview.reviewShown}
                      </>
                    ) : null}
                    {reviewOverview && reviewOverview.learningWaiting > 0 ? (
                      <> {" "}• Waiting: {reviewOverview.learningWaiting}</>
                    ) : null}
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

              {/* Answer style is randomized per card (from enabled styles). */}

              {current ? (
                <div className="relative overflow-hidden rounded-3xl border border-foreground/15 bg-foreground/5 p-6">
                  {currentTimingTag ? (
                    <div className="absolute left-4 top-4 text-xs text-foreground/60">
                      <span
                        className={`font-semibold ${
                          currentTimingTag.kind === "new"
                            ? "text-blue-400"
                            : currentTimingTag.kind === "due"
                              ? "text-yellow-500"
                              : "text-foreground"
                        }`}
                      >
                        {currentTimingTag.label}
                      </span>
                      {currentTimingTag.detail ? (
                        <span className="text-foreground/60"> {currentTimingTag.detail}</span>
                      ) : null}
                    </div>
                  ) : null}

                  {promotedSound?.filename ? (
                    <div className="absolute right-4 top-4">
                      <SoundButton
                        namespace={activeNamespace}
                        filename={promotedSound.filename}
                        variant="icon"
                        disabled={isReverseAudioLocked}
                      />
                    </div>
                  ) : null}

                  <div className="flex flex-col gap-6">
                    {reviewAnswerStyle === "write" && !showAnswer ? (
                      <div className="py-6">
                        <div className="text-center text-sm text-foreground/70">
                          Click (or Tab to) the letters to write the word
                        </div>
                        {writeOutcome != null ? (
                          <div
                            className={`mt-2 text-center text-sm font-medium ${
                              writeOutcome === "correct"
                                ? "text-green-500"
                                : "text-red-400"
                            }`}
                          >
                            {writeOutcome === "correct" ? "Correct" : "Wrong"}
                          </div>
                        ) : null}
                        {!writeIsAvailable ? (
                          <div className="mt-3 text-center text-sm text-foreground/70">
                            Write mode isn’t available for this card.
                          </div>
                        ) : (
                          <>
                            <div className="mt-4 flex justify-center">
                              <div className="min-h-14 rounded-2xl border border-foreground/15 bg-background px-5 py-3 text-center text-3xl font-semibold tracking-widest">
                                {writePicked.length > 0 ? (
                                  <div className="flex flex-wrap justify-center gap-2">
                                    {writePicked.map((p, pickedIdx) => (
                                      <button
                                        key={`picked-${currentId ?? ""}-${pickedIdx}-${p.index}-${p.ch}`}
                                        type="button"
                                        disabled={reviewBusy || writeOutcome != null}
                                        onClick={() => {
                                          if (reviewBusy) return;
                                          if (writeOutcome != null) return;
                                          setWritePicked((prev) =>
                                            prev.filter((_, i) => i !== pickedIdx)
                                          );
                                        }}
                                        title="Remove"
                                        aria-label={p.ch === " " ? "Remove space" : `Remove ${p.ch}`}
                                        className="inline-flex h-10 min-w-10 items-center justify-center rounded-2xl border border-foreground/15 bg-foreground/5 px-2 text-lg hover:bg-foreground/10 disabled:opacity-50 sm:h-12 sm:min-w-12 sm:px-3 sm:text-2xl"
                                      >
                                        {p.ch === " " ? "␣" : p.ch}
                                      </button>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-foreground/30">…</span>
                                )}
                              </div>
                            </div>

                            <div className="mt-3 flex justify-center">
                              <button
                                type="button"
                                className="h-11 rounded-full bg-foreground px-6 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
                                disabled={
                                  reviewBusy ||
                                  !writeIsAvailable ||
                                  writePicked.length === 0 ||
                                  writeOutcome != null
                                }
                                onClick={() => {
                                  if (!writeIsAvailable) return;
                                  if (writePicked.length === 0) return;
                                  if (writeOutcome != null) return;

                                  const expected = writeExpectedChars.join("");
                                  const answer = writePicked.map((p) => p.ch).join("");
                                  const ok =
                                    answer.normalize("NFKC").toLowerCase() ===
                                    expected.normalize("NFKC").toLowerCase();

                                  setWriteOutcome(ok ? "correct" : "wrong");
                                }}
                              >
                                Submit
                              </button>
                            </div>

                            <div className="mt-4 flex flex-wrap justify-center gap-2">
                              {writeBank.map((ch, idx) => {
                                const used = writeUsed.has(idx);
                                return (
                                  <button
                                    key={`write-${currentId ?? ""}-${idx}-${ch}`}
                                    type="button"
                                    disabled={reviewBusy || used || writeOutcome != null}
                                    onClick={() => {
                                      if (reviewBusy) return;
                                      if (used) return;
                                      if (writeOutcome != null) return;
                                      setWritePicked((prev) => [...prev, { index: idx, ch }]);
                                    }}
                                    className={`h-12 w-12 rounded-2xl border border-foreground/15 text-lg font-semibold hover:bg-foreground/5 disabled:opacity-40 ${
                                      used ? "bg-foreground/5" : "bg-background"
                                    }`}
                                  >
                                    {ch === " " ? "␣" : ch}
                                  </button>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </div>
                    ) : reviewAnswerStyle === "reverse" && !showAnswer ? (
                      <div className="py-10">
                        <CardFace
                          namespace={activeNamespace}
                          html={reversePromptHtml ?? current.card.backHtml}
                          suppressFirstSoundFilename={
                            promotedSound?.source === "back"
                              ? promotedSound.filename
                              : null
                          }
                          soundDisabled={isReverseAudioLocked}
                          className="text-center text-xl leading-8"
                        />
                      </div>
                    ) : (
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
                    )}

                    {reviewAnswerStyle === "multiple-choice" && !showAnswer ? (
                      <div className="pb-2">
                        <div className="text-center text-sm text-foreground/70">
                          Choose the correct answer
                        </div>
                        {mcOutcome != null ? (
                          <div
                            className={`mt-2 text-center text-sm font-medium ${
                              mcOutcome === "correct"
                                ? "text-green-500"
                                : "text-red-400"
                            }`}
                          >
                            {mcOutcome === "correct" ? "Correct" : "Wrong"}
                          </div>
                        ) : null}
                        {!mcCanRun ? (
                          <div className="mt-3 text-center text-sm text-foreground/70">
                            Multiple-choice isn’t available for this card.
                          </div>
                        ) : (
                          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {mcOptions.map((opt, idx) => (
                              <button
                                key={`mc-${currentId ?? ""}-${idx}-${opt.label}`}
                                type="button"
                                disabled={reviewBusy || mcOutcome != null}
                                onClick={() => {
                                  if (reviewBusy) return;
                                  if (mcOutcome != null) return;

                                  const ok = Boolean(opt.isCorrect);
                                  setMcOutcome(ok ? "correct" : "wrong");
                                }}
                                className="min-h-12 rounded-2xl border border-foreground/15 bg-background px-4 py-3 text-left text-base font-medium hover:bg-foreground/5 disabled:opacity-60"
                              >
                                <span className="mr-2 text-foreground/60">
                                  {String.fromCharCode(65 + (idx % 26))}.
                                </span>
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null}

                    {reviewAnswerStyle === "reverse" && !showAnswer ? (
                      <div className="pb-2">
                        <div className="text-center text-sm text-foreground/70">
                          Choose the correct front
                        </div>
                        {reverseOutcome != null ? (
                          <div
                            className={`mt-2 text-center text-sm font-medium ${
                              reverseOutcome === "correct"
                                ? "text-green-500"
                                : "text-red-400"
                            }`}
                          >
                            {reverseOutcome === "correct" ? "Correct" : "Wrong"}
                          </div>
                        ) : null}

                        {!reverseCanRun ? (
                          <div className="mt-3 text-center text-sm text-foreground/70">
                            Reverse mode isn’t available for this card.
                          </div>
                        ) : (
                          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {reverseOptions.map((opt, idx) => (
                              <button
                                key={`rev-${currentId ?? ""}-${idx}-${opt.label}`}
                                type="button"
                                disabled={reviewBusy || reverseOutcome != null}
                                onClick={() => {
                                  if (reviewBusy) return;
                                  if (reverseOutcome != null) return;

                                  const ok = Boolean(opt.isCorrect);
                                  setReverseOutcome(ok ? "correct" : "wrong");
                                }}
                                className="min-h-12 rounded-2xl border border-foreground/15 bg-background px-4 py-3 text-left text-base font-medium hover:bg-foreground/5 disabled:opacity-60"
                              >
                                <span className="mr-2 text-foreground/60">
                                  {String.fromCharCode(65 + (idx % 26))}.
                                </span>
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null}

                    {showAnswer ? (
                      <div className="border-t border-foreground/15 pt-6">
                        <>
                          {pinnedBackSections.length > 0 ? (
                            <div className="mb-6 flex flex-col gap-4">
                              {pinnedBackRender.sections.map((sec) => (
                                <div key={`pinned-${sec.index}-${sec.label}`}>
                                  <div className="mb-1 text-xs text-center font-medium text-foreground/60">
                                    {sec.label}:
                                  </div>
                                  <CardFace
                                    namespace={activeNamespace}
                                    html={sec.valueHtml}
                                    suppressFirstSoundFilename={sec.suppressFirstSoundFilename}
                                    className="text-center text-xl leading-8"
                                  />
                                </div>
                              ))}
                            </div>
                          ) : null}

                          {answerFieldSectionsWithoutPinned.length > 0 ? (
                            <div className="flex flex-col gap-4">
                              {answerFieldSectionsWithoutPinned.map((sec, idx) => (
                                <div key={`${sec.index}-${sec.label}`}>
                                  <div className="mb-1 text-xs text-center font-medium text-foreground/60">
                                    {sec.label}:
                                  </div>
                                  <CardFace
                                    namespace={activeNamespace}
                                    html={sec.valueHtml}
                                    suppressFirstSoundFilename={
                                      idx === 0 &&
                                      !pinnedBackRender.didSuppressPromotedBackSound &&
                                      promotedSound?.source === "back"
                                        ? promotedSound.filename
                                        : null
                                    }
                                    className="text-center text-xl leading-8"
                                  />
                                </div>
                              ))}
                            </div>
                          ) : (
                            <>
                              {answerFieldLabelsWithoutPinned.length > 0 ? (
                                <div className="mb-3 text-xs font-medium text-foreground/60">
                                  {answerFieldLabelsWithoutPinned.join(" • ")}
                                </div>
                              ) : null}
                              {pinnedBackSections.length === 0 ? (
                                <CardFace
                                  namespace={activeNamespace}
                                  html={current.card.backHtml}
                                  suppressFirstSoundFilename={
                                    !pinnedBackRender.didSuppressPromotedBackSound &&
                                    promotedSound?.source === "back"
                                      ? promotedSound.filename
                                      : null
                                  }
                                  className="text-center text-xl leading-8"
                                />
                              ) : null}
                            </>
                          )}
                        </>
                      </div>
                    ) : null}

                    {showAnswer ? (
                      <FieldsList
                        key={`${activeNamespace}:${reviewRef?.deckId ?? current.card.deckId}`}
                        namespace={activeNamespace}
                        fields={current.card.fieldsHtml}
                        names={current.card.fieldNames}
                        defaultOpen={Boolean(reviewDeckConfig?.cardInfoOpenByDefault)}
                      />
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-foreground/15 bg-foreground/5 px-4 py-6 text-center">
                  <div className="text-lg font-semibold">All done for today!</div>
                  <div className="mt-1 text-sm text-foreground/70">
                    {reviewOverview?.nextAvailableTs != null || reviewOverview?.nextDueTs != null ? (
                      (() => {
                        const nextTs = reviewOverview?.nextAvailableTs ?? reviewOverview?.nextDueTs ?? nowTs;
                        const inLabel = formatIn(nextTs, nowTs);
                        const atLabel = new Date(nextTs).toLocaleTimeString();
                        const waiting = reviewOverview.learningWaiting;
                        return (
                          <>
                            Next card in <span className="font-medium">{inLabel}</span>
                            <span className="text-foreground/60"> (at {atLabel})</span>
                            {waiting > 0 ? (
                              <>
                                {" "}• Waiting: <span className="font-medium">{waiting}</span>
                              </>
                            ) : null}
                          </>
                        );
                      })()
                    ) : (
                      <>No more cards ready (or you hit today’s limits).</>
                    )}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-3 sm:flex-row">
                {current ? (
                  !showAnswer ? (
                    reviewAnswerStyle === "normal" ||
                    (reviewAnswerStyle === "write" && !writeIsAvailable) ||
                    (reviewAnswerStyle === "multiple-choice" && !mcCanRun) ||
                    (reviewAnswerStyle === "reverse" && !reverseCanRun) ||
                    (reviewAnswerStyle === "write" && writeOutcome != null) ||
                    (reviewAnswerStyle === "multiple-choice" && mcOutcome != null) ||
                    (reviewAnswerStyle === "reverse" && reverseOutcome != null) ? (
                      <button
                        type="button"
                        className="h-12 flex-1 rounded-full bg-foreground px-5 text-sm font-medium text-background hover:opacity-90"
                        onClick={() => setShowAnswer(true)}
                        disabled={reviewBusy}
                      >
                        {reviewAnswerStyle === "write" && writeOutcome != null
                          ? "Reveal answer"
                          : reviewAnswerStyle === "multiple-choice" &&
                              mcOutcome != null
                            ? "Reveal answer"
                            : reviewAnswerStyle === "reverse" &&
                                reverseOutcome != null
                              ? "Reveal answer"
                            : "Show answer"}
                      </button>
                    ) : null
                  ) : (
                    <>
                      <button
                        type="button"
                        className="h-12 flex-1 rounded-full border border-red-500 px-5 text-sm font-medium text-red-500 hover:bg-red-500 hover:text-background disabled:pointer-events-none disabled:border-foreground/20 disabled:bg-foreground/5 disabled:text-foreground/40"
                        onClick={() => void onAnswer("fail")}
                        disabled={
                          reviewBusy ||
                          (reviewAnswerStyle === "multiple-choice" && mcOutcome === "correct")
                          || (reviewAnswerStyle === "reverse" && reverseOutcome === "correct")
                        }
                      >
                        Fail{nextDueLabels ? ` • ${nextDueLabels.fail}` : ""}
                      </button>
                      <button
                        type="button"
                        className="h-12 flex-1 rounded-full border border-green-500 px-5 text-sm font-medium text-green-500 hover:bg-green-500 hover:text-background disabled:pointer-events-none disabled:border-foreground/20 disabled:bg-foreground/5 disabled:text-foreground/40"
                        onClick={() => void onAnswer("pass")}
                        disabled={
                          reviewBusy ||
                          (reviewAnswerStyle === "write" && writeOutcome === "wrong") ||
                          (reviewAnswerStyle === "multiple-choice" && mcOutcome === "wrong") ||
                          (reviewAnswerStyle === "reverse" && reverseOutcome === "wrong")
                        }
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