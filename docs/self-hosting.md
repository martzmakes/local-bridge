# Self-host Local Bridge on AWS

Deploy the bridge into your own AWS account. Your stack relays calls, sends sign-in mail, and authenticates the Macs you register. Hosted billing is off by default.

## Prerequisites

- A source checkout, Node.js 22+, an AWS CLI profile, and access to deploy AWS CDK in `us-east-1`.
- A public Route 53 zone and two distinct hostnames in the zone, one for HTTPS and one for the Mac’s WebSocket.
- An issued ACM certificate in `us-east-1` covering both hostnames.
- A verified SES sending identity in `us-east-1`. In the SES sandbox, also verify each recipient or request production access.

## Deploy

Run from your checkout. Replace the sample names with your values.

```bash
export AWS_PROFILE=your-profile AWS_REGION=us-east-1
export CDK_DEFAULT_REGION="$AWS_REGION"
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export LOCAL_BRIDGE_ZONE_NAME=example.com
export LOCAL_BRIDGE_DOMAIN=bridge.example.com
export LOCAL_BRIDGE_WS_DOMAIN=bridge-ws.example.com
export LOCAL_BRIDGE_SES_FROM='Local Bridge <no-reply@example.com>'
export LOCAL_BRIDGE_ALLOWED_EMAILS='you@example.com'
export LOCAL_BRIDGE_ZONE_PARAM=/local-bridge/route53-zone-id
export LOCAL_BRIDGE_CERT_PARAM=/local-bridge/certificate-arn

aws ssm put-parameter --name "$LOCAL_BRIDGE_ZONE_PARAM" --type String --value 'YOUR_ZONE_ID'
aws ssm put-parameter --name "$LOCAL_BRIDGE_CERT_PARAM" --type String --value 'YOUR_CERTIFICATE_ARN'
aws ssm put-parameter --name /local-bridge/jwt-secret --type SecureString --value "$(openssl rand -hex 32)"
aws ssm put-parameter --name /local-bridge/audit-hmac-key --type SecureString --value "$(openssl rand -hex 32)"

(cd app && npm ci && EXPO_PUBLIC_AUTH_API_URL="https://$LOCAL_BRIDGE_DOMAIN" npx expo export --platform web \
  && cp static/manifest.json static/sw.js assets/favicon.png dist/)
(cd infra && npm ci && npx cdk bootstrap \
  && npx cdk deploy LocalBridgeStack --outputs-file cdk-outputs.json)
```

Create the secrets once and reuse them on redeploy. The deploy prints `PublicBaseUrl` and `DeviceEndpoint`. When running the admin CLI, also export `DOMAIN="$LOCAL_BRIDGE_DOMAIN"` and `ALLOWED_EMAILS="$LOCAL_BRIDGE_ALLOWED_EMAILS"`.

Customize the hosted preview page in `app/public/landing` for your deployment. CloudFront serves `landing/index.html` at the root.

## Connect a Mac

Before opening the app on a fresh Mac, set its endpoints using the two URLs from CDK. Back up and edit an existing config deliberately, reviewing which servers and tools it exposes before you connect it to a different stack.

```bash
mkdir -p ~/.config/local-bridge
(
  umask 077
  set -o noclobber
  cat > ~/.config/local-bridge/config.json <<'JSON'
{
  "machine": "mymac",
  "endpoint": "wss://bridge-ws.example.com",
  "publicBase": "https://bridge.example.com",
  "servers": {}
}
JSON
)
```

Open the app, sign in with an allowlisted email, and add your local MCP servers. Copy a connector URL from the app. Check your stack before signing in by fetching `https://bridge.example.com/.well-known/oauth-authorization-server`.

For your own software updates, see [Updates and releases](../macapp/README.md#updates-and-releases). For AWS usage estimates, see [Hosted service costs](hosted-service.md).
