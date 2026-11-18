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

## Waitlist and hosted plans

The public waitlist records interest. The email allowlist controls invitations. The hosted plan limits take effect when billing is enabled.

| Plan | Price | Macs | MCP servers per Mac | Tool calls per month |
| --- | --- | ---: | ---: | ---: |
| Free | $0 | 1 | 3 | 300 |
| Plus | $6 monthly or $60 annually | 3 | 10 | 3,000 |
| Self-host | Your AWS bill | Stack limits | Stack limits | Your AWS usage |

The Stripe product is `local_bridge_plus`. Checkout uses `local_bridge_plus_monthly` or `local_bridge_plus_annual`. The web account page offers Checkout and billing management to invited users when billing is enabled.

Before activating billing, configure a dedicated Stripe key for Customers, Prices, Checkout Sessions, Subscriptions and Portal Sessions in `/local-bridge/stripe-secret-key`, then configure the Stripe customer portal. Register `/api/billing/webhook` for customer subscription created, updated, and deleted events and put its signing secret in `/local-bridge/stripe-webhook-secret`. Deploy with `LOCAL_BRIDGE_ENABLE_BILLING=1` and exercise the purchase, cancellation, and cap changes in a Stripe test environment before admitting a paying cohort. Stripe webhooks update entitlements for known accounts. Invitations are managed separately. [Stripe subscriptions](https://docs.stripe.com/billing/subscriptions/build-subscriptions) [Stripe customer portal](https://docs.stripe.com/customer-management/integrate-customer-portal)
