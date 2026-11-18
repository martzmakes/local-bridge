import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
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
