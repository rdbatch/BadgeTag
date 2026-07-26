import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Construct } from "constructs";
import { dataStackParamPaths } from "./data-stack";
import { authStackParamPaths } from "./auth-stack";

/**
 * Builds the predictable SSM parameter namespace for a given environment.
 * FrontendStack computes the same path from just the environment name, so
 * it never needs a direct CDK construct/prop reference to ApiStack —
 * decoupling it from ApiStack's CloudFormation lifecycle (no
 * `Fn::ImportValue`, no hard cross-stack delete/replace dependency).
 */
export function apiStackParamPaths(environment: string) {
  const base = `/badgetag/${environment}/api`;
  return {
    apiUrl: `${base}/api-url`,
    apiId: `${base}/api-id`,
    functionName: `${base}/function-name`,
    logGroupName: `${base}/log-group-name`,
  };
}

export interface ApiStackProps extends cdk.StackProps {
  /**
   * Deployment environment (e.g. "dev", "staging", "prod"). Used to look up
   * DataStack's and AuthStack's published resource identifiers in SSM
   * Parameter Store (see `dataStackParamPaths` / `authStackParamPaths`),
   * avoiding direct CDK construct references (and the CloudFormation
   * `Fn::ImportValue` hard dependency that comes with them) on those stacks.
   */
  readonly environment: string;
  /**
   * Origins allowed to call this API directly (e.g. local dev against a
   * deployed API). In production the frontend calls /api/* same-origin
   * through CloudFront, which never triggers CORS, so this can be left
   * empty for prod deploys.
   */
  readonly allowedOrigins?: string[];
  /**
   * The app's public origin (e.g. "https://badgetag.me"), used only to
   * build absolute og:url/og:image values for the crawler-facing
   * /__og/profile/{id} route (see docs on that route in router.rs).
   * Leave unset until a custom domain is configured — the Lambda omits
   * those tags rather than emit invalid relative URLs.
   *
   * @default - no custom domain yet, og:url/og:image are omitted
   */
  readonly siteUrl?: string;
}

/**
 * ApiStack — Rust Lambda function behind an HTTP API Gateway for BadgeTag.
 */
export class ApiStack extends cdk.Stack {
  /** The HTTP API Gateway URL */
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const environment = props.environment;
    const paramPaths = dataStackParamPaths(environment);

    // Resolve DataStack's table/bucket via SSM (deploy-time CFN tokens, not
    // a synth-time lookup) and reconstruct full ITable/IBucket handles from
    // their ARNs. This preserves correct, minimal-privilege IAM grants via
    // grantReadWriteData/grantReadWrite below, without creating a
    // CloudFormation stack-export dependency on DataStack.
    const tableArn = ssm.StringParameter.valueForStringParameter(
      this,
      paramPaths.tableArn,
    );
    const imageBucketArn = ssm.StringParameter.valueForStringParameter(
      this,
      paramPaths.imageBucketArn,
    );

    const table = dynamodb.Table.fromTableArn(this, "ProfileTable", tableArn);
    const imageBucket = s3.Bucket.fromBucketArn(
      this,
      "ImageBucket",
      imageBucketArn,
    );

    // Resolve AuthStack's Cognito identifiers via SSM — same rationale as
    // the table/bucket lookups above.
    const authParamPaths = authStackParamPaths(environment);
    const userPoolId = ssm.StringParameter.valueForStringParameter(
      this,
      authParamPaths.userPoolId,
    );
    const userPoolClientId = ssm.StringParameter.valueForStringParameter(
      this,
      authParamPaths.userPoolClientId,
    );

