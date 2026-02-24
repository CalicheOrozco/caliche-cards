import JSZip from "jszip";
import fs from "fs";
import { decompress } from "fzstd";

function readVarint(bytes, offset) {
  let value = 0;
  let shift = 0;
  let i = offset;

  while (i < bytes.length) {
    const b = bytes[i];
    value |= (b & 0x7f) << shift;
    i += 1;
    if ((b & 0x80) === 0) return { value, offset: i };
    shift += 7;
    if (shift > 35) throw new Error("protobuf varint too large");
  }

  throw new Error("protobuf varint truncated");
}

function skipWireValue(bytes, offset, wireType) {
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

function decodeMediaEntryName(entryBytes) {
  // MediaEntry: we only need field 1: string name = 1;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let i = 0;
  while (i < entryBytes.length) {
    const key = readVarint(entryBytes, i);
    i = key.offset;
    const field = key.value >>> 3;
    const wire = key.value & 0x7;

    if (field === 1 && wire === 2) {
      const len = readVarint(entryBytes, i);
      i = len.offset;
      const end = i + len.value;
      if (end > entryBytes.length) throw new Error("protobuf string out of bounds");
      return decoder.decode(entryBytes.subarray(i, end));
    }

    i = skipWireValue(entryBytes, i, wire);
    if (i > entryBytes.length) throw new Error("protobuf field out of bounds");
  }
  return "";
}

function decodeMediaEntry(entryBytes) {
  // Observed modern MediaEntry fields:
  // - field 1 (wire 2): string name
  // - field 2 (wire 0): varint id (NOT necessarily the zip entry key)
  let name = "";
  let entryId = null;

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let i = 0;
  while (i < entryBytes.length) {
    const key = readVarint(entryBytes, i);
    i = key.offset;
    const field = key.value >>> 3;
    const wire = key.value & 0x7;

    if (field === 1 && wire === 2) {
      const len = readVarint(entryBytes, i);
      i = len.offset;
      const end = i + len.value;
      if (end > entryBytes.length) throw new Error("protobuf string out of bounds");
      name = decoder.decode(entryBytes.subarray(i, end));
      i = end;
      continue;
    }

    if (field === 2 && wire === 0) {
      const v = readVarint(entryBytes, i);
      entryId = String(v.value);
      i = v.offset;
      continue;
    }

    i = skipWireValue(entryBytes, i, wire);
    if (i > entryBytes.length) throw new Error("protobuf field out of bounds");
  }

  return { name, entryId };
}

function decodeMediaEntries(bytes) {
  // MediaEntries: field 1 repeated MediaEntry entries = 1;
  const entries = [];
  let i = 0;
  let idx = 0;
  while (i < bytes.length) {
    const key = readVarint(bytes, i);
    i = key.offset;
    const field = key.value >>> 3;
    const wire = key.value & 0x7;

    if (field === 1 && wire === 2) {
      const len = readVarint(bytes, i);
      i = len.offset;
      const end = i + len.value;
      if (end > bytes.length) throw new Error("protobuf embedded message out of bounds");
      const entryBytes = bytes.subarray(i, end);
      const decoded = decodeMediaEntry(entryBytes);
      const name = String(decoded.name ?? "").trim();
      if (name) entries.push({ name, idx, entryId: decoded.entryId });
      i = end;
      idx += 1;
      continue;
    }

    i = skipWireValue(bytes, i, wire);
    if (i > bytes.length) throw new Error("protobuf field out of bounds");
  }
  return entries;
}

function isZstd(bytes) {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x28 &&
    bytes[1] === 0xb5 &&
    bytes[2] === 0x2f &&
    bytes[3] === 0xfd
  );
}

function hex(bytes, n = 8) {
  return Array.from(bytes.slice(0, n))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join(" ");
}

const apkgPath = process.argv[2] ?? "public/Refold FR1K.apkg";
const query = process.argv[3] ?? "FR1K_une meere_mother_image.jpg";

const buf = fs.readFileSync(apkgPath);
const zip = await JSZip.loadAsync(buf);

const mediaFile =
  zip.file("media") ??
  // Some zip implementations may store paths; JSZip keys are the full paths.
  Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith("/media") || f.name.toLowerCase() === "media") ??
  null;
if (!mediaFile) {
  console.error("No media entry found in apkg");
  process.exit(1);
}

const mediaBytes = await mediaFile.async("uint8array");
const decodedBytes = isZstd(mediaBytes) ? decompress(mediaBytes) : mediaBytes;
const entries = decodeMediaEntries(decodedBytes);
const names = entries.map((e) => e.name);
const entryByName = new Map(entries.map((e) => [e.name, e]));

console.log("apkg", apkgPath);
console.log("zip entries", Object.keys(zip.files).length);
console.log("media names", names.length);

const qLower = query.toLowerCase();
const exactIndex = names.findIndex((n) => n === query);
const foldIndex = names.findIndex((n) => n.toLowerCase() === qLower);

console.log("query", query);
console.log("exact index", exactIndex);
console.log("casefold index", foldIndex);

const idx = foldIndex >= 0 ? foldIndex : exactIndex;
if (idx >= 0) {
  const canonical = names[idx];
  const meta = canonical ? entryByName.get(canonical) : null;
  const mediaKey = String(idx);
  const entry = zip.file(mediaKey) ?? zip.file(new RegExp(`(^|/)${mediaKey}$`))?.[0] ?? null;
  console.log("media key", mediaKey, "zip entry exists", Boolean(entry));
  if (meta?.entryId) {
    console.log("protobuf entryId (field2)", meta.entryId);
  }
  if (entry) {
    const b = await entry.async("uint8array");
    console.log("zip entry bytes", b.length, "first8", hex(b, 8));
    if (isZstd(b)) {
      const d = decompress(b);
      console.log("decompressed bytes", d.length, "first8", hex(d, 8));
    }
  }

  if (canonical && canonical !== query) {
    console.log("canonical name", canonical);
  }
} else {
  const related = names
    .filter((n) => n.toLowerCase().includes("fr1k_une") && n.toLowerCase().includes("mother_image"))
    .slice(0, 25);
  console.log("related samples", related);
}
