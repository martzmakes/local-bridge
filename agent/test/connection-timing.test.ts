// Unit tests for the connection's clock-driven behaviour, with time, timers
// and the WebSocket all injected. No sockets are opened.
import { describe, expect, it } from "vitest";
import {
  FrameSchema,
  decodeFrames,
  type MachineMessage,
  type ResultMessage,
  type ServerInfo,
} from "../../infra/lib/shared/protocol";
import { Connection, type SocketLike, type Timers } from "../src/connection";
import type { CallOptions, ToolRunner } from "../src/servers";

class FakeClock implements Timers {
  now = 1_800_000_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void; every?: number }>();

  setTimeout = (fn: () => void, ms: number) => this.add(fn, ms);
  setInterval = (fn: () => void, ms: number) => this.add(fn, ms, ms);
  clearTimeout = (h: unknown) => void this.timers.delete(h as number);
  clearInterval = (h: unknown) => void this.timers.delete(h as number);

  private add(fn: () => void, ms: number, every?: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn, ...(every !== undefined ? { every } : {}) });
    return id;
  }

  /** Delays of the pending one-shot timers, soonest first. */
  pendingTimeouts(): number[] {
    return [...this.timers.values()].filter((t) => t.every === undefined).map((t) => t.at - this.now).sort((a, b) => a - b);
  }

  /** Moves time forward, firing timers in order and letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every?: number }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      const [id, timer] = next;
      this.now = Math.max(this.now, timer.at);
      if (timer.every !== undefined) timer.at += timer.every;
      else this.timers.delete(id);
      timer.fn();
      await flush();
    }
    this.now = end;
    await flush();
  }

  /** The machine slept: the clock moves but no timer fired in between. */
  sleep(ms: number): void {
    this.now += ms;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: MachineMessage[] = [];
  closedWith: number | "terminated" | undefined;
  private readonly handlers = new Map<string, Array<(arg?: any) => void>>();
  private readonly partial = new Map<string, string[]>();

  constructor(readonly url: string, readonly headers: Record<string, string>) {}

  on(event: string, listener: (arg?: any) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    return this;
  }
  private emit(event: string, arg?: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(arg);
  }
  send(data: string, cb?: (err?: Error | null) => void): void {
    if (this.readyState !== 1) throw new Error("send on a socket that is not open");
    const frame = FrameSchema.parse(JSON.parse(data));
    const parts = this.partial.get(frame.id) ?? [];
    this.partial.set(frame.id, parts);
    parts.push(frame.d);
    if (parts.length === frame.n) {
      this.partial.delete(frame.id);
      this.sent.push(decodeFrames(parts));
    }
    cb?.();
  }
  close(code?: number): void {
    this.closedWith = code ?? 1005;
    this.readyState = 3;
  }
  terminate(): void {
    this.closedWith = "terminated";
    this.readyState = 3;
  }
  // Test controls.
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
  /** The other end went away. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.emit("close", code);
  }
  types(): string[] {
    return this.sent.map((m) => m.type);
  }
}

class FakeRunner implements ToolRunner {
  servers: ServerInfo[] = [{ name: "fix", status: "up", tools: [{ name: "echo", inputSchema: {}, access: "read" }] }];
  calls: Array<{ server: string; tool: string; opts: CallOptions; finish: (r?: Partial<ResultMessage>) => void }> = [];
  private listeners = new Set<() => void>();
  list = () => this.servers;
  statuses = () => this.servers.map(({ name, status }) => ({ name, status }));
  onChange = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  change(): void {
    for (const l of this.listeners) l();
  }
  callTool(server: string, tool: string, _args: Record<string, unknown>, opts: CallOptions): Promise<ResultMessage> {
    return new Promise((resolve) => {
      const done = (r: ResultMessage) => resolve(r);
      opts.signal?.addEventListener("abort", () =>
        done({ type: "result", callId: opts.callId, ok: false, error: { code: "cancelled", message: "cancelled" } }),
      );
      this.calls.push({
        server,
        tool,
        opts,
        finish: () => done({ type: "result", callId: opts.callId, ok: true, result: { content: [{ type: "text", text: "ok" }] } }),
      });
    });
  }
}

function harness(over: { random?: () => number } = {}) {
  const clock = new FakeClock();
  const runner = new FakeRunner();
  const sockets: FakeSocket[] = [];
  let assertions = 0;
  const connection = new Connection({
    machine: "mini",
    endpoint: "wss://example.invalid",
    servers: runner,
    signAssertion: async () => `assertion-${++assertions}`,
    now: () => clock.now,
    random: over.random ?? (() => 1),
    timers: clock,
    createSocket: (url, o) => {
      const s = new FakeSocket(url, o.headers);
      sockets.push(s);
      return s;
    },
  });
  const call = (socket: FakeSocket, callId: string, deadline = clock.now + 20_000) =>
    socket.receive({ type: "call", callId, server: "fix", tool: "echo", arguments: {}, deadline, maxResultBytes: 1000 });
  return { clock, runner, sockets, connection, call };
}

describe("connection timing", () => {
  it("presents a fresh bearer assertion on each connect and sends hello on open", async () => {
    const h = harness();
    h.connection.start();
    await flush();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.headers).toEqual({ Authorization: "Bearer assertion-1" });
    expect(h.sockets[0]!.sent).toEqual([]);
    h.sockets[0]!.open();
    expect(h.sockets[0]!.types()).toEqual(["hello"]);
    expect(h.connection.connected).toBe(true);
  });

  it("heartbeats every 60 s", async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.sockets[0]!.open();
    await h.clock.advance(59_000);
    expect(h.sockets[0]!.types()).toEqual(["hello"]);
    await h.clock.advance(1_000);
    expect(h.sockets[0]!.types()).toEqual(["hello", "hb"]);
    await h.clock.advance(120_000);
    expect(h.sockets[0]!.types()).toEqual(["hello", "hb", "hb", "hb"]);
  });

  it("backs off from 1 s to 60 s after unexpected closes, and resets once connected", async () => {
    const h = harness(); // random() = 1: the top of the jitter range
    h.connection.start();
    await flush();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      h.sockets.at(-1)!.drop();
      delays.push(h.clock.pendingTimeouts()[0]!);
      await h.clock.advance(delays.at(-1)!);
      expect(h.sockets).toHaveLength(i + 2);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);

    h.sockets.at(-1)!.open();
    h.sockets.at(-1)!.drop();
    expect(h.clock.pendingTimeouts()[0]).toBe(1000);
  });

  it("jitters the backoff downwards, never below half", async () => {
    const h = harness({ random: () => 0 });
    h.connection.start();
    await flush();
    h.sockets[0]!.drop();
    expect(h.clock.pendingTimeouts()[0]).toBe(500);
  });

  it("reconnects on its own at 110 minutes", async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.sockets[0]!.open();
    await h.clock.advance(110 * 60_000 - 1);
    expect(h.sockets).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.sockets[0]!.closedWith).toBe(1000);
    expect(h.sockets).toHaveLength(2); // immediately, no backoff
    expect(h.sockets[1]!.headers).toEqual({ Authorization: "Bearer assertion-2" });
    h.sockets[1]!.open();
    expect(h.sockets[1]!.types()).toEqual(["hello"]);
  });

  it("lets an in-flight call finish before the planned reconnect, and turns new calls away meanwhile", async () => {
    const h = harness();
    h.connection.start();
    await flush();
    const first = h.sockets[0]!;
    first.open();
    await h.clock.advance(110 * 60_000 - 5_000);
    h.call(first, "inflight");
    await flush();
    await h.clock.advance(5_000); // planned reconnect is due, but a call is running
    expect(h.sockets).toHaveLength(1);
    expect(first.closedWith).toBeUndefined();

    h.call(first, "late");
    await flush();
    expect(first.sent.filter((m) => "callId" in m && m.callId === "late")).toEqual([
      { type: "ack", callId: "late" },
      { type: "result", callId: "late", ok: false, error: { code: "busy", message: "the machine is reconnecting, retry in a few seconds" } },
    ]);
    expect(h.runner.calls).toHaveLength(1);

    h.runner.calls[0]!.finish();
    await flush();
    expect(first.sent.at(-1)).toMatchObject({ type: "result", callId: "inflight", ok: true });
    expect(first.closedWith).toBe(1000);
    expect(h.sockets).toHaveLength(2);
  });

  it("waits at most 25 s for in-flight calls at a planned reconnect", async () => {
    const h = harness();
    h.connection.start();
    await flush();
    const first = h.sockets[0]!;
    first.open();
    await h.clock.advance(110 * 60_000 - 1_000);
    h.call(first, "stuck", h.clock.now + 600_000);
    await flush();
    await h.clock.advance(1_000 + 24_999);
    expect(h.sockets).toHaveLength(1);
    await h.clock.advance(1);
    expect(first.closedWith).toBe(1000);
    expect(h.sockets).toHaveLength(2);
    expect(h.runner.calls[0]!.opts.signal?.aborted).toBe(true);
  });

  it("reconnects immediately when the clock jumps (wake from sleep)", async () => {
    const h = harness();
    h.connection.start();
    await flush();
    const first = h.sockets[0]!;
    first.open();
    await h.clock.advance(15_000); // three ordinary 5 s ticks
    expect(h.sockets).toHaveLength(1);

    h.clock.sleep(10 * 60_000);
    await h.clock.advance(5_000); // the first tick after waking
    expect(first.closedWith).toBe("terminated"); // no polite close on a socket that is probably dead
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.open();
    expect(h.sockets[1]!.types()).toEqual(["hello"]);
  });

  it("a wake cuts a backoff wait short", async () => {
    const h = harness();
    h.connection.start();
    await flush();
    for (let i = 0; i < 6; i++) {
      h.sockets.at(-1)!.drop();
      await h.clock.advance(h.clock.pendingTimeouts()[0]!);
    }
    h.sockets.at(-1)!.drop();
    const count = h.sockets.length;
    expect(h.clock.pendingTimeouts()[0]).toBe(60_000);
    h.clock.sleep(60 * 60_000);
    await h.clock.advance(5_000);
    expect(h.sockets).toHaveLength(count + 1);
    await h.clock.advance(120_000); // the old backoff timer does not also fire
    expect(h.sockets).toHaveLength(count + 1);
  });

  it("does not run a call that arrives after its deadline plus the skew allowance", async () => {
    const h = harness();
    h.connection.start();
    await flush();
    const s = h.sockets[0]!;
    s.open();
    h.call(s, "stale", h.clock.now - 30_001);
    await flush();
    expect(h.runner.calls).toHaveLength(0);
    expect(s.sent.slice(1)).toMatchObject([
      { type: "ack", callId: "stale" },
      { type: "result", callId: "stale", ok: false, error: { code: "expired" } },
    ]);
    h.call(s, "edge", h.clock.now - 30_000);
    await flush();
    expect(h.runner.calls).toHaveLength(1);
  });

  it("abandons in-flight calls when the socket drops and never replays their results", async () => {
    const h = harness();
    h.connection.start();
    await flush();
    const first = h.sockets[0]!;
    first.open();
    h.call(first, "c1");
    await flush();
    first.drop();
    expect(h.runner.calls[0]!.opts.signal?.aborted).toBe(true);
    await h.clock.advance(1000);
    const second = h.sockets[1]!;
    second.open();
    h.runner.calls[0]!.finish();
    await flush();
    expect(second.types()).toEqual(["hello"]);
    expect(first.sent.some((m) => m.type === "result")).toBe(false);
  });

  it("re-sends hello, debounced, when the server set changes", async () => {
    const h = harness();
    h.connection.start();
    await flush();
    const s = h.sockets[0]!;
    s.open();
    h.runner.servers = [{ name: "fix", status: "down", error: "server exited", tools: [] }];
    h.runner.change();
    h.runner.change();
    await h.clock.advance(250);
    expect(s.types()).toEqual(["hello", "hello"]);
    expect(s.sent[1]).toMatchObject({ servers: [{ name: "fix", status: "down", tools: [] }] });
  });

  it("ignores a duplicate callId while the first is running", async () => {
    const h = harness();
    h.connection.start();
    await flush();
    const s = h.sockets[0]!;
    s.open();
    h.call(s, "dup");
    h.call(s, "dup");
    await flush();
    expect(h.runner.calls).toHaveLength(1);
    expect(s.sent.filter((m) => m.type === "ack")).toHaveLength(1);
  });

  it("retries when signing the assertion fails", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const sockets: FakeSocket[] = [];
    const connection = new Connection({
      machine: "mini",
      endpoint: "wss://example.invalid",
      servers: new FakeRunner(),
      signAssertion: async () => {
        if (++attempts === 1) throw new Error("keychain locked");
        return "ok";
      },
      now: () => clock.now,
      random: () => 1,
      timers: clock,
      createSocket: (url, o) => {
        const s = new FakeSocket(url, o.headers);
        sockets.push(s);
        return s;
      },
    });
    connection.start();
    await flush();
    expect(sockets).toHaveLength(0);
    await clock.advance(1000);
    expect(sockets).toHaveLength(1);
  });
});
