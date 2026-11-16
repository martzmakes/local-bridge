// Forwards one tool call to a machine and waits for the outcome.
// Spec sections 3.2, 4 and 11: never hang. A stale heartbeat or a gone socket
// fails at once; a silent machine fails at the ack timeout; a slow tool fails
// at the deadline.
import { ACK_TIMEOUT_MS, OFFLINE_AFTER_MS, ToolResultSchema, type CloudMessage, type ToolResult } from "../../shared/protocol";
import type { CallMeta, MachineMeta } from "./store";

export type DispatchFailure =
  | "not_registered"
  | "machine_disabled"
  | "offline"
  | "reconnecting"
  | "not_responding"
  | "timeout"
  | "machine_error"
  | "bridge_error";

export type DispatchOutcome =
  | { ok: true; result: ToolResult }
  | { ok: false; failure: DispatchFailure; message: string; machineCode?: string };

export class GoneError extends Error {}

export interface DispatchDeps {
  getMachine(id: string): Promise<MachineMeta | null>;
  createCall(callId: string, machine: string, agent: string): Promise<void>;
  getCall(callId: string): Promise<CallMeta | null>;
  readResult(callId: string): Promise<string>;
  abandonCall(callId: string, machine: string): Promise<void>;
  deleteCall(callId: string, chunks: number): Promise<void>;
  /** Must throw GoneError when the connection no longer exists. */
  push(connectionId: string, message: CloudMessage): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface DispatchRequest {
  callId: string;
  agent: string;
  machine: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  maxResultBytes: number;
}

function lastSeenText(meta: MachineMeta): string {
  if (!meta.lastSeenAt) return "never connected";
  const t = new Date(meta.lastSeenAt).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `last seen ${t} ET`;
}

/** Why a machine cannot take a call right now, or null if it looks live. */
export function livenessFailure(meta: MachineMeta | null, machine: string, now: number): DispatchOutcome | null {
  if (!meta) return { ok: false, failure: "not_registered", message: `${machine} is not registered with the bridge` };
  if (!meta.enabled) return { ok: false, failure: "machine_disabled", message: `${machine} is disabled` };
  const fresh = meta.lastSeenAt !== undefined && now - meta.lastSeenAt <= OFFLINE_AFTER_MS;
  if (!meta.connectionId) {
    // A machine seen moments ago with no socket is in its reconnect window.
    if (meta.lastSeenAt !== undefined && now - meta.lastSeenAt <= 20_000) {
      return { ok: false, failure: "reconnecting", message: `${machine} is reconnecting, retry in a few seconds` };
    }
    return { ok: false, failure: "offline", message: `${machine} is offline (${lastSeenText(meta)}). It is asleep or disconnected.` };
  }
  if (!fresh) {
    return { ok: false, failure: "offline", message: `${machine} is offline (${lastSeenText(meta)}). It is probably asleep.` };
  }
  return null;
}

/** Messages a machine may send back that are safe to show: built from fixed codes, not server text. */
const MACHINE_ERROR_TEXT: Record<string, string> = {
  expired: "the call reached the machine after its deadline and was not run",
  not_exposed: "this tool is not exposed by the machine's local configuration",
  write_disabled: "this write tool is not enabled in the machine's local configuration",
  server_down: "the local server is not running",
  busy: "the machine is busy with other calls, retry shortly",
  cancelled: "the call was cancelled",
  tool_error: "the local server failed while running the tool",
};

export async function dispatchCall(req: DispatchRequest, deps: DispatchDeps): Promise<DispatchOutcome> {
  const meta = await deps.getMachine(req.machine);
  const down = livenessFailure(meta, req.machine, deps.now());
  if (down) return down;
  const connectionId = meta!.connectionId!;

  const started = deps.now();
  const deadline = started + req.timeoutMs;
  await deps.createCall(req.callId, req.machine, req.agent);
  try {
    await deps.push(connectionId, {
      type: "call",
      callId: req.callId,
      server: req.server,
      tool: req.tool,
      arguments: req.args,
      deadline,
      maxResultBytes: req.maxResultBytes,
    });
  } catch (err) {
    await deps.deleteCall(req.callId, 0);
    if (err instanceof GoneError) {
      return { ok: false, failure: "offline", message: `${req.machine} is offline (connection dropped). It is asleep or reconnecting.` };
    }
    return { ok: false, failure: "bridge_error", message: `bridge error ${req.callId}` };
  }

  for (;;) {
    const elapsed = deps.now() - started;
    const call = await deps.getCall(req.callId);
    if (!call) return { ok: false, failure: "bridge_error", message: `bridge error ${req.callId}` };

    if (call.status === "done") {
      const json = await deps.readResult(req.callId);
      await deps.deleteCall(req.callId, call.chunks ?? 0);
      const parsed = ToolResultSchema.safeParse(safeJson(json));
      if (!parsed.success) return { ok: false, failure: "bridge_error", message: `bridge error ${req.callId}` };
      return { ok: true, result: parsed.data };
    }
    if (call.status === "error") {
      await deps.deleteCall(req.callId, 0);
      const code = call.error?.code ?? "tool_error";
      // too_large, permission and timeout messages are composed by the local
      // agent from byte counts and permission names, with no content.
      const passthrough = code === "too_large" || code === "permission" || code === "timeout";
      const text = passthrough ? (call.error?.message ?? code) : (MACHINE_ERROR_TEXT[code] ?? "the machine could not run the call");
      return { ok: false, failure: "machine_error", machineCode: code, message: `${req.machine}.${req.server}: ${text}` };
    }
    if (call.status === "pending" && elapsed >= ACK_TIMEOUT_MS) {
      await deps.abandonCall(req.callId, req.machine);
      return { ok: false, failure: "not_responding", message: `${req.machine} is not responding (probably asleep). The call was not run.` };
    }
    if (elapsed >= req.timeoutMs) {
      await deps.abandonCall(req.callId, req.machine);
      try {
        await deps.push(connectionId, { type: "cancel", callId: req.callId });
      } catch {
        // the machine is gone; nothing to cancel
      }
      return {
        ok: false,
        failure: "timeout",
        message: `timed out after ${Math.round(req.timeoutMs / 1000)} s waiting for ${req.machine}.${req.server}. If this was a write, it may still have happened; check before retrying.`,
      };
    }
    await deps.sleep(elapsed < 2_000 ? 40 : 120);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
