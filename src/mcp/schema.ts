import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Wrapper around the maintained zod-to-json-schema (adopted in 2026-06 audit, review #9).
 * Used for MCP server tools/list and provider tool schemas.
 * Falls back to a permissive object for very complex cases.
 */
export function zodToJsonSchemaSimple(schema: z.ZodType): unknown {
  try {
    // Use the real converter; options tuned for our LLM/MCP use (descriptions, etc.)
    return zodToJsonSchema(schema as any, {
      target: "jsonSchema7",
      $refStrategy: "none", // avoid $refs for simple provider consumption
    });
  } catch {
    // Conservative fallback (matches old behavior for unknowns)
    return { type: "object", additionalProperties: true };
  }
}