    const apiFnLogGroup = new logs.LogGroup(this, "ApiFnLogGroup", {
      logGroupName: `/aws/lambda/badgetag-api-${environment}`,
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    // Rust Lambda function (ARM64 Graviton)
    const apiFn = new lambda.Function(this, "ApiFn", {
      functionName: `badgetag-api-${environment}`,
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: "bootstrap",
      code: lambda.Code.fromAsset("../backend/target/lambda/api"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: apiFnLogGroup,
      // API Gateway HTTP APIs (v2) don't support X-Ray at the gateway layer
      // (only REST APIs do), so the trace begins here at the Lambda rather
      // than at the edge — client<->server correlation instead relies on
      // the x-request-id response header (see api.rs).
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: imageBucket.bucketName,
        // Empty (site-root-relative) base — images are served same-origin
        // via the frontend's CloudFront distribution (an /images/*
        // behavior pointed at the image bucket). The S3 object key already
        // starts with "images/", so the resulting image_url is
        // "/images/<profile_id>". Using a relative path also avoids a
        // circular dependency between ApiStack and FrontendStack.
        IMAGE_BASE_URL: "",
        USER_POOL_ID: userPoolId,
        USER_POOL_CLIENT_ID: userPoolClientId,
        SITE_URL: props.siteUrl ?? "",
      },
    });

    // Grant Lambda permissions to DynamoDB and S3
    table.grantReadWriteData(apiFn);
    imageBucket.grantReadWrite(apiFn);

    // --- OG image bulk regeneration (manual, admin-only) ---
    //
    // Backfills/refreshes every profile's composite OG share image (see
    // og_image::generate) — e.g. once for profiles that predate the
    // composite feature, or again after a layout change to it. Not wired
    // to any schedule or event source; a human starts it on demand via
    // `aws stepfunctions start-execution` (see the state machine below).
    // Lives in ApiStack (rather than its own stack) since it just needs
    // the same table/bucket already resolved here.
    const ogRegenFnLogGroup = new logs.LogGroup(this, "OgRegenFnLogGroup", {
      logGroupName: `/aws/lambda/badgetag-og-regen-${environment}`,
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    const ogRegenFn = new lambda.Function(this, "OgRegenFn", {
      functionName: `badgetag-og-regen-${environment}`,
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: "bootstrap",
      code: lambda.Code.fromAsset("../backend/target/lambda/og-regen"),
      // Higher than the API Lambda: image generation is CPU-bound (more
      // memory proportionally grants more CPU), and "list" has to Scan the
      // whole table in one invocation — 5 minutes comfortably covers
      // realistic profile counts without reaching to a paginated/
      // self-continuing design prematurely.
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logGroup: ogRegenFnLogGroup,
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: imageBucket.bucketName,
        IMAGE_BASE_URL: "",
        SITE_URL: props.siteUrl ?? "",
      },
    });
    table.grantReadWriteData(ogRegenFn);
    imageBucket.grantReadWrite(ogRegenFn);

    const listProfiles = new tasks.LambdaInvoke(this, "ListProfiles", {
      lambdaFunction: ogRegenFn,
      payload: sfn.TaskInput.fromObject({ action: "list" }),
      payloadResponseOnly: true,
      resultPath: "$.list",
    });

    const regenerateOne = new tasks.LambdaInvoke(this, "RegenerateOne", {
      lambdaFunction: ogRegenFn,
      payload: sfn.TaskInput.fromObject({
        action: "regenerate",
        profile_id: sfn.JsonPath.stringAt("$.profile_id"),
        force: sfn.JsonPath.stringAt("$.force"),
      }),
      payloadResponseOnly: true,
    });
    // A profile that transiently fails (e.g. an S3/DynamoDB throttle)
    // shouldn't abort the whole run — retry a couple times before giving
    // up on just that one item.
    regenerateOne.addRetry({
      maxAttempts: 2,
      interval: cdk.Duration.seconds(2),
      backoffRate: 2,
    });

    const regenerateAll = new sfn.Map(this, "RegenerateAll", {
      itemsPath: "$.list.profile_ids",
      // Caps concurrent Lambda invocations (and therefore concurrent S3/
      // DynamoDB calls) rather than firing all profiles at once.
      maxConcurrency: 20,
      itemSelector: {
        "profile_id.$": "$$.Map.Item.Value",
        "force.$": "$.force",
      },
    });
    regenerateAll.itemProcessor(regenerateOne);

    // Execution input: `{ "force": false }` (default/backfill — skips
    // profiles that already have a composite) or `{ "force": true }`
    // (regenerate everyone, e.g. after a layout change).
    new sfn.StateMachine(this, "OgRegenStateMachine", {
      stateMachineName: `badgetag-og-regen-${environment}`,
      definitionBody: sfn.DefinitionBody.fromChainable(listProfiles.next(regenerateAll)),
      timeout: cdk.Duration.hours(2),
    });

    // HTTP API Gateway
    const integration = new HttpLambdaIntegration("ApiIntegration", apiFn);

    // CORS is only needed for direct (non-CloudFront) callers, e.g. local
    // dev hitting the deployed API from http://localhost. The production
    // frontend calls /api/* same-origin through CloudFront, which browsers
    // never treat as cross-origin. Default to no allowed origins so the API
    // is not callable cross-site unless explicitly configured.
    const allowedOrigins = props.allowedOrigins ?? [];

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `badgetag-api-${environment}`,
      corsPreflight:
        allowedOrigins.length > 0
          ? {
              allowOrigins: allowedOrigins,
              allowMethods: [
                apigwv2.CorsHttpMethod.GET,
                apigwv2.CorsHttpMethod.PUT,
                apigwv2.CorsHttpMethod.POST,
                apigwv2.CorsHttpMethod.DELETE,
                apigwv2.CorsHttpMethod.OPTIONS,
              ],
              allowHeaders: ["Content-Type", "Authorization"],
            }
          : undefined,
      // We create the default ($default) stage ourselves below so we can
      // attach throttle settings — HttpApiProps has no direct throttle knob.
      createDefaultStage: false,
    });

    // Basic throttling to blunt scripted abuse. Tune based on real traffic;
    // API Gateway's account-level default is 10,000 rps/5,000 burst, so this
    // is intentionally much lower for a low-traffic app.
    new apigwv2.HttpStage(this, "DefaultStage", {
      httpApi,
      stageName: "$default",
      autoDeploy: true,
      throttle: {
        rateLimit: 50,
        burstLimit: 100,
      },
    });

    // Routes
    // NOTE: HTTP API route matching prioritizes more specific (literal)
    // path segments over parameterized ones automatically, so
    // /api/profile/me is correctly matched ahead of /api/profile/{id}
    // regardless of declaration order — but it's declared first here for
    // readability, to mirror the Lambda-side router's match-arm order.
    httpApi.addRoutes({
      path: "/api/profile/me",
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });

    httpApi.addRoutes({
      path: "/api/profile/{id}",
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });

    httpApi.addRoutes({
      path: "/api/profile",
      methods: [apigwv2.HttpMethod.PUT],
      integration,
    });

    httpApi.addRoutes({
      path: "/api/profile",
      methods: [apigwv2.HttpMethod.DELETE],
      integration,
    });

    httpApi.addRoutes({
      path: "/api/profile/image",
      methods: [apigwv2.HttpMethod.POST],
      integration,
    });

    httpApi.addRoutes({
      path: "/api/profile/slug",
      methods: [apigwv2.HttpMethod.PUT],
      integration,
    });

    httpApi.addRoutes({
      path: "/api/connections",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
    });

    httpApi.addRoutes({
      path: "/api/connections/{id}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration,
    });

    // Crawler-facing OpenGraph HTML — routed here by a CloudFront Function
    // that 302-redirects /p/{id} requests from known social-media crawler
    // User-Agents (see FrontendStack). Not under /api/* since it returns
    // HTML, not JSON, and is reached via that redirect rather than the app
    // calling it directly.
    httpApi.addRoutes({
      path: "/__og/profile/{id}",
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });

    this.apiUrl = httpApi.apiEndpoint;

    // --- Observability ---
    //
    // Alarms for the failure modes that actually matter at this app's
    // scale (Lambda errors/latency, API Gateway 5xx, DynamoDB throttling).
    // The dashboard itself lives in MonitoringStack, not here — it combines
    // these metrics with FrontendStack's CloudFront metrics, and neither
    // stack can reference the other directly without a deploy-order cycle
    // (see MonitoringStack's doc comment). MonitoringStack resolves the
    // identifiers it needs (function name, log group, API id) via the SSM
    // params published at the bottom of this constructor.

    // Shared alerts topic (AuthStack owns it, alongside its own SES
    // alarms) — every alarm below routes through it so there's one inbox
    // and one subscription to confirm per environment.
    const alertsTopicArn = ssm.StringParameter.valueForStringParameter(
      this,
      authParamPaths.alertsTopicArn,
    );
    const alertsTopic = sns.Topic.fromTopicArn(this, "AlertsTopic", alertsTopicArn);

    const lambdaErrors = apiFn.metric("Errors", {
      statistic: "Sum",
      period: cdk.Duration.minutes(5),
    });
    const lambdaInvocations = apiFn.metricInvocations({ period: cdk.Duration.minutes(5) });
    const lambdaDurationP50 = apiFn.metricDuration({
      statistic: "p50",
      period: cdk.Duration.minutes(5),
    });
    const lambdaDurationP99 = apiFn.metricDuration({
      statistic: "p99",
      period: cdk.Duration.minutes(5),
    });
    // The imported `table` handle (via fromTableArn) only exposes ARN/name
    // and grant methods, not the concrete Table class's metric* helpers —
    // build this one directly from the well-known AWS/DynamoDB namespace.
    const dynamoThrottledRequests = new cloudwatch.Metric({
      namespace: "AWS/DynamoDB",
      metricName: "ThrottledRequests",
      dimensionsMap: { TableName: table.tableName },
      statistic: "Sum",
      period: cdk.Duration.minutes(5),
    });

    new cloudwatch.Alarm(this, "LambdaErrorsAlarm", {
      alarmName: `badgetag-api-${environment}-lambda-errors`,
      alarmDescription: "5 or more Lambda errors within a 5-minute window",
      metric: lambdaErrors,
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    }).addAlarmAction(new cw_actions.SnsAction(alertsTopic));

    new cloudwatch.Alarm(this, "LambdaDurationAlarm", {
      alarmName: `badgetag-api-${environment}-lambda-p99-duration`,
      alarmDescription: "p99 Lambda duration at or above 10s for two consecutive 5-minute periods",
      metric: lambdaDurationP99,
      threshold: cdk.Duration.seconds(10).toMilliseconds(),
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    }).addAlarmAction(new cw_actions.SnsAction(alertsTopic));

    new cloudwatch.Alarm(this, "ApiGateway5xxAlarm", {
      alarmName: `badgetag-api-${environment}-5xx`,
      alarmDescription: "5 or more API Gateway 5xx responses within a 5-minute window",
      metric: httpApi.metricServerError({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    }).addAlarmAction(new cw_actions.SnsAction(alertsTopic));

    new cloudwatch.Alarm(this, "DynamoThrottleAlarm", {
      alarmName: `badgetag-api-${environment}-dynamodb-throttles`,
      alarmDescription: "Any DynamoDB throttled requests within a 5-minute window",
      metric: dynamoThrottledRequests,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    }).addAlarmAction(new cw_actions.SnsAction(alertsTopic));

    // Publish identifiers to SSM instead of CloudFormation stack exports —
    // see `apiStackParamPaths`. Avoids a CloudFormation `Fn::ImportValue`
    // hard dependency on this stack from FrontendStack/MonitoringStack.
    new ssm.StringParameter(this, "ApiUrlParam", {
      parameterName: apiStackParamPaths(environment).apiUrl,
      stringValue: this.apiUrl,
    });

    new ssm.StringParameter(this, "ApiIdParam", {
      parameterName: apiStackParamPaths(environment).apiId,
      stringValue: httpApi.apiId,
    });

    new ssm.StringParameter(this, "FunctionNameParam", {
      parameterName: apiStackParamPaths(environment).functionName,
      stringValue: apiFn.functionName,
    });

    new ssm.StringParameter(this, "LogGroupNameParam", {
      parameterName: apiStackParamPaths(environment).logGroupName,
      stringValue: apiFnLogGroup.logGroupName,
    });

    // Output retained for human visibility (console/CLI) only — no
    // exportName, so no other stack can create a CloudFormation import
    // dependency on it.
    new cdk.CfnOutput(this, "ApiUrl", {
      value: httpApi.apiEndpoint,
    });
  }
}
