import type { ImageKind } from "./types.ts";

type ArticleImage = {
  url: string;
  alt: string;
  kind: ImageKind;
};

const relatedImages = {
  ai: {
    url: "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1400&q=80",
    alt: "Circuit board used as a related technology image",
  },
  finance: {
    url: "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=1400&q=80",
    alt: "Financial market display used as a related finance image",
  },
  climate: {
    url: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=1400&q=80",
    alt: "Forest canopy used as a related environment image",
  },
  space: {
    url: "https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=1400&q=80",
    alt: "Spacecraft launch used as a related space image",
  },
  science: {
    url: "https://images.unsplash.com/photo-1532094349884-543bc11b234d?auto=format&fit=crop&w=1400&q=80",
    alt: "Laboratory equipment used as a related science image",
  },
  uk: {
    url: "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=1400&q=80",
    alt: "London skyline used as a related UK image",
  },
  culture: {
    url: "https://images.unsplash.com/photo-1549490349-8643362247b5?auto=format&fit=crop&w=1400&q=80",
    alt: "Colourful artwork used as a related culture image",
  },
  general: {
    url: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=1400&q=80",
    alt: "Newspapers used as a related news image",
  },
} as const;

export function relatedImageForTopics(topics: string[]): ArticleImage {
  const text = topics.join(" ").toLowerCase();
  const key =
    /\b(ai|artificial intelligence|software|computing|technology|apple)\b/.test(text)
      ? "ai"
      : /\b(finance|investment|venture capital|business|economics|funding)\b/.test(text)
        ? "finance"
        : /\b(climate|environment|wildfire|energy)\b/.test(text)
          ? "climate"
          : /\b(space|nasa|astronomy)\b/.test(text)
            ? "space"
            : /\b(science|health|research|medicine)\b/.test(text)
              ? "science"
              : /\b(uk|britain|london|transport|housing|immigration|infrastructure)\b/.test(text)
                ? "uk"
                : /\b(art|culture|museum|film|music|entertainment)\b/.test(text)
                  ? "culture"
                  : "general";
  return { ...relatedImages[key], kind: "related" };
}
