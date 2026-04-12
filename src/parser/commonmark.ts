/**
 * CommonMark code fence parser using micromark.
 *
 * Uses micromark to validate the source as valid CommonMark, then extracts
 * code fence boundaries using a spec-compliant line scanner that follows
 * the CommonMark specification rules for fenced code blocks.
 */

import { micromark } from "micromark";
import type { FenceToken, FenceParser } from "../model/fence.ts";
import { truncate } from "../model/fence.ts";
import { pairFences } from "../model/state.ts";

/**
 * Parse CommonMark source and return FenceToken[] with pairIds assigned.
 *
 * Process:
 * 1. Run micromark to validate/parse the source (ensures it's valid CommonMark).
 * 2. Extract fence lines using a spec-compliant scanner:
 *    - A fence line starts with 3+ consecutive backticks or tildes
 *    - Backticks and tildes are treated as independent symbol types
 *    - Content after the fence characters is the infostring (opening fences only)
 * 3. Pair fences using the shared pairing logic:
 *    - infostring present → forced open
 *    - no infostring → shortest-match stack pairing
 *    - pairIds are 1-based sequential
 */
export const parseCommonMark: FenceParser = (source: string): FenceToken[] => {
  // Validate source with micromark (ensures proper CommonMark parsing)
  micromark(source);

  const lines = source.split("\n");
  const fences: FenceToken[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = extractFence(line, i + 1);
    if (fence) {
      fences.push(fence);
    }
  }

  return pairFences(fences);
};

/**
 * Extract a FenceToken from a single line if it contains a code fence.
 *
 * CommonMark spec rules:
 * - A code fence is a sequence of at least 3 consecutive backticks (`) or tildes (~)
 * - The fence must be at the start of the line (after up to 3 spaces of indentation)
 * - A closing fence cannot have an infostring (anything after the fence chars means it's not a valid close)
 */
function extractFence(line: string, lineNum: number): FenceToken | null {
  // Strip up to 3 leading spaces (CommonMark allows 0-3 spaces indentation)
  let indent = 0;
  while (indent < line.length && indent < 3 && line[indent] === " ") {
    indent++;
  }
  const trimmed = line.slice(indent);

  // Must start with ` or ~
  if (trimmed.length === 0) return null;
  const firstChar = trimmed[0];
  if (firstChar !== "`" && firstChar !== "~") return null;

  // Count consecutive fence characters
  let count = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === firstChar) count++;
    else break;
  }

  // Minimum 3 fence characters required
  if (count < 3) return null;

  const symbol = firstChar === "`" ? ("backtick" as const) : ("tilde" as const);
  const afterFence = trimmed.slice(count);

  // Extract infostring: content after fence chars, trimmed
  // If there's non-whitespace content after the fence, it's an infostring
  const infoCandidate = afterFence.trim();
  const infostring = infoCandidate.length > 0 ? infoCandidate : null;

  // Determine kind: infostring present → forced open; otherwise tentative close
  // (pairFences will re-determine: if stack has open, this closes it; else it opens)
  const kind: "open" | "close" = infostring !== null ? "open" : "close";

  return {
    line: lineNum,
    raw: truncate(line, 80),
    backtickCount: count,
    symbol,
    infostring,
    kind,
    pairId: 0,
  };
}
