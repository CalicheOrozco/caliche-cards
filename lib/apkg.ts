export type ImportedDeck = {
  decks: Array<{ id: number; name: string }>;
  cards: ImportedCard[];
};

export type ImportedCard = {
  id: number;
  deckId: number;
  noteId: number;
  frontHtml: string;
  backHtml: string;
  fieldsHtml: string[];
  fieldNames: string[];
};

type SqlJsModule = {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
};

type SqlJsDatabase = {
  exec: (
    sql: string,
    params?: unknown[]
  ) => Array<{ columns: string[]; values: unknown[][] }>;
  close: () => void;
};

function toArray<T>(value: unknown): T[] | null {
  if (Array.isArray(value)) return value as T[];
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return null;
  }

  try {
    // Handles iterables + array-like objects.
    return Array.from(value as ArrayLike<T>) as T[];
  } catch {
    return null;
  }
}

function toRowArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return null;
  }
  try {
    return Array.from(value as ArrayLike<unknown>);
  } catch {
    return null;
  }
}

let sqlJsPromise: Promise<SqlJsModule> | null = null;

async function getSqlJs(): Promise<SqlJsModule> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      const initSqlJs = (await import("sql.js")).default as unknown as (
        config: {
          locateFile: (file: string) => string;
          wasmBinary?: Uint8Array;
        }
      ) => Promise<SqlJsModule>;

      let wasmBinary: Uint8Array | undefined;
      try {
        const resp = await fetch("/sql-wasm.wasm");
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          wasmBinary = new Uint8Array(buf);
        }
      } catch {
        // ignore; initSqlJs will try fetching via locateFile
      }

      return initSqlJs({
        locateFile: (file) => `/${file}`,
        wasmBinary,
      });
    })();
  }

  return sqlJsPromise;
}

function getTextFieldPair(flds: string): { front: string; back: string } {
  const parts = flds.split("\u001f");
  const p0 = parts[0] ?? "";
  const p1 = parts[1] ?? "";

  const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").trim();
  const isNumericOnly = (s: string) => /^\d+(?:[.,]\d+)?$/.test(stripTags(s));

  // Common in some shared decks: first field is a numeric index ("1", "2", ...)
  // and the actual prompt/answer are in the next fields.
  if (isNumericOnly(p0) && p1) {
    const front = p1;

    // Many decks store meanings/definitions starting at field index 4.
    const meaningFields = parts.slice(4).filter((s) => (s ?? "").trim() !== "");
    const back =
      meaningFields.length > 0
        ? meaningFields.join("<br/>")
        : (parts.slice(2).filter((s) => (s ?? "").trim() !== "").join("<br/>") || "");

    return { front, back };
  }

  const front = p0;
  const back = p1;

  if (front || back) return { front, back };
  return { front: parts.join("\n\n"), back: "" };
}

function execFirstCell(db: SqlJsDatabase, sql: string): unknown {
  let res: Array<{ columns: string[]; values: unknown[][] }>;
  try {
    res = db.exec(sql);
  } catch {
    return undefined;
  }

  const first = res?.[0] as unknown as { values?: unknown };
  const values = toArray<unknown>(first?.values);
  const row = values ? toRowArray(values[0]) : null;
  return row?.[0];
}

function isSQLiteFile(bytes: Uint8Array) {
  // "SQLite format 3\0" header
  if (bytes.length < 16) return false;
  const header = String.fromCharCode(...bytes.slice(0, 16));
  return header === "SQLite format 3\u0000";
}

function guessAudioMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  return "application/octet-stream";
}

function extractSoundFilenames(html: string): string[] {
  const out: string[] = [];
  const re = /\[sound:([^\]]+)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const name = (match[1] ?? "").trim();
    if (name) out.push(name);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findZipFile(
  zip: { file(path: string): unknown; file(path: RegExp): unknown[] },
  name: string
): unknown {
  const direct = zip.file(name);
  if (direct) return direct;

  const matches = zip.file(new RegExp(`(^|/)${escapeRegExp(name)}$`, "i"));
  return matches?.[0] ?? null;
}

function coerceMediaFilename(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const firstString = value.find((v) => typeof v === "string") as
      | string
      | undefined;
    return firstString ?? null;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const candidates = [obj.filename, obj.fname, obj.name, obj.file];
    const found = candidates.find((v) => typeof v === "string") as
      | string
      | undefined;
    return found ?? null;
  }
  return null;
}

