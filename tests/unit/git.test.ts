import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type EasyHostError, EXIT_CODES } from "../../src/cli/errors.js";
import {
  checkoutWorkspace,
  classifyGitFailure,
  fetchWorkspace,
  GIT_CHECKOUT_TIMEOUT_MS,
  GIT_CHILD_ENVIRONMENT,
  GIT_CLONE_TIMEOUT_MS,
  GIT_FAILURE_CODES,
  GIT_FETCH_TIMEOUT_MS,
  GIT_REV_PARSE_TIMEOUT_MS,
  type GitCommandOptions,
  type GitCommandResult,
  type GitRunner,
  prepareWorkspace,
  redactRepositoryUrl,
  WORKSPACE_DIRECTORY_NAME,
  workspacePath,
} from "../../src/platform/git.js";

const createdDirectories: string[] = [];

function makeTemporaryDirectory(prefix = "easy-host-git-"): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

function makeAppDir(name = "blog"): string {
  const appDir = path.join(makeTemporaryDirectory(), name);
  mkdirSync(appDir, { recursive: true });
  return appDir;
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface RecordedCall {
  command: string;
  args: string[];
  options: GitCommandOptions | undefined;
}

class RecordingRunner implements GitRunner {
  readonly calls: RecordedCall[] = [];
  readonly #results: GitCommandResult[];

  constructor(results: GitCommandResult[] = []) {
    this.#results = [...results];
  }

  run(command: string, args: readonly string[], options?: GitCommandOptions): GitCommandResult {
    this.calls.push({ command, args: [...args], options });

    const result = this.#results.shift();
    if (result === undefined) {
      throw new Error("the recording runner has no queued result");
    }

    return result;
  }
}

const explodingRunner: GitRunner = {
  run() {
    throw new Error("the runner must not be called");
  },
};

function ok(stdout = ""): GitCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr: string, exitCode = 128): GitCommandResult {
  return { exitCode, stdout: "", stderr };
}

async function capture(promise: Promise<unknown>): Promise<EasyHostError> {
  try {
    await promise;
  } catch (error) {
    return error as EasyHostError;
  }

  throw new Error("expected the promise to reject");
}

function expectGitEnvironment(options: GitCommandOptions | undefined): void {
  expect(options?.env).toMatchObject(GIT_CHILD_ENVIRONMENT);
}

const GIT_TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "easy-host tests",
  GIT_AUTHOR_EMAIL: "tests@easy-host.invalid",
  GIT_COMMITTER_NAME: "easy-host tests",
  GIT_COMMITTER_EMAIL: "tests@easy-host.invalid",
};

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: GIT_TEST_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

interface BareFixture {
  bare: string;
  mainCommit: string;
  featureCommit: string;
  tagCommit: string;
}

/**
 * Builds a source repository with two branches and a tag, then a bare clone of
 * it. The bare repository is the "remote" for the real-git tests.
 */
function makeBareRepository(): BareFixture {
  const root = makeTemporaryDirectory("easy-host-git-fixture-");
  const source = path.join(root, "source");
  mkdirSync(source);

  runGit(source, ["init", "-b", "main"]);
  writeFileSync(path.join(source, "index.html"), "main\n");
  runGit(source, ["add", "index.html"]);
  runGit(source, ["commit", "-m", "main"]);
  const mainCommit = runGit(source, ["rev-parse", "HEAD"]);
  runGit(source, ["tag", "v1.0.0"]);
  const tagCommit = mainCommit;

  runGit(source, ["checkout", "-b", "feature"]);
  writeFileSync(path.join(source, "index.html"), "feature\n");
  runGit(source, ["add", "index.html"]);
  runGit(source, ["commit", "-m", "feature"]);
  const featureCommit = runGit(source, ["rev-parse", "HEAD"]);
  runGit(source, ["checkout", "main"]);

  const bare = path.join(root, "origin.git");
  runGit(root, ["clone", "--bare", source, bare]);

  return { bare, mainCommit, featureCommit, tagCommit };
}

describe("workspacePath", () => {
  it("always derives <appDir>/workspace", () => {
    expect(workspacePath("/state/apps/blog")).toBe("/state/apps/blog/workspace");
    expect(workspacePath("/state/apps/blog/")).toBe("/state/apps/blog/workspace");
    expect(WORKSPACE_DIRECTORY_NAME).toBe("workspace");
  });
});

