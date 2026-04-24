/**
 * Test tilde fence actions: restructure, conversion, and state mutation.
 */

import { parseCommonMark } from "../src/parser/commonmark.ts";
import { applyAction, autoAdjustBackticks, createEditorState, generateValidActions, getOutputPairs, reconstructOutput } from "../src/model/state.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Tilde-only test file ───────────────────────────────────────
const TILDE_SOURCE = `~~~js
outer content
~~~
~~~
inner content
~~~
end
`;

Deno.test("tilde: parse and verify initial pairing", () => {
  const tokens = parseCommonMark(TILDE_SOURCE);
  assertEquals(tokens.length, 4, "Should have 4 fence tokens");
  assert(tokens.every((t) => t.symbol === "tilde"), "All should be tildes");

  const state = createEditorState(tokens);
  const pairs = getOutputPairs(state.outputTokens);
  assertEquals(pairs.length, 2, "Should have 2 pairs");

  assertEquals(pairs[0].open.line, 1);
  assertEquals(pairs[0].close.line, 3);
  assertEquals(pairs[1].open.line, 4);
  assertEquals(pairs[1].close.line, 6);
});

Deno.test("tilde: generate restructure action (pairwise swap)", () => {
  const tokens = parseCommonMark(TILDE_SOURCE);
  const state = createEditorState(tokens);

  const actions = generateValidActions(state);
  const swapAction = actions.find(
    (a) => a.type === "restructure" && a.swapPairId !== undefined,
  );
  assert(swapAction, "Should have a swap action for tilde pairs");
  assert(
    swapAction.label.includes("line 6") && swapAction.label.includes("line 4"),
    `Swap label should reference moving close to line 6, got: "${swapAction.label}"`,
  );
});

Deno.test("tilde: apply swap action mutates state correctly", () => {
  const tokens = parseCommonMark(TILDE_SOURCE);
  const state = createEditorState(tokens);

  const actions = generateValidActions(state);
  const swapAction = actions.find(
    (a) => a.type === "restructure" && a.swapPairId !== undefined,
  );
  assert(swapAction, "Should have swap action");

  const newState = applyAction(state, swapAction.id);

  const newPairs = getOutputPairs(newState.outputTokens);
  assertEquals(newPairs.length, 2);

  const outer = newPairs.find((p) => p.open.line === 1 && p.close.line === 6);
  const inner = newPairs.find((p) => p.open.line === 3 && p.close.line === 4);

  assert(outer, `Should have outer pair (1,6)`);
  assert(inner, `Should have inner pair (3,4)`);

  assert(
    newState.outputTokens.every((t) => t.symbol === "tilde"),
    "All tokens should remain tilde after swap",
  );

  for (const t of newState.outputTokens) {
    assert(
      t.raw.startsWith("~"),
      `Token at line ${t.line} raw should start with ~, got: "${t.raw}"`,
    );
  }
});

Deno.test("tilde: reconstructOutput uses updated token.raw after swap", () => {
  const tokens = parseCommonMark(TILDE_SOURCE);
  const state = createEditorState(tokens);

  const actions = generateValidActions(state);
  const swapAction = actions.find(
    (a) => a.type === "restructure" && a.swapPairId !== undefined,
  );
  assert(swapAction, "Should have swap action");

  const newState = applyAction(state, swapAction.id);
  const originalLines = TILDE_SOURCE.split("\n");
  const output = reconstructOutput(newState.outputTokens, originalLines);
  const outputLines = output.split("\n");

  const line1Token = newState.outputTokens.find((t) => t.line === 1)!;
  const line3Token = newState.outputTokens.find((t) => t.line === 3)!;
  const line4Token = newState.outputTokens.find((t) => t.line === 4)!;
  const line6Token = newState.outputTokens.find((t) => t.line === 6)!;

  assertEquals(outputLines[0], line1Token.raw);
  assertEquals(outputLines[2], line3Token.raw);
  assertEquals(outputLines[3], line4Token.raw);
  assertEquals(outputLines[5], line6Token.raw);

  assertEquals(line1Token.backtickCount, 4, "Outer open should have 4 tildes");
  assertEquals(line6Token.backtickCount, 4, "Outer close should have 4 tildes");
  assertEquals(line3Token.backtickCount, 3, "Inner open should stay at 3");
  assertEquals(line4Token.backtickCount, 3, "Inner close should stay at 3");
});