function parseBinaryMediaMap(bytes: Uint8Array): Map<string, string> {
  // Observed format (after zstd decompress):
  //   \n<ascii digits>\n<len byte><filename bytes>...
  // Example: 0x0a 0x30 0x0a 0x14 'E' 'N' 'P' 'V' ...
  const map = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: false });

  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0x0a) {
      i += 1;
      continue;
    }
    i += 1;

    // Read key digits until next LF.
    const keyStart = i;
    while (i < bytes.length && bytes[i] !== 0x0a) {
      i += 1;
    }
    if (i >= bytes.length) break;

    const keyBytes = bytes.slice(keyStart, i);
    const keyStr = decoder.decode(keyBytes).trim();
    i += 1; // skip LF

    if (!keyStr || !/^\d+$/.test(keyStr)) {
      continue;
    }
    if (i >= bytes.length) break;

    const nameLen = bytes[i] ?? 0;
    i += 1;
    if (nameLen <= 0 || i + nameLen > bytes.length) {
      continue;
    }

    const nameBytes = bytes.slice(i, i + nameLen);
    i += nameLen;

    const name = decoder.decode(nameBytes).trim();
    if (name) {
      map.set(name, keyStr);
    }
  }

  return map;
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let i = offset;

  while (i < bytes.length) {
    const b = bytes[i] as number;
    value |= (b & 0x7f) << shift;
    i += 1;
    if ((b & 0x80) === 0) {
      return { value, offset: i };
    }
    shift += 7;
    if (shift > 35) {
      throw new Error("protobuf varint too large");
    }
  }

  throw new Error("protobuf varint truncated");
}

function skipProtobufWireValue(
  bytes: Uint8Array,
  offset: number,
  wireType: number
): number {
  switch (wireType) {
    case 0: {
      const v = readVarint(bytes, offset);
      return v.offset;
    }
    case 1:
      return offset + 8;
    case 2: {
      const len = readVarint(bytes, offset);
      return len.offset + len.value;
    }
    case 5:
      return offset + 4;
    default:
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
}

function decodeMediaEntryNameFromProtobuf(bytes: Uint8Array): string {
  // Matches `anki.import_export.MediaEntries.MediaEntry` in Anki's
  // `proto/anki/import_export.proto`.
  // We only need field 1: `string name = 1;`
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let i = 0;
  while (i < bytes.length) {
    const key = readVarint(bytes, i);
    i = key.offset;
    const fieldNumber = key.value >>> 3;
    const wireType = key.value & 0x7;

    if (fieldNumber === 1 && wireType === 2) {
      const len = readVarint(bytes, i);
      i = len.offset;
      const end = i + len.value;
      if (end > bytes.length) {
        throw new Error("protobuf string out of bounds");
      }
      return decoder.decode(bytes.subarray(i, end));
    }

    i = skipProtobufWireValue(bytes, i, wireType);
    if (i > bytes.length) {
      throw new Error("protobuf field out of bounds");
    }
  }
  return "";
}

function decodeMediaEntriesFromProtobuf(bytes: Uint8Array): string[] {
  // Matches `anki.import_export.MediaEntries` in Anki's
  // `proto/anki/import_export.proto`.
  // We only need field 1: `repeated MediaEntry entries = 1;`
  const names: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const key = readVarint(bytes, i);
    i = key.offset;
    const fieldNumber = key.value >>> 3;
    const wireType = key.value & 0x7;

    if (fieldNumber === 1 && wireType === 2) {
      const len = readVarint(bytes, i);
      i = len.offset;
      const end = i + len.value;
      if (end > bytes.length) {
        throw new Error("protobuf embedded message out of bounds");
      }
      const entryBytes = bytes.subarray(i, end);
      const name = decodeMediaEntryNameFromProtobuf(entryBytes).trim();
      if (name) names.push(name);
      i = end;
      continue;
    }

    i = skipProtobufWireValue(bytes, i, wireType);
    if (i > bytes.length) {
      throw new Error("protobuf field out of bounds");
    }
  }
  return names;
}

