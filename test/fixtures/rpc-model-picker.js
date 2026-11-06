// Synthetic human UI driver for integration tests; never installed with the extension.
// The SDK RpcClient has no public extension_ui_response method, so this transparent
// transport answers only our model-picker dialogs while leaving native Pi untouched.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const child = spawn(
  process.execPath,
  [join(getPackageDir(), "dist/cli.js"), ...process.argv.slice(2)],
  { stdio: ["pipe", "pipe", "inherit"], env: process.env },
);
const inputDecoder = new StringDecoder("utf8");
let input = "";
process.stdin.on("data", (chunk) => {
  input += inputDecoder.write(chunk);
  let end;
  while ((end = input.indexOf("\n")) !== -1) {
    child.stdin.write(input.slice(0, end + 1));
    input = input.slice(end + 1);
  }
});
const decoder = new StringDecoder("utf8");
let pending = "";
child.stdout.on("data", (chunk) => {
  if (!process.stdout.write(chunk)) {
    child.stdout.pause();
    process.stdout.once("drain", () => child.stdout.resume());
  }
  pending += decoder.write(chunk);
  let end;
  while ((end = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      event.type !== "extension_ui_request" ||
      event.method !== "select" ||
      !/^Choose candidate models|^Review selected models/.test(
        event.title ?? "",
      )
    )
      continue;
    if (process.env.WORKER_TEST_PICKER_HOLD) continue;
    if (process.env.WORKER_TEST_PICKER_CANCEL) {
      child.stdin.write(
        JSON.stringify({
          type: "extension_ui_response",
          id: event.id,
          cancelled: true,
        }) + "\n",
      );
      continue;
    }
    const options = event.options ?? [];
    const desired = process.env.WORKER_TEST_PICK_MODEL;
    let value;
    if (desired && event.title.startsWith("Choose candidate models")) {
      const slash = desired.indexOf("/");
      const provider = desired.slice(0, slash),
        model = desired.slice(slash + 1);
      value = options.find((row) => {
        if (!/\[[x ]\]/.test(row)) return false;
        const selected = row.includes("[x]");
        const target =
          row.includes(JSON.stringify(provider)) &&
          row.includes(JSON.stringify(model));
        return selected !== target;
      });
    }
    value ??= options.find((option) =>
      /^Review selected models|^Start research/.test(option),
    );
    if (!value) throw new Error("No model-picker confirmation option");
    child.stdin.write(
      JSON.stringify({ type: "extension_ui_response", id: event.id, value }) +
        "\n",
    );
  }
});
child.stdin.on("error", () => {});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  process.exitCode = code ?? 1;
});