describe("redactRepositoryUrl", () => {
  it("replaces URL credentials and leaves the rest of the URL intact", () => {
    expect(redactRepositoryUrl("https://user:s3cret@example.com/org/repo.git")).toBe(
      "https://[redacted]@example.com/org/repo.git",
    );
    expect(redactRepositoryUrl("https://token@example.com/org/repo.git")).toBe(
      "https://[redacted]@example.com/org/repo.git",
    );
    expect(redactRepositoryUrl("git@github.com:org/repo.git")).toBe("git@github.com:org/repo.git");
  });
});

describe("classifyGitFailure", () => {
  it("distinguishes authentication, unknown ref, and missing repository text", () => {
    expect(classifyGitFailure("fatal: Authentication failed for 'https://host/repo.git/'")).toBe(
      "authentication",
    );
    expect(
      classifyGitFailure(
        "fatal: could not read Username for 'https://host': terminal prompts disabled",
      ),
    ).toBe("authentication");
    expect(
      classifyGitFailure("error: pathspec 'nope' did not match any file(s) known to git"),
    ).toBe("unknown-ref");
    expect(classifyGitFailure("fatal: couldn't find remote ref nope")).toBe("unknown-ref");
    expect(classifyGitFailure("fatal: repository 'https://host/repo.git/' not found")).toBe(
      "repository-not-found",
    );
    expect(classifyGitFailure("fatal: unable to write new index file")).toBe("unknown");
  });
});

describe("prepareWorkspace git mode", () => {
  it("clones and checks out a temporary bare repository at the default branch", async () => {
    const fixture = makeBareRepository();
    const appDir = makeAppDir();

    const prepared = await prepareWorkspace({
      app: "blog",
      appDir,
      repo: fixture.bare,
    });

    expect(prepared.mode).toBe("git");
    expect(prepared.devOnly).toBe(false);
    expect(prepared.cloned).toBe(true);
    expect(prepared.fetched).toBe(false);
    expect(prepared.workspace).toBe(path.join(appDir, "workspace"));
    expect(prepared.commit).toBe(fixture.mainCommit);
    expect(prepared.ref).toBe("main");
    expect(readFileSync(path.join(prepared.workspace, "index.html"), "utf8")).toBe("main\n");
  });

  it("checks out a non-default branch through its remote-tracking ref", async () => {
    const fixture = makeBareRepository();
    const appDir = makeAppDir();

    const prepared = await prepareWorkspace({
      app: "blog",
      appDir,
      repo: fixture.bare,
      ref: "feature",
    });

    expect(prepared.commit).toBe(fixture.featureCommit);
    expect(readFileSync(path.join(prepared.workspace, "index.html"), "utf8")).toBe("feature\n");
  });

  it("checks out a tag", async () => {
    const fixture = makeBareRepository();
    const appDir = makeAppDir();

    const prepared = await prepareWorkspace({
      app: "blog",
      appDir,
      repo: fixture.bare,
      ref: "v1.0.0",
    });

    expect(prepared.commit).toBe(fixture.tagCommit);
    expect(readFileSync(path.join(prepared.workspace, "index.html"), "utf8")).toBe("main\n");
  });

  it("reports an unknown ref for a real repository without leaving a checkout", async () => {
    const fixture = makeBareRepository();
    const appDir = makeAppDir();

    const error = await capture(
      prepareWorkspace({ app: "blog", appDir, repo: fixture.bare, ref: "does-not-exist" }),
    );

    expect(error.code).toBe(GIT_FAILURE_CODES.UNKNOWN_REF);
    expect(error.exitCode).toBe(EXIT_CODES.BUILD);
    expect(error.message).toContain('ref "does-not-exist" was not found');
  });

  it("reports a real missing repository with the missing-repository code", async () => {
    const appDir = makeAppDir();
    const missing = path.join(makeTemporaryDirectory(), "missing.git");

    const error = await capture(prepareWorkspace({ app: "blog", appDir, repo: missing }));

    expect(error.code).toBe(GIT_FAILURE_CODES.REPOSITORY_NOT_FOUND);
    expect(error.exitCode).toBe(EXIT_CODES.BUILD);
  });

  it("reuses an existing checkout by fetching before checkout", async () => {
    const appDir = makeAppDir();
    const workspace = workspacePath(appDir);
    mkdirSync(path.join(workspace, ".git"), { recursive: true });

    const runner = new RecordingRunner([ok(), ok("abc123\n"), ok()]);
    const prepared = await prepareWorkspace({
      app: "blog",
      appDir,
      repo: "/tmp/origin.git",
      runner,
    });

    expect(prepared.cloned).toBe(false);
    expect(prepared.fetched).toBe(true);
    expect(prepared.commit).toBe("abc123");
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["-C", workspace, "fetch", "--prune", "--tags", "origin"],
      ["-C", workspace, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"],
      ["-C", workspace, "checkout", "--detach", "abc123"],
    ]);
  });

  it("fetches a new upstream commit into an existing checkout", async () => {
    const fixture = makeBareRepository();
    const appDir = makeAppDir();

    const first = await prepareWorkspace({ app: "blog", appDir, repo: fixture.bare });
    expect(first.cloned).toBe(true);

    const work = path.join(makeTemporaryDirectory("easy-host-git-work-"), "work");
    runGit(path.dirname(work), ["clone", fixture.bare, work]);
    writeFileSync(path.join(work, "index.html"), "main v2\n");
    runGit(work, ["add", "index.html"]);
    runGit(work, ["commit", "-m", "second"]);
    runGit(work, ["push", "origin", "main"]);
    const secondCommit = runGit(work, ["rev-parse", "HEAD"]);

    const second = await prepareWorkspace({ app: "blog", appDir, repo: fixture.bare });

    expect(second.cloned).toBe(false);
    expect(second.fetched).toBe(true);
    expect(second.commit).toBe(secondCommit);
    expect(readFileSync(path.join(second.workspace, "index.html"), "utf8")).toBe("main v2\n");
  });

  it("refuses to clone over a populated non-checkout workspace", async () => {
    const appDir = makeAppDir();
    const workspace = workspacePath(appDir);
    mkdirSync(workspace);
    writeFileSync(path.join(workspace, "notes.txt"), "keep me\n");

    const error = await capture(
      prepareWorkspace({ app: "blog", appDir, repo: "/tmp/origin.git", runner: explodingRunner }),
    );

    expect(error.code).toBe(GIT_FAILURE_CODES.WORKSPACE_OCCUPIED);
    expect(error.exitCode).toBe(EXIT_CODES.CONFLICT);
    expect(existsSync(path.join(workspace, "notes.txt"))).toBe(true);
  });
});

