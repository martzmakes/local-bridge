import type { EventBridgeEvent } from "aws-lambda";
import type Stripe from "stripe";
import { errName, getStore, logEvent } from "../bridge/runtime";
import { PROJECT, stripe, stripeMode, syncPlan } from "./stripe";

export async function handler(event: Pick<EventBridgeEvent<string, Stripe.Event>, "detail">): Promise<void> {
  const stripeEvent = event.detail;
  if (stripeEvent?.livemode !== (stripeMode === "live")) return;
  if (stripeEvent.type !== "customer.subscription.created" &&
      stripeEvent.type !== "customer.subscription.updated" &&
      stripeEvent.type !== "customer.subscription.deleted") return;

  const subscription = stripeEvent.data.object;
  const uid = subscription.metadata?.uid;
  if (subscription.metadata?.project !== PROJECT || !uid || !/^[a-f0-9]{20}$/.test(uid)) return;

  const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  try {
    const billing = await getStore().forTenant(uid).getBilling();
    if (billing.customer === customer) await syncPlan(await stripe(), uid, customer);
  } catch (error) {
    logEvent("billing_event_failed", { error: errName(error) });
    throw new Error("Could not reconcile Stripe subscription");
  }
}
