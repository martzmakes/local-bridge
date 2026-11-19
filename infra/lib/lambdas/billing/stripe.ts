import Stripe from "stripe";
import { getSecret, getStore } from "../bridge/runtime";

export const PROJECT = "local-bridge";
export const stripeMode = process.env.STRIPE_MODE === "test" ? "test" : "live";
let stripeClient: Stripe | undefined;

export function subscriptionGrantsPlus(subscription: Pick<Stripe.Subscription, "status" | "items">): boolean {
  return ["active", "trialing"].includes(subscription.status) && subscription.items.data.some(
    item => (typeof item.price.product === "string" ? item.price.product : item.price.product.id) === "local_bridge_plus",
  );
}

export async function stripe() {
  if (!stripeClient) {
    const key = await getSecret(process.env.STRIPE_KEY_PARAM!);
    const acceptedPrefixes = stripeMode === "test" ? ["rk_test_", "sk_test_", "rkcs_test_"] : ["rk_live_", "sk_live_"];
    if (!acceptedPrefixes.some(prefix => key.startsWith(prefix))) {
      throw new Error("Stripe key does not match the deployment's mode");
    }
    stripeClient = new Stripe(key, { maxNetworkRetries: 1, timeout: 6000 });
  }
  return stripeClient;
}

// Reconcile current Stripe state so duplicate deliveries and out-of-order
// snapshots converge without blocking retries after a failed write.
export async function syncPlan(client: Stripe, uid: string, customer: string) {
  const started = Date.now();
  const subscriptions = await client.subscriptions.list({ customer, status: "all", limit: 100 });
  const relevant = subscriptions.data.filter(subscription =>
    subscription.metadata.project === PROJECT && subscription.metadata.uid === uid
  );
  const plus = relevant.some(subscriptionGrantsPlus);
  await getStore().forTenant(uid).recordBillingPlan(customer, started, plus);
  return { plus, hasSubscription: relevant.some(s => !["canceled", "incomplete_expired"].includes(s.status)) };
}
