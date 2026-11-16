import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { verifyJwt } from "./lib/jwt";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const USERS_TABLE = process.env.USERS_TABLE!;

function response(statusCode: number, body?: Record<string, unknown>) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,DELETE,OPTIONS",
    },
    body: body ? JSON.stringify(body) : "",
  };
}

async function extractEmail(
  authHeader: string | undefined
): Promise<string | null> {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) return null;
  try {
    const { email } = await verifyJwt(match[1]);
    return email;
  } catch {
    return null;
  }
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;
  if (method === "OPTIONS") return response(204);

  const authHeader =
    event.headers?.authorization || event.headers?.Authorization;
  const email = await extractEmail(authHeader);
  if (!email) return response(401, { error: "unauthorized" });

  if (method === "GET") {
    const user = await ddb.send(
      new GetCommand({ TableName: USERS_TABLE, Key: { email } })
    );
    if (!user.Item) {
      // User row was deleted — re-seed so the JWT stays usable until expiry.
      const now = Date.now();
      await ddb.send(
        new UpdateCommand({
          TableName: USERS_TABLE,
          Key: { email },
          UpdateExpression:
            "SET lastLoginAt = :now, createdAt = if_not_exists(createdAt, :now), ownedEntitlements = if_not_exists(ownedEntitlements, :empty)",
          ExpressionAttributeValues: {
            ":now": now,
            ":empty": [] as string[],
          },
        })
      );
      return response(200, {
        email,
        ownedEntitlements: [],
        createdAt: now,
        lastLoginAt: now,
      });
    }
    return response(200, {
      email: user.Item.email,
      ownedEntitlements: user.Item.ownedEntitlements || [],
      createdAt: user.Item.createdAt || null,
      lastLoginAt: user.Item.lastLoginAt || null,
    });
  }

  if (method === "DELETE") {
    await ddb.send(
      new DeleteCommand({ TableName: USERS_TABLE, Key: { email } })
    );
    return response(204);
  }

  return response(405, { error: "method_not_allowed" });
};