Deno.test("tilde: autoAdjustBackticks works for tilde nesting", () => {
  const tokens = [
    { line: 1, backtickCount: 3, symbol: "tilde" as const, infostring: "outer", kind: "open" as const, pairId: 1, raw: "~~~" },
    { line: 3, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "~~~" },
    { line: 5, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "~~~" },
    { line: 7, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "~~~" },
  ];

  const adjusted = autoAdjustBackticks(tokens);
  const outer = adjusted.find((t) => t.pairId === 1 && t.kind === "open")!;
  const inner = adjusted.find((t) => t.pairId === 2 && t.kind === "open")!;

  assertEquals(outer.backtickCount, 4, "Outer tilde should be increased to 4");
  assertEquals(inner.backtickCount, 3, "Inner tilde should stay at 3");
  assert(outer.raw.startsWith("~~~~"), `Outer raw should start with ~~~~, got: "${outer.raw}"`);
});

Deno.test("tilde: convert-tilde is atomic with auto-adjustment", () => {
  // Nested tilde pairs with equal counts
  const tokens = [
    { line: 1, backtickCount: 3, symbol: "tilde" as const, infostring: "outer", kind: "open" as const, pairId: 1, raw: "~~~" },
    { line: 3, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "~~~" },
    { line: 5, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "~~~" },
    { line: 7, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "~~~" },
  ];
  const state = createEditorState(tokens);

  const actions = generateValidActions(state);
  const convertAction = actions.find((a) => a.type === "convert-tilde");
  assert(convertAction, "Should have convert-tilde action");

  const newState = applyAction(state, convertAction.id);

  // All symbols should be backtick
  assert(
    newState.outputTokens.every((t) => t.symbol === "backtick"),
    "All tokens should be backtick after conversion",
  );

  // Outer should have been auto-adjusted to 4
  const outer = newState.outputTokens.find((t) => t.line === 1)!;
  const inner = newState.outputTokens.find((t) => t.line === 3)!;

  assertEquals(outer.backtickCount, 4, "Outer should be auto-adjusted to 4");
  assertEquals(inner.backtickCount, 3, "Inner should stay at 3");

  assert(outer.raw.startsWith("````"), `Outer raw should start with \`\`\`\`, got: "${outer.raw}"`);
  assertEquals(newState.hasTilde, false);
});

Deno.test("tilde: convert-tilde on mixed backtick+tilde nesting", () => {
  // O.1=(5,14) backtick, O.2=(8,11) tilde, O.3=(18,21) tilde
  // After conversion: O.2 nested inside O.1, so O.1 count → 4
  const tokens = [
    { line: 5, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "open" as const, pairId: 1, raw: "```" },
    { line: 8, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 2, raw: "~~~" },
    { line: 11, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 2, raw: "~~~" },
    { line: 14, backtickCount: 3, symbol: "backtick" as const, infostring: null, kind: "close" as const, pairId: 1, raw: "```" },
    { line: 18, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "open" as const, pairId: 3, raw: "~~~" },
    { line: 21, backtickCount: 3, symbol: "tilde" as const, infostring: null, kind: "close" as const, pairId: 3, raw: "~~~" },
  ];
  const state = createEditorState(tokens);

  const actions = generateValidActions(state);
  const convertAction = actions.find((a) => a.type === "convert-tilde");
  assert(convertAction, "Should have convert-tilde action");

  const newState = applyAction(state, convertAction.id);

  // O.1=(5,14) should have count 4 (O.2=(8,11) is nested inside)
  const outer = newState.outputTokens.find((t) => t.line === 5)!;
  assertEquals(outer.backtickCount, 4, "O.1 should be auto-adjusted to 4");

  // O.3=(18,21) should stay at 3 (not nested inside O.1)
  const o3open = newState.outputTokens.find((t) => t.line === 18)!;
  assertEquals(o3open.backtickCount, 3, "O.3 should stay at 3");

  // All symbols should be backtick
  assert(
    newState.outputTokens.every((t) => t.symbol === "backtick"),
    "All tokens should be backtick",
  );
});
