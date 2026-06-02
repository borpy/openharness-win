import { IMAGE_PREFIX } from "../tools/ImageReadTool/index.js";

export type ParsedImageContext = {
  text: string;
  images: Array<{ mediaType: string; data: string }>;
};

const IMAGE_SENTINEL_RE = new RegExp(`${IMAGE_PREFIX}:([^:\\n]+):([A-Za-z0-9+/=]+)`, "g");

export function parseImageContext(content: string): ParsedImageContext {
  const images: Array<{ mediaType: string; data: string }> = [];
  const text = content
    .replace(IMAGE_SENTINEL_RE, (_match, mediaType: string, data: string) => {
      images.push({ mediaType, data });
      return "[image attached]";
    })
    .trim();
  return { text, images };
}

export function hasImageContext(content: string): boolean {
  IMAGE_SENTINEL_RE.lastIndex = 0;
  return IMAGE_SENTINEL_RE.test(content);
}

export function createImageContextContent(input: {
  mediaType: string;
  base64: string;
  label?: string;
  source?: string;
}): string {
  const lines = [
    input.label ?? "Pasted screenshot/image context for this conversation.",
    input.source ? `Source: ${input.source}` : "",
    `${IMAGE_PREFIX}:${input.mediaType}:${input.base64}`,
  ].filter(Boolean);
  return lines.join("\n");
}
