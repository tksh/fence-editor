/**
 * Integration test: parse test/00.md, apply swap action, verify output.
 */

import { parseCommonMark } from "../src/parser/commonmark.ts";
import {
  createEditorState,
  generateValidActions,
  applyAction,
  reconstructOutput,
  getOutputPairs,
} from "../src/model/state.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile("test/fixtures/00.md");
const originalLines = source.split("\n");

Deno.test("integration: test/fixtures/00.md swap action produces correct nested output", () => {
  const tokens = parseCommonMark(source);
  const state = createEditorState(tokens);

  console.log("Initial pairs:");
  for (const p of getOutputPairs(state.outputTokens)) {
    console.log(`  O.${p.id}: line ${p.open.line} → line ${p.close.line}`);
  }

  const actions = generateValidActions(state);
  console.log("\nAvailable actions:");
  for (const a of actions) {
    console.log(`  [${a.id}] ${a.label}`);
  }

  const swapAction = actions.find(
    (a) => a.type === "restructure" && a.swapPairId !== undefined,
  );
  assert(swapAction, "Should have swap action");

  assertEquals(
    swapAction.label,
    "Change close fence for O.1 from line 8 to line 14 (auto-pairs O.2 to line 11)",
  );

  const newState = applyAction(state, swapAction.id);

  console.log("\nAfter swap:");
  for (const p of getOutputPairs(newState.outputTokens)) {
    console.log(
      `  O.${p.id}: line ${p.open.line} → line ${p.close.line} (${p.open.symbol}, ${p.open.backtickCount}x)`,
    );
  }

  // Verify nested structure
  const pairs = getOutputPairs(newState.outputTokens);
  assertEquals(pairs.length, 2);

  const outer = pairs.find((p) => p.open.line === 5 && p.close.line === 14)!;
  const inner = pairs.find((p) => p.open.line === 8 && p.close.line === 11)!;

  assert(outer, "Outer pair (5,14) should exist");
  assert(inner, "Inner pair (8,11) should exist");

  // Verify backtick adjustment: outer >= inner + 1
  assert(
    outer.open.backtickCount >= inner.open.backtickCount + 1,
    `Outer backtickCount (${outer.open.backtickCount}) should be >= inner + 1 (${inner.open.backtickCount + 1})`,
  );

  // Verify raw strings are correct
  const line5 = newState.outputTokens.find((t) => t.line === 5)!;
  const line8 = newState.outputTokens.find((t) => t.line === 8)!;
  const line11 = newState.outputTokens.find((t) => t.line === 11)!;
  const line14 = newState.outputTokens.find((t) => t.line === 14)!;

  assertEquals(line5.kind, "open");
  assertEquals(line8.kind, "open");
  assertEquals(line11.kind, "close");
  assertEquals(line14.kind, "close");

  // Outer should have 4 backticks (inner has 3, need >= 4)
  assertEquals(line5.backtickCount, 4);
  assertEquals(line14.backtickCount, 4);
  assertEquals(line5.raw, "````");
  assertEquals(line14.raw, "````");

  // Inner stays at 3
  assertEquals(line8.backtickCount, 3);
  assertEquals(line11.backtickCount, 3);
  assertEquals(line8.raw, "```");
  assertEquals(line11.raw, "```");

  // Verify output reconstruction
  const output = reconstructOutput(newState.outputTokens, originalLines);
  const outputLines = output.split("\n");

  assertEquals(outputLines[0], "# Test markdown file"); // preserved
  assertEquals(outputLines[4], "````"); // line 5 (0-indexed 4)
  assertEquals(outputLines[7], "```"); // line 8 (0-indexed 7)
  assertEquals(outputLines[10], "```"); // line 11 (0-indexed 10)
  assertEquals(outputLines[13], "````"); // line 14 (0-indexed 13)

  // Non-fence lines preserved
  assertEquals(outputLines[1], "");
  assertEquals(outputLines[2], "Normal text.");
  assertEquals(outputLines[5], "Fenced text before code block.");
});
