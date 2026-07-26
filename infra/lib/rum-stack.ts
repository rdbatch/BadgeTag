import * as cdk from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rum from "aws-cdk-lib/aws-rum";
import * as sns from "aws-cdk-lib/aws-sns";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { authStackParamPaths } from "./auth-stack";

/**
 * Builds the predictable SSM parameter namespace for a given environment.
 * MonitoringStack resolves `appMonitorName` from here to build its `AWS/RUM`
 * dashboard widgets, and the frontend build's config.json step reads the
 * CfnOutputs (not SSM) — see RumStackProps doc comment.
 */
export function rumStackParamPaths(environment: string) {
  const base = `/badgetag/${environment}/rum`;
  return {
    appMonitorId: `${base}/app-monitor-id`,
    appMonitorName: `${base}/app-monitor-name`,
    identityPoolId: `${base}/identity-pool-id`,
    guestRoleArn: `${base}/guest-role-arn`,
  };
}

export interface RumStackProps extends cdk.StackProps {
  readonly environment: string;
  /**
   * The site's public domain(s) (e.g. "dev.badgetag.me") — RUM only accepts
   * telemetry from pages served under a domain the app monitor is
   * authorized for. Same list as FrontendStack's `domainNames`.
   */
  readonly domainNames: string[];
  /**
   * Portion of user sessions to sample, 0 to 1. Pass via CDK context key
   * `rumSampleRate`.
   * @default 1
   */
  readonly sessionSampleRate?: number;
}

/**
 * RumStack — CloudWatch RUM client-side monitoring: an app monitor plus the
 * Cognito identity pool and guest IAM role it needs to authorize anonymous
 * browsers to call `rum:PutRumEvents`.
 *
 * This is a separate, early-deployed stack (alongside Data/Auth/Api/Waf)
 * rather than living in MonitoringStack, because of a hard pipeline
 * constraint: the app monitor ID and identity pool ID are AWS-generated
 * GUIDs the frontend needs at runtime, and the only channel to the browser
 * is `config.json` — written from `cdk-outputs.json` *before* the frontend
 * deploy, several steps before MonitoringStack (deployed last) even runs.
 * See docs-md/observability/rum.md.
 *
 * The identity pool created here is unrelated to AuthStack's User Pool — it
 * has no `cognitoIdentityProviders` and never authenticates a signed-in
 * user. It exists solely to vend short-lived, unauthenticated STS
 * credentials so an anonymous browser can sign its RUM telemetry calls.
 *
 * The dashboard widgets that visualize this stack's metrics still live in
 * MonitoringStack, resolving `appMonitorName` via SSM like every other
 * cross-stack identifier — only the resources themselves had to move early.
 */
export class RumStack extends cdk.Stack {
  public readonly appMonitor: rum.CfnAppMonitor;
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly guestRole: iam.Role;

  constructor(scope: Construct, id: string, props: RumStackProps) {
    super(scope, id, props);

    const environment = props.environment;
    const appMonitorName = `badgetag-${environment}`;
    const sessionSampleRate = props.sessionSampleRate ?? 1;

    // Anonymous-only credential source for RUM's data-plane calls. No
    // Cognito user-pool provider is attached — this pool never sees an
    // authenticated identity.
    this.identityPool = new cognito.CfnIdentityPool(this, "RumIdentityPool", {
      identityPoolName: `badgetag_rum_${environment}`,
      allowUnauthenticatedIdentities: true,
    });

    // The role RUM's vended credentials assume. Both trust conditions
    // matter: `aud` pins the role to this specific identity pool, and `amr`
    // pins it to the unauthenticated (guest) path only.
    this.guestRole = new iam.Role(this, "RumGuestRole", {
      roleName: `badgetag-rum-guest-${environment}`,
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: { "cognito-identity.amazonaws.com:aud": this.identityPool.ref },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "unauthenticated",
          },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
    });

