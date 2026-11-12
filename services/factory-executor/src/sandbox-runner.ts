import { Sandbox } from "@vercel/sandbox";

export type CheckName = "type-check" | "test" | "build" | "lint";
export interface RepositoryCheckRequest {
  repositoryFullName: string;
  commitSha: string;
  checks?: CheckName[];
  timeoutMs?: number;
}
export interface CheckResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  stdout: string;
  stderr: string;
}
export interface RepositoryCheckResult {
  sandboxId: string;
  repositoryFullName: string;
  commitSha: string;
  status: "passed" | "failed";
  checks: CheckResult[];
  startedAt: string;
  finishedAt: string;
}
interface CommandResult {
  exitCode: number;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}
interface SandboxHandle {
  runCommand(options: { cmd: string; args: string[]; cwd?: string }): Promise<CommandResult>;
  updateNetworkPolicy(policy: "deny-all"): Promise<void>;
  stop(): Promise<void>;
}
type SandboxCreate = (options: Record<string, unknown>) => Promise<SandboxHandle>;
const ROOT = "/vercel/sandbox";
const MAX_LOG_CHARS = 24_000;
const ALLOWED_CHECKS = new Set<CheckName>(["type-check", "test", "build", "lint"]);

function clip(value: string): string {
  return value.length > MAX_LOG_CHARS ? value.slice(0, MAX_LOG_CHARS) + "\n...[truncated]" : value;
}
function validateRequest(input: RepositoryCheckRequest): void {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repositoryFullName)) throw new Error("INVALID_REPOSITORY");
  if (!/^[a-f0-9]{40}$/i.test(input.commitSha)) throw new Error("INVALID_COMMIT_SHA");
  if (input.checks && (input.checks.length < 1 || input.checks.some(name => !ALLOWED_CHECKS.has(name)))) throw new Error("INVALID_CHECK_SET");
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 60_000 || input.timeoutMs > 1_200_000)) throw new Error("INVALID_TIMEOUT");
}

export class VercelSandboxRepositoryRunner {
  constructor(private readonly createSandbox: SandboxCreate = options => Sandbox.create(options as Parameters<typeof Sandbox.create>[0]) as Promise<unknown> as Promise<SandboxHandle>) {}

  async run(input: RepositoryCheckRequest): Promise<RepositoryCheckResult> {
    validateRequest(input);
    const startedAt = new Date().toISOString();
    const url = "https://github.com/" + input.repositoryFullName + ".git";
    const sandbox = await this.createSandbox({
      source: { type: "git", url, depth: 1, revision: input.commitSha },
      image: "vercel/sandbox/node:22",
      resources: { vcpus: 2 },
      timeout: input.timeoutMs ?? 600_000,
      persistent: false,
      networkPolicy: { allow: ["github.com", "codeload.github.com", "registry.npmjs.org"] },
    });
    const checks: CheckResult[] = [];
    let sandboxId = "ephemeral";
    try {
      const install = await sandbox.runCommand({ cmd: "npm", args: ["install", "--no-audit", "--no-fund"], cwd: ROOT });
      const installStdout = clip(await install.stdout());
      const installStderr = clip(await install.stderr());
      checks.push({ name: "dependency-install", status: install.exitCode === 0 ? "passed" : "failed", exitCode: install.exitCode, stdout: installStdout, stderr: installStderr });
      if (install.exitCode !== 0) {
        return { sandboxId, repositoryFullName: input.repositoryFullName, commitSha: input.commitSha, status: "failed", checks, startedAt, finishedAt: new Date().toISOString() };
      }

      // Remove all egress before executing repository scripts, which are untrusted.
      await sandbox.updateNetworkPolicy("deny-all");
      const packageFile = await sandbox.runCommand({ cmd: "node", args: ["-e", "const p=require('./package.json'); process.stdout.write(JSON.stringify(p.scripts||{}))"], cwd: ROOT });
      if (packageFile.exitCode !== 0) throw new Error("PACKAGE_SCRIPTS_READ_FAILED");
      const scripts = JSON.parse(await packageFile.stdout()) as Record<string, string>;
      const requested = input.checks ?? ["type-check", "test", "build"];
      for (const name of requested) {
        if (!scripts[name]) {
          checks.push({ name, status: "skipped", stdout: "", stderr: "No matching package.json script" });
          continue;
        }
        const result = await sandbox.runCommand({ cmd: "npm", args: ["run", name], cwd: ROOT });
        checks.push({
          name, status: result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode,
          stdout: clip(await result.stdout()), stderr: clip(await result.stderr()),
        });
        if (result.exitCode !== 0) break;
      }
      const failed = checks.some(check => check.status === "failed");
      return {
        sandboxId, repositoryFullName: input.repositoryFullName, commitSha: input.commitSha,
        status: failed ? "failed" : "passed", checks, startedAt, finishedAt: new Date().toISOString(),
      };
    } finally {
      await sandbox.stop();
    }
  }
}
