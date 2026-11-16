// Shared runtime wiring for the bridge Lambdas: DynamoDB store, the API
// Gateway management client used to push to a machine, SSM-backed secrets, and
// content-free logging.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { CloudMessage } from "../../shared/protocol";
import { Store } from "./store";

let store: Store | null = null;
export function getStore(): Store {
  if (!store) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    store = new Store(ddb, process.env.BRIDGE_TABLE!);
  }
  return store;
}

let mgmt: ApiGatewayManagementApiClient | null = null;

export class ConnectionGone extends Error {}

/** Pushes one message to a machine. Throws ConnectionGone if the socket no longer exists. */
export async function pushToConnection(connectionId: string, message: CloudMessage): Promise<void> {
  if (!mgmt) mgmt = new ApiGatewayManagementApiClient({ endpoint: process.env.WS_MANAGEMENT_ENDPOINT! });
  try {
    await mgmt.send(
      new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(message), "utf8") })
    );
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === "GoneException" || e.$metadata?.httpStatusCode === 410) throw new ConnectionGone();
    throw err;
  }
}

const ssm = new SSMClient({});
const secretCache = new Map<string, string>();
export async function getSecret(name: string): Promise<string> {
  const cached = secretCache.get(name);
  if (cached) return cached;
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is empty`);
  secretCache.set(name, value);
  return value;
}

type LogValue = string | number | boolean | undefined | null;

/**
 * The only logging the bridge Lambdas do. Fields are scalars chosen by this
 * codebase: ids, canonical tool names, sizes, fixed outcome codes. Never pass
 * arguments, results, or error text produced by a local server.
 */
export function logEvent(event: string, fields: Record<string, LogValue> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/** Error class name only: messages can quote content. */
export function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