async function parseApkgMediaBytes(
  mediaBytes: Uint8Array
): Promise<{ map: Map<string, string>; how: string }> {
  // 1) Try legacy JSON directly.
  {
    const rawUtf8 = decodeText(mediaBytes, "utf-8");
    if (looksLikeJsonText(rawUtf8)) {
      const jsonMap = parseApkgMediaMap(rawUtf8);
      if (jsonMap.size > 0) return { map: jsonMap, how: "utf-8+json" };
    }
  }

  // 2) Try zstd → JSON/protobuf.
  let zstdBytes: Uint8Array | null = null;
  try {
    const maybe = await maybeDecompressZstd(mediaBytes);
    if (maybe !== mediaBytes) zstdBytes = maybe;
  } catch {
    // ignore
  }

  if (zstdBytes) {
    // 2a) Some legacy-ish exports may still be JSON but compressed.
    const zstdUtf8 = decodeText(zstdBytes, "utf-8");
    if (looksLikeJsonText(zstdUtf8)) {
      const jsonMap = parseApkgMediaMap(zstdUtf8);
      if (jsonMap.size > 0) return { map: jsonMap, how: "zstd+json" };
    }

    // 2b) Modern exports: zstd-compressed protobuf MediaEntries.
    try {
      const names = decodeMediaEntriesFromProtobuf(zstdBytes);
      if (names.length > 0) {
        const map = new Map<string, string>();
        for (let idx = 0; idx < names.length; idx += 1) {
          map.set(names[idx] as string, String(idx));
        }
        return { map, how: "zstd+protobuf" };
      }
    } catch {
      // ignore
    }

    // 2c) Last-resort heuristic for unknown formats.
    const binaryMap = parseBinaryMediaMap(zstdBytes);
    if (binaryMap.size > 0) return { map: binaryMap, how: "zstd+binary-heuristic" };
  }

  // 3) Try protobuf without compression (unlikely, but cheap).
  try {
    const names = decodeMediaEntriesFromProtobuf(mediaBytes);
    if (names.length > 0) {
      const map = new Map<string, string>();
      for (let idx = 0; idx < names.length; idx += 1) {
        map.set(names[idx] as string, String(idx));
      }
      return { map, how: "protobuf" };
    }
  } catch {
    // ignore
  }

  // 4) Fallbacks for JSON that isn't UTF-8 (gzip/utf-16, etc).
  const decoded = await decodeMediaFileToText(mediaBytes);
  const decodedMap = parseApkgMediaMap(decoded.text);
  if (decodedMap.size > 0) {
    return { map: decodedMap, how: `${decoded.how}+json` };
  }

  return { map: new Map(), how: "unknown" };
}

function parseApkgMediaMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const normalized = text.replace(/^\uFEFF/, "");
  const trimmed = normalized.trim();
  if (!trimmed) return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return map;
  }

  if (Array.isArray(parsed)) {
    parsed.forEach((v, idx) => {
      const name = coerceMediaFilename(v);
      if (!name) return;
      map.set(String(name).trim(), String(idx));
    });
    return map;
  }

  if (parsed && typeof parsed === "object") {
    for (const [keyRaw, valueRaw] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      const name = coerceMediaFilename(valueRaw);
      if (!name) continue;
      map.set(String(name).trim(), String(keyRaw).trim());
    }
  }

  return map;
}

