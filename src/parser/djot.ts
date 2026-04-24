/**
 * Djot code fence parser using djot.js.
 *
 * Uses djot.js parse() to get AST with source positions, finds code_block
 * nodes, and extracts fence tokens from the corresponding lines.
 */

import djot from "@djot/djot";
import type { FenceParser, FenceToken } from "../model/fence.ts";
import { truncate } from "../model/fence.ts";
import { pairFences } from "../model/state.ts";

/**
 * Parse Djot source and return FenceToken[] with pairIds assigned.
 *
 * Process:
 * 1. Parse with sourcePositions to get AST with code_block locations.
 * 2. Find code_block nodes and extract their open/close line numbers.
 * 3. Extract fence strings from those lines (backtick/tilde count, infostring).
 * 4. Pair fences using the shared pairing logic.
 */
export const parseDjot: FenceParser = (source: string): FenceToken[] => {
  const lines = source.split("\n");
  const fences: FenceToken[] = [];

  // Parse with source positions to get code_block locations
  const ast = djot.parse(source, { sourcePositions: true });

  // Walk the AST to find code_block nodes
  const codeBlocks = findCodeBlocks(ast as unknown as AstNode);

  for (const cb of codeBlocks) {
    if (!cb.pos) continue;

    const startLine = cb.pos.start.line;
    const endLine = cb.pos.end.line;

    const startLineContent = lines[startLine - 1] ?? "";
    const endLineContent = lines[endLine - 1] ?? "";

    // Extract language from the code_block's lang field
    const infostring = cb.lang ?? null;

    const openFence = extractFenceFromLine(
      startLineContent,
      startLine,
      true,
      infostring,
    );
    const closeFence = extractFenceFromLine(
      endLineContent,
      endLine,
      false,
      null,
    );

    if (openFence) fences.push(openFence);
    if (closeFence) fences.push(closeFence);
  }

  return pairFences(fences);
};

/** AST node type from djot.js (simplified). */
interface AstNode {
  tag: string;
  children?: AstNode[];
  pos?: {
    start: { line: number; col: number; offset: number };
    end: { line: number; col: number; offset: number };
  };
  lang?: string | null;
  text?: string;
  attrs?: Record<string, string>;
}

/**
 * Recursively find all code_block nodes in the AST.
 * Uses a minimal walker that only accesses properties we care about,
 * avoiding deep type compatibility checks with djot.js's full AST type.
 */
function findCodeBlocks(
  node: Record<string, unknown> | AstNode,
): AstNode[] {
  const results: AstNode[] = [];
  const n = node as Record<string, unknown>;

  if (n.tag === "code_block") {
    results.push(n as unknown as AstNode);
  }

  const children = n.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (typeof child === "object" && child !== null) {
        results.push(...findCodeBlocks(child as Record<string, unknown>));
      }
    }
  }

  return results;
}

/**
 * Extract fence details from a line.
 */
function extractFenceFromLine(
  line: string,
  lineNum: number,
  isOpen: boolean,
  overrideInfo: string | null,
): FenceToken | null {
  const trimmed = line.trimStart();

  // Match fence: 3+ consecutive backticks or tildes
  const match = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
  if (!match) return null;

  const fenceChars = match[1];

  const symbol = fenceChars[0] === "`" ? ("backtick" as const) : ("tilde" as const);
  const count = fenceChars.length;
  // In Djot, only opening fences can have infostrings
  const infostring = isOpen ? (overrideInfo ?? null) : null;
  const kind: "open" | "close" = isOpen ? "open" : "close";

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
