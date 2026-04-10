/**
 * EditorState and restructuring logic.
 *
 * Manages the immutable input snapshot, mutable output tokens,
 * pair reassignment, and backtick auto-adjustment.
 */

import type { FenceToken } from "./fence.ts";
import { truncate } from "./fence.ts";

/**
 * The editor state tracks:
 * - inputTokens: original parsed fences (immutable)
 * - outputTokens: current working copy (mutable)
 * - hasTilde: whether any tilde fences exist in output
 * - actionLog: history of applied actions
 */
export interface EditorState {
  inputTokens: ReadonlyArray<FenceToken>;
  outputTokens: FenceToken[];
  hasTilde: boolean;
  actionLog: string[];
}

/**
 * Create the initial EditorState from parsed tokens.
 * inputTokens are frozen; outputTokens are a mutable deep copy.
 */
export function createEditorState(tokens: FenceToken[]): EditorState {
  const inputTokens = Object.freeze(tokens.map((t) => ({ ...t })));
  const outputTokens = tokens.map((t) => ({ ...t }));
  const hasTilde = tokens.some((t) => t.symbol === "tilde");
  return { inputTokens, outputTokens, hasTilde, actionLog: [] };
}

/**
 * Pair tokens using CommonMark/Djot rules:
 * - infostring present → forced open
 * - no infostring → shortest-match stack pairing (independent per symbol type)
 * - pairIds start at 1
 *
 * This is the shared pairing logic used by both parsers and restructuring.
 */
export function pairFences(tokens: FenceToken[]): FenceToken[] {
  const result = tokens.map((t) => ({ ...t, pairId: 0 }));

  // Process each symbol type independently, but share a global pairId counter.
  const symbols: Array<"backtick" | "tilde"> = ["backtick", "tilde"];
  let nextPairId = 1;

  for (const sym of symbols) {
    // Get indices of tokens with this symbol, sorted by line number
    const indices = result
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.symbol === sym)
      .sort((a, b) => a.t.line - b.t.line)
      .map(({ i }) => i);

    const stack: number[] = []; // stack of open token indices

    for (const idx of indices) {
      const tok = result[idx];

      if (tok.infostring !== null) {
        // Forced open — infostring means this is definitely an opening fence
        tok.kind = "open";
        stack.push(idx);
      } else if (tok.kind === "close") {
        // Explicitly marked as close (e.g., from restructuring).
        // Try to match with top of stack (shortest-match).
        if (stack.length > 0) {
          const openIdx = stack.pop()!;
          result[openIdx].kind = "open";
          result[openIdx].pairId = nextPairId;
          tok.kind = "close";
          tok.pairId = nextPairId;
          nextPairId++;
        } else {
          // No matching open — treat as open
          tok.kind = "open";
          stack.push(idx);
        }
      } else {
        // No infostring and not explicitly close — ambiguous.
        // Apply shortest-match: try to close if there's an open on stack.
        if (stack.length > 0) {
          const openIdx = stack.pop()!;
          result[openIdx].kind = "open";
          result[openIdx].pairId = nextPairId;
          tok.kind = "close";
          tok.pairId = nextPairId;
          nextPairId++;
        } else {
          // No open to match — treat as open
          tok.kind = "open";
          stack.push(idx);
        }
      }
    }

    // Unmatched opens remain as opens with pairId 0 (unpaired)
    for (const idx of stack) {
      result[idx].pairId = 0;
    }
  }

  return result;
}

/**
 * Get the list of unique pair IDs present in outputTokens (excluding 0).
 */
