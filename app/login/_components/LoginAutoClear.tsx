"use client";

import { useEffect } from "react";

import { clearApkg } from "@/lib/apkgStorage";
import { clearLastState, loadLastState, saveLastState } from "@/lib/deckStorage";
import { clearMedia } from "@/lib/mediaStorage";
import { deleteStudyDb } from "@/lib/studyDb";

export default function LoginAutoClear() {
  useEffect(() => {
    const KEY = "caliche:login:autoClear:v1";
    if (typeof window === "undefined") return;
    if (window.sessionStorage.getItem(KEY) === "1") return;
    window.sessionStorage.setItem(KEY, "1");

    void (async () => {
      try {
        const { state } = await loadLastState();
        const libraries = state?.libraries ?? [];
        const guestLibs = libraries.filter((l) => l.source === "guest");
        if (guestLibs.length === 0) return;

        const nonGuestLibs = libraries.filter((l) => l.source !== "guest");

        // If the user only ever loaded demo/guest decks, do a full clear to
        // guarantee a clean slate before login.
        if (nonGuestLibs.length === 0) {
          await clearLastState();
          await clearMedia();
          await clearApkg();
          await deleteStudyDb();
          return;
        }

        // Otherwise: remove guest libraries from the persisted deck list and
        // best-effort clear only the guest cached blobs.
        for (const lib of guestLibs) {
          try {
            await clearMedia(lib.id);
          } catch {
            // ignore
          }
          try {
            await clearApkg(lib.id);
          } catch {
            // ignore
          }
        }

        const nextActiveLibraryId = nonGuestLibs.some((l) => l.id === state?.activeLibraryId)
          ? (state?.activeLibraryId ?? null)
          : (nonGuestLibs[0]?.id ?? null);

        await saveLastState({
          libraries: nonGuestLibs,
          activeLibraryId: nextActiveLibraryId,
          savedAt: Date.now(),
          lastSyncAt: state?.lastSyncAt ?? null,
        });
      } catch {
        // ignore
      }
    })();
  }, []);

  return null;
}