describe("prepareWorkspace exact git invocations", () => {
  it("passes clone, ref resolution, and checkout as argument arrays with finite timeouts", async () => {
    const appDir = makeAppDir();
    const workspace = workspacePath(appDir);
    const repo = "https://example.com/org/repo.git";
    const runner = new RecordingRunner([ok(), ok("deadbeef\n"), ok()]);

    const prepared = await prepareWorkspace({ app: "blog", appDir, repo, runner });

    expect(prepared.commit).toBe("deadbeef");
    expect(runner.calls).toHaveLength(3);

    expect(runner.calls[0]?.command).toBe("git");
    expect(runner.calls[0]?.args).toEqual(["clone", "--no-checkout", "--", repo, workspace]);
    expect(runner.calls[0]?.options?.timeoutMs).toBe(GIT_CLONE_TIMEOUT_MS);
    expectGitEnvironment(runner.calls[0]?.options);

    expect(runner.calls[1]?.args).toEqual([
      "-C",
      workspace,
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/remotes/origin/main^{commit}",
    ]);
    expect(runner.calls[1]?.options?.timeoutMs).toBe(GIT_REV_PARSE_TIMEOUT_MS);

    expect(runner.calls[2]?.args).toEqual(["-C", workspace, "checkout", "--detach", "deadbeef"]);
    expect(runner.calls[2]?.options?.timeoutMs).toBe(GIT_CHECKOUT_TIMEOUT_MS);
    expectGitEnvironment(runner.calls[2]?.options);
  });

  it("falls back to the plain ref when no remote-tracking ref exists", async () => {
    const appDir = makeAppDir();
    const workspace = workspacePath(appDir);
    const runner = new RecordingRunner([
      ok(),
      fail("fatal: Needed a single revision", 1),
      ok("tagsha\n"),
      ok(),
    ]);

    const prepared = await prepareWorkspace({
      app: "blog",
      appDir,
      repo: "/tmp/origin.git",
      ref: "v2.0.0",
      runner,
    });

    expect(prepared.commit).toBe("tagsha");
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["clone", "--no-checkout", "--", "/tmp/origin.git", workspace],
      ["-C", workspace, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/v2.0.0^{commit}"],
      ["-C", workspace, "rev-parse", "--verify", "--quiet", "v2.0.0^{commit}"],
      ["-C", workspace, "checkout", "--detach", "tagsha"],
    ]);
  });

  it("never lets the repository value choose the clone destination", async () => {
    const appDir = makeAppDir();
    const runner = new RecordingRunner([ok(), ok("abc\n"), ok()]);

    await prepareWorkspace({
      app: "blog",
      appDir,
      repo: "https://example.com/../../evil.git",
      runner,
    });

    expect(runner.calls[0]?.args.at(-1)).toBe(workspacePath(appDir));
    expect(runner.calls[0]?.args.at(-1)).toBe(path.join(appDir, "workspace"));
  });
});

