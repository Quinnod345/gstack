/**
 * The engine's env-value scan (GSTA-104): a credential already in the process
 * environment (*_KEY, *_TOKEN, *_SECRET, *_PASSWORD) is a HIGH finding wherever
 * its VALUE appears in the scanned text, whatever shape it has. During GSTA-96's
 * unattended /ship, a docs-audit child re-typed the launch assignments as
 * `export $(...)`; the substitution came back empty, the bare `export` printed
 * the whole environment, and three API key values sat in a tool output that any
 * later writer (PR body, receipt, report, Drive mirror) could have quoted. Every
 * writer scans through this engine, so the value itself is now what it refuses.
 */
import { describe, expect, test } from "bun:test";
import { credentialEnvValues, redactFindingSpans, scan } from "../lib/redact-engine";

// Fixture values live in plain constants: a credential-named assignment with an
// entropic literal on one line is exactly what the repo's own pregate secrets
// scan (env.kv) refuses in added lines.
const anthropicValue = "zq7Vm2pL9xR4tW8yB3nK6hJ1";
const ubicloudValue = "ubi-plain-looking-value-0042";
const ghValue = "f0a9c2e1d7b6";
const dbValue = "hunter2hunter2";

const env = {
  ANTHROPIC_API_KEY: anthropicValue,
  UBICLOUD_API_KEY: ubicloudValue,
  GH_TOKEN: ghValue,
  DB_PASSWORD: dbValue,
  SHORT_KEY: "abc",
  PLACEHOLDER_TOKEN: "your-token-here",
  HOME: "/home/user/with/enough/length",
  GSTACK_STATE_ROOT: "/home/user/.gstack",
  GSTACK_LAUNCH_FILE: "/home/user/.gstack/install-verdicts/a/b.env",
};

describe("env-value scan", () => {
  test("picks only credential-named variables with credential-sized, non-placeholder values", () => {
    const names = credentialEnvValues(env).map(e => e.name).sort();
    expect(names).toEqual(["ANTHROPIC_API_KEY", "DB_PASSWORD", "GH_TOKEN", "UBICLOUD_API_KEY"]);
  });

  test("a dumped environment line is HIGH by value, whatever the value's shape", () => {
    const text = [
      "Tool output:",
      `ANTHROPIC_API_KEY=${anthropicValue}`,
      "GSTACK_STATE_ROOT=/home/user/.gstack",
      `the cloud key is ${ubicloudValue} and nothing else`,
    ].join("\n");
    const result = scan(text, { processEnv: env });
    const envFindings = result.findings.filter(f => f.id === "env.value");
    expect(envFindings.map(f => [f.line, f.description])).toEqual([
      [2, "Value of the ANTHROPIC_API_KEY environment variable"],
      [4, "Value of the UBICLOUD_API_KEY environment variable"],
    ]);
    for (const f of envFindings) {
      expect(f.severity).toBe("HIGH");
      expect(f.category).toBe("secret");
      expect(f.preview).not.toContain(anthropicValue);
      expect(f.preview).not.toContain(ubicloudValue);
    }
    expect(result.counts.HIGH).toBeGreaterThanOrEqual(2);
  });

  test("a variable's path-shaped non-credential value and the launch file path are not findings", () => {
    const text = "GSTACK_STATE_ROOT=/home/user/.gstack GSTACK_LAUNCH_FILE=/home/user/.gstack/install-verdicts/a/b.env HOME=/home/user/with/enough/length";
    expect(scan(text, { processEnv: env }).findings.filter(f => f.id === "env.value")).toEqual([]);
  });

  test("the allowlist suppresses a value, and an empty environment scans nothing by value", () => {
    const text = `token ${ghValue} here`;
    expect(scan(text, { processEnv: env }).findings.map(f => f.id)).toContain("env.value");
    expect(scan(text, { processEnv: env, allowlist: [ghValue] }).findings.filter(f => f.id === "env.value")).toEqual([]);
    expect(scan(text, { processEnv: {} }).findings.filter(f => f.id === "env.value")).toEqual([]);
  });

  test("redactFindingSpans removes the value bytes for machine egress", () => {
    const text = `key=${anthropicValue}; password ${dbValue} twice: ${dbValue}`;
    const redacted = redactFindingSpans(text, { processEnv: env });
    expect(redacted).not.toBeNull();
    expect(redacted).not.toContain(anthropicValue);
    expect(redacted).not.toContain(dbValue);
    expect(redacted).toContain("<REDACTED-env.value>");
  });

  test("the default environment is process.env", () => {
    const name = "GSTA104_TEST_TOKEN";
    process.env[name] = "v4lue-only-this-test-knows";
    try {
      const found = scan("leaked: v4lue-only-this-test-knows").findings.find(f => f.id === "env.value");
      expect(found?.description).toBe(`Value of the ${name} environment variable`);
    } finally {
      delete process.env[name];
    }
  });
});
