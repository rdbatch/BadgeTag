import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";
import { DataStack } from "../lib/data-stack";
import { AuthStack } from "../lib/auth-stack";
import { ApiStack } from "../lib/api-stack";
import { RumStack } from "../lib/rum-stack";
import { FrontendStack } from "../lib/frontend-stack";
import { MonitoringStack } from "../lib/monitoring-stack";

// Ensure frontend/dist exists for asset resolution during synth — same
// guard as frontend-stack.test.ts (this file's Jest process may run
// independently of that one).
const distPath = path.join(__dirname, "../../frontend/dist");
if (!fs.existsSync(distPath)) {
  fs.mkdirSync(distPath, { recursive: true });
  fs.writeFileSync(path.join(distPath, "index.html"), "<html></html>");
}

/**
 * MonitoringStack resolves every identifier it needs (function name, log
 * group, API id, table name, distribution id, RUM app monitor name) via SSM
 * from Data/Api/Frontend/Rum — all four must exist in the same App for
 * MonitoringStack to synth, same scaffolding as frontend-stack.test.ts.
 */
function synthMonitoringStack(app: cdk.App, id: string, env: cdk.Environment) {
  new DataStack(app, `${id}Data`, {
    tags: { project: "badgetag", environment: "test" },
    env,
  });
  const authStack = new AuthStack(app, `${id}Auth`, {
    tags: { project: "badgetag", environment: "test" },
    sesDomainName: "test.badgetag.me",
    passkeyRelyingPartyId: "test.badgetag.me",
    alertEmail: "ops@example.com",
    env,
  });
  const apiStack = new ApiStack(app, `${id}Api`, {
    tags: { project: "badgetag", environment: "test" },
    environment: "test",
    env,
  });
  apiStack.addDependency(authStack);
  const rumStack = new RumStack(app, `${id}Rum`, {
    tags: { project: "badgetag", environment: "test" },
    environment: "test",
    domainNames: ["test.badgetag.me"],
    env,
  });
  rumStack.addDependency(authStack);
  const frontendStack = new FrontendStack(app, `${id}Frontend`, {
    tags: { project: "badgetag", environment: "test" },
    environment: "test",
    env,
  });
  frontendStack.addDependency(apiStack);
  const stack = new MonitoringStack(app, id, {
    tags: { project: "badgetag", environment: "test" },
    environment: "test",
    alertEmail: "ops@example.com",
    env,
  });
  stack.addDependency(apiStack);
  stack.addDependency(rumStack);
  stack.addDependency(frontendStack);
  return stack;
}

describe("MonitoringStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { environment: "test" } });
    const env = { account: "123456789012", region: "us-east-1" };
    const stack = synthMonitoringStack(app, "TestMonitoringStack", env);
    template = Template.fromStack(stack);
  });

  test("creates exactly one dashboard, named badgetag-{environment}", () => {
    template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    template.hasResourceProperties("AWS::CloudWatch::Dashboard", {
      DashboardName: "badgetag-test",
    });
  });

  describe("RUM widgets", () => {
    // The dashboard body is a single Fn::Join'd JSON string (widget objects
    // embed CFN intrinsics as non-string entries), so — like ApiStack's
    // state-machine definition test — reconstruct the literal (string)
    // parts and substring-check rather than parsing it as JSON directly.
    function dashboardBodyText(): string {
      const dashboards = template.findResources("AWS::CloudWatch::Dashboard");
      const [dashboard] = Object.values(dashboards) as Array<{
        Properties: { DashboardBody: { "Fn::Join": [string, unknown[]] } };
      }>;
      const parts = dashboard.Properties.DashboardBody["Fn::Join"][1];
      return parts.filter((part): part is string => typeof part === "string").join("");
    }

    test("includes an AWS/RUM metric namespace (sessions/errors/vitals widgets)", () => {
      expect(dashboardBodyText()).toContain("AWS/RUM");
    });

    test("dimensions RUM metrics by application_name", () => {
      expect(dashboardBodyText()).toContain("application_name");
    });
  });

  test("does not create any new Fn::ImportValue cross-stack dependency (every identifier comes from SSM)", () => {
    const template_json = JSON.stringify(template.toJSON());
    expect(template_json).not.toContain("Fn::ImportValue");
  });

  describe("Cost budget", () => {
    test("creates a monthly cost budget defaulting to $25", () => {
      template.hasResourceProperties("AWS::Budgets::Budget", {
        Budget: Match.objectLike({
          BudgetType: "COST",
          TimeUnit: "MONTHLY",
          BudgetName: "badgetag-test-monthly-cost",
          BudgetLimit: { Amount: 25, Unit: "USD" },
        }),
      });
    });

    test("notifies alertEmail by direct email subscription, not SNS", () => {
      template.hasResourceProperties("AWS::Budgets::Budget", {
        NotificationsWithSubscribers: Match.arrayWith([
          Match.objectLike({
            Subscribers: Match.arrayWith([
              Match.objectLike({
                SubscriptionType: "EMAIL",
                Address: "ops@example.com",
              }),
            ]),
          }),
        ]),
      });
    });
  });
});
