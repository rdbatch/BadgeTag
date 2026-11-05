import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Path to the repo-committed admin allowlist config (a
 * `{ [environment]: string[] }` map). Resolved relative to this compiled
 * module so it works both under ts-node (CDK synth) and plain node (tests).
 */
const CONFIG_PATH = path.join(__dirname, "..", "config", "admin-emails.json");

/**
 * Resolves the admin email allowlist for an environment.
 *
 * Precedence:
 *  1. An explicit `override` (from `--context adminEmails=a@x,b@y`), for
 *     ad-hoc or preview deploys that shouldn't edit the committed file.
 *  2. The `environment` key in `config/admin-emails.json`.
 *
 * Committing the list to a file — rather than threading a `--context`
 * flag through CI — means a deploy picks it up with no change to the
 * GitHub Actions workflow. A missing/unreadable config, an unknown
 * environment, or a non-array value all yield an empty list, so admin
 * access fails closed until the config names someone. The admin decision
 * is always re-made server-side against the verified JWT email; this list
 * only sets the Lambda's `ADMIN_EMAILS` env var.
 *
 * `configPath` is injectable for tests; production callers omit it.
 */
export function resolveAdminEmails(
  environment: string,
  override?: string,
  configPath: string = CONFIG_PATH,
): string[] {
  if (override) {
    return normalize(override.split(","));
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const forEnv = raw[environment];
    if (!Array.isArray(forEnv)) {
      return [];
    }
    return normalize(forEnv.filter((e): e is string => typeof e === "string"));
  } catch {
    return [];
  }
}

/** Trims each entry and drops blanks. */
function normalize(emails: string[]): string[] {
  return emails.map((email) => email.trim()).filter(Boolean);
}
