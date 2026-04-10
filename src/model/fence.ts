/**
 * Core data models for code fence tokens and pairs.
 * Shared between parser and state modules.
 */

/** A single code fence line extracted from source. */
export interface FenceToken {
  /** 1-based line number in the source */
  line: number;
  /** Original line text, truncated to 80 chars */
  raw: string;
  /** Number of consecutive backticks or tildes */
  backtickCount: number;
  /** The fence symbol type */
  symbol: "backtick" | "tilde";
  /** Language/infostring if present, null otherwise */
  infostring: string | null;
  /** Whether this fence acts as an opener or closer */
  kind: "open" | "close";
  /** Pair identifier (1-based, assigned during pairing) */
  pairId: number;
}

/** A matched pair of opening and closing fences. */
export interface FencePair {
  /** Unique pair identifier */
  id: number;
  /** The opening fence token */
  open: FenceToken;
  /** The closing fence token */
  close: FenceToken;
}

/**
 * Parser function type. Both CommonMark and Djot parsers
 * implement this signature, returning an array of FenceTokens
 * with pairIds already assigned.
 */
export type FenceParser = (source: string) => FenceToken[];

/** Truncate a string to maxLength characters. */
export function truncate(s: string, maxLength: number): string {
  if (s.length <= maxLength) return s;
  return s.slice(0, maxLength);
}
