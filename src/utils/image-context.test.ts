import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_PREFIX } from "../tools/ImageReadTool/index.js";
import { createImageContextContent, hasImageContext, parseImageContext } from "./image-context.js";

test("parseImageContext extracts image sentinel payloads and leaves text", () => {
  const content = createImageContextContent({
    mediaType: "image/png",
    base64: "ZmFrZQ==",
    source: "clipboard",
  });
  const parsed = parseImageContext(content);
  assert.equal(parsed.images.length, 1);
  assert.deepEqual(parsed.images[0], { mediaType: "image/png", data: "ZmFrZQ==" });
  assert.match(parsed.text, /Pasted screenshot/);
  assert.match(parsed.text, /\[image attached\]/);
});

test("hasImageContext detects image sentinels", () => {
  assert.equal(hasImageContext(`${IMAGE_PREFIX}:image/png:ZmFrZQ==`), true);
  assert.equal(hasImageContext("plain text"), false);
});