describe("git failure mapping", () => {
  it("distinguishes an unknown ref from an authentication failure and a missing repository", async () => {
    const unknownRefApp = makeAppDir();
    const unknownRef = await capture(
      prepareWorkspace({
        app: "blog",
        appDir: unknownRefApp,
        repo: "https://example.com/org/repo.git",
        ref: "nope",
        runner: new RecordingRunner([
          ok(),
          fail("fatal: Needed a single revision", 1),
          fail("fatal: Needed a single revision", 1),
        ]),
      }),
    );

    const authApp = makeAppDir();
    const auth = await capture(
      prepareWorkspace({
        app: "blog",
        appDir: authApp,
        repo: "https://example.com/org/repo.git",
        runner: new RecordingRunner([
          fail("fatal: Authentication failed for 'https://example.com/org/repo.git/'"),
        ]),
      }),
    );

    const missingApp = makeAppDir();
    const missing = await capture(
      prepareWorkspace({
        app: "blog",
        appDir: missingApp,
        repo: "https://example.com/org/repo.git",
        runner: new RecordingRunner([
          fail("fatal: repository 'https://example.com/org/repo.git/' not found"),
        ]),
      }),
    );

    expect(unknownRef.code).toBe(GIT_FAILURE_CODES.UNKNOWN_REF);
    expect(auth.code).toBe(GIT_FAILURE_CODES.AUTHENTICATION_FAILED);
    expect(missing.code).toBe(GIT_FAILURE_CODES.REPOSITORY_NOT_FOUND);
    expect(new Set([unknownRef.message, auth.message, missing.message]).size).toBe(3);
  });

  it("never leaks a credential embedded in the repository URL", async () => {
    const appDir = makeAppDir();
    const secret = "s3cret-token";
    const error = await capture(
      prepareWorkspace({
        app: "blog",
        appDir,
        repo: `https://deploy:${secret}@example.com/org/repo.git`,
        runner: new RecordingRunner([
          fail(
            `fatal: Authentication failed for 'https://deploy:${secret}@example.com/org/repo.git/'`,
          ),
        ]),
      }),
    );

    const rendered = `${error.message}\n${error.remediation ?? ""}\n${JSON.stringify(error.details)}`;

    expect(error.code).toBe(GIT_FAILURE_CODES.AUTHENTICATION_FAILED);
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("deploy:");
    expect(rendered).toContain("[redacted]");
  });

  it("redacts credentials from a generic clone failure reason", async () => {
    const appDir = makeAppDir();
    const secret = "another-secret";
    const error = await capture(
      prepareWorkspace({
        app: "blog",
        appDir,
        repo: `https://user:${secret}@example.com/org/repo.git`,
        runner: new RecordingRunner([
          fail(
            `fatal: unable to access 'https://user:${secret}@example.com/org/repo.git/': SSL error`,
          ),
        ]),
      }),
    );

    expect(error.code).toBe(GIT_FAILURE_CODES.CLONE_FAILED);
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
  });

  it("reports a missing git executable as a host prerequisite", async () => {
    const appDir = makeAppDir();
    const error = await capture(
      prepareWorkspace({
        app: "blog",
        appDir,
        repo: "https://example.com/org/repo.git",
        runner: new RecordingRunner([
          { exitCode: 127, stdout: "", stderr: "", spawnError: "ENOENT" },
        ]),
      }),
    );

    expect(error.code).toBe(GIT_FAILURE_CODES.UNAVAILABLE);
    expect(error.exitCode).toBe(EXIT_CODES.PREREQUISITE);
  });

  it("reports a spawn error that is not ENOENT as a clone failure", async () => {
    const appDir = makeAppDir();
    const error = await capture(
      prepareWorkspace({
        app: "blog",
        appDir,
        repo: "https://example.com/org/repo.git",
        runner: new RecordingRunner([
          { exitCode: 127, stdout: "", stderr: "", spawnError: "EAGAIN" },
        ]),
      }),
    );

    expect(error.code).toBe(GIT_FAILURE_CODES.CLONE_FAILED);
    expect(error.exitCode).toBe(EXIT_CODES.BUILD);
    expect(error.message).toContain("EAGAIN");
  });

  it("reports a timeout with the call's finite budget", async () => {
    const appDir = makeAppDir();
    const error = await capture(
      prepareWorkspace({
        app: "blog",
        appDir,
        repo: "https://example.com/org/repo.git",
        cloneTimeoutMs: 5_000,
        runner: new RecordingRunner([
          { exitCode: 1, stdout: "", stderr: "", spawnError: "ETIMEDOUT" },
        ]),
      }),
    );

    expect(error.code).toBe(GIT_FAILURE_CODES.CLONE_FAILED);
    expect(error.exitCode).toBe(EXIT_CODES.BUILD);
    expect(error.message).toContain("timed out after 5s");
    expect(error.details.timeoutMs).toBe(5_000);
  });

  it("does not disguise a ref-resolution timeout as an unknown ref", async () => {
    const appDir = makeAppDir();
    const error = await capture(
      prepareWorkspace({
        app: "blog",
        appDir,
        repo: "https://example.com/org/repo.git",
        runner: new RecordingRunner([
          ok(),
          { exitCode: 1, stdout: "", stderr: "", spawnError: "ETIMEDOUT" },
        ]),
      }),
    );

    expect(error.code).toBe(GIT_FAILURE_CODES.REVISION_FAILED);
    expect(error.exitCode).toBe(EXIT_CODES.BUILD);
    expect(error.message).toContain("timed out");
  });
});

