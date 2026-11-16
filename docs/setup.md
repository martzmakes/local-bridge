# Setup and deploy

Everything runs from this Mac with the `your-profile` profile. There is no CI.

```bash
export AWS_PROFILE=your-profile AWS_REGION=us-east-1 \
  CDK_DEFAULT_REGION=us-east-1 CDK_DEFAULT_ACCOUNT=123456789012
```

## 1. Secrets (once)

Two SecureStrings. The values are generated in the shell and never printed.

```bash
aws ssm put-parameter --name /local-bridge/jwt-secret --type SecureString --value "$(openssl rand -base64 48)"
```

```bash
aws ssm put-parameter --name /local-bridge/audit-hmac-key --type SecureString --value "$(openssl rand -base64 48)"
```

Rotating `/local-bridge/jwt-secret` signs every agent out: connectors must sign in again and minted tokens must be re-minted. Rotating the audit key only means argument hashes before and after the change cannot be compared.

## 2. Web bundle

The stack uploads `app/dist`, so build it before the first deploy and whenever `app/` changes.

```bash
cd app && npm ci && EXPO_PUBLIC_AUTH_API_URL="https://bridge.martzmakes.com" npx expo export --platform web --clear \
  && cp static/manifest.json dist/manifest.json && cp static/sw.js dist/sw.js && cp assets/favicon.png dist/favicon.png
```

## 3. Deploy

```bash
cd infra && npm ci && npx cdk deploy LocalBridgeStack --require-approval never --outputs-file cdk-outputs.json
```

`cdk-outputs.json` is how `scripts/admin.ts` and `scripts/mint.ts` find the table. It is git-ignored.

Check:

```bash
curl -s https://bridge.martzmakes.com/.well-known/oauth-protected-resource
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://bridge.martzmakes.com/mcp -d '{}'
```

The second prints `401`.

## 4. A machine

On the Mac that will be bridged:

```bash
cd agent && npm ci && npm run build && node dist/cli.mjs init
```

`init` creates the device key in the login Keychain and prints the public key with the exact registration command. Run that command from `infra/`:

```bash
npm run admin -- device register mini '<public jwk printed by init>'
```

Write `~/.config/local-bridge/config.json` (start from `agent/config.example.json`), `chmod 600` it, then check it and run in the foreground first:

```bash
node dist/cli.mjs doctor
```

```bash
node dist/cli.mjs run
```

```bash
cd ../infra && npm run admin -- device list
```

When that shows the machine connected with its servers up, install the LaunchAgent:

```bash
cd agent && ./scripts/install.sh
```

Grant the macOS permissions in [`permissions.md`](permissions.md). Automation prompts appear the first time a tool is called and have to be approved at the Mac's screen.

## 5. An agent

See [`operations.md`](operations.md).
