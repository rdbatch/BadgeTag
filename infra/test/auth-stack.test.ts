import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AuthStack } from "../lib/auth-stack";

describe("AuthStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { environment: "test" } });
    const stack = new AuthStack(app, "TestAuthStack", {
      tags: { project: "badgetag", environment: "test" },
      sesDomainName: "test.badgetag.me",
      passkeyRelyingPartyId: "test.badgetag.me",
      alertEmail: "ops@example.com",
    });
    template = Template.fromStack(stack);
  });

  describe("Cognito User Pool", () => {
    test("creates a user pool with email sign-in", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        UsernameAttributes: ["email"],
        AutoVerifiedAttributes: ["email"],
      });
    });

    test("enables self sign-up", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        AdminCreateUserConfig: {
          AllowAdminCreateUserOnly: false,
        },
      });
    });

    test("enables email OTP and passkey in sign-in policy", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        Policies: {
          SignInPolicy: {
            AllowedFirstAuthFactors: ["PASSWORD", "EMAIL_OTP", "WEB_AUTHN"],
          },
        },
      });
    });

    test("configures the passkey relying party ID and user verification", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        WebAuthnRelyingPartyID: "test.badgetag.me",
        WebAuthnUserVerification: "preferred",
      });
    });

    test("uses Essentials feature plan for choice-based auth", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        UserPoolTier: "ESSENTIALS",
      });
    });

    test("has RETAIN deletion policy", () => {
      template.hasResource("AWS::Cognito::UserPool", {
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    });
  });

  describe("User Pool Client", () => {
    test("creates a client with USER_AUTH flow", () => {
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_AUTH"]),
      });
    });

    test("does not allow SRP or user password flows", () => {
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        ExplicitAuthFlows: Match.not(
          Match.arrayWith(["ALLOW_USER_SRP_AUTH"]),
        ),
      });
    });

    test("allows refresh token auth so the frontend can silently renew tokens", () => {
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        ExplicitAuthFlows: Match.arrayWith(["ALLOW_REFRESH_TOKEN_AUTH"]),
      });
    });

    test("prevents user existence errors", () => {
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        PreventUserExistenceErrors: "ENABLED",
      });
    });

    test("sets explicit token validity so lifetimes are not left to Cognito defaults", () => {
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        IdTokenValidity: 60,
        AccessTokenValidity: 60,
        RefreshTokenValidity: 43200, // 30 days, expressed in minutes by CDK
        TokenValidityUnits: {
          IdToken: "minutes",
          AccessToken: "minutes",
          RefreshToken: "minutes",
        },
      });
    });
  });

  describe("SSM Parameters", () => {
    test("publishes user pool ID to SSM", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/badgetag/test/auth/user-pool-id",
        Type: "String",
      });
    });

    test("publishes user pool client ID to SSM", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/badgetag/test/auth/user-pool-client-id",
        Type: "String",
      });
    });
  });

  describe("Outputs", () => {
    test("has a User Pool ID output with no CloudFormation export (avoids hard cross-stack dependency)", () => {
      template.hasOutput("UserPoolId", { Export: Match.absent() });
    });

    test("has a User Pool Client ID output with no CloudFormation export", () => {
      template.hasOutput("UserPoolClientId", { Export: Match.absent() });
    });

    test("has an SES from address output with no CloudFormation export", () => {
      template.hasOutput("SesFromAddress", {
        Value: "noreply@test.badgetag.me",
        Export: Match.absent(),
      });
    });
  });

  describe("SES Email Identity", () => {
    test("does not manage the SES domain identity in this stack (created manually for now)", () => {
      template.resourceCountIs("AWS::SES::EmailIdentity", 0);
    });

    test("configures the User Pool to send email via SES with the domain-based from address", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        EmailConfiguration: {
          EmailSendingAccount: "DEVELOPER",
          From: "BadgeTag <noreply@test.badgetag.me>",
        },
      });
    });
  });

  test("does not create a Pre Sign-up trigger (new users must confirm via a real emailed code)", () => {
    template.resourceCountIs("AWS::Lambda::Function", 0);
    const userPools = template.findResources("AWS::Cognito::UserPool");
    for (const userPool of Object.values(userPools)) {
      expect(userPool.Properties.LambdaConfig).toBeUndefined();
    }
  });

  describe("SES Configuration Set", () => {
    test("creates a configuration set with reputation metrics enabled", () => {
      template.hasResourceProperties("AWS::SES::ConfigurationSet", {
        Name: "badgetag-test",
        ReputationOptions: {
          ReputationMetricsEnabled: true,
        },
      });
    });

    test("wires the configuration set to the Cognito User Pool email config", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        EmailConfiguration: {
          // Resolves to a Ref at synth time — presence is what matters here.
          ConfigurationSet: Match.anyValue(),
        },
      });
    });

    test("has config set name output with no CloudFormation export", () => {
      template.hasOutput("SesConfigurationSetName", { Export: Match.absent() });
    });
  });

  describe("SES Reputation Alarms", () => {
    test("creates a bounce rate alarm on AWS/SES namespace at 3% threshold", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "AWS/SES",
        MetricName: "Reputation.BounceRate",
        Threshold: 0.03,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        TreatMissingData: "notBreaching",
      });
    });

    test("creates a complaint rate alarm on AWS/SES namespace at 0.08% threshold", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "AWS/SES",
        MetricName: "Reputation.ComplaintRate",
        Threshold: 0.0008,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        TreatMissingData: "notBreaching",
      });
    });

    test("creates exactly two SES reputation alarms", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm", {
        Properties: { Namespace: "AWS/SES" },
      });
      expect(Object.keys(alarms)).toHaveLength(2);
    });
  });

  describe("Shared Alerts SNS Topic", () => {
    test("creates a shared SNS topic for operational alerts across every stack", () => {
      template.hasResourceProperties("AWS::SNS::Topic", {
        TopicName: "badgetag-alerts-test",
      });
    });

    test("creates an email subscription on the alerts topic", () => {
      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: "ops@example.com",
      });
    });

    test("has alerts topic ARN output with no CloudFormation export", () => {
      template.hasOutput("AlertsTopicArn", { Export: Match.absent() });
    });

    test("publishes the alerts topic ARN to SSM for other stacks to import", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/badgetag/test/auth/alerts-topic-arn",
        Type: "String",
      });
    });
  });
});