    // Scoped to this one app monitor's ARN, built from the known name
    // string rather than `appMonitor.attrId` — the role must exist before
    // the app monitor (which references the role's ARN below), so
    // referencing the monitor's own attribute here would be a cycle. Same
    // technique DataStack uses for its CloudFront bucket policy.
    this.guestRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["rum:PutRumEvents"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:rum:${this.region}:${this.account}:appmonitor/${appMonitorName}`,
        ],
      }),
    );

    // Load-bearing, not just tidiness: the browser uses RUM's *enhanced*
    // credential flow (GetId → GetCredentialsForIdentity), which resolves
    // the guest role from this attachment. `allowClassicFlow` is
    // deliberately left off, so the classic flow's GetOpenIdToken →
    // sts:AssumeRoleWithWebIdentity path stays unavailable — which is also
    // why the frontend must not pass a guestRoleArn (see monitoring/rum.ts).
    new cognito.CfnIdentityPoolRoleAttachment(this, "RumRoleAttachment", {
      identityPoolId: this.identityPool.ref,
      roles: { unauthenticated: this.guestRole.roleArn },
    });

    const [domain, ...restDomains] = props.domainNames;
    this.appMonitor = new rum.CfnAppMonitor(this, "RumAppMonitor", {
      name: appMonitorName,
      domain: restDomains.length === 0 ? domain : undefined,
      domainList: restDomains.length === 0 ? undefined : props.domainNames,
      // Kept for >30-day retention and so MonitoringStack can query RUM
      // events via Logs Insights the same way it already does for the
      // backend's usage-counter lines.
      cwLogEnabled: true,
      appMonitorConfiguration: {
        // No privacy notice exists for this app today, so the session/user
        // cookies RUM would otherwise set are deliberately left off. A
        // session then only lasts for the current page load rather than
        // persisting across visits — acceptable at this stage.
        allowCookies: false,
        enableXRay: true,
        sessionSampleRate,
        telemetries: ["errors", "performance", "http"],
        identityPoolId: this.identityPool.ref,
        guestRoleArn: this.guestRole.roleArn,
      },
    });

    // Alarm on client-side JS errors, routed through the same shared alerts
    // topic AuthStack's SES alarms and ApiStack's alarms use.
    const alertsTopicArn = ssm.StringParameter.valueForStringParameter(
      this,
      authStackParamPaths(environment).alertsTopicArn,
    );
    const alertsTopic = sns.Topic.fromTopicArn(this, "AlertsTopic", alertsTopicArn);

    const jsErrors = new cloudwatch.Metric({
      namespace: "AWS/RUM",
      metricName: "JsErrorCount",
      dimensionsMap: { application_name: appMonitorName },
      statistic: "Sum",
      period: cdk.Duration.minutes(5),
    });

    new cloudwatch.Alarm(this, "RumJsErrorsAlarm", {
      alarmName: `badgetag-rum-${environment}-js-errors`,
      alarmDescription: "10 or more client-side JS errors within a 5-minute window",
      metric: jsErrors,
      threshold: 10,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    }).addAlarmAction(new cw_actions.SnsAction(alertsTopic));

    const paramPaths = rumStackParamPaths(environment);
    new ssm.StringParameter(this, "AppMonitorIdParam", {
      parameterName: paramPaths.appMonitorId,
      stringValue: this.appMonitor.attrId,
    });
    new ssm.StringParameter(this, "AppMonitorNameParam", {
      parameterName: paramPaths.appMonitorName,
      stringValue: appMonitorName,
    });
    new ssm.StringParameter(this, "IdentityPoolIdParam", {
      parameterName: paramPaths.identityPoolId,
      stringValue: this.identityPool.ref,
    });
    new ssm.StringParameter(this, "GuestRoleArnParam", {
      parameterName: paramPaths.guestRoleArn,
      stringValue: this.guestRole.roleArn,
    });

    // Outputs retained for human visibility and for the deploy pipeline's
    // `jq` step, which writes the app monitor and identity pool IDs into
    // frontend/dist/config.json. The guest role ARN is output for console
    // visibility only — the browser never receives it (see the role
    // attachment above). No exportName, so no other stack can create a
    // CloudFormation import dependency on them.
    new cdk.CfnOutput(this, "RumAppMonitorId", {
      value: this.appMonitor.attrId,
    });
    new cdk.CfnOutput(this, "RumIdentityPoolId", {
      value: this.identityPool.ref,
    });
    new cdk.CfnOutput(this, "RumGuestRoleArn", {
      value: this.guestRole.roleArn,
    });
  }
}