describe("fetchWorkspace and checkoutWorkspace", () => {
  it("fetches with an argument array and a finite timeout", async () => {
    const appDir = makeAppDir();
    const workspace = workspacePath(appDir);
    mkdirSync(path.join(workspace, ".git"), { recursive: true });
    const runner = new RecordingRunner([ok()]);

    const result = await fetchWorkspace({ app: "blog", appDir, runner });

    expect(result.workspace).toBe(workspace);
    expect(runner.calls[0]?.args).toEqual([
      "-C",
      workspace,
      "fetch",
      "--prune",
      "--tags",
      "origin",
    ]);
    expect(runner.calls[0]?.options?.timeoutMs).toBe(GIT_FETCH_TIMEOUT_MS);
    expectGitEnvironment(runner.calls[0]?.options);
  });

  it("checks out the resolved commit and returns it", async () => {
    const appDir = makeAppDir();
    const workspace = workspacePath(appDir);
    mkdirSync(path.join(workspace, ".git"), { recursive: true });
    const runner = new RecordingRunner([ok("feedface\n"), ok()]);

    const result = await checkoutWorkspace({ app: "blog", appDir, ref: "main", runner });

    expect(result.commit).toBe("feedface");
    expect(result.ref).toBe("main");
    expect(runner.calls[1]?.args).toEqual(["-C", workspace, "checkout", "--detach", "feedface"]);
  });
});

