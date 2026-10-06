import { parseAntigravityStdoutLine } from "../ui/parse-stdout.js";
export function printAntigravityStreamEvent(raw: string, debug: boolean): void {
  for (const entry of parseAntigravityStdoutLine(raw, "")) {
    if (entry.kind === "assistant") process.stdout.write(entry.text);
    else if (entry.kind === "result" && entry.isError) console.error(entry.errors?.join("\n") || "Antigravity run failed");
    else if (debug) console.log(raw);
  }
}
