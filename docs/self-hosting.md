# Self-host Local Bridge on AWS

This walkthrough takes you from a domain you own to your first working Local Bridge connector. AWS runs the relay and sends sign-in links. Your Mac runs the tools. Your AWS account controls the bill and the list of people who can sign in.

## Before you start

- An Apple silicon Mac running macOS 14 or newer. Install [Local Bridge 0.3.1 or later](https://bridge.martzmakes.com/updates/LocalBridge-Mac-0.3.1.zip), [Node.js 22 or newer](https://nodejs.org/en/download), and the [AWS CLI for macOS](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).
- An AWS account and a sign-in with permission to deploy CDK and set up Route 53, Certificate Manager, SES, and Systems Manager. Use **US East (N. Virginia)** (`us-east-1`) for the certificate, email, and stack. Route 53 is global.
- A domain whose DNS records you can edit and an email inbox you can open.
- The [Local Bridge source code](https://github.com/martzmakes/local-bridge). The repository is private during release preparation. If you have access, choose **Code → Download ZIP** and unzip it. The Mac app download is a separate file.

AWS bills you for the hosted zone and usage. CDK will show you the changes it plans to make before deployment.

### Worked example

Use the same values in the AWS console, Terminal, and the Mac app. Replace every sample domain, email address, ID, and ARN with your own.

| What you need | Example |
| --- | --- |
| Public Route 53 hosted zone | `example.com` |
| Website, sign-in, and connector host | `bridge.example.com` |
| WebSocket host the Mac connects to | `bridge-ws.example.com` |
| Email sender and first sign-in | `alex@example.com` |
| AWS CLI profile | `local-bridge` |
| CDK stack name | `LocalBridgeStack` |

## 1. Set up DNS in Route 53

1. Open **Route 53 → Hosted zones**. If Route 53 already handles DNS for your domain, open its **Public** hosted zone and copy the **Hosted zone ID**. It usually starts with `Z`.
2. If your DNS is with another provider, you can keep your existing website and mail there. Create a **public** Route 53 hosted zone for a subdomain such as `tools.example.com`. In the original provider's DNS settings for `example.com`, add an **NS** record for `tools` that lists all four name servers from the new Route 53 zone. Use `tools.example.com` as the zone and `bridge.tools.example.com` and `bridge-ws.tools.example.com` as the two hosts throughout this guide. [AWS subdomain delegation walkthrough](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/CreatingNewSubdomain.html)
3. In Terminal, run the following and compare the result with the nameservers listed in your Route 53 zone. Use `tools.example.com` instead for the delegated example. Wait for the records to match before requesting the certificate.

```bash
dig +short NS example.com
```

Choose two unused hostnames. CDK creates their address records during deployment.

## 2. Request the HTTPS certificate

1. In the AWS console, select **US East (N. Virginia)** and open **Certificate Manager**. Choose **Request → Request a public certificate**.
2. Add both your hostnames, for example `bridge.example.com` and `bridge-ws.example.com`. Choose **DNS validation** and keep the default key settings.
3. Open the certificate. Under **Domains**, choose **Create records in Route 53** and confirm the validation records for both names. If you need to add them manually, copy the CNAME names and values ACM displays into the correct public hosted zone.
4. Wait for the certificate status to show **Issued**, then copy its **ARN**. It starts with `arn:aws:acm:us-east-1:`. Keep the validation CNAME records so ACM can renew it. [AWS certificate validation walkthrough](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)

## 3. Verify an email address in SES

1. Still in **US East (N. Virginia)**, open **Amazon SES → Verified identities → Create identity**. Choose **Email address** and enter an inbox you control, such as `alex@example.com`.
2. Open the Amazon SES verification email and click its link. Return to SES and check that the identity is **Verified**.
3. Use that same address as both the sender and your first sign-in below. This works in the SES sandbox. To invite someone else while in the sandbox, verify their recipient email address in SES too, then add it to your Local Bridge allowlist. [SES identity setup](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) · [SES sandbox rules](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)

## 4. Sign in to AWS from Terminal

Open **Terminal** with Spotlight. You can paste each command block as a group. Use the same Terminal window for the remaining steps so the configuration stays loaded.

```bash
node --version
aws --version
```

Look for Node `v22` or newer and AWS CLI `aws-cli/2`. If a command is missing after installation, reopen Terminal and try again.

If you already have a CLI profile for this AWS account, use its name in place of `local-bridge`. To create a profile with an AWS console sign-in, run the following with AWS CLI 2.32.0 or newer. Complete the browser sign-in with your deployment identity and choose `us-east-1` if asked for a region. [AWS CLI browser sign-in](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html)

```bash
aws login --profile local-bridge
```

If your organization gave you an AWS access portal or uses IAM Identity Center, use `aws configure sso --profile local-bridge` and then `aws sso login --profile local-bridge`. [AWS CLI single sign-on setup](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)

Now open the unzipped source folder in Terminal. Type `cd ` with a space, drag the folder from Finder into Terminal, and press Return. Then check that you can see the project folders.

```bash
ls
```

You should see `agent`, `app`, `docs`, `infra`, and `macapp`.

## 5. Configure and deploy

### Select your AWS account and enter your values

Set the profile name below to the one you just signed in with. The last line prints the account number. Confirm it matches the AWS console before continuing.

```bash
export AWS_PROFILE=local-bridge
export AWS_REGION=us-east-1
aws sts get-caller-identity --query Account --output text
```

Replace the worked-example domain and email values. Replace both `REPLACE_WITH_…` strings with the hosted zone ID and certificate ARN you copied.

```bash
export CDK_DEFAULT_REGION="$AWS_REGION"
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity \
  --query Account --output text)"

export LOCAL_BRIDGE_ZONE_NAME=example.com
export LOCAL_BRIDGE_DOMAIN=bridge.example.com
export LOCAL_BRIDGE_WS_DOMAIN=bridge-ws.example.com
export LOCAL_BRIDGE_SES_FROM='Local Bridge <alex@example.com>'
export LOCAL_BRIDGE_ALLOWED_EMAILS='alex@example.com'

export LOCAL_BRIDGE_STACK_NAME=LocalBridgeStack
export LOCAL_BRIDGE_PARAMETER_PREFIX=/local-bridge
export LOCAL_BRIDGE_ENABLE_BILLING=0

export LOCAL_BRIDGE_ZONE_PARAM="$LOCAL_BRIDGE_PARAMETER_PREFIX/route53-zone-id"
export LOCAL_BRIDGE_CERT_PARAM="$LOCAL_BRIDGE_PARAMETER_PREFIX/certificate-arn"
ZONE_ID='REPLACE_WITH_HOSTED_ZONE_ID'
CERTIFICATE_ARN='REPLACE_WITH_CERTIFICATE_ARN'
```

With multiple users, the allowlist takes comma-separated email addresses, for example `'alex@example.com,sam@example.com'`. For a second deployment in the same account, use distinct hostnames, a different stack name, and a different parameter prefix.

### Save the deployment values in AWS

Run these in the same Terminal window. The last two commands generate random values and store them in Systems Manager as encrypted parameters.

```bash
aws ssm put-parameter --name "$LOCAL_BRIDGE_ZONE_PARAM" \
  --type String --value "$ZONE_ID" &&
aws ssm put-parameter --name "$LOCAL_BRIDGE_CERT_PARAM" \
  --type String --value "$CERTIFICATE_ARN" &&
aws ssm put-parameter \
  --name "$LOCAL_BRIDGE_PARAMETER_PREFIX/jwt-secret" \
  --type SecureString --value "$(openssl rand -hex 32)" &&
aws ssm put-parameter \
  --name "$LOCAL_BRIDGE_PARAMETER_PREFIX/audit-hmac-key" \
  --type SecureString --value "$(openssl rand -hex 32)"
```

Each successful command prints a version number. If a previous run already created a parameter, run only the commands for the missing parameters. When running one command on its own, omit the trailing `&&`. Keep the same signing keys for future deployments.

### Build the sign-in site and deploy the bridge

Run both blocks from the source folder. The first builds the sign-in website. The second prepares the account for CDK and deploys the stack. Read the proposed AWS changes before typing `y` if CDK asks for approval. A first deployment can take several minutes. [AWS CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)

```bash
(
  cd app &&
  npm ci &&
  EXPO_PUBLIC_AUTH_API_URL="https://$LOCAL_BRIDGE_DOMAIN" \
    npx expo export --platform web &&
  cp static/manifest.json static/sw.js assets/favicon.png dist/
)
```

```bash
(
  cd infra &&
  npm ci &&
  npx cdk bootstrap "aws://$CDK_DEFAULT_ACCOUNT/$AWS_REGION" &&
  npx cdk deploy "$LOCAL_BRIDGE_STACK_NAME" --outputs-file cdk-outputs.json
)
```

Look for these two outputs with your hostnames. They are also saved in `infra/cdk-outputs.json`.

```text
LocalBridgeStack.PublicBaseUrl = https://bridge.example.com
LocalBridgeStack.DeviceEndpoint = wss://bridge-ws.example.com
```

Check the sign-in service before opening the Mac app. This should print JSON with an `issuer` and an `authorization_endpoint` on your HTTPS host.

```bash
curl -fsS "https://$LOCAL_BRIDGE_DOMAIN/.well-known/oauth-authorization-server"
```

## 6. Connect the Mac and add a server

1. Open Local Bridge. From the sign-in window, click **Choose Backend… → Self-hosted**.
2. Paste the outputs from CDK into the matching fields and click **Save Backend**.

| Field in the Mac app | CDK output | Worked example |
| --- | --- | --- |
| **Public HTTPS URL** | `PublicBaseUrl` | `https://bridge.example.com` |
| **WebSocket URL** | `DeviceEndpoint` | `wss://bridge-ws.example.com` |

3. Choose **Sign In with Email…** and enter the allowlisted email. Open the emailed link and let your browser return to Local Bridge. Give the Mac a name such as `mymac` and click **Continue**. The sidebar should show that the Mac is connected.
4. Click **+** to import a server you've already configured in another app, or choose **Add Manually…** and provide the command and arguments from your MCP server's setup instructions. Enable the tools you want to share and click **Save**. The server's **Connect** section shows a URL ending in `/mcp/<uuid>`.
5. Copy that full URL into a remote MCP client that supports custom connectors, sign in with the allowlisted email, and start by asking it to run a read tool. Leave the Mac awake for this test.

If the app is already signed in elsewhere, use **Settings → Account → Sign Out** before changing the backend. Your server definitions carry over with servers turned off. Review what each one shares, then re-enable the ones you want.

## 7. Try a demo without personal data

The source includes a small test MCP server that can echo text. From the same Terminal window and source folder, run the following. The last two lines print the absolute paths to Node and the test server.

```bash
(cd agent && npm ci) &&
command -v node &&
printf '%s\n' "$PWD/agent/test/fixtures/fixture-server.mjs"
```

1. In Local Bridge, click **+ → Add Manually…**. Use the title **Echo Demo**, the name `echo`, and the type **Runs a command on this Mac**. Paste the Node path into **Command** and the test server path on one line in **Arguments**.
2. Click **Add**. Once the tool list loads, right-click `echo` and choose **Treat as Read-Only** if it appears under **Can Make Changes**. Enable only `echo` and click **Save**.
3. Copy the new connector URL to your MCP client and ask it to echo `Hello from my Mac`. A successful result returns that phrase. You can also hover over `echo` and click **Try…** in Local Bridge to check that the tool runs locally.

## Troubleshooting and updating

| What you see | What to check |
| --- | --- |
| ACM stays on **Pending validation** | Check the public zone is delegated from its parent and the certificate's CNAMEs are in that zone. |
| CDK says **AccessDenied** | Run the account check again and confirm your AWS identity can bootstrap CDK and deploy CloudFormation. If your session expired, sign in again. |
| Deployment fails | In **CloudFormation → Stacks**, open `LocalBridgeStack` and read the first failed entry under **Events**. If AWS reports a hostname conflict, choose unused names and update the certificate and variables. |
| The magic link never arrives | Check spam, the exact address in `LOCAL_BRIDGE_ALLOWED_EMAILS`, and the SES identity status in `us-east-1`. In the sandbox, check the recipient's verification too. |
| The Mac stays disconnected | Check that the two addresses are in the right fields, Node is available in **Settings → General**, and the Mac is awake. |
| A connector opens but shows no useful tools | Enable the server and at least one tool, click **Save**, and confirm you're using the full connector URL from that server. |

To redeploy, load the same profile and variables, reuse the four Systems Manager parameters, and repeat the build and deploy blocks. For the operator CLI, keep the same environment variables. For a custom website, CloudFront serves `app/public/landing/index.html` at your domain root.

### Configure an older Mac app or the daemon

On a fresh installation, you can put the same settings in `~/.config/local-bridge/config.json`. Use the backend picker on an existing installation so you can sign in again and review server access.

```json
{
  "machine": "mymac",
  "publicBase": "https://bridge.example.com",
  "endpoint": "wss://bridge-ws.example.com",
  "servers": {}
}
```

If you build the daemon, install the dependencies in `infra/` first because the daemon imports the shared protocol from that directory. Then run `npm ci && npm run build` in `agent/`.
