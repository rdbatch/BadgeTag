import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sns_subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

/**
 * Builds the predictable SSM parameter namespace for a given environment.
 * Consumer stacks (ApiStack, FrontendStack) compute the same paths from
 * just the environment name, so they never need a direct CDK construct
 * reference to AuthStack — decoupling them from AuthStack's CloudFormation
 * lifecycle (no `Fn::ImportValue`, no hard cross-stack delete/replace
 * dependency).
 */
export function authStackParamPaths(environment: string) {
  const base = `/badgetag/${environment}/auth`;
  return {
    userPoolId: `${base}/user-pool-id`,
    userPoolClientId: `${base}/user-pool-client-id`,
    alertsTopicArn: `${base}/alerts-topic-arn`,
  };
}

export interface AuthStackProps extends cdk.StackProps {
  /**
   * Domain to verify in SES and send auth emails from (e.g. "badgetag.me"
   * for prod, "dev.badgetag.me" for dev). Each environment uses its own
   * (sub)domain so sending reputation and bounce/complaint handling stay
   * isolated per environment.
   *
   * DNS for this domain must be manually managed (this project's domain is
   * hosted in Cloudflare, not Route 53). After deploying, find the required
   * DKIM CNAME records in the SES console (Identities → this domain → DKIM
   * tab) and add them to Cloudflare DNS as DNS-only (not proxied) records.
   */
  readonly sesDomainName: string;
  /**
   * Local part of the "from" address, e.g. "noreply" produces
   * "noreply@<sesDomainName>".
   *
   * @default "noreply"
   */
  readonly sesFromAddressLocalPart?: string;
  /**
   * The fully-qualified domain that WebAuthn/passkey providers must treat
   * as the relying party (RP) for this pool (e.g. "badgetag.me" for prod,
   * "dev.badgetag.me" for dev). Must be a registrable-domain match of the
   * actual origin the browser is on when navigator.credentials.create()/
   * get() run — a passkey registered under one RP ID cannot be used to
   * sign in from a different origin. This is the same custom domain
   * already used as this environment's public site origin (see the
   * `domainName` CDK context flag in infra/bin/app.ts), which is why it's
   * threaded in from there rather than hardcoded per-environment here like
   * sesDomainName is. Required (not optional): passkey support ships to
   * every environment in the same change, so there's no valid "auth stack
   * without a relying party ID" state.
   */
  readonly passkeyRelyingPartyId: string;
  /**
   * Email address to notify when SES reputation alarms fire (bounce rate ≥ 3%
   * or complaint rate ≥ 0.08%). Pass via CDK context key `alertEmail`.
   * Note: the SNS email subscription requires manual confirmation after deploy.
   */
  readonly alertEmail: string;
}

/**
 * AuthStack — Cognito User Pool with native passwordless email OTP authentication.
 *
 * Email OTPs are delivered via SES (not Cognito's built-in email sender),
 * which is verified per-environment against its own (sub)domain. This is
 * required for production: Cognito's built-in sender is hard-capped at 50
 * emails/day per user pool and offers no custom "from" domain, deliverability
 * controls, or bounce/complaint visibility — all of which matter for an
 * OTP-only login flow where every sign-in depends on the email arriving.
 *
 * The USER_AUTH flow allows users to authenticate with either an emailed
 * one-time code or a registered passkey (WebAuthn) — Cognito's
 * SELECT_CHALLENGE mechanism reports, per-account, which of these are
 * available before any credential is submitted (see
 * frontend/src/auth/service.ts), so a user with no registered passkey
 * never sees a passkey prompt. Passkeys are an additional first factor,
 * never a replacement for email OTP, and still involve no standard
 * passwords.
 *
 * New users are confirmed the standard Cognito way: `autoVerify: { email:
 * true }` makes SignUp send a real confirmation code to the address given,
 * and the account only becomes CONFIRMED/verified once that code is
 * submitted via ConfirmSignUp (see frontend/src/auth/service.ts). There is
 * deliberately no Pre Sign-up trigger that force-confirms/verifies users —
 * that would let anyone mark an arbitrary, unowned email address as
 * "verified" just by calling SignUp, without ever proving they can receive
 * mail there.
 */
