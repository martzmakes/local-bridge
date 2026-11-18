import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import type Stripe from "stripe";
import { handler, subscriptionGrantsPlus } from "../../lib/lambdas/billing/handler";
import { limitHostedCatalog } from "../../lib/lambdas/billing/plans";
import type { Machine } from "../../lib/lambdas/bridge/store";

function subscription(status: Stripe.Subscription.Status, product = "local_bridge_plus") {
  return { status, items: { data: [{ price: { product } }] } } as Pick<Stripe.Subscription, "status" | "items">;
}

it("grants Plus only for an active or trialing Local Bridge subscription", () => {
  expect(subscriptionGrantsPlus(subscription("active"))).toBe(true);
  expect(subscriptionGrantsPlus(subscription("trialing"))).toBe(true);
  expect(subscriptionGrantsPlus(subscription("past_due"))).toBe(false);
  expect(subscriptionGrantsPlus(subscription("canceled"))).toBe(false);
  expect(subscriptionGrantsPlus(subscription("active", "another_project"))).toBe(false);
});

it("caps the authenticated catalog at the plan's machine and server counts", () => {
  const machines = Array.from({ length: 4 }, (_, index) => ({
    meta: { id: "mac" + index, enabled: true, keys: [] },
    servers: Array.from({ length: 11 }, (_, server) => ({
      machine: "mac" + index, name: "server" + server, status: "up" as const, tools: [], updatedAt: 0,
    })),
  })) satisfies Machine[];
  expect(limitHostedCatalog(machines, "free").map(machine => machine.servers.length)).toEqual([3]);
  expect(limitHostedCatalog(machines, "plus").map(machine => machine.servers.length)).toEqual([10, 10, 10]);
  expect(machines[0].servers).toHaveLength(11);
});

it("rejects unauthenticated checkout requests and unsigned webhooks", async () => {
  const request = (route: string) => handler({
    rawPath: "/api/billing/" + route,
    requestContext: { http: { method: "POST" } },
    headers: {},
  } as APIGatewayProxyEventV2, {} as Context, () => {});
  expect(await request("checkout")).toMatchObject({ statusCode: 401 });
  expect(await request("webhook")).toMatchObject({ statusCode: 400 });
});
