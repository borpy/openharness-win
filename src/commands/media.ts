import { readClipboardImage } from "../harness/clipboard-image.js";
import { createHiddenUserMessage } from "../types/message.js";
import { createImageContextContent } from "../utils/image-context.js";
import type { CommandHandler } from "./types.js";

export function registerMediaCommands(register: (name: string, description: string, handler: CommandHandler) => void) {
  const handler: CommandHandler = async (_args, ctx) => {
    const image = await readClipboardImage();
    if (!image) {
      return {
        output:
          "No screenshot/image found on the clipboard. Copy a screenshot first, or provide an image path with the ImageRead tool.",
        handled: true,
      };
    }
    const base64 = image.buffer.toString("base64");
    const hidden = createHiddenUserMessage(
      createImageContextContent({
        mediaType: image.mediaType,
        base64,
        source: image.source,
      }),
    );
    const sizeKb = Math.max(1, Math.round(image.buffer.length / 1024));
    return {
      output: `Attached clipboard image (${image.mediaType}, ${sizeKb}KB) to hidden conversation context.`,
      handled: true,
      compactedMessages: [...ctx.messages, hidden],
    };
  };

  register("paste-image", "Attach a screenshot/image from the clipboard to model context", handler);
  register("screenshot", "Attach a screenshot/image from the clipboard to model context", handler);
}