export class AuthStack extends cdk.Stack {
  /** The Cognito User Pool */
  public readonly userPool: cognito.UserPool;

  /** The User Pool Client configured for USER_AUTH flow */
  public readonly userPoolClient: cognito.UserPoolClient;

  /** SES Configuration Set for reputation metrics, attached to Cognito sends */
  public readonly sesConfigurationSet: ses.ConfigurationSet;

  /**
   * Shared SNS topic for operational alarm notifications across every
   * stack (SES reputation, ApiStack's Lambda/API Gateway/DynamoDB alarms,
   * RumStack's client-side error alarm) — one topic, one subscription to
   * confirm, one inbox to watch.
   */
  public readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const environment =
      this.node.tryGetContext("environment") ?? "dev";

    // NOTE: The SES domain identity for `props.sesDomainName` is managed
    // manually outside this stack for now (the identities were created by
    // hand in the SES console, DKIM records added to Cloudflare DNS). Cognito
    // below references the verified domain by name (`sesVerifiedDomain`), not
    // by a CDK construct, so no in-stack SES resource is required. TODO: import
    // the existing `AWS::SES::EmailIdentity` back into this stack later.
    const fromAddress = `${props.sesFromAddressLocalPart ?? "noreply"}@${props.sesDomainName}`;

    // SES Configuration Set — enables per-environment reputation metrics for
    // Cognito's OTP/confirmation sends. Attaching this to Cognito's email
    // config (via configurationSetName below) tags every send so AWS/SES
    // Reputation.BounceRate and Reputation.ComplaintRate metrics reflect only
    // this environment's traffic, consistent with the per-env SES domain
    // isolation already in place.
    this.sesConfigurationSet = new ses.ConfigurationSet(this, "SesConfigSet", {
      configurationSetName: `badgetag-${environment}`,
      reputationMetrics: true,
    });

    // Shared SNS topic for every stack's operational alarms.
    // Note: email subscriptions require manual confirmation after first deploy —
    // check the inbox at the alertEmail address for the confirmation link.
    const alertEmail = props.alertEmail;
    this.alertsTopic = new sns.Topic(this, "AlertsTopic", {
      topicName: `badgetag-alerts-${environment}`,
    });
    this.alertsTopic.addSubscription(
      new sns_subs.EmailSubscription(alertEmail),
    );

    // CloudWatch alarms on account-level SES reputation metrics (no dimensions
    // — SES pauses the whole account if these cross enforcement thresholds).
    // Alarm before the enforcement line to give time to investigate:
    //   Bounce:    alarm at 3%  (SES review ~5%, enforcement varies)
    //   Complaint: alarm at 0.08% (SES enforcement 0.1%)
    const sesAlarmProps = {
      period: cdk.Duration.hours(1),
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    };

    const bounceAlarm = new cloudwatch.Alarm(this, "SesBounceRateAlarm", {
      alarmName: `badgetag-${environment}-ses-bounce-rate`,
      alarmDescription: "SES bounce rate ≥ 3% — investigate before SES pauses the account",
      metric: new cloudwatch.Metric({
        namespace: "AWS/SES",
        metricName: "Reputation.BounceRate",
        statistic: "Average",
        period: cdk.Duration.hours(1),
      }),
      threshold: 0.03,
      ...sesAlarmProps,
    });
    bounceAlarm.addAlarmAction(new cw_actions.SnsAction(this.alertsTopic));

    const complaintAlarm = new cloudwatch.Alarm(this, "SesComplaintRateAlarm", {
      alarmName: `badgetag-${environment}-ses-complaint-rate`,
      alarmDescription: "SES complaint rate ≥ 0.08% — investigate before SES pauses the account",
      metric: new cloudwatch.Metric({
        namespace: "AWS/SES",
        metricName: "Reputation.ComplaintRate",
        statistic: "Average",
        period: cdk.Duration.hours(1),
      }),
      threshold: 0.0008,
      ...sesAlarmProps,
    });
    complaintAlarm.addAlarmAction(new cw_actions.SnsAction(this.alertsTopic));

