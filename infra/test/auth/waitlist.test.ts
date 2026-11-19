import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { DynamoDBDocumentClient, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

jest.mock("../../lib/lambdas/auth/lib/email", () => ({ sendMagicLinkEmail: jest.fn() }));
import { sendMagicLinkEmail } from "../../lib/lambdas/auth/lib/email";

it("records waitlist interest even for an invited email without sending a sign-in link", async () => {
  const priorTable = process.env.WAITLIST_TABLE;
  const priorEmails = process.env.ALLOWED_EMAILS;
  process.env.ALLOWED_EMAILS = "invited@example.com";
  process.env.WAITLIST_TABLE = "waitlist-test";
  const db = mockClient(DynamoDBDocumentClient);
  db.on(PutCommand).resolves({});
  try {
    const { handler } = require("../../lib/lambdas/auth/request") as typeof import("../../lib/lambdas/auth/request");
    const response = await handler({
      rawPath: "/api/waitlist",
      requestContext: { http: { method: "POST" } },
      body: JSON.stringify({ email: " Invited@Example.com ", interest: "plus" }),
    } as APIGatewayProxyEventV2, {} as Context, () => {});
    expect(response).toMatchObject({ statusCode: 200 });
    expect(db.commandCalls(PutCommand)[0].args[0].input).toMatchObject({
      TableName: "waitlist-test",
      Item: { email: "invited@example.com", interest: "plus" },
      ConditionExpression: "attribute_not_exists(email)",
    });
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  } finally {
    db.restore();
    if (priorEmails === undefined) delete process.env.ALLOWED_EMAILS;
    else process.env.ALLOWED_EMAILS = priorEmails;
    if (priorTable === undefined) delete process.env.WAITLIST_TABLE;
    else process.env.WAITLIST_TABLE = priorTable;
  }
});

it.each([true, false])("reserves the public email budget before sending a link (available: %s)", async (allowed) => {
  const env = jest.replaceProperty(process, "env", { ...process.env, PUBLIC_SIGNUPS: "1" });
  const db = mockClient(DynamoDBDocumentClient);
  jest.mocked(sendMagicLinkEmail).mockClear();
  db.on(PutCommand).resolves({});
  const reserve = db.on(TransactWriteCommand);
  if (allowed) reserve.resolves({});
  else reserve.rejects({ name: "TransactionCanceledException" });
  try {
    const { handler } = require("../../lib/lambdas/auth/request") as typeof import("../../lib/lambdas/auth/request");
    const response = await handler({
      rawPath: "/auth/request",
      requestContext: { http: { method: "POST" } },
      body: JSON.stringify({ email: "new-account@example.com" }),
    } as APIGatewayProxyEventV2, {} as Context, () => {});
    expect(response).toMatchObject({ statusCode: allowed ? 200 : 429 });
    expect(db.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(db.commandCalls(PutCommand)).toHaveLength(allowed ? 1 : 0);
    expect(sendMagicLinkEmail).toHaveBeenCalledTimes(allowed ? 1 : 0);
  } finally {
    db.restore();
    env.restore();
  }
});
