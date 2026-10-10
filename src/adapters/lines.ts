import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Stream a text file line by line so large log files are never fully
 * buffered in memory. Handles both \n and \r\n line endings.
 */
export async function* readLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}
