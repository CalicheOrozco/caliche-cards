import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Caliche Cards",
    short_name: "Caliche Cards",
    description:
      "Offline-first flashcards for importing Anki decks (.apkg) and studying with simple Fail/Pass reviews.",
    id: "/",
    start_url: "/",
    scope: "/",
    lang: "en",
    display: "standalone",
    display_override: ["standalone", "fullscreen"],
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    categories: ["education", "productivity"],
    icons: [
      {
        src: "/logo-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/logo-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/logo-180.png",
        sizes: "180x180",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
