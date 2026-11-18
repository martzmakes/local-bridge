// infra/test/infra-stack-routes.test.ts
// The OAuth handler serves seven endpoints (see lambdas/oauth/handler.ts route
// dispatch). Every one of them must have an API Gateway route, or CloudFront's
// /oauth/* proxy forwards the request to a 404. Regression: the SSO consent
// screen POSTs to /oauth/consent, which the template's route list omitted —
// Claude then never received its OAuth callback ("Missing OAuth callback data").
import * as cdk from "aws-cdk-lib/core";
import { Match, Template } from "aws-cdk-lib/assertions";
import { LocalBridgeStack } from "../lib/infra-stack";

const EXPECTED_OAUTH_ROUTES = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/authorize",
  "/oauth/consent",
  "/oauth/email",
  "/oauth/token",
];

describe("LocalBridgeStack", () => {
  jest.setTimeout(180_000); // NodejsFunction bundles the Lambdas at synth time

  let template: Template;
  beforeAll(() => {
    const app = new cdk.App();
    const stack = new LocalBridgeStack(app, "TestStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  it.each(EXPECTED_OAUTH_ROUTES)("routes POST %s to the OAuth handler", (path) => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: `POST ${path}` });
  });

  it("routes POST /mcp and the per-server endpoint to the MCP handler", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /mcp" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /mcp/{endpointId}" });
  });

  it("serves per-endpoint protected-resource metadata", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /.well-known/oauth-protected-resource/{proxy+}" });
  });

  it("serves the marketing page at the root and keeps the auth callback on the sign-in app", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        DefaultRootObject: "landing/index.html",
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/auth/complete",
            FunctionAssociations: Match.arrayWith([Match.objectLike({ EventType: "viewer-request" })]),
          }),
        ]),
      },
    });
  });

  it("serves software updates separately from the SPA and excludes them from site pruning", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/updates/appcast.xml",
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
            FunctionAssociations: Match.absent(),
          }),
          Match.objectLike({
            PathPattern: "/updates/*",
            FunctionAssociations: Match.absent(),
          }),
        ]),
      },
    });
    template.hasResourceProperties("Custom::CDKBucketDeployment", { Exclude: ["updates/*"] });
  });

  it("guards the machine channel's $connect with the device authorizer", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "WEBSOCKET" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", { AuthorizerType: "REQUEST", IdentitySource: ["route.request.header.Authorization"] });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "$connect", AuthorizationType: "CUSTOM" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "$default" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "$disconnect" });
  });

  it("keeps the bridge table through teardown, with TTL and point-in-time recovery", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: {
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
        TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      },
    });
  });

  it("exposes the account API the macOS app uses", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /api/me" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /api/machines" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "PUT /api/machines/{machine}" });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "DELETE /api/machines/{machine}" });
  });

  it("publishes the waitlist without enabling billing by default", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /api/waitlist" });
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route"));
    expect(routes.some(route => String(route.Properties.RouteKey).includes("/api/billing/"))).toBe(false);
  });

  it("retains bridge Lambda logs for 30 days", () => {
    template.resourcePropertiesCountIs("AWS::Logs::LogGroup", { RetentionInDays: 30 }, 4);
  });
});


