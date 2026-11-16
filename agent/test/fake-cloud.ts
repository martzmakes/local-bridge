// A local `ws` server that plays the cloud for the agent's integration tests.
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { FrameSchema, decodeFrames, type MachineMessage } from "../../infra/lib/shared/protocol";
import { waitFor } from "./helpers";

export interface Session {
  socket: WebSocket;
  authorization: string | undefined;
  /** Decoded machine messages, in arrival order. */
  messages: MachineMessage[];
  /** Byte length of every raw ws message, and how many frames each message used. */
  rawSizes: number[];
  frameCounts: Map<MachineMessage, number>;
  closed: boolean;
}

/** A stand-in for the WebSocket API + device Lambda: reassembles frames, records everything. */
export class FakeCloud {
  readonly sessions: Session[] = [];
  private readonly wss: WebSocketServer;

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
    wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
      const session: Session = {
        socket,
        authorization: req.headers.authorization,
        messages: [],
        rawSizes: [],
        frameCounts: new Map(),
        closed: false,
      };
      this.sessions.push(session);
      const partial = new Map<string, string[]>();
      socket.on("message", (data: Buffer) => {
        session.rawSizes.push(data.length);
        const frame = FrameSchema.parse(JSON.parse(data.toString("utf8")));
        const parts = partial.get(frame.id) ?? [];
        partial.set(frame.id, parts);
        expect(frame.i).toBe(parts.length); // in order
        parts.push(frame.d);
        if (parts.length === frame.n) {
          partial.delete(frame.id);
          const message = decodeFrames(parts);
          session.frameCounts.set(message, frame.n);
          session.messages.push(message);
        }
      });
      socket.on("close", () => (session.closed = true));
      socket.send(JSON.stringify({ type: "welcome", machine: "mini", serverTime: Date.now() }));
    });
  }

  /** HTTP status to answer every upgrade with instead of accepting it; undefined accepts. */
  refuseWith: number | undefined;

  static async start(): Promise<FakeCloud> {
    let cloud: FakeCloud | undefined;
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (_info, done) => {
        const status = cloud?.refuseWith;
        if (status === undefined) done(true);
        else done(false, status);
      },
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    cloud = new FakeCloud(wss);
    return cloud;
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }

  async session(index: number): Promise<Session> {
    return waitFor(() => this.sessions[index], 10_000, `session ${index}`);
  }

  async stop(): Promise<void> {
    for (const s of this.sessions) s.socket.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

export function sendCall(session: Session, call: { callId: string; tool: string; server?: string; arguments?: Record<string, unknown>; deadline?: number; maxResultBytes?: number }): void {
  session.socket.send(
    JSON.stringify({
      type: "call",
      server: "fix",
      arguments: {},
      deadline: Date.now() + 10_000,
      maxResultBytes: 262_144,
      ...call,
    }),
  );
}

export type Result = Extract<MachineMessage, { type: "result" }>;
export const resultFor = (session: Session, callId: string, timeoutMs = 10_000): Promise<Result> =>
  waitFor(() => session.messages.find((m): m is Result => m.type === "result" && m.callId === callId), timeoutMs, `result ${callId}`);
