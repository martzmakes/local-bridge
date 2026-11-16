// Wire protocol between a machine's local agent and the cloud.
// Imported by both sides (the agent imports this file by relative path), so it
// must depend on nothing but zod and Node's Buffer.
// Spec: docs/superpowers/specs/2026-11-15-local-bridge-design.md section 6.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/** Machine and server names: short, lowercase, safe inside keys and tool names. */
export const NAME_RE = /^[a-z0-9]{1,16}$/;
export const NameSchema = z.string().regex(NAME_RE);

/** A local tool's own name. Anything the local server calls it, within reason. */
export const ToolNameSchema = z.string().min(1).max(128);

export const AccessSchema = z.enum(["read", "write"]);
export type Access = z.infer<typeof AccessSchema>;

export const ToolInfoSchema = z.object({
  name: ToolNameSchema,
  description: z.string().max(8192).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  access: AccessSchema,
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

export const ServerInfoSchema = z.object({
  name: NameSchema,
  /** Display name set in the machine's app, shown to MCP clients. */
  title: z.string().max(64).optional(),
  status: z.enum(["up", "down"]),
  error: z.string().max(500).optional(),
  tools: z.array(ToolInfoSchema).max(500),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

export const ServerStatusSchema = ServerInfoSchema.pick({ name: true, status: true, error: true });
export type ServerStatus = z.infer<typeof ServerStatusSchema>;

export const CallErrorCodeSchema = z.enum([
  "expired", // deadline already passed when the call arrived
  "not_exposed", // server or tool is not in the machine's config
  "write_disabled", // tool is a write tool the machine's config has not enabled
  "server_down", // local server is not running
  "too_large", // result exceeded maxResultBytes
  "permission", // a macOS privacy permission is missing
  "timeout", // the local tool did not return before the deadline
  "busy", // too many calls in flight on this machine
  "cancelled",
  "tool_error", // the local server threw (as opposed to returning isError)
]);
export type CallErrorCode = z.infer<typeof CallErrorCodeSchema>;

/** An MCP CallToolResult as returned by the local server; passed through opaquely. */
export const ToolResultSchema = z
  .object({
    content: z.array(z.record(z.string(), z.unknown())).default([]),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
    isError: z.boolean().optional(),
  })
  .loose();
export type ToolResult = z.infer<typeof ToolResultSchema>;

// ---------------------------------------------------------------------------
// Machine -> cloud
// ---------------------------------------------------------------------------

export const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.number().int(),
  machine: NameSchema,
  agentVersion: z.string().max(32),
  servers: z.array(ServerInfoSchema).max(32),
});

export const HeartbeatSchema = z.object({
  type: z.literal("hb"),
  servers: z.array(ServerStatusSchema).max(32),
});

export const AckSchema = z.object({ type: z.literal("ack"), callId: z.string().min(1).max(64) });

export const ResultSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("result"),
    callId: z.string().min(1).max(64),
    ok: z.literal(true),
    result: ToolResultSchema,
  }),
  z.object({
    type: z.literal("result"),
    callId: z.string().min(1).max(64),
    ok: z.literal(false),
    error: z.object({ code: CallErrorCodeSchema, message: z.string().max(1000) }),
  }),
]);

export const RotateSchema = z.object({
  type: z.literal("rotate"),
  kid: z.string().min(1).max(64),
  jwk: z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().min(40).max(64) }),
});

export const MachineMessageSchema = z.union([
  HelloSchema,
  HeartbeatSchema,
  AckSchema,
  ResultSchema,
  RotateSchema,
]);
export type MachineMessage = z.infer<typeof MachineMessageSchema>;
export type HelloMessage = z.infer<typeof HelloSchema>;
export type ResultMessage = z.infer<typeof ResultSchema>;

// ---------------------------------------------------------------------------
// Cloud -> machine
// ---------------------------------------------------------------------------

export const WelcomeSchema = z.object({
  type: z.literal("welcome"),
  machine: NameSchema,
  serverTime: z.number(),
});

export const CallSchema = z.object({
  type: z.literal("call"),
  callId: z.string().min(1).max(64),
  server: NameSchema,
  tool: ToolNameSchema,
  arguments: z.record(z.string(), z.unknown()),
  /** Epoch milliseconds. The machine refuses the call after this. */
  deadline: z.number(),
  maxResultBytes: z.number().int().positive(),
});
export type CallMessage = z.infer<typeof CallSchema>;

export const CancelSchema = z.object({ type: z.literal("cancel"), callId: z.string().min(1).max(64) });

export const RotatedSchema = z.object({ type: z.literal("rotated"), kid: z.string() });

export const CloudMessageSchema = z.discriminatedUnion("type", [
  WelcomeSchema,
  CallSchema,
  CancelSchema,
  RotatedSchema,
]);
export type CloudMessage = z.infer<typeof CloudMessageSchema>;

// ---------------------------------------------------------------------------
// Framing (machine -> cloud only)
//
// API Gateway WebSocket caps one frame at 32 KB and one message at 128 KB.
// Every machine->cloud message is cut into slices of raw UTF-8 bytes, each
// base64-encoded into its own small JSON frame, so no frame comes near 32 KB
// and a message may be far larger than 128 KB.
// ---------------------------------------------------------------------------

export const FRAME_RAW_BYTES = 18_000; // 24 KB once base64-encoded
export const MAX_FRAMES = 64; // 64 * 18 KB = 1.15 MB, above the 1 MB result ceiling

export const FrameSchema = z.object({
  t: z.literal("f"),
  id: z.string().min(1).max(40),
  i: z.number().int().min(0),
  n: z.number().int().min(1).max(MAX_FRAMES),
  d: z.string().max(26_000),
});
export type Frame = z.infer<typeof FrameSchema>;

export function encodeFrames(message: MachineMessage, id: string): Frame[] {
  const bytes = Buffer.from(JSON.stringify(message), "utf8");
  const n = Math.max(1, Math.ceil(bytes.length / FRAME_RAW_BYTES));
  if (n > MAX_FRAMES) throw new Error(`message too large to frame (${bytes.length} bytes)`);
  const frames: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const slice = bytes.subarray(i * FRAME_RAW_BYTES, (i + 1) * FRAME_RAW_BYTES);
    frames.push({ t: "f", id, i, n, d: slice.toString("base64") });
  }
  return frames;
}

/** Joins the `d` fields of a complete, ordered frame set back into a message. */
export function decodeFrames(parts: string[]): MachineMessage {
  const json = Buffer.concat(parts.map((p) => Buffer.from(p, "base64"))).toString("utf8");
  return MachineMessageSchema.parse(JSON.parse(json));
}

// ---------------------------------------------------------------------------
// Device assertion (the JWT a machine presents on the WebSocket upgrade)
// ---------------------------------------------------------------------------

export const DEVICE_AUDIENCE = "local-bridge-device";
export const DEVICE_ASSERTION_TTL_SECONDS = 60;

// Timing constants both sides agree on.
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** A machine whose last heartbeat is older than this is treated as offline. */
export const OFFLINE_AFTER_MS = 150_000;
export const ACK_TIMEOUT_MS = 3_000;
export const DEADLINE_SKEW_MS = 30_000;
