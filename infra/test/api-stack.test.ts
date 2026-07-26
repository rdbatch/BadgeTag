import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { DataStack } from "../lib/data-stack";
import { AuthStack } from "../lib/auth-stack";
import { ApiStack } from "../lib/api-stack";

describe("ApiStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { environment: "test" } });
    const env = { account: "123456789012", region: "us-east-1" };

    // DataStack and AuthStack publish their identifiers to SSM under a path
    // derived from the "test" environment; ApiStack reads them back the
    // same way it would in a real, separately-deployed stack.
    new DataStack(app, "TestDataStack", {
      tags: { project: "badgetag", environment: "test" },
      env,
    });

    new AuthStack(app, "TestAuthStack", {
      tags: { project: "badgetag", environment: "test" },
      sesDomainName: "test.badgetag.me",
      passkeyRelyingPartyId: "test.badgetag.me",
      alertEmail: "ops@example.com",
      env,
    });

    const apiStack = new ApiStack(app, "TestApiStack", {
      tags: { project: "badgetag", environment: "test" },
      env,
      environment: "test",
    });

    template = Template.fromStack(apiStack);
  });

  describe("Lambda Function", () => {
    test("creates a Lambda with ARM64 and provided.al2023 runtime", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "badgetag-api-test",
        Architectures: ["arm64"],
        Runtime: "provided.al2023",
      });
    });

    test("has correct environment variables", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: {
            TABLE_NAME: Match.anyValue(),
            BUCKET_NAME: Match.anyValue(),
            IMAGE_BASE_URL: Match.anyValue(),
            USER_POOL_ID: Match.anyValue(),
            USER_POOL_CLIENT_ID: Match.anyValue(),
            SITE_URL: Match.anyValue(),
          },
        },
      });
    });

    test("defaults SITE_URL to empty when siteUrl prop is not set", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: Match.objectLike({
            SITE_URL: "",
          }),
        },
      });
    });

    test("uses an empty (root-relative) IMAGE_BASE_URL since images are served same-origin via FrontendStack", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: Match.objectLike({
            IMAGE_BASE_URL: "",
          }),
        },
      });
    });

    test("enables X-Ray active tracing (client<->server correlation is imperfect for HTTP APIs, but the trace at least begins here)", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "badgetag-api-test",
        TracingConfig: { Mode: "Active" },
      });
    });

    test("has DynamoDB read/write permissions", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                "dynamodb:BatchGetItem",
                "dynamodb:GetItem",
                "dynamodb:PutItem",
              ]),
              Effect: "Allow",
            }),
          ]),
        },
      });
    });

    test("has S3 read/write permissions", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                "s3:GetObject*",
                "s3:GetBucket*",
              ]),
              Effect: "Allow",
            }),
          ]),
        },
      });
    });
  });

  describe("HTTP API Gateway", () => {
    test("creates an HTTP API", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
        Name: "badgetag-api-test",
        ProtocolType: "HTTP",
      });
    });

    test("has no CORS configuration by default (same-origin via CloudFront)", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
        CorsConfiguration: Match.absent(),
      });
    });

    test("has default stage with throttling configured", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
        StageName: "$default",
        AutoDeploy: true,
        DefaultRouteSettings: Match.objectLike({
          ThrottlingRateLimit: 50,
          ThrottlingBurstLimit: 100,
        }),
      });
    });

    test("has GET /api/profile/me route", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "GET /api/profile/me",
      });
    });

    test("has GET /api/profile/{id} route", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "GET /api/profile/{id}",
      });
    });

    test("has PUT /api/profile route", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "PUT /api/profile",
      });
    });

    test("has DELETE /api/profile route", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "DELETE /api/profile",
      });
    });

    test("has POST /api/profile/image route", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "POST /api/profile/image",
      });
    });

    test("has GET /__og/profile/{id} route for crawler-facing OpenGraph HTML", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "GET /__og/profile/{id}",
      });
    });

    test("has GET /api/connections route", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "GET /api/connections",
      });
    });

    test("has POST /api/connections route", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "POST /api/connections",
      });
    });

    test("has DELETE /api/connections/{id} route", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "DELETE /api/connections/{id}",
      });
    });
  });

  describe("Observability", () => {
    test("does not create a CloudWatch dashboard (that lives in MonitoringStack)", () => {
      template.resourceCountIs("AWS::CloudWatch::Dashboard", 0);
    });

    test("publishes the API id, Lambda function name, and log group name to SSM for MonitoringStack to consume", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/badgetag/test/api/api-id",
      });
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/badgetag/test/api/function-name",
      });
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/badgetag/test/api/log-group-name",
      });
    });

    test("creates an alarm on Lambda errors, routed to the shared alerts topic", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "badgetag-api-test-lambda-errors",
        Namespace: "AWS/Lambda",
        MetricName: "Errors",
        Threshold: 5,
        AlarmActions: Match.anyValue(),
      });
    });

    test("creates an alarm on Lambda p99 duration, routed to the shared alerts topic", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "badgetag-api-test-lambda-p99-duration",
        Namespace: "AWS/Lambda",
        MetricName: "Duration",
        ExtendedStatistic: "p99",
        AlarmActions: Match.anyValue(),
      });
    });

    test("creates an alarm on API Gateway 5xx responses, routed to the shared alerts topic", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "badgetag-api-test-5xx",
        Namespace: "AWS/ApiGateway",
        AlarmActions: Match.anyValue(),
      });
    });

    test("creates an alarm on DynamoDB throttled requests, routed to the shared alerts topic", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "badgetag-api-test-dynamodb-throttles",
        Namespace: "AWS/DynamoDB",
        MetricName: "ThrottledRequests",
        AlarmActions: Match.anyValue(),
      });
    });

    test("every alarm this stack creates has a non-empty AlarmActions (none of the 4 alarms are silent)", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      for (const alarm of Object.values(alarms)) {
        expect((alarm as { Properties: { AlarmActions?: unknown[] } }).Properties.AlarmActions?.length).toBeGreaterThan(0);
      }
    });
  });

  describe("OG image bulk regeneration", () => {
    test("creates the og-regen Lambda with ARM64 and provided.al2023 runtime", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "badgetag-og-regen-test",
        Architectures: ["arm64"],
        Runtime: "provided.al2023",
        MemorySize: 512,
        Timeout: 300,
      });
    });

    test("creates exactly two Lambda functions (api + og-regen)", () => {
      template.resourceCountIs("AWS::Lambda::Function", 2);
    });

    test("creates the OG regen state machine", () => {
      template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
        StateMachineName: "badgetag-og-regen-test",
      });
    });

    // The rendered DefinitionString is an Fn::Join (it embeds Lambda ARN
    // references as non-string array entries), not a plain JSON string, so
    // Match.serializedJson can't parse it directly. Concatenating just the
    // literal (string) entries reconstructs the definition's own raw JSON
    // text verbatim (with ARN references dropped), which a plain substring
    // check can then assert against without hand-parsing the Fn::Join.
    function definitionText(): string {
      const machines = template.findResources("AWS::StepFunctions::StateMachine");
      const [machine] = Object.values(machines) as Array<{
        Properties: { DefinitionString: { "Fn::Join": [string, unknown[]] } };
      }>;
      const parts = machine.Properties.DefinitionString["Fn::Join"][1];
      return parts.filter((part): part is string => typeof part === "string").join("");
    }

    function definitionStringContains(...substrings: string[]) {
      const text = definitionText();
      for (const substring of substrings) {
        expect(text).toContain(substring);
      }
    }

    test("state machine's Map state caps concurrency at 20 and iterates the listed profile ids", () => {
      definitionStringContains(
        '"RegenerateAll"',
        '"Type":"Map"',
        '"MaxConcurrency":20',
        '"ItemsPath":"$.list.profile_ids"',
      );
    });

    test("state machine retries a failed regeneration before giving up on that profile", () => {
      definitionStringContains('"Retry"', '"MaxAttempts":2');
    });

    test("list step runs before the map over all profiles", () => {
      definitionStringContains('"StartAt":"ListProfiles"', '"Next":"RegenerateAll"');
    });
  });

  describe("siteUrl prop", () => {
    test("sets SITE_URL when siteUrl is provided", () => {
      const app = new cdk.App({ context: { environment: "test" } });
      const env = { account: "123456789012", region: "us-east-1" };

      new DataStack(app, "SiteUrlDataStack", {
        tags: { project: "badgetag", environment: "test" },
        env,
      });
      new AuthStack(app, "SiteUrlAuthStack", {
        tags: { project: "badgetag", environment: "test" },
        sesDomainName: "test.badgetag.me",
        passkeyRelyingPartyId: "test.badgetag.me",
        alertEmail: "ops@example.com",
        env,
      });
      const apiStack = new ApiStack(app, "SiteUrlApiStack", {
        tags: { project: "badgetag", environment: "test" },
        env,
        environment: "test",
        siteUrl: "https://badgetag.example.com",
      });

      Template.fromStack(apiStack).hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: Match.objectLike({
            SITE_URL: "https://badgetag.example.com",
          }),
        },
      });
    });
  });

  describe("SSM Parameters", () => {
    test("publishes API URL to SSM", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/badgetag/test/api/api-url",
        Type: "String",
      });
    });
  });

  describe("Outputs", () => {
    test("has an API URL output with no CloudFormation export (avoids hard cross-stack dependency)", () => {
      template.hasOutput("ApiUrl", { Export: Match.absent() });
    });
  });
});
