import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { verifyJwt } from "../auth/lib/jwt";
import { errName, getSecret, getStore, logEvent } from "../bridge/runtime";
import { uidFromEmail } from "../bridge/tenant";
import { HOSTED_PLANS, PLUS_LOOKUP_KEYS } from "./plans";

const ROOT = "/api/billing";
const PROJECT = "local-bridge";
const site = process.env.SITE_URL!;
let stripeClient: Stripe | undefined;
const json = (statusCode: number, value: unknown) => ({
  statusCode,
  body: JSON.stringify(value),
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

export function subscriptionGrantsPlus(subscription: Pick<Stripe.Subscription, "status" | "items">): boolean {
  return ["active", "trialing"].includes(subscription.status) && subscription.items.data.some(
    item => (typeof item.price.product === "string" ? item.price.product : item.price.product.id) === "local_bridge_plus",
  );
}

async function stripe() {
  if (!stripeClient) stripeClient = new Stripe(await getSecret(process.env.STRIPE_KEY_PARAM!), { maxNetworkRetries: 1, timeout: 6000 });
  return stripeClient;
}

async function syncPlan(client: Stripe, uid: string, customer: string) {
  const started = Date.now();
  const subscriptions = await client.subscriptions.list({ customer, status: "all", limit: 100 });
  const relevant = subscriptions.data.filter(subscription =>
    subscription.metadata.project === PROJECT && subscription.metadata.uid === uid
  );
  const plus = relevant.some(subscriptionGrantsPlus);
  await getStore().forTenant(uid).recordBillingPlan(customer, started, plus);
  return { plus, hasSubscription: relevant.some(s => !["canceled", "incomplete_expired"].includes(s.status)) };
}

export const handler: APIGatewayProxyHandlerV2 = async event => {
  const method = event.requestContext.http.method;
  const route = event.rawPath;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
  try {
    if (method === "POST" && route === ROOT + "/webhook") {
      const signature = event.headers["stripe-signature"];
      if (!signature) return json(400, { error: "invalid_signature" });
      const secret = await getSecret(process.env.STRIPE_WEBHOOK_PARAM!);
      const client = await stripe();
      let stripeEvent: Stripe.Event;
      try {
        stripeEvent = client.webhooks.constructEvent(raw, signature, secret);
      } catch {
        return json(400, { error: "invalid_signature" });
      }
      if (stripeEvent.type === "customer.subscription.created" ||
          stripeEvent.type === "customer.subscription.updated" ||
          stripeEvent.type === "customer.subscription.deleted") {
        const subscription = stripeEvent.data.object;
        const uid = subscription.metadata.uid;
        const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
        if (subscription.metadata.project === PROJECT && /^[a-f0-9]{20}$/.test(uid) &&
            (await getStore().forTenant(uid).getBilling()).customer === customer) {
          await syncPlan(client, uid, customer);
        }
      }
      return json(200, { ok: true });
    }

    const token = /^Bearer\s+(.+)$/i.exec(event.headers.authorization ?? "")?.[1];
    if (!token) return json(401, { error: "unauthorized" });
    const identity = await verifyJwt(token).catch(() => null);
    if (!identity || identity.agent || identity.kind) return json(401, { error: "unauthorized" });
    const uid = uidFromEmail(identity.email);
    const store = getStore().forTenant(uid);
    const billing = await store.getBilling();

    if (method === "GET" && route === ROOT + "/status") {
      const plan = billing.plus ? "plus" : "free";
      return json(200, { plan, limits: HOSTED_PLANS[plan], customer: !!billing.customer });
    }
    if (method === "POST" && route === ROOT + "/portal" && billing.customer) {
      const session = await (await stripe()).billingPortal.sessions.create({
        customer: billing.customer, return_url: site + "/account",
      });
      return json(200, { url: session.url });
    }
    if (method !== "POST" || route !== ROOT + "/checkout") return json(404, { error: "not_found" });
    if (Buffer.byteLength(raw) > 1024) return json(413, { error: "payload_too_large" });
    const interval: unknown = (() => { try { return JSON.parse(raw)?.interval; } catch { return null; } })();
    if (interval !== "monthly" && interval !== "annual") return json(400, { error: "invalid_interval" });

    const client = await stripe();
    const customer = billing.customer ?? (await client.customers.create(
      { email: identity.email, metadata: { project: PROJECT, uid } },
      { idempotencyKey: "local-bridge-customer-" + uid }
    )).id;
    if (!billing.customer) await store.setBillingCustomer(customer);
    const lock = randomUUID();
    if (!await store.claimBillingCheckout(customer, lock)) return json(409, { error: "checkout_busy" });
    try {
      if ((await syncPlan(client, uid, customer)).hasSubscription) return json(409, { error: "manage_existing_subscription" });
      const open = await client.checkout.sessions.list({ customer, status: "open", limit: 1 });
      if (open.data[0]?.url) return json(200, { url: open.data[0].url });
      const prices = await client.prices.list({ lookup_keys: [PLUS_LOOKUP_KEYS[interval]], active: true, limit: 1 });
      const price = prices.data[0];
      if (!price?.recurring) return json(503, { error: "price_unavailable" });
      const session = await client.checkout.sessions.create({
        customer,
        mode: "subscription",
        line_items: [{ price: price.id, quantity: 1 }],
        subscription_data: { metadata: { project: PROJECT, uid } },
        success_url: site + "/account?billing=success",
        cancel_url: site + "/account?billing=cancelled",
      }, { idempotencyKey: "local-bridge-checkout-" + lock });
      return json(200, { url: session.url });
    } finally {
      await store.releaseBillingCheckout(lock);
    }
  } catch (error) {
    logEvent("billing_failed", { error: errName(error) });
    return json(503, { error: "billing_unavailable" });
  }
};