export function getOutputPairIds(tokens: FenceToken[]): number[] {
  const ids = new Set<number>();
  for (const t of tokens) {
    if (t.pairId > 0) ids.add(t.pairId);
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Build FencePair objects from outputTokens grouped by pairId.
 */
export interface FencePairInfo {
  id: number;
  open: FenceToken;
  close: FenceToken;
}

export function getOutputPairs(tokens: FenceToken[]): FencePairInfo[] {
  const pairs: FencePairInfo[] = [];
  const ids = getOutputPairIds(tokens);
  for (const id of ids) {
    const opens = tokens.filter((t) => t.pairId === id && t.kind === "open");
    const closes = tokens.filter((t) => t.pairId === id && t.kind === "close");
    if (opens.length > 0 && closes.length > 0) {
      pairs.push({ id, open: opens[0], close: closes[0] });
    }
  }
  return pairs;
}

/**
 * Restructure: change the close fence of a given pairId to use a
 * different fence token (identified by its line number) as the new close.
 *
 * Steps:
 * 1. Find the current close fence for targetPairId and its corresponding open.
 * 2. Find the target token at newCloseLine.
 * 3. Promote the old close fence to an open fence.
 * 4. Set the target token as the new close, explicitly pairing it with the
 *    original open of targetPairId.
 * 5. Re-pair remaining tokens for other pairs.
 * 6. Auto-adjust backtick counts for nesting compliance.
 */
export function restructureClose(
  state: EditorState,
  targetPairId: number,
  newCloseLine: number,
): EditorState {
  const newTokens = state.outputTokens.map((t) => ({ ...t }));

  // Find the current pair's open and close
  const openToken = newTokens.find(
    (t) => t.pairId === targetPairId && t.kind === "open",
  );
  const oldCloseIdx = newTokens.findIndex(
    (t) => t.pairId === targetPairId && t.kind === "close",
  );
  if (!openToken || oldCloseIdx < 0) return state;

  // Find the new close fence by line number
  const newCloseIdx = newTokens.findIndex((t) => t.line === newCloseLine);
  if (newCloseIdx < 0) return state;

  // Promote old close to open (remove from target pair)
  newTokens[oldCloseIdx] = {
    ...newTokens[oldCloseIdx],
    kind: "open" as const,
    pairId: 0, // No longer part of the target pair
  };

  // Set the new close and explicitly pair it with the original open
  newTokens[newCloseIdx] = {
    ...newTokens[newCloseIdx],
    kind: "close" as const,
    infostring: null,
    pairId: targetPairId, // Keep the same pairId
  };
  // Also update the open token's pairId (it stays the same)
  const openIdx = newTokens.findIndex(
    (t) => t.line === openToken.line && t.symbol === openToken.symbol,
  );
  if (openIdx >= 0) {
    newTokens[openIdx].pairId = targetPairId;
  }

  // Now re-pair all OTHER tokens (excluding the target pair).
  // Reset tokens not in the target pair:
  for (let i = 0; i < newTokens.length; i++) {
    if (i === openIdx || i === newCloseIdx) continue; // Skip target pair tokens
    if (newTokens[i].infostring === null && newTokens[i].pairId !== 0) {
      newTokens[i].kind = "close";
    }
  }

  // Re-pair non-target tokens
  const rePaired = pairFencesExcluding(newTokens, targetPairId);

  // Apply auto-adjust for backtick nesting
  const adjusted = autoAdjustBackticks(rePaired);

  return {
    ...state,
    outputTokens: adjusted,
    actionLog: [
      ...state.actionLog,
      `Changed close fence for O.${targetPairId} to line ${newCloseLine}`,
    ],
  };
}

/**
 * Pair tokens excluding a specific pairId (those tokens keep their pairId).
 * All tokens with the excluded pairId are left untouched.
 */
function pairFencesExcluding(
  tokens: FenceToken[],
  excludePairId: number,
): FenceToken[] {
  const result = tokens.map((t) => ({ ...t }));
  const symbols: Array<"backtick" | "tilde"> = ["backtick", "tilde"];

  for (const sym of symbols) {
    // Only process tokens NOT in the excluded pair
    const indices = result
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.symbol === sym && t.pairId !== excludePairId)
      .sort((a, b) => a.t.line - b.t.line)
      .map(({ i }) => i);

    const stack: number[] = [];
    let nextPairId = 1;

    // Find the next available pairId (skip the excluded one)
    if (nextPairId === excludePairId) nextPairId++;

    for (const idx of indices) {
      const tok = result[idx];

      if (tok.infostring !== null || tok.kind === "open") {
        tok.kind = "open";
        stack.push(idx);
      } else {
        if (stack.length > 0) {
          const openIdx = stack.pop()!;
          result[openIdx].kind = "open";
          result[openIdx].pairId = nextPairId;
          tok.kind = "close";
          tok.pairId = nextPairId;
          nextPairId++;
          if (nextPairId === excludePairId) nextPairId++;
        } else {
          tok.kind = "open";
          stack.push(idx);
        }
      }
    }

    for (const idx of stack) {
      result[idx].pairId = 0;
    }
  }

  return result;
}

/**
 * Auto-adjust backtick counts to satisfy the nesting rule:
 * outer fence backtickCount must be >= inner fence backtickCount + 1.
 *
 * Detects nesting by checking if one pair's line range fully contains
 * another pair's line range. Applies minimal increments only — increases
 * the outer fence just enough to satisfy the rule.
 *
 * Only applies when both outer and inner use the same symbol type (backtick).
 */
export function autoAdjustBackticks(tokens: FenceToken[]): FenceToken[] {
  const result = tokens.map((t) => ({ ...t }));
  const pairs = getOutputPairs(result);

  // For each pair, find which other pairs are nested inside it
  for (const outer of pairs) {
    if (outer.open.symbol !== "backtick") continue;

    for (const inner of pairs) {
      if (inner.id === outer.id) continue;
      if (inner.open.symbol !== "backtick") continue;

      // Check if inner is fully within outer's line range
      if (
        inner.open.line > outer.open.line &&
        inner.close.line < outer.close.line
      ) {
        const minOuter = inner.open.backtickCount + 1;
        if (outer.open.backtickCount < minOuter) {
          const diff = minOuter - outer.open.backtickCount;
          // Mutate the existing tokens in-place so that the `pairs` array sees the change
          for (let i = 0; i < result.length; i++) {
            if (result[i].pairId === outer.id) {
              result[i].backtickCount += diff;
            }
          }
        }
      }
    }
  }

  // Re-truncate raw strings after adjustment
  for (let i = 0; i < result.length; i++) {
    result[i] = {
      ...result[i],
      raw: truncate(result[i].raw, 80),
    };
  }

  return result;
}

/**
 * Convert all tilde fences to backtick fences in outputTokens.
 */
export function convertTildesToBackticks(state: EditorState): EditorState {
  const newTokens = state.outputTokens.map((t) =>
    t.symbol === "tilde" ? { ...t, symbol: "backtick" as const } : { ...t },
  );
  return {
    ...state,
    outputTokens: newTokens,
    hasTilde: false,
    actionLog: [...state.actionLog, "Converted all tilde fences to backticks"],
  };
}

/**
 * Reconstruct the source text with outputTokens applied.
 * Non-fence lines are preserved exactly; fence lines are replaced
 * with the reconstructed fence string from outputTokens.
 */
export function reconstructSource(
  originalSource: string,
  outputTokens: FenceToken[],
): string {
  const lines = originalSource.split("\n");
  const tokenMap = new Map<number, FenceToken>();
  for (const t of outputTokens) {
    tokenMap.set(t.line, t);
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const token = tokenMap.get(lineNum);
    if (token) {
      const sym = token.symbol === "backtick" ? "`" : "~";
      const fenceStr = sym.repeat(token.backtickCount);
      lines[i] = token.infostring !== null
        ? `${fenceStr}${token.infostring}`
        : fenceStr;
    }
  }

  return lines.join("\n");
}
