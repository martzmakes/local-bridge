# Custom domain wiring

The CDK stack assumes you already own `bridge.martzmakes.com` and have a Route 53 hosted zone for it.

## If you registered the domain at Route 53

The hosted zone is created automatically. Skip to "What CDK does" below.

## If you registered elsewhere (Namecheap, Porkbun, etc.)

1. Create a hosted zone manually:

   ```bash
   AWS_PROFILE=your-profile aws route53 create-hosted-zone \
     --name bridge.martzmakes.com \
     --caller-reference "$(date +%s)"
   ```

2. Note the four NS records that AWS assigns to the zone.
3. At your registrar, set the domain's nameservers to those four NS values. Propagation: minutes to hours.
4. Verify the zone is live: `dig NS bridge.martzmakes.com` should return your AWS NS records.

## What CDK does

- `HostedZone.fromLookup({ domainName: "bridge.martzmakes.com" })` — finds the zone (must already exist).
- `acm.Certificate` — issues a TLS cert for the apex, validated by DNS records auto-added to the zone.
- `cloudfront.Distribution` — uses the cert, serves the apex domain.
- `route53.ARecord` — alias from the apex to the CloudFront distribution.

## Apex vs www

The template wires the **apex** (`bridge.martzmakes.com`) only. To also serve `www.bridge.martzmakes.com`:

1. Add `www.bridge.martzmakes.com` to the cert's `subjectAlternativeNames`.
2. Add `www.bridge.martzmakes.com` to the distribution's `domainNames`.
3. Add a second `route53.ARecord` for the `www` subdomain.

Or: set up a redirect (301 `www → apex`) using a CloudFront Function or Route 53 alias to a separate redirect-only distribution.

## SES on the same domain

The auth stack creates an SES `EmailIdentity` for the apex. It auto-adds three DKIM CNAMEs to the Route 53 zone. **Compatible** with using the same domain for inbound email at another provider — DKIM selectors don't conflict.

If you have inbound mail elsewhere, **merge SPF**:

```
v=spf1 include:icloud.com include:amazonses.com ~all
```

(Replace `include:icloud.com` with your inbound provider.) Only one SPF record per domain — they don't stack.

## ACM cert region

CloudFront requires certs in **us-east-1**. The template assumes the whole stack runs in us-east-1. If you want infra in another region:

1. Create the cert separately in us-east-1 with a `CrossRegionStack`, or
2. Use the [DnsValidatedCertificate construct](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_certificatemanager.DnsValidatedCertificate.html) which works around the constraint.

Easier path: keep the stack in us-east-1 unless you have a specific reason not to.
