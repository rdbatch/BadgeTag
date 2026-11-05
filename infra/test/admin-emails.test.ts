import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAdminEmails } from "../lib/admin-emails";

/**
 * Writes a throwaway config file under a per-test temp dir and returns its
 * path. Registered for cleanup so nothing survives the run.
 */
function writeConfig(contents: string, cleanup: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-emails-"));
  cleanup.push(dir);
  const file = path.join(dir, "admin-emails.json");
  fs.writeFileSync(file, contents);
  return file;
}

describe("resolveAdminEmails", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
    }
  });

  it("reads the allowlist for the requested environment from the config file", () => {
    const configPath = writeConfig(
      JSON.stringify({ dev: ["ryan@rdbatch.dev"], prod: ["a@x.com", "b@y.com"] }),
      cleanup,
    );
    expect(resolveAdminEmails("dev", undefined, configPath)).toEqual(["ryan@rdbatch.dev"]);
    expect(resolveAdminEmails("prod", undefined, configPath)).toEqual(["a@x.com", "b@y.com"]);
  });

  it("returns an empty list for an environment absent from the config (fail closed)", () => {
    const configPath = writeConfig(JSON.stringify({ dev: ["ryan@rdbatch.dev"] }), cleanup);
    expect(resolveAdminEmails("staging", undefined, configPath)).toEqual([]);
  });

  it("returns an empty list when the config value is not an array", () => {
    const configPath = writeConfig(JSON.stringify({ dev: "ryan@rdbatch.dev" }), cleanup);
    expect(resolveAdminEmails("dev", undefined, configPath)).toEqual([]);
  });

  it("ignores non-string entries and trims/drops blanks", () => {
    const configPath = writeConfig(
      JSON.stringify({ dev: ["  ryan@rdbatch.dev  ", "", 42, "b@y.com"] }),
      cleanup,
    );
    expect(resolveAdminEmails("dev", undefined, configPath)).toEqual([
      "ryan@rdbatch.dev",
      "b@y.com",
    ]);
  });

  it("fails closed when the config file is missing or unreadable", () => {
    expect(resolveAdminEmails("dev", undefined, "/no/such/admin-emails.json")).toEqual([]);
  });

  it("a context override wins over the config file", () => {
    const configPath = writeConfig(JSON.stringify({ dev: ["ryan@rdbatch.dev"] }), cleanup);
    expect(resolveAdminEmails("dev", "override@x.com, second@y.com", configPath)).toEqual([
      "override@x.com",
      "second@y.com",
    ]);
  });

  it("the committed config names the real admin for dev and prod", () => {
    // Guards the actual shipped file — a broken/renamed key would silently
    // disable admin access on deploy.
    const committed = path.join(__dirname, "..", "config", "admin-emails.json");
    expect(resolveAdminEmails("dev", undefined, committed)).toContain("ryan@rdbatch.dev");
    expect(resolveAdminEmails("prod", undefined, committed)).toContain("ryan@rdbatch.dev");
  });
});
