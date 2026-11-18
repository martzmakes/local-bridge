import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaRuntime from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudfrontOrigins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as apigwv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "path";

const PROJECT_SLUG = "local-bridge";
const DOMAIN = "bridge.martzmakes.com";
// The machine channel (WebSocket API) gets its own hostname so a machine's
// config survives the API being recreated.
const WS_DOMAIN = "bridge-ws.martzmakes.com";
// Send via the shared parent-zone SES identity (verified once, account-wide
// for martzmakes.com). Avoids per-prototype EmailIdentity collisions. If
// your DOMAIN is NOT a martzmakes-subdomain, override SES_FROM with a
// per-stack-verified identity and add `ses.EmailIdentity` back below.
const SES_FROM = "Local Bridge <no-reply@martzmakes.com>";
const JWT_SECRET_NAME = `/${PROJECT_SLUG}/jwt-secret`;
const AUDIT_HMAC_PARAM = `/${PROJECT_SLUG}/audit-hmac-key`;
const AUDIT_RETENTION_DAYS = 90;

export class LocalBridgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------
    // DynamoDB
    // -------------------------------------------------------------------
    const usersTable = new dynamodb.Table(this, "UsersTable", {
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // For production, change to RETAIN to prevent accidental data loss.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const magicLinkTokensTable = new dynamodb.Table(
      this,
      "MagicLinkTokensTable",
      {
        partitionKey: { name: "token", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: "ttl",
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // OAuthTable — ephemeral OAuth state for MCP clients (registered clients
    // + pending auth requests) with TTL cleanup. Delete this with the rest
    // of the MCP/OAuth block if your project doesn't expose an MCP server.
    //   pk = CLIENT#<clientId> / sk = CLIENT
    //   pk = AUTH#<authCode>  / sk = AUTH
    const oauthTable = new dynamodb.Table(this, "OAuthTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // WaitlistTable — every non-allowlisted email is captured here as a
    // demand signal instead of silently dropped. RETAIN so a redeploy or
    // teardown doesn't lose the validation data.
    const waitlistTable = new dynamodb.Table(this, "WaitlistTable", {
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // BridgeTable: agents and their allowlist rules, machines and their tool
    // catalogs, live connections, in-flight calls, rate counters and the audit
    // trail. Key layout is documented in lambdas/bridge/store.ts. RETAIN: the
    // allowlist and the audit trail must survive a stack teardown.
    const bridgeTable = new dynamodb.Table(this, "BridgeTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // -------------------------------------------------------------------
    // SSM secrets (created out-of-band; see docs/setup.md)
    // -------------------------------------------------------------------
    const jwtSecretParam =
      ssm.StringParameter.fromSecureStringParameterAttributes(
        this,
        "JwtSecretParam",
        { parameterName: JWT_SECRET_NAME }
      );

    // Key for the audit trail's argument hashes (created out of band, like the
    // JWT secret). Read only by the MCP Lambda.
    const auditHmacParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this, "AuditHmacParam", { parameterName: AUDIT_HMAC_PARAM }
    );

    // -------------------------------------------------------------------
    // Lambda defaults
    // -------------------------------------------------------------------
    const lambdaEnv: Record<string, string> = {
      USERS_TABLE: usersTable.tableName,
      MAGIC_LINK_TOKENS_TABLE: magicLinkTokensTable.tableName,
      OAUTH_TABLE: oauthTable.tableName,
      JWT_SECRET_NAME,
      PROJECT_SLUG,
      DOMAIN,
      // Allowlist gate — locked to the owner by default. Override at deploy
      // time via the ALLOWED_EMAILS env (comma-separated) to open access.
      // Wired into the SHARED lambda env defaults (not just auth-issuance
      // lambdas) because verifyJwt() re-checks this on every call, not just
      // at token mint time — every lambda that verifies a JWT needs it.
      ALLOWED_EMAILS: "operator@example.com",
    };

    const lambdaDefaults = {
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        forceDockerBundling: false,
        externalModules: [] as string[],
      },
    };

    // -------------------------------------------------------------------
    // Auth HTTP API + Lambdas
    // -------------------------------------------------------------------
    const authHttpApi = new apigwv2.HttpApi(this, "AuthHttpApi", {
      apiName: `${PROJECT_SLUG}-auth`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type"],
      },
    });

    const authLambdaBase = {
      ...lambdaDefaults,
      environment: {
        ...lambdaEnv,
        VERIFY_BASE_URL: `${authHttpApi.apiEndpoint}/auth/verify`,
        SITE_URL: `https://${DOMAIN}`,
        SES_FROM_ADDRESS: SES_FROM,
        WAITLIST_TABLE: waitlistTable.tableName,
      },
    };

    const requestMagicLinkHandler = new lambda.NodejsFunction(
      this,
      "AuthRequestHandler",
      {
        ...authLambdaBase,
        entry: path.join(__dirname, "lambdas", "auth", "request.ts"),
        handler: "handler",
      }
    );

    const verifyMagicLinkHandler = new lambda.NodejsFunction(
      this,
      "AuthVerifyHandler",
      {
        ...authLambdaBase,
        entry: path.join(__dirname, "lambdas", "auth", "verify.ts"),
        handler: "handler",
      }
    );

    const meHandler = new lambda.NodejsFunction(this, "AuthMeHandler", {
      ...authLambdaBase,
      entry: path.join(__dirname, "lambdas", "auth", "me.ts"),
      handler: "handler",
    });

    magicLinkTokensTable.grantReadWriteData(requestMagicLinkHandler);
    waitlistTable.grantWriteData(requestMagicLinkHandler);
    magicLinkTokensTable.grantReadWriteData(verifyMagicLinkHandler);
    usersTable.grantReadWriteData(verifyMagicLinkHandler);
    usersTable.grantReadWriteData(meHandler);
    oauthTable.grantReadWriteData(verifyMagicLinkHandler); // for OAuth handoff
    jwtSecretParam.grantRead(verifyMagicLinkHandler);
    jwtSecretParam.grantRead(meHandler);

    requestMagicLinkHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      })
    );

    authHttpApi.addRoutes({
      path: "/auth/request",
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.OPTIONS],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "AuthRequestIntegration",
        requestMagicLinkHandler
      ),
    });

    authHttpApi.addRoutes({
      path: "/auth/verify",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "AuthVerifyIntegration",
        verifyMagicLinkHandler
      ),
    });

    authHttpApi.addRoutes({
      path: "/auth/me",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.DELETE,
        apigwv2.HttpMethod.OPTIONS,
      ],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "AuthMeIntegration",
        meHandler
      ),
    });

    // -------------------------------------------------------------------
    // MCP server + OAuth (for Claude Desktop / remote MCP clients)
    // Delete this whole block (and the OAuthTable above + lambdas/mcp +
    // lambdas/oauth) if you don't expose MCP.
    // See docs/mcp.md for what this enables and how to extend.
    // -------------------------------------------------------------------
    const oauthHandler = new lambda.NodejsFunction(this, "OAuthHandler", {
      ...authLambdaBase,
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      entry: path.join(__dirname, "lambdas", "oauth", "handler.ts"),
      handler: "handler",
    });

    oauthTable.grantReadWriteData(oauthHandler);
    magicLinkTokensTable.grantReadWriteData(oauthHandler);
    waitlistTable.grantWriteData(oauthHandler); // for allowlist-gate waitlist writes
    jwtSecretParam.grantRead(oauthHandler);
    oauthHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      })
    );

    for (const p of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/oauth/register",
      "/oauth/authorize",
      "/oauth/consent", // SSO consent screen POSTs here; the template omitted it (404 → "Missing OAuth callback data")
      "/oauth/email",
      "/oauth/token",
    ]) {
      authHttpApi.addRoutes({
        path: p,
        methods: [
          apigwv2.HttpMethod.GET,
          apigwv2.HttpMethod.POST,
          apigwv2.HttpMethod.OPTIONS,
        ],
        integration: new apigwv2Integrations.HttpLambdaIntegration(
          `OAuthIntegration_${p.replace(/[^a-zA-Z0-9]/g, "_")}`,
          oauthHandler
        ),
      });
    }

    // -------------------------------------------------------------------
    // Machine channel: WebSocket API a machine's local agent dials out to.
    // $connect is guarded by a Lambda authorizer that verifies the machine's
    // signed device assertion (lambdas/bridge/device-auth.ts).
    // -------------------------------------------------------------------
    const bridgeLogGroup = (id: string) =>
      new logs.LogGroup(this, id, {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    const bridgeEnv = { BRIDGE_TABLE: bridgeTable.tableName, PROJECT_SLUG };

    const deviceAuthorizerFn = new lambda.NodejsFunction(this, "DeviceAuthorizer", {
      ...lambdaDefaults,
      environment: bridgeEnv,
      entry: path.join(__dirname, "lambdas", "ws", "authorizer.ts"),
      handler: "handler",
      logGroup: bridgeLogGroup("DeviceAuthorizerLogs"),
    });
    bridgeTable.grantReadWriteData(deviceAuthorizerFn);

    const deviceHandler = new lambda.NodejsFunction(this, "DeviceHandler", {
      ...lambdaDefaults,
      memorySize: 512,
      environment: bridgeEnv,
      entry: path.join(__dirname, "lambdas", "ws", "handler.ts"),
      handler: "handler",
      logGroup: bridgeLogGroup("DeviceHandlerLogs"),
    });
    bridgeTable.grantReadWriteData(deviceHandler);

    const wsApi = new apigwv2.WebSocketApi(this, "DeviceWsApi", {
      apiName: `${PROJECT_SLUG}-devices`,
      connectRouteOptions: {
        integration: new apigwv2Integrations.WebSocketLambdaIntegration("DeviceConnect", deviceHandler),
        authorizer: new apigwv2Authorizers.WebSocketLambdaAuthorizer("DeviceAuth", deviceAuthorizerFn, {
          identitySource: ["route.request.header.Authorization"],
        }),
      },
      disconnectRouteOptions: {
        integration: new apigwv2Integrations.WebSocketLambdaIntegration("DeviceDisconnect", deviceHandler),
      },
      defaultRouteOptions: {
        integration: new apigwv2Integrations.WebSocketLambdaIntegration("DeviceDefault", deviceHandler),
      },
    });
    const wsCertificate = acm.Certificate.fromCertificateArn(
      this,
      "WsCertificate",
      ssm.StringParameter.valueForStringParameter(this, "/local-bridge/certificate-arn")
    );
    const wsDomain = new apigwv2.DomainName(this, "DeviceWsDomain", {
      domainName: WS_DOMAIN,
      certificate: wsCertificate,
    });
    const wsStage = new apigwv2.WebSocketStage(this, "DeviceWsStage", {
      webSocketApi: wsApi,
      stageName: "prod",
      autoDeploy: true,
      domainMapping: { domainName: wsDomain },
      // One machine sends a heartbeat a minute; anything near this is abuse.
      throttle: { rateLimit: 20, burstLimit: 40 },
    });
    deviceHandler.addEnvironment("WS_MANAGEMENT_ENDPOINT", wsStage.callbackUrl);
    wsStage.grantManagementApiAccess(deviceHandler);

    const mcpHandler = new lambda.NodejsFunction(this, "McpHandler", {
      ...lambdaDefaults,
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...lambdaDefaults.environment,
        MCP_PUBLIC_BASE: `https://${DOMAIN}`,
        BRIDGE_TABLE: bridgeTable.tableName,
        WS_MANAGEMENT_ENDPOINT: wsStage.callbackUrl,
        AUDIT_HMAC_PARAM,
        AUDIT_RETENTION_DAYS: String(AUDIT_RETENTION_DAYS),
        // "true" keeps a disconnected machine's last tool list in tools/list
        // (calls then fail fast with the offline error). See spec section 7.
        LIST_STALE_TOOLS: "false",
      },
      entry: path.join(__dirname, "lambdas", "mcp", "server.ts"),
      handler: "handler",
      logGroup: bridgeLogGroup("McpHandlerLogs"),
    });

    jwtSecretParam.grantRead(mcpHandler);
    auditHmacParam.grantRead(mcpHandler);
    bridgeTable.grantReadWriteData(mcpHandler);
    wsStage.grantManagementApiAccess(mcpHandler);

    // Account API for the macOS app (register this Mac, list and remove
    // Macs). The account is always the bearer token's; see account/handler.ts.
    const accountHandler = new lambda.NodejsFunction(this, "AccountHandler", {
      ...lambdaDefaults,
      environment: { ...lambdaDefaults.environment, BRIDGE_TABLE: bridgeTable.tableName },
      entry: path.join(__dirname, "lambdas", "account", "handler.ts"),
      handler: "handler",
      logGroup: bridgeLogGroup("AccountHandlerLogs"),
    });
    jwtSecretParam.grantRead(accountHandler);
    bridgeTable.grantReadWriteData(accountHandler);
    for (const [p, methods] of [
      ["/api/me", [apigwv2.HttpMethod.GET]],
      ["/api/machines", [apigwv2.HttpMethod.GET]],
      ["/api/machines/{machine}", [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE]],
    ] as const) {
      authHttpApi.addRoutes({
        path: p,
        methods: [...methods],
        integration: new apigwv2Integrations.HttpLambdaIntegration(
          `AccountIntegration_${p.replace(/[^a-zA-Z0-9]/g, "_")}`,
          accountHandler
        ),
      });
    }

    authHttpApi.addRoutes({
      path: "/mcp",
      methods: [
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.DELETE,
        apigwv2.HttpMethod.OPTIONS,
      ],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "McpIntegration",
        mcpHandler
      ),
    });

    // One MCP endpoint per local server: /mcp/<endpointId>. Same auth
    // as /mcp; the endpoint exposes that server's tools under their own names.
    authHttpApi.addRoutes({
      path: "/mcp/{endpointId}",
      methods: [
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.DELETE,
        apigwv2.HttpMethod.OPTIONS,
      ],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "McpServerEndpointIntegration",
        mcpHandler
      ),
    });
    // Path-specific protected-resource metadata for those URLs (RFC 9728).
    authHttpApi.addRoutes({
      path: "/.well-known/oauth-protected-resource/{proxy+}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.OPTIONS],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "OAuthResourceMetadataIntegration",
        oauthHandler
      ),
    });
    // -------------------------------------------------------------------
    // End MCP + OAuth block
    // -------------------------------------------------------------------

    // -------------------------------------------------------------------
    // Static site (S3 + CloudFront + Route 53 + ACM + SES)
    //
    // CloudFront fronts both the S3 static bundle (default behavior) AND
    // the API Gateway endpoints. Routing API traffic through the same
    // custom domain is REQUIRED for Claude's MCP Apps widgets — Claude
    // rejects ui.domain hints from raw *.execute-api.* URLs ("local
    // connector" error). Other clients still work without the proxy, but
    // widgets won't render.
    // -------------------------------------------------------------------
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Parent zone + wildcard cert sourced from SSM (provisioned once by the
    // prototype-builder infra). Avoids per-prototype zone-delegation + cert-
    // validation (5-30 min/each) and uses the shared *.martzmakes.com cert.
    // SSM params (created out-of-band; see docs/setup.md):
    //   /local-bridge/certificate-arn    (= *.martzmakes.com ACM)
    //   /local-bridge/route53-zone-id      (= martzmakes.com zone)
    // If you are NOT using a martzmakes-subdomain DOMAIN, swap these for a
    // per-stack HostedZone.fromLookup + acm.Certificate (and add SES identity
    // back) — the inline pattern below is the autonomous-deploy default.
    const wildcardCertArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/local-bridge/certificate-arn"
    );
    const parentZoneId = ssm.StringParameter.valueForStringParameter(
      this,
      "/local-bridge/route53-zone-id"
    );
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "HostedZone",
      {
        hostedZoneId: parentZoneId,
        zoneName: "martzmakes.com",
      }
    );
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "SiteCertificate",
      wildcardCertArn
    );

    // Build an HttpOrigin pointed at the API Gateway domain, then attach it
    // to extra behaviors so /mcp, /auth/*, /oauth/*, /.well-known/*
    // all proxy to API Gateway through the same custom domain.
    const apiOriginHost = cdk.Fn.select(
      2,
      cdk.Fn.split("/", authHttpApi.apiEndpoint)
    );
    const apiOrigin = new cloudfrontOrigins.HttpOrigin(apiOriginHost, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
    const apiBehavior = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy:
        cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
    };

    // SPA-fallback CloudFront Function. Rewrites any non-asset, non-API
    // path to /index.html at the viewer-request stage so deep links (e.g.
    // /auth/complete, /share/<token>) load the SPA. This replaces
    // the previous distribution-wide `errorResponses: 404->index.html` which
    // had a critical bug: it intercepted JSON 404s from API behaviors and
    // converted them to 200 + index.html, leaking existence info on bogus
    // IDs and breaking anti-existence-leak invariants on share endpoints.
    //
    // This function ONLY runs on the default S3 behavior. API behaviors
    // (/auth/*, /oauth/*, /mcp*, etc.) are not associated with
    // it, so API 404s flow through untouched.
    const spaFallbackFunction = new cloudfront.Function(
      this,
      "SpaFallbackFunction",
      {
        functionName: `${PROJECT_SLUG.replace(/-/g, "")}SpaFallback`,
        code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  // Pass-through: actual asset paths, anything with an extension, anything
  // under /_expo/ (Metro bundles), and the manifest/sw.js/favicon.
  if (uri === '/' || uri === '/index.html') return request;
  if (uri.indexOf('/_expo/') === 0) return request;
  if (uri.indexOf('/static/') === 0) return request;
  if (uri.indexOf('/assets/') === 0) return request;
  if (/\\.[a-zA-Z0-9]{2,5}$/.test(uri)) return request;
  // Otherwise this is an SPA deep link — rewrite to /index.html so S3
  // returns the SPA bundle. Status remains 200 from S3; the SPA reads
  // window.location.pathname itself.
  request.uri = '/index.html';
  return request;
}
        `),
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        comment:
          "SPA deep-link fallback (rewrites non-asset paths to /index.html)",
      }
    );

    // The S3 SPA behavior, reused for both the default behavior and the exact
    // /auth/complete deep link below (one origin, referenced by both).
    const staticBehavior = {
      origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(siteBucket),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    };
    const spaBehavior = {
      ...staticBehavior,
      functionAssociations: [
        {
          function: spaFallbackFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        },
      ],
    };

    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      defaultBehavior: spaBehavior,
      additionalBehaviors: {
        // Exact /auth/complete → SPA. MUST precede the "/auth/*" API proxy: a
        // more specific CloudFront path pattern wins. /auth/complete is the
        // magic-link landing page (a CLIENT route handled by App.tsx), NOT an
        // API route — routing it to the API Gateway 404s the login link.
        "/auth/complete": spaBehavior,
        "/mcp": apiBehavior,
        "/mcp/*": apiBehavior,
        "/api/*": apiBehavior,
        "/auth/*": apiBehavior,
        "/oauth/*": apiBehavior,
        "/.well-known/*": apiBehavior,
        "/updates/appcast.xml": {
          ...staticBehavior,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
        "/updates/*": staticBehavior,
      },
      defaultRootObject: "landing/index.html",
      domainNames: [DOMAIN],
      certificate,
      // NOTE: errorResponses removed deliberately (see SpaFallbackFunction
      // above). The function handles SPA deep-link fallback at the viewer-
      // request stage, scoped to the default S3 behavior only, so API 404s
      // flow through untouched (preserves anti-existence-leak invariants).
    });

    // Subdomain A-record under the shared martzmakes.com parent zone.
    // DOMAIN is e.g. "proto-<slug>.martzmakes.com" — recordName is the
    // subdomain prefix only (Route53 appends the zoneName automatically).
    const subdomainPrefix = DOMAIN.endsWith(".martzmakes.com")
      ? DOMAIN.slice(0, -".martzmakes.com".length)
      : DOMAIN;
    new route53.ARecord(this, "DeviceWsAliasRecord", {
      zone: hostedZone,
      recordName: WS_DOMAIN.slice(0, -".martzmakes.com".length),
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          wsDomain.regionalDomainName,
          wsDomain.regionalHostedZoneId
        )
      ),
    });

    new route53.ARecord(this, "SubdomainAliasRecord", {
      zone: hostedZone,
      recordName: subdomainPrefix,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution)
      ),
    });

    new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../../app/dist"))],
      destinationBucket: siteBucket,
      exclude: ["updates/*"],
      distribution,
      distributionPaths: ["/*"],
    });

    // SES sending identity dropped in the autonomous-deploy pattern: the
    // parent zone (martzmakes.com) already owns a shared SES identity
    // (verified once, account-wide). Creating a per-stack EmailIdentity
    // for the parent zone collides with sibling stacks. Send mail from
    // a shared address (e.g. no-reply@martzmakes.com) via SES_FROM_ADDRESS
    // — the SES_FROM constant above defaults to `no-reply@${DOMAIN}` for
    // backwards compatibility; override `SES_FROM` in this file to point
    // at the shared mailbox if the parent identity is the one verified.

    // -------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------
    new cdk.CfnOutput(this, "PublicBaseUrl", {
      value: `https://${DOMAIN}`,
      description: "Public base URL (CloudFront-fronted, API + static)",
    });
    new cdk.CfnOutput(this, "AuthHttpApiDirectUrl", {
      value: authHttpApi.apiEndpoint,
      description: "Direct API Gateway URL (for debugging only)",
    });
    new cdk.CfnOutput(this, "McpUrl", {
      value: `https://${DOMAIN}/mcp`,
      description: "MCP server URL — paste into Claude Desktop connectors",
    });
    new cdk.CfnOutput(this, "CloudFrontUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "CloudFront URL (redirects to apex domain)",
    });
    new cdk.CfnOutput(this, "SiteBucketName", { value: siteBucket.bucketName });
    new cdk.CfnOutput(this, "UpdateFeedUrl", { value: `https://${DOMAIN}/updates/appcast.xml` });
    new cdk.CfnOutput(this, "UsersTableName", { value: usersTable.tableName });
    new cdk.CfnOutput(this, "MagicLinkTokensTableName", {
      value: magicLinkTokensTable.tableName,
    });
    new cdk.CfnOutput(this, "OAuthTableName", { value: oauthTable.tableName });
    new cdk.CfnOutput(this, "BridgeTableName", { value: bridgeTable.tableName });
    new cdk.CfnOutput(this, "DeviceEndpoint", {
      value: `wss://${WS_DOMAIN}`,
      description: "WebSocket endpoint for a machine's local agent config",
    });
    new cdk.CfnOutput(this, "DeviceEndpointDirect", {
      value: wsStage.url,
      description: "Direct WebSocket API URL (for debugging only)",
    });
    // SES identity output dropped — see drop comment above the A-record.
  }
}
