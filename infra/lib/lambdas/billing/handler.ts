import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { randomUUID } from "node:crypto";
import { verifyJwt } from "../auth/lib/jwt";
import { errName, getStore, logEvent } from "../bridge/runtime";
import { uidFromEmail } from "../bridge/tenant";
import { HOSTED_PLANS, PLUS_LOOKUP_KEYS } from "./plans";
import { PROJECT, stripe, syncPlan } from "./stripe";

const ROOT = "/api/billing";
const site = process.env.SITE_URL!;
const json = (statusCode: number, value: unknown) => ({
  statusCode,
  body: JSON.stringify(value),
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

export const handler: APIGatewayProxyHandlerV2 = async event => {
  const method = event.requestContext.http.method;
  const route = event.rawPath;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
  try {
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
        ...(process.env.STRIPE_PORTAL_CONFIG ? { configuration: process.env.STRIPE_PORTAL_CONFIG } : {}),
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
      const prices = await client.prices.list({ lookup_keys: [PLUS_LOOKUP_KEYS[interval]], active: true, limit: 1 });
      const price = prices.data[0];
      const product = typeof price?.product === "string" ? price.product : price?.product.id;
      if (product !== "local_bridge_plus" || price?.currency !== "usd" ||
          price.recurring?.interval !== (interval === "monthly" ? "month" : "year") ||
          price.recurring.interval_count !== 1) {
        return json(503, { error: "price_unavailable" });
      }
      const open = await client.checkout.sessions.list({ customer, status: "open", limit: 1 });
      const existing = open.data[0];
      if (existing?.url && existing.metadata?.price === price.id) return json(200, { url: existing.url });
      if (existing) await client.checkout.sessions.expire(existing.id);
      const session = await client.checkout.sessions.create({
        customer,
        mode: "subscription",
        line_items: [{ price: price.id, quantity: 1 }],
        metadata: { price: price.id, project: PROJECT, uid },
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
