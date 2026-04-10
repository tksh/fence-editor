/**
 * Thin Deno API wrapper.
 * Isolates all Deno-specific I/O for easier testing and runtime portability.
 */

/** Return the raw CLI arguments (excluding the runtime executable and script path). */
export function getArgs(): string[] {
  return Deno.args;
}

/** Read all content from stdin. */
export async function readStdin(): Promise<string> {
  const decoder = new TextDecoder();
  let result = "";
  // Check if stdin is a TTY (interactive) — if so, return empty
  if (Deno.stdin.isTerminal()) {
    return "";
  }
  for await (const chunk of Deno.stdin.readable) {
    result += decoder.decode(chunk, { stream: true });
  }
  return result;
}

/**
 * Read a single line from stdin.
 * Uses a BufReader-like approach to read until newline.
 */
export async function readLine(): Promise<string> {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(1);
  let line = "";

  while (true) {
    const bytesRead = await Deno.stdin.read(buffer);
    if (bytesRead === null) {
      // EOF
      return line;
    }
    if (bytesRead === 0) {
      return line;
    }
    const byte = buffer[0];
    if (byte === 0x0a) {
      // \n — end of line
      // Check for trailing \r
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      return line;
    }
    line += decoder.decode(buffer);
  }
}

/** Write content to a file, creating parent directories if needed. */
export async function writeFile(
  path: string,
  content: string,
): Promise<void> {
  const encoder = new TextEncoder();
  await Deno.writeFile(path, encoder.encode(content));
}

/** Exit the process with a given code. */
export function exit(code: number): never {
  Deno.exit(code);
}