describe("prepareWorkspace local mode", () => {
  it("returns the provided directory in place without copying it", async () => {
    const appDir = makeAppDir();
    const source = path.join(appDir, "src");
    mkdirSync(source);
    writeFileSync(path.join(source, "main.py"), "print('hello')\n");

    const prepared = await prepareWorkspace({
      app: "blog",
      appDir,
      localPath: "src",
      runner: explodingRunner,
    });

    expect(prepared.mode).toBe("local");
    expect(prepared.devOnly).toBe(true);
    expect(prepared.workspace).toBe(source);
    expect(prepared.repo).toBeUndefined();
    expect(prepared.ref).toBeUndefined();
    expect(prepared.commit).toBeUndefined();
    expect(prepared.cloned).toBe(false);
    expect(prepared.fetched).toBe(false);
    expect(existsSync(path.join(appDir, "workspace"))).toBe(false);
    expect(readFileSync(path.join(source, "main.py"), "utf8")).toBe("print('hello')\n");
  });

  it("rejects an absolute local path", async () => {
    const appDir = makeAppDir();
    const source = path.join(appDir, "src");
    mkdirSync(source);

    const error = await capture(
      prepareWorkspace({ app: "blog", appDir, localPath: source, runner: explodingRunner }),
    );

    expect(error.code).toBe(GIT_FAILURE_CODES.INVALID_LOCAL_PATH);
    expect(error.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("rejects a '..' segment", async () => {
    const appDir = makeAppDir();
    mkdirSync(path.join(path.dirname(appDir), "outside"));

    const error = await capture(
      prepareWorkspace({ app: "blog", appDir, localPath: "../outside", runner: explodingRunner }),
    );

    expect(error.code).toBe(GIT_FAILURE_CODES.INVALID_LOCAL_PATH);
  });

  it("reports a missing local directory as a usage error", async () => {
    const appDir = makeAppDir();

    const error = await capture(
      prepareWorkspace({ app: "blog", appDir, localPath: "absent", runner: explodingRunner }),
    );

    expect(error.code).toBe(GIT_FAILURE_CODES.LOCAL_PATH_NOT_FOUND);
    expect(error.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("reports a file as not a directory", async () => {
    const appDir = makeAppDir();
    writeFileSync(path.join(appDir, "file.txt"), "not a directory\n");

    const error = await capture(
      prepareWorkspace({ app: "blog", appDir, localPath: "file.txt", runner: explodingRunner }),
    );

    expect(error.code).toBe(GIT_FAILURE_CODES.LOCAL_PATH_NOT_DIRECTORY);
    expect(error.exitCode).toBe(EXIT_CODES.USAGE);
  });
});

describe("workspace source validation", () => {
  it("requires exactly one of repo and localPath", async () => {
    const appDir = makeAppDir();

    const neither = await capture(
      prepareWorkspace({ app: "blog", appDir, runner: explodingRunner }),
    );
    expect(neither.code).toBe(GIT_FAILURE_CODES.MISSING_WORKSPACE_SOURCE);
    expect(neither.exitCode).toBe(EXIT_CODES.USAGE);

    const both = await capture(
      prepareWorkspace({
        app: "blog",
        appDir,
        repo: "https://example.com/org/repo.git",
        localPath: "src",
        runner: explodingRunner,
      }),
    );
    expect(both.code).toBe(GIT_FAILURE_CODES.CONFLICTING_WORKSPACE_SOURCE);
    expect(both.exitCode).toBe(EXIT_CODES.USAGE);
  });

  it("rejects an invalid ref before any git call", async () => {
    const appDir = makeAppDir();

    for (const ref of ["bad ref", "-option", "a..b"]) {
      const error = await capture(
        prepareWorkspace({
          app: "blog",
          appDir,
          repo: "https://example.com/org/repo.git",
          ref,
          runner: explodingRunner,
        }),
      );

      expect(error.code).toBe(GIT_FAILURE_CODES.INVALID_REF);
      expect(error.exitCode).toBe(EXIT_CODES.USAGE);
    }
  });

  it("rejects an invalid repository before any git call", async () => {
    const appDir = makeAppDir();

    const error = await capture(
      prepareWorkspace({ app: "blog", appDir, repo: "-origin", runner: explodingRunner }),
    );

    expect(error.code).toBe(GIT_FAILURE_CODES.INVALID_REPOSITORY);
    expect(error.exitCode).toBe(EXIT_CODES.USAGE);
  });
});

describe("git failure codes", () => {
  it("keeps the documented codes distinct", () => {
    expect(new Set(Object.values(GIT_FAILURE_CODES)).size).toBe(
      Object.values(GIT_FAILURE_CODES).length,
    );
  });
});
