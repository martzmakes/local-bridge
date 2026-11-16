// WebSocket routes for the machine channel: $connect, $disconnect, $default.
// Every $default body is a frame (see shared/protocol.ts). Nothing in here logs
// message bodies.
import { z } from "zod";
import { decodeFrames, FrameSchema, type MachineMessage } from "../../shared/protocol";
import { keysAfterRotate, pruneKeysAfterAuth } from "../bridge/device-auth";
import { ConnectionGone, errName, getStore, logEvent, pushToConnection } from "../bridge/runtime";
import type { Store } from "../bridge/store";
import type { CloudMessage } from "../../shared/protocol";

interface WsEvent {
  requestContext: {
    routeKey: string;
    connectionId: string;
    authorizer?: { uid?: string; machine?: string; kid?: string };
  };
  body?: string | null;
  isBase64Encoded?: boolean;
}

export interface WsDeps {
  store: Store;
  push(connectionId: string, message: CloudMessage): Promise<void>;
  now(): number;
}

const OK = { statusCode: 200, body: "" };

export async function handleEvent(event: WsEvent, deps: WsDeps) {
  const { routeKey, connectionId } = event.requestContext;
  const root = deps.store;

  if (routeKey === "$connect") {
    const uid = event.requestContext.authorizer?.uid;
    const machine = event.requestContext.authorizer?.machine;
    const kid = event.requestContext.authorizer?.kid;
    if (!uid || !machine || !kid) return { statusCode: 401, body: "" };
    const store = root.forTenant(uid);
    await store.bindConnection(machine, connectionId, kid);
    // A connect with the new key completes a rotation: drop the outgoing key.
    const meta = await store.getMachine(machine);
    const pruned = meta ? pruneKeysAfterAuth(meta.keys, kid) : null;
    if (meta && pruned) await store.putMachineRegistration(machine, meta.enabled, pruned);
    logEvent("machine_connected", { uid, machine, connectionId });
    return OK;
  }

  if (routeKey === "$disconnect") {
    await root.unbindConnection(connectionId);
    logEvent("machine_disconnected", { connectionId });
    return OK;
  }

  // $default
  // The connection row, written at $connect from the verified assertion, is
  // the only source of which account and machine a message belongs to.
  const conn = await root.connection(connectionId);
  if (!conn) return { statusCode: 403, body: "" };
  const machine = conn.machine;
  const store = root.forTenant(conn.uid);

  let message: MachineMessage;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
    const frame = FrameSchema.parse(JSON.parse(raw));
    if (frame.i >= frame.n) throw new z.ZodError([]);
    let parts: string[] | null;
    if (frame.n === 1) parts = [frame.d];
    else parts = await store.addFrame(connectionId, frame.id, frame.i, frame.n, frame.d);
    if (!parts) return OK; // waiting for more slices
    message = decodeFrames(parts);
  } catch (err) {
    logEvent("machine_message_invalid", { machine, error: errName(err) });
    return { statusCode: 400, body: "" };
  }

  switch (message.type) {
    case "hello": {
      if (message.machine !== machine) {
        logEvent("machine_hello_mismatch", { machine });
        return { statusCode: 403, body: "" };
      }
      await store.replaceServers(machine, connectionId, message.agentVersion, message.servers);
      logEvent("machine_hello", {
        machine,
        servers: message.servers.length,
        tools: message.servers.reduce((n, s) => n + s.tools.length, 0),
      });
      await safePush(deps, connectionId, { type: "welcome", machine, serverTime: deps.now() });
      return OK;
    }
    case "hb": {
      const status = Object.fromEntries(
        message.servers.map((s) => [s.name, { status: s.status, ...(s.error ? { error: s.error } : {}) }])
      );
      await store.heartbeat(machine, connectionId, status);
      return OK;
    }
    case "ack": {
      await store.ackCall(message.callId, machine);
      return OK;
    }
    case "result": {
      const stored = await store.completeCall(
        message.callId,
        machine,
        message.ok ? { resultJson: JSON.stringify(message.result) } : { error: message.error }
      );
      if (!stored) logEvent("result_dropped", { machine, callId: message.callId });
      return OK;
    }
    case "rotate": {
      const meta = await store.getMachine(machine);
      const currentKid = conn.kid;
      if (!meta || !currentKid) return { statusCode: 403, body: "" };
      const keys = keysAfterRotate(meta.keys, currentKid, { kid: message.kid, jwk: message.jwk }, deps.now());
      await store.putMachineRegistration(machine, meta.enabled, keys);
      logEvent("machine_key_rotated", { machine, kid: message.kid });
      await safePush(deps, connectionId, { type: "rotated", kid: message.kid });
      return OK;
    }
  }
}

async function safePush(deps: WsDeps, connectionId: string, message: CloudMessage): Promise<void> {
  try {
    await deps.push(connectionId, message);
  } catch (err) {
    if (!(err instanceof ConnectionGone)) logEvent("push_failed", { connectionId, error: errName(err) });
  }
}

export const handler = async (event: WsEvent) => {
  try {
    return await handleEvent(event, { store: getStore(), push: pushToConnection, now: Date.now });
  } catch (err) {
    logEvent("ws_handler_error", { route: event.requestContext.routeKey, error: errName(err) });
    return { statusCode: 500, body: "" };
  }
};
