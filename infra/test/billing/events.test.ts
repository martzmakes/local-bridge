import Stripe from "stripe";
import { handler } from "../../lib/lambdas/billing/events";
import { getSecret, getStore } from "../../lib/lambdas/bridge/runtime";

jest.mock("stripe");
jest.mock("../../lib/lambdas/bridge/runtime", () => ({
  getSecret: jest.fn(), getStore: jest.fn(), errName: jest.fn(), logEvent: jest.fn(),
}));

const uid = "0123456789abcdef0123";
const customer = "cus_local_bridge";
const billing = {
  getBilling: jest.fn().mockResolvedValue({ customer }),
  recordBillingPlan: jest.fn().mockResolvedValue(undefined),
};

function event(project = "local-bridge", livemode = true, eventCustomer = customer) {
  return {
    detail: {
      type: "customer.subscription.updated",
      livemode,
      data: { object: { customer: eventCustomer, metadata: { project, uid } } },
    },
  } as unknown as Parameters<typeof handler>[0];
}

it("ignores another project, Stripe mode, or customer", async () => {
  jest.mocked(getStore).mockReturnValue({ forTenant: () => billing } as unknown as ReturnType<typeof getStore>);
  await handler(event("another-project"));
  await handler(event("local-bridge", false));
  await handler(event("local-bridge", true, "cus_another"));
  expect(getSecret).not.toHaveBeenCalled();
  expect(billing.recordBillingPlan).not.toHaveBeenCalled();
});

it("reconciles current Stripe state on repeats and leaves failed events retryable", async () => {
  const list = jest.fn().mockResolvedValue({ data: [{
    metadata: { project: "local-bridge", uid },
    status: "active",
    items: { data: [{ price: { product: "local_bridge_plus" } }] },
  }] });
  jest.mocked(Stripe).mockImplementation(() => ({ subscriptions: { list } } as unknown as Stripe));
  jest.mocked(getSecret).mockResolvedValue("rk_live_mock-key");
  jest.mocked(getStore).mockReturnValue({ forTenant: () => billing } as unknown as ReturnType<typeof getStore>);

  billing.recordBillingPlan.mockRejectedValueOnce(new Error("temporarily unavailable"));
  await expect(handler(event())).rejects.toThrow("Could not reconcile Stripe subscription");
  await handler(event());
  expect(billing.recordBillingPlan).toHaveBeenLastCalledWith(customer, expect.any(Number), true);

  list.mockResolvedValueOnce({ data: [] });
  await handler(event());
  expect(billing.recordBillingPlan).toHaveBeenLastCalledWith(customer, expect.any(Number), false);
});
