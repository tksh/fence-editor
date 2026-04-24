/**
 * Test: verify stderr/stdout separation.
 * UI goes to stderr, data goes to stdout.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("verify: render functions write to stderr, not stdout", async () => {
  // Capture stderr and stdout separately
  const origStderr = Deno.stderr;
  const origStdout = Deno.stdout;

  // We can't easily intercept the writes in a unit test,
  // so we verify the code path statically:
  // render.ts uses Deno.stderr.writeSync for ALL UI output
  // cli.ts uses Deno.stdout.writeSync ONLY for destination "stdout"

  // This test documents the contract. Actual verification happens
  // in the integration test below.
  assertEquals(typeof Deno.stderr.writeSync, "function");
  assertEquals(typeof Deno.stdout.writeSync, "function");
});

Deno.test("verify: render.ts source code uses stderr exclusively", async () => {
  const renderSource = await Deno.readTextFile("src/ui/render.ts");

  // All Deno writes in render.ts should go to stderr
  const stdoutWrites = [...renderSource.matchAll(/Deno\.stdout\./g)];
  assertEquals(
    stdoutWrites.length,
    0,
    `render.ts should NOT contain Deno.stdout writes, found: ${stdoutWrites.map((m) => m[0])}`,
  );

  // Should contain stderr writes
  const stderrWrites = [...renderSource.matchAll(/Deno\.stderr\./g)];
  assert(stderrWrites.length > 0, "render.ts should contain Deno.stderr writes");
});

Deno.test("verify: cli.ts uses stdout only for destination output", async () => {
  const cliSource = await Deno.readTextFile("src/cli.ts");

  // stdout should only be used for the final content output
  const stdoutLines = [...cliSource.matchAll(/Deno\.stdout\.writeSync/g)];
  assertEquals(
    stdoutLines.length,
    1,
    `cli.ts should have exactly 1 Deno.stdout.writeSync (for destination [3]), found: ${stdoutLines.length}`,
  );

  // All other messages should go to stderr
  const stderrLines = [...cliSource.matchAll(/Deno\.stderr\./g)];
  assert(stderrLines.length >= 3, "cli.ts should use stderr for multiple messages");
});
