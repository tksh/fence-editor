/**
 * Thin Deno API wrapper.
 * Isolates all Deno-specific I/O for easier testing and runtime portability.
 *
 * Key design: readStdin() and readLine() read from DIFFERENT sources.
 * - readStdin(): reads ALL data from DENO.STDIN (works correctly for pipes).
 * - readLine(): reads interactive prompts from the CONTROLLING TERMINAL
 *   (/dev/tty or CON), NEVER from a piped DENO.STDIN.
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

// ─── Interactive Terminal Reader ─────────────────────────────────

/** Minimal reader interface — satisfied by both FsFile and Deno.stdin. */
interface Reader {
  read(p: Uint8Array<ArrayBufferLike>): Promise<number | null>;
}

/**
 * Cached handle for the controlling terminal.
 * Lazily opened on the first call to readLine().
 */
let ttyFile: Reader | null = null;

/**
 * Get (or create) a reader for the controlling terminal.
 * Tries /dev/tty (Unix) → CON (Windows) → fallback to Deno.stdin.
 */
function getTtyFile(): Reader {
  if (ttyFile) return ttyFile;

  const osType = Deno.build.os;
  const ttyPath = osType === "windows" ? "CON" : "/dev/tty";

  try {
    const handle: Reader = Deno.openSync(ttyPath, { read: true });
    ttyFile = handle;
  } catch {
    // If the alternate tty path also fails, try the other platform's path
    const fallback = osType === "windows" ? "/dev/tty" : "CON";
    try {
      const handle: Reader = Deno.openSync(fallback, { read: true });
      ttyFile = handle;
    } catch {
      // Last resort: use stdin directly (works only if stdin is a TTY)
      ttyFile = Deno.stdin as Reader;
    }
  }

  return ttyFile;
}

/**
 * Read a single line from the controlling terminal.
 *
 * Blocks until the user presses Enter. Always reads from /dev/tty (Unix)
 * or CON (Windows), never from a piped stdin. This ensures that
 * `cat file.md | deno run ...` correctly waits for keyboard input.
 *
 * Handles both \n and \r\n line endings.
 */
export async function readLine(): Promise<string> {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(1);
  let line = "";
  const tty = getTtyFile();

  while (true) {
    const bytesRead = await tty.read(buffer);
    if (bytesRead === null) {
      // EOF on the tty
      return line;
    }
    if (bytesRead === 0) {
      // Zero bytes read — treat as EOF
      return line;
    }
    const byte = buffer[0];
    if (byte === 0x0a) {
      // \n — end of line
      // Strip trailing \r for \r\n (Windows-style)
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
