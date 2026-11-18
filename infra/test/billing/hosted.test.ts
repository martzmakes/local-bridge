import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import Stripe from "stripe";
import { verifyJwt } from "../../lib/lambdas/auth/lib/jwt";
import { getSecret, getStore } from "../../lib/lambdas/bridge/runtime";
import { handler, subscriptionGrantsPlus } from "../../lib/lambdas/billing/handler";
import { limitHostedCatalog } from "../../lib/lambdas/billing/plans";
import type { Machine } from "../../lib/lambdas/bridge/store";

jest.mock("stripe");
jest.mock("../../lib/lambdas/auth/lib/jwt", () => ({ verifyJwt: jest.fn() }));
jest.mock("../../lib/lambdas/bridge/runtime", () => ({
  getSecret: jest.fn(), getStore: jest.fn(), errName: jest.fn(), logEvent: jest.fn(),
}));

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

it("replaces an open monthly Checkout session when an annual purchase is requested", async () => {
  const sessions = {
    list: jest.fn().mockResolvedValue({ data: [{
      id: "cs_monthly", url: "https://checkout.stripe.com/monthly", metadata: { price: "price_monthly" },
    }] }),
    expire: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({ url: "https://checkout.stripe.com/annual" }),
  };
  jest.mocked(Stripe).mockImplementation(() => ({
    subscriptions: { list: jest.fn().mockResolvedValue({ data: [] }) },
    prices: { list: jest.fn().mockResolvedValue({ data: [{
      id: "price_annual", product: "local_bridge_plus", currency: "usd",
      recurring: { interval: "year", interval_count: 1 },
    }] }) },
    checkout: { sessions },
  } as unknown as Stripe));
  jest.mocked(verifyJwt).mockResolvedValue({ email: "example@example.invalid" });
  jest.mocked(getSecret).mockResolvedValue("test-key");
  jest.mocked(getStore).mockReturnValue({ forTenant: () => ({
    getBilling: jest.fn().mockResolvedValue({ customer: "cus_local_bridge" }),
    recordBillingPlan: jest.fn().mockResolvedValue(undefined),
    claimBillingCheckout: jest.fn().mockResolvedValue(true),
    releaseBillingCheckout: jest.fn().mockResolvedValue(undefined),
  }) } as unknown as ReturnType<typeof getStore>);

  const response = await handler({
    version: "2.0", rawQueryString: "", routeKey: "POST /api/billing/checkout", isBase64Encoded: false,
    rawPath: "/api/billing/checkout", requestContext: { http: { method: "POST" } },
    headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ interval: "annual" }),
  } as unknown as APIGatewayProxyEventV2, {} as Context, () => {});

  expect(sessions.expire).toHaveBeenCalledWith("cs_monthly");
  expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({
    line_items: [{ price: "price_annual", quantity: 1 }],
  }), expect.any(Object));
  expect(response).toMatchObject({ statusCode: 200, body: '{"url":"https://checkout.stripe.com/annual"}' });
});