function bytesToHex(bytes: Uint8Array, max = 16): string {
  const slice = bytes.slice(0, Math.min(bytes.length, max));
  return Array.from(slice)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

function looksLikeJsonText(text: string): boolean {
  let t = text;
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  t = t.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

function isGzipFile(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function maybeDecompressGzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzipFile(bytes)) return bytes;
  if (typeof DecompressionStream === "undefined") return bytes;

  const ds = new DecompressionStream("gzip");
  const copy = new Uint8Array(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(ds);
  const decompressed = await new Response(stream).arrayBuffer();
  return new Uint8Array(decompressed);
}

function decodeText(
  bytes: Uint8Array,
  encoding: "utf-8" | "utf-16le" | "utf-16be"
): string {
  try {
    // TextDecoder supports utf-8/utf-16le/utf-16be in modern browsers.
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

async function decodeMediaFileToText(bytes: Uint8Array): Promise<{ text: string; how: string }> {
  const utf8 = decodeText(bytes, "utf-8");
  if (looksLikeJsonText(utf8)) return { text: utf8, how: "utf-8" };

  // Try zstd (some exports pack it)
  try {
    const zstd = await maybeDecompressZstd(bytes);
    if (zstd !== bytes) {
      const t = decodeText(zstd, "utf-8");
      if (process.env.NODE_ENV !== "production") {
         
        console.info(
          "[apkg] media zstd bytes:",
          "len=",
          zstd.length,
          "hex=",
          bytesToHex(zstd)
        );
         
        console.info(
          "[apkg] media zstd preview:",
          t.slice(0, 120).replace(/\s+/g, " ")
        );
      }
      if (looksLikeJsonText(t)) return { text: t, how: "zstd+utf-8" };
    }
  } catch {
    // ignore
  }

  // Try gzip
  try {
    const gunzipped = await maybeDecompressGzip(bytes);
    if (gunzipped !== bytes) {
      const t = decodeText(gunzipped, "utf-8");
      if (looksLikeJsonText(t)) return { text: t, how: "gzip+utf-8" };
    }
  } catch {
    // ignore
  }

  // Try UTF-16
  const u16le = decodeText(bytes, "utf-16le");
  if (looksLikeJsonText(u16le)) return { text: u16le, how: "utf-16le" };
  const u16be = decodeText(bytes, "utf-16be");
  if (looksLikeJsonText(u16be)) return { text: u16be, how: "utf-16be" };

  return { text: utf8, how: "utf-8(raw)" };
}

function isZstdFile(bytes: Uint8Array) {
  // Zstandard frame magic number: 0xFD2FB528 (little-endian bytes: 28 B5 2F FD)
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x28 &&
    bytes[1] === 0xb5 &&
    bytes[2] === 0x2f &&
    bytes[3] === 0xfd
  );
}

async function maybeDecompressZstd(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isZstdFile(bytes)) return bytes;

  const mod = (await import("fzstd")) as unknown as {
    decompress?: (data: Uint8Array) => Uint8Array;
    default?: { decompress?: (data: Uint8Array) => Uint8Array };
  };
  const decompress = mod.decompress ?? mod.default?.decompress;
  if (typeof decompress !== "function") {
    throw new Error("No pude cargar el descompresor zstd para collection.anki21b");
  }

  return decompress(bytes);
}

export async function importApkg(
  file: File,
  opts?: { mediaNamespace?: string }
): Promise<ImportedDeck> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  // Map numeric media keys ("0", "1", ...) to filenames.
  const mediaEntry = findZipFile(zip, "media") as
    | { async: (type: "uint8array") => Promise<Uint8Array> }
    | null;
  let mediaKeyByFilename = new Map<string, string>();
  let mediaKeyByLowerFilename = new Map<string, string>();
  if (mediaEntry) {
    try {
      const mediaBytes = await mediaEntry.async("uint8array");
      const parsed = await parseApkgMediaBytes(mediaBytes);
      mediaKeyByFilename = parsed.map;
      const parsedHow = parsed.how;

      if (process.env.NODE_ENV !== "production") {
        console.info(
          "[apkg] media bytes:",
          "len=",
          mediaBytes.length,
          "hex=",
          bytesToHex(mediaBytes),
          "parsedAs=",
          parsedHow
        );
      }

      mediaKeyByLowerFilename = new Map(
        Array.from(mediaKeyByFilename.entries()).map(([name, key]) => [
          name.toLowerCase(),
          key,
        ])
      );
    } catch {
      mediaKeyByFilename = new Map();
      mediaKeyByLowerFilename = new Map();
    }
  }

  if (process.env.NODE_ENV !== "production") {
     
    console.info(
      "[apkg] media entry:",
      mediaEntry ? "found" : "missing",
      "mediaMapSize=",
      mediaKeyByFilename.size
    );
  }

  const anki21b = zip.file(/collection\.anki21b$/i)?.[0] ?? zip.file("collection.anki21b");
  const collectionMatches = zip.file(/collection\.(anki2|anki21)$/i);
  const collectionFile = collectionMatches?.[0] ?? zip.file("collection.anki2") ?? zip.file("collection.anki21");

  if (!anki21b && !collectionFile) {
    throw new Error(
      "No encontré collection.anki2 dentro del .apkg (¿archivo válido de Anki?)."
    );
  }

  let sqliteBytes: Uint8Array | null = null;

  if (anki21b) {
    const maybeCompressed = await anki21b.async("uint8array");
    try {
      const decompressed = await maybeDecompressZstd(maybeCompressed);
      if (isSQLiteFile(decompressed)) {
        sqliteBytes = decompressed;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`No pude descomprimir collection.anki21b: ${msg}`);
    }
  }

  if (!sqliteBytes && collectionFile) {
    const raw = await collectionFile.async("uint8array");
    if (isSQLiteFile(raw)) {
      sqliteBytes = raw;
    }
  }

  if (!sqliteBytes) {
    throw new Error(
      "No pude obtener una base SQLite válida desde el .apkg. Si tu export viene de Anki muy nuevo, re-exporta como .apkg estándar desde Anki Desktop."
    );
  }
  const SQL = await getSqlJs();
  const db = new SQL.Database(sqliteBytes);

  try {
    const modelsJson = (execFirstCell(db, "SELECT models FROM col LIMIT 1") as
      | string
      | undefined) ?? "{}";
    let modelsObj: Record<string, { flds?: Array<{ name?: string }> }> = {};
    try {
      modelsObj = JSON.parse(modelsJson) as Record<
        string,
        { flds?: Array<{ name?: string }> }
      >;
    } catch {
      modelsObj = {};
    }

    const fieldNamesByMid = new Map<number, string[]>();
    for (const [midStr, model] of Object.entries(modelsObj)) {
      const mid = Number(midStr);
      if (!Number.isFinite(mid)) continue;
      const names = (model?.flds ?? [])
        .map((f) => (f?.name ?? "").trim())
        .filter((n) => n.length > 0);
      fieldNamesByMid.set(mid, names);
    }

    // Newer collection formats may store field names in dedicated tables.
    // If `col.models` is empty, try reading from `fields`.
    try {
      const fieldsRes = db.exec("SELECT ntid, ord, name FROM fields");
      const values =
        toArray<unknown>((fieldsRes[0] as unknown as { values?: unknown }).values) ??
        [];

      const tmp = new Map<number, string[]>();
      for (const rawRow of values) {
        const row = toRowArray(rawRow);
        if (!row) continue;
        const ntid = Number(row[0]);
        const ord = Number(row[1]);
        const name = String(row[2] ?? "").trim();
        if (!Number.isFinite(ntid) || !Number.isFinite(ord) || ord < 0) continue;

        const arr = tmp.get(ntid) ?? [];
        while (arr.length <= ord) arr.push("");
        arr[ord] = name;
        tmp.set(ntid, arr);
      }

      for (const [ntid, names] of tmp.entries()) {
        const cleaned = names.map((n) => n.trim());
        if (cleaned.some((n) => n.length > 0)) {
          fieldNamesByMid.set(ntid, cleaned);
        }
      }
    } catch {
      // ignore
    }

    const decksJson = (execFirstCell(db, "SELECT decks FROM col LIMIT 1") as
      | string
      | undefined) ?? "{}";

    let decksObj: Record<string, { name?: string }> = {};
    try {
      decksObj = JSON.parse(decksJson) as Record<string, { name?: string }>;
    } catch {
      decksObj = {};
    }

    const decks = Object.entries(decksObj)
      .map(([id, value]) => ({
        id: Number(id),
        name: value?.name ?? `Deck ${id}`,
      }))
      .filter((d) => Number.isFinite(d.id))
      .sort((a, b) => a.name.localeCompare(b.name));

    const notesRes = db.exec("SELECT id, mid, flds FROM notes");
    const notesById = new Map<number, { flds: string; mid: number }>();
    if (notesRes[0]) {
      const values =
        toArray<unknown>((notesRes[0] as unknown as { values?: unknown }).values) ??
        [];

      for (const rawRow of values) {
        const row = toRowArray(rawRow);
        if (!row) continue;
        // SELECT id, flds
        const id = Number(row[0]);
        const mid = Number(row[1]);
        const flds = String(row[2] ?? "");
        if (Number.isFinite(id)) {
          notesById.set(id, { flds, mid: Number.isFinite(mid) ? mid : NaN });
        }
      }
    }

    const cardsRes = db.exec("SELECT id, nid, did FROM cards");
    const cards: ImportedCard[] = [];

    const referencedAudio = new Set<string>();

    if (cardsRes[0]) {
      const values =
        toArray<unknown>((cardsRes[0] as unknown as { values?: unknown }).values) ??
        [];

      for (const rawRow of values) {
        const row = toRowArray(rawRow);
        if (!row) continue;
        // SELECT id, nid, did
        const id = Number(row[0]);
        const noteId = Number(row[1]);
        const deckId = Number(row[2]);
        if (!Number.isFinite(id) || !Number.isFinite(noteId) || !Number.isFinite(deckId)) {
          continue;
        }
        const note = notesById.get(noteId);
        if (!note) continue;

        const flds = note.flds;
        const mid = note.mid;
        const fieldNames = fieldNamesByMid.get(mid) ?? [];

        const { front, back } = getTextFieldPair(flds);
        const fieldsHtml = flds ? flds.split("\u001f") : [];

        for (const html of [front, back, ...fieldsHtml]) {
          for (const filename of extractSoundFilenames(html)) {
            referencedAudio.add(filename);
          }
        }

        cards.push({
          id,
          noteId,
          deckId,
          frontHtml: front,
          backHtml: back,
          fieldsHtml,
          fieldNames,
        });
      }
    }

    if (cards.length === 0) {
      throw new Error(
        "No pude extraer cards del .apkg (la consulta a cards devolvió 0 filas o un formato inesperado)."
      );
    }

    // Some newer/converted exports may not populate `col.decks` in an easy-to-parse way.
    // If we got cards but no decks, infer decks from card deckIds.
    const inferredDecks =
      decks.length === 0
        ? Array.from(new Set(cards.map((c) => c.deckId)))
            .filter((id) => Number.isFinite(id))
            .sort((a, b) => a - b)
            .map((id, idx) => ({
              id,
              name: idx === 0 && id === 1 ? "Default" : `Deck ${id}`,
            }))
        : null;

    const finalDecks = inferredDecks ?? decks;

    // Extract referenced audio files from the zip and store in IndexedDB for offline playback.
    if (process.env.NODE_ENV !== "production") {
       
      console.info(
        "[apkg] cards=",
        cards.length,
        "referencedAudio=",
        referencedAudio.size
      );
    }

    if (referencedAudio.size > 0) {
      const { saveMediaItems } = await import("./mediaStorage");
      const items: Array<{ name: string; blob: Blob }> = [];

      let missingInMediaMap = 0;
      let missingZipEntry = 0;
      let usedDirectFilename = 0;
      const sampleMissingInMediaMap: string[] = [];
      const sampleMissingZipEntry: string[] = [];

      for (const filename of referencedAudio) {
        const trimmed = filename.trim();
        const key =
          mediaKeyByFilename.get(trimmed) ??
          mediaKeyByLowerFilename.get(trimmed.toLowerCase()) ??
          null;

        if (!key) {
          const directByName = findZipFile(zip, trimmed) as
            | { async: (type: "uint8array") => Promise<Uint8Array> }
            | null;
          if (directByName) {
            try {
              const bytes = await directByName.async("uint8array");
              const maybeDecoded = await maybeDecompressZstd(bytes);
              const copy = new Uint8Array(maybeDecoded);
              const blob = new Blob([copy], { type: guessAudioMimeType(trimmed) });
              items.push({ name: trimmed, blob });
              usedDirectFilename += 1;
              continue;
            } catch {
              // fall through
            }
          }

          missingInMediaMap += 1;
          if (sampleMissingInMediaMap.length < 5) sampleMissingInMediaMap.push(trimmed);
          continue;
        }
        const entry = findZipFile(zip, key) as
          | { async: (type: "uint8array") => Promise<Uint8Array> }
          | null;
        if (!entry) {
          missingZipEntry += 1;
          if (sampleMissingZipEntry.length < 5) sampleMissingZipEntry.push(`${trimmed} -> ${key}`);
          continue;
        }

        try {
          const bytes = await entry.async("uint8array");
          const maybeDecoded = await maybeDecompressZstd(bytes);
          const copy = new Uint8Array(maybeDecoded);
          const blob = new Blob([copy], { type: guessAudioMimeType(filename) });
          items.push({ name: filename, blob });
        } catch {
          // ignore missing/corrupt media
        }
      }

      try {
        if (process.env.NODE_ENV !== "production") {
           
          console.info(
            "[apkg] saving media:",
            "willSave=",
            items.length,
            "usedDirectFilename=",
            usedDirectFilename,
            "missingInMediaMap=",
            missingInMediaMap,
            sampleMissingInMediaMap.length ? sampleMissingInMediaMap : "",
            "missingZipEntry=",
            missingZipEntry,
            sampleMissingZipEntry.length ? sampleMissingZipEntry : ""
          );
        }
        await saveMediaItems(opts?.mediaNamespace ?? "default", items);
      } catch {
        // ignore storage errors
      }
    }

    return { decks: finalDecks, cards };
  } finally {
    db.close();
  }
}
