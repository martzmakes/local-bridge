# Hosted service costs and plans

November 2026 estimate for US East (N. Virginia) at pay-as-you-go rates before free allowances, taxes, payment fees, and support. Use these figures for planning and compare the first cohort with Cost Explorer.

| Monthly use | Estimated AWS cost per account |
| --- | ---: |
| Waitlist entry or account without a connected Mac | A fraction of a cent for storage plus any sign-in email |
| One Mac connected continuously, idle | $0.11–$0.17 |
| One continuously connected Mac and 1,000 typical calls | $0.15–$0.30 |
| One continuously connected Mac and 3,000 slow calls returning roughly 200–256 KiB each | $1.50–$2.50 |

Typical one-Mac use works out to roughly $15–$30 for 100 active accounts, $150–$300 for 1,000, or $1,500–$3,000 for 10,000 per month. These are cost scenarios. The current shared WebSocket rate limit is 20 messages per second, and 1,000 idle connected Macs alone average about 17 heartbeats per second. Load-test and size the stage for the intended cohort.

- A 30-day month has 43,200 connection minutes and about 43,200 application heartbeats per always-connected Mac. API Gateway charges about $0.054 per Mac for those alone. Heartbeats also use a 512 MB Lambda, a DynamoDB read and write, and execution logs. [API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/) [Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- Typical calls assume about a second of Lambda time and 8–12 KiB results. More time means more DynamoDB polls. Larger responses add writes, reads and transfer. DynamoDB Standard on-demand pricing is $0.625 per million write units and $0.125 per million read units in this region. [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/)
- Budget separately for shared logs, backups, static downloads, DNS and abuse. SES outgoing mail starts at $0.10 per 1,000 messages. [CloudWatch Lambda log pricing](https://aws.amazon.com/about-aws/whats-new/2025/05/amazon-cloudwatch-tiered-pricing-additional-log-delivery-destinations-aws-lambda/) [SES pricing](https://aws.amazon.com/ses/pricing/) [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/) [Route 53 pricing](https://aws.amazon.com/route53/pricing/)

## Hosted plans

The public hosted service creates an account after the user follows an emailed sign-in link. A self-hosted deployment uses its configured email allowlist by default. Set `LOCAL_BRIDGE_PUBLIC_SIGNUPS=1` to open signups and apply the hosted plan limits. The public sign-in endpoints share a per-recipient and deployment-wide email rate limit.

| Plan | Price | Macs | MCP servers per Mac | Tool calls per month |
| --- | --- | ---: | ---: | ---: |
| Free | $0 | 1 | 3 | 300 |
| Plus | $6 monthly or $60 annually | 3 | 10 | 3,000 |
| Self-host | Your AWS bill | Stack limits | Stack limits | Your AWS usage |

The Stripe product is `local_bridge_plus`. Checkout uses `local_bridge_plus_monthly` or `local_bridge_plus_annual`. Users choose a subscription or open Stripe’s billing portal from the [account page](https://bridge.martzmakes.com/account).

Before activating billing, configure a server-side Stripe key for Customers, Prices, Checkout Sessions, Subscriptions and Portal Sessions in `/local-bridge/stripe-secret-key`. Configure the Stripe customer portal and set `LOCAL_BRIDGE_STRIPE_PORTAL_CONFIG` to select that configuration. [Stripe customer portal](https://docs.stripe.com/customer-management/integrate-customer-portal)

Deploy the shared Stripe Events ingestion stack in the same AWS account and Region first. The Stripe snapshot destination must include `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. Deploy Local Bridge with `LOCAL_BRIDGE_ENABLE_BILLING=1` and `LOCAL_BRIDGE_STRIPE_EVENTS_ENV=prod` for the hosted service. The rule matches live subscription events tagged `metadata.project=local-bridge`. The billing Lambda checks the customer binding and reconciles current Stripe subscriptions before updating the account’s plan. Undelivered or failed events go to the billing dead-letter queue after retries. [Stripe Events](https://github.com/martzmakes/stripe-events) [Stripe EventBridge destinations](https://docs.stripe.com/event-destinations/eventbridge)

## Isolated Stripe checkout test

Use a second CDK stack with its own HTTPS and WebSocket hostnames, its own SSM parameter prefix, and a test-only email allowlist. Follow [Self-host Local Bridge on AWS](self-hosting.md) for the DNS, certificate, and web export. Build the account page with `EXPO_PUBLIC_AUTH_API_URL` set to the test HTTPS origin and point `LOCAL_BRIDGE_SITE_DIST_DIR` at that export.

Set `LOCAL_BRIDGE_STACK_NAME` to the test stack name, `LOCAL_BRIDGE_PARAMETER_PREFIX` to its SSM prefix, `LOCAL_BRIDGE_ENABLE_BILLING=1`, and `LOCAL_BRIDGE_STRIPE_MODE=test`. Under the test prefix, create independent `jwt-secret` and `audit-hmac-key` SecureStrings and store the test API key as `stripe-secret-key`. Configure a separate sandbox Stripe destination and Stripe Events ingestion stack, and point the test consumer at it with `LOCAL_BRIDGE_STRIPE_EVENTS_ENV=test`.

Create the Plus product and the two lookup keys in Stripe test mode. Configure the sandbox destination with the same three subscription events. From an invited test account, start Checkout, use Stripe's test card, and verify the account changes from Free to Plus. Cancel the test subscription and verify it returns to Free after the cancellation takes effect. [Stripe testing](https://docs.stripe.com/testing)
