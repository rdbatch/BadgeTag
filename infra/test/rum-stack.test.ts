import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AuthStack } from "../lib/auth-stack";
import { RumStack } from "../lib/rum-stack";

describe("RumStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { environment: "test" } });
    const env = { account: "123456789012", region: "us-east-1" };

    // RumStack's JS-error alarm reads AuthStack's shared alerts topic ARN
    // via SSM — instantiate it in the same App so that parameter exists,
    // same scaffolding as api-stack.test.ts.
    new AuthStack(app, "TestAuthStack", {
      tags: { project: "badgetag", environment: "test" },
      sesDomainName: "test.badgetag.me",
      passkeyRelyingPartyId: "test.badgetag.me",
      alertEmail: "ops@example.com",
      env,
    });

    const rumStack = new RumStack(app, "TestRumStack", {
      tags: { project: "badgetag", environment: "test" },
      env,
      environment: "test",
      domainNames: ["test.badgetag.me"],
    });

    template = Template.fromStack(rumStack);
  });

  describe("Identity Pool", () => {
    test("allows unauthenticated identities (the only path RUM ever uses)", () => {
      template.hasResourceProperties("AWS::Cognito::IdentityPool", {
        IdentityPoolName: "badgetag_rum_test",
        AllowUnauthenticatedIdentities: true,
      });
    });

    test("is not linked to any Cognito user pool provider (unrelated to sign-in)", () => {
      template.hasResourceProperties("AWS::Cognito::IdentityPool", {
        CognitoIdentityProviders: Match.absent(),
      });
    });

    test("leaves the classic flow off, so credentials come from the role attachment", () => {
      // Pairs with the frontend's "omits guestRoleArn" test: aws-rum-web
      // only uses the enhanced flow (GetCredentialsForIdentity) when the
      // browser has no guest role ARN. Enabling AllowClassicFlow here
      // would make the broken pairing silently work and mask a regression.
      template.hasResourceProperties("AWS::Cognito::IdentityPool", {
        AllowClassicFlow: Match.absent(),
      });
    });
  });

  describe("Guest IAM Role", () => {
    test("trust policy scopes the role to this identity pool and the unauthenticated path only", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "sts:AssumeRoleWithWebIdentity",
              Effect: "Allow",
              Principal: { Federated: "cognito-identity.amazonaws.com" },
              Condition: {
                StringEquals: {
                  "cognito-identity.amazonaws.com:aud": Match.anyValue(),
                },
                "ForAnyValue:StringLike": {
                  "cognito-identity.amazonaws.com:amr": "unauthenticated",
                },
              },
            }),
          ]),
        },
      });
    });

    test("is granted only rum:PutRumEvents, scoped to this one app monitor's ARN", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: [
            Match.objectLike({
              Action: "rum:PutRumEvents",
              Effect: "Allow",
              Resource: Match.objectLike({
                "Fn::Join": Match.arrayWith([
                  Match.arrayWith([Match.stringLikeRegexp(":rum:.*:appmonitor/badgetag-test$")]),
                ]),
              }),
            }),
          ],
        },
      });
    });
  });

  test("attaches the guest role as the identity pool's unauthenticated role", () => {
    template.hasResourceProperties("AWS::Cognito::IdentityPoolRoleAttachment", {
      Roles: { unauthenticated: Match.anyValue() },
    });
  });

  describe("App Monitor", () => {
    test("is cookieless (no privacy notice exists for this app yet)", () => {
      template.hasResourceProperties("AWS::RUM::AppMonitor", {
        Name: "badgetag-test",
        Domain: "test.badgetag.me",
        AppMonitorConfiguration: Match.objectLike({
          AllowCookies: false,
          EnableXRay: true,
          Telemetries: ["errors", "performance", "http"],
        }),
      });
    });

    test("uses domainList instead of domain when more than one domain is configured", () => {
      const app = new cdk.App({ context: { environment: "test" } });
      const env = { account: "123456789012", region: "us-east-1" };
      new AuthStack(app, "MultiDomainAuthStack", {
        tags: { project: "badgetag", environment: "test" },
        sesDomainName: "test.badgetag.me",
        passkeyRelyingPartyId: "badgetag.me",
        alertEmail: "ops@example.com",
        env,
      });
      const rumStack = new RumStack(app, "MultiDomainRumStack", {
        tags: { project: "badgetag", environment: "test" },
        env,
        environment: "test",
        domainNames: ["badgetag.me", "www.badgetag.me"],
      });

      Template.fromStack(rumStack).hasResourceProperties("AWS::RUM::AppMonitor", {
        Domain: Match.absent(),
        DomainList: ["badgetag.me", "www.badgetag.me"],
      });
    });

    test("defaults session sample rate to 1 (100%) when not overridden via context", () => {
      template.hasResourceProperties("AWS::RUM::AppMonitor", {
        AppMonitorConfiguration: Match.objectLike({
          SessionSampleRate: 1,
        }),
      });
    });

    test("keeps RUM events in CloudWatch Logs beyond the default 30-day retention", () => {
      template.hasResourceProperties("AWS::RUM::AppMonitor", {
        CwLogEnabled: true,
      });
    });
  });

  describe("JS Errors Alarm", () => {
    test("alarms on 10 or more client-side JS errors within 5 minutes", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "badgetag-rum-test-js-errors",
        Namespace: "AWS/RUM",
        MetricName: "JsErrorCount",
        Threshold: 10,
        AlarmActions: Match.anyValue(),
      });
    });
  });

  describe("SSM Parameters", () => {
    test("publishes app monitor id, app monitor name, identity pool id, and guest role ARN", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/badgetag/test/rum/app-monitor-id",
      });
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/badgetag/test/rum/app-monitor-name",
        Value: "badgetag-test",
      });
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/badgetag/test/rum/identity-pool-id",
      });
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/badgetag/test/rum/guest-role-arn",
      });
    });
  });

  describe("Outputs", () => {
    test("has an app monitor id output with no CloudFormation export (avoids hard cross-stack dependency)", () => {
      template.hasOutput("RumAppMonitorId", { Export: Match.absent() });
    });

    test("has an identity pool id output with no CloudFormation export", () => {
      template.hasOutput("RumIdentityPoolId", { Export: Match.absent() });
    });

    test("has a guest role ARN output with no CloudFormation export", () => {
      template.hasOutput("RumGuestRoleArn", { Export: Match.absent() });
    });
  });
});
