import { decodeFrames, encodeFrames, FrameSchema, MachineMessageSchema, CloudMessageSchema, type MachineMessage } from "../../lib/shared/protocol";

describe("framing", () => {
  it("round-trips a 200 KB result through frames that each fit in one 32 KB WebSocket frame", () => {
    const text = "é".repeat(100_000); // 200 KB of multi-byte UTF-8, so slices cut characters in half
    const msg: MachineMessage = { type: "result", callId: "c1", ok: true, result: { content: [{ type: "text", text }] } };
    const frames = encodeFrames(msg, "m1");
    expect(frames.length).toBeGreaterThan(8);
    for (const f of frames) {
      expect(Buffer.byteLength(JSON.stringify(f))).toBeLessThan(32_000);
      expect(FrameSchema.safeParse(f).success).toBe(true);
    }
    expect(decodeFrames(frames.map((f) => f.d))).toEqual(msg);
  });

  it("sends a small message as a single frame", () => {
    expect(encodeFrames({ type: "ack", callId: "c1" }, "m2")).toHaveLength(1);
  });

  it("refuses a message larger than the frame budget", () => {
    const msg: MachineMessage = { type: "result", callId: "c1", ok: true, result: { content: [{ type: "text", text: "x".repeat(1_300_000) }] } };
    expect(() => encodeFrames(msg, "m3")).toThrow(/too large/);
  });
});

describe("message schemas", () => {
  it("rejects unknown message types in both directions", () => {
    expect(MachineMessageSchema.safeParse({ type: "exec", cmd: "rm" }).success).toBe(false);
    expect(CloudMessageSchema.safeParse({ type: "exec" }).success).toBe(false);
  });

  it("rejects a hello whose server name could break key or tool-name parsing", () => {
    const hello = { type: "hello", protocol: 1, machine: "mini", agentVersion: "0.1.0", servers: [{ name: "no#tes", status: "up", tools: [] }] };
    expect(MachineMessageSchema.safeParse(hello).success).toBe(false);
  });

  it("rejects a result error with a code outside the fixed list", () => {
    const r = { type: "result", callId: "c", ok: false, error: { code: "whatever", message: "m" } };
    expect(MachineMessageSchema.safeParse(r).success).toBe(false);
  });
});