    // Cognito User Pool with native passwordless email OTP.
    // Choice-based authentication (email OTP as first factor) requires the
    // Essentials feature plan or higher.
    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `badgetag-users-${environment}`,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      signInPolicy: {
        allowedFirstAuthFactors: {
          password: true, // Cognito requires password auth to remain enabled
          emailOtp: true,
          passkey: true,
        },
      },
      // Passkey (WebAuthn) as an additional first-factor option, alongside
      // email OTP. The relying party ID must match the site's real origin
      // (see AuthStackProps.passkeyRelyingPartyId doc comment) — this is
      // why AuthStack now needs the deploy's domain name, unlike before.
      // No Lambda triggers, IAM, or new AWS resources are introduced —
      // Cognito manages passkey credential storage internally, same as it
      // already manages email OTP delivery state.
      passkeyRelyingPartyId: props.passkeyRelyingPartyId,
      // PREFERRED (not REQUIRED): user verification (biometric/PIN) is
      // requested from the authenticator but not hard-required, matching
      // how most consumer passkey flows behave (Face ID/Touch ID/Windows
      // Hello all satisfy PREFERRED; REQUIRED would reject authenticators
      // that can't enforce it, unnecessarily strict for this app's threat
      // model).
      passkeyUserVerification: cognito.PasskeyUserVerification.PREFERRED,
      passwordPolicy: {
        minLength: 8,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
      },
      // SES-backed email delivery — see the sesDomainName doc comment above
      // for why this replaced Cognito's built-in sender. configurationSetName
      // tags Cognito's sends with the per-environment config set so reputation
      // metrics (and future event destinations) track only this environment.
      email: cognito.UserPoolEmail.withSES({
        fromEmail: fromAddress,
        fromName: "BadgeTag",
        sesRegion: this.region,
        sesVerifiedDomain: props.sesDomainName,
        configurationSetName: this.sesConfigurationSet.configurationSetName,
      }),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // User Pool Client — USER_AUTH flow for passwordless
    // No new scopes needed for passkey APIs: aws.cognito.signin.user.admin
    // is granted by default and already covers StartWebAuthnRegistration/
    // CompleteWebAuthnRegistration/ListWebAuthnCredentials/
    // DeleteWebAuthnCredential.
    this.userPoolClient = this.userPool.addClient("AppClient", {
      userPoolClientName: `badgetag-app-client-${environment}`,
      authFlows: {
        user: true, // Enables USER_AUTH (choice-based, includes email OTP)
        userSrp: false,
        userPassword: false,
        custom: false,
      },
      // Explicit token lifetimes (Cognito defaults would otherwise be relied
      // on implicitly: 60 min ID/access, 60 day refresh). ID/access tokens
      // are short-lived; the refresh token allows the frontend to silently
      // renew them for up to 30 days without forcing re-authentication.
      idTokenValidity: cdk.Duration.minutes(60),
      accessTokenValidity: cdk.Duration.minutes(60),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // Publish identifiers to SSM Parameter Store instead of CloudFormation
    // stack exports — see `authStackParamPaths`. Avoids a CloudFormation
    // `Fn::ImportValue` hard dependency on this stack from ApiStack/
    // FrontendStack.
    const paramPaths = authStackParamPaths(environment);

    new ssm.StringParameter(this, "UserPoolIdParam", {
      parameterName: paramPaths.userPoolId,
      stringValue: this.userPool.userPoolId,
    });

    new ssm.StringParameter(this, "UserPoolClientIdParam", {
      parameterName: paramPaths.userPoolClientId,
      stringValue: this.userPoolClient.userPoolClientId,
    });

    new ssm.StringParameter(this, "AlertsTopicArnParam", {
      parameterName: paramPaths.alertsTopicArn,
      stringValue: this.alertsTopic.topicArn,
    });


    // Outputs retained for human visibility (console/CLI) only — no
    // exportName, so no other stack can create a CloudFormation import
    // dependency on them.
    new cdk.CfnOutput(this, "UserPoolId", {
      value: this.userPool.userPoolId,
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: this.userPoolClient.userPoolClientId,
    });

    new cdk.CfnOutput(this, "SesFromAddress", {
      value: fromAddress,
    });

    new cdk.CfnOutput(this, "SesConfigurationSetName", {
      value: this.sesConfigurationSet.configurationSetName,
    });

    new cdk.CfnOutput(this, "AlertsTopicArn", {
      value: this.alertsTopic.topicArn,
    });
  }
}
