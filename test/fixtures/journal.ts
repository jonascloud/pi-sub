import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";

/** Worker scenarios make no billable tool calls; their tokens are all assistant usage. */
export async function assistantTokens(file: string) {
  return parseSessionEntries(await readFile(file, "utf8")).reduce(
    (sum, entry) =>
      sum +
      (entry.type === "message" && entry.message.role === "assistant"
        ? entry.message.usage.totalTokens
        : 0),
    0,
  );
}
