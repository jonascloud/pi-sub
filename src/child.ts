import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Explicitly loaded in the native CLI, not a replacement runtime or provider. */
export default function childGuard(pi: ExtensionAPI) {
  if (process.env.PI_SUB_CHILD !== "1") return;
  let blocked: string | undefined;
  const check = (ctx: ExtensionContext) => {
    const expected = `${process.env.PI_SUB_EXPECTED_PROVIDER}/${process.env.PI_SUB_EXPECTED_MODEL} thinking=${process.env.PI_SUB_EXPECTED_THINKING}`;
    const actual = `${ctx.model?.provider}/${ctx.model?.id} thinking=${ctx.thinkingLevel}`;
    if (expected !== actual)
      blocked ??= `Worker model mismatch: expected ${expected}, got ${actual}`;
    const expectedSession = process.env.PI_SUB_EXPECTED_SESSION_FILE;
    const actualSession = ctx.sessionManager.getSessionFile();
    if (!expectedSession || actualSession !== expectedSession)
      blocked ??= `Worker session mismatch: expected ${expectedSession}, got ${actualSession}`;
    const expectedId = process.env.PI_SUB_EXPECTED_SESSION_ID;
    if (expectedId && ctx.sessionManager.getSessionId() !== expectedId)
      blocked ??= "Worker session identity mismatch";
    if (blocked) {
      console.error(blocked);
      // Never await abort from an active hook: abort waits for this run to finish.
      void ctx.abort();
    }
    return !!blocked;
  };
  pi.on("session_start", (_event, ctx) => {
    check(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    check(ctx);
  });
  pi.on("before_provider_request", (_event, ctx) => {
    check(ctx);
  });
  // Restored sessions can compact before before_agent_start.
  pi.on("session_before_compact", (_event, ctx) => {
    if (check(ctx)) return { cancel: true };
  });
}
