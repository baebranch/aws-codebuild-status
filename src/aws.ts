import { execFile } from "child_process";

/**
 * Thin wrapper around the locally installed AWS CLI for CodeBuild.
 *
 * All commands are executed with execFile and an explicit argument array
 * (no shell), so user/AWS supplied values such as region names or build IDs
 * are passed as discrete arguments and cannot be interpreted as shell syntax.
 */

export interface CodeBuildPhase {
  phaseType?: string;
  phaseStatus?: string;
}

export interface CodeBuildBuild {
  id: string;
  arn?: string;
  buildNumber?: number;
  projectName?: string;
  buildStatus?: string;
  startTime?: string;
  endTime?: string;
  currentPhase?: string;
  sourceVersion?: string;
  logs?: {
    deepLink?: string;
    groupName?: string;
    streamName?: string;
  };
}

export interface ListBuildsPage {
  ids: string[];
  nextToken?: string;
}

export class AwsCliError extends Error {
  constructor(message: string, public readonly stderr?: string) {
    super(message);
    this.name = "AwsCliError";
  }
}

export interface AwsOptions {
  region?: string;
  profile?: string;
}

const AWS_COMMAND = process.platform === "win32" ? "aws.exe" : "aws";

function runAws(args: string[], options: AwsOptions): Promise<string> {
  const fullArgs = [...args, "--output", "json"];
  if (options.region) {
    fullArgs.push("--region", options.region);
  }
  if (options.profile) {
    fullArgs.push("--profile", options.profile);
  }

  return new Promise((resolve, reject) => {
    execFile(
      AWS_COMMAND,
      fullArgs,
      {
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        // Force UTF-8 so the CLI (Python) doesn't fail with a 'charmap' codec
        // error on Windows when build data contains non-ASCII characters.
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const enoent = (error as NodeJS.ErrnoException).code === "ENOENT";
          if (enoent) {
            reject(
              new AwsCliError(
                "The AWS CLI ('aws') was not found on your PATH. Install it and ensure it is configured.",
                stderr
              )
            );
            return;
          }
          reject(
            new AwsCliError(
              stderr?.trim() || error.message || "AWS CLI command failed.",
              stderr
            )
          );
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/** Returns the default region configured for the AWS CLI, if any. */
export async function getDefaultRegion(options: AwsOptions): Promise<string | undefined> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const args = ["configure", "get", "region"];
      if (options.profile) {
        args.push("--profile", options.profile);
      }
      execFile(AWS_COMMAND, args, { windowsHide: true }, (error, stdout) => {
        // `configure get` exits non-zero when the value is unset; treat as empty.
        if (error && !stdout) {
          resolve("");
          return;
        }
        resolve(stdout);
      });
    });
    const region = out.trim();
    return region || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lists every CodeBuild project name in a region (following pagination),
 * sorted by name ascending.
 */
export async function listAllProjects(options: AwsOptions): Promise<string[]> {
  const projects: string[] = [];
  let nextToken: string | undefined;
  do {
    const args = [
      "codebuild",
      "list-projects",
      "--sort-by",
      "NAME",
      "--sort-order",
      "ASCENDING",
    ];
    if (nextToken) {
      args.push("--next-token", nextToken);
    }
    const stdout = await runAws(args, options);
    const parsed = JSON.parse(stdout || "{}");
    if (Array.isArray(parsed.projects)) {
      projects.push(...parsed.projects);
    }
    nextToken = parsed.nextToken || undefined;
  } while (nextToken);
  return projects;
}

/**
 * Lists build IDs for a single project, most recent first, one page at a time.
 * Uses the AWS CLI's client-side pagination (--max-items / --starting-token).
 */
export async function listBuildsForProject(
  options: AwsOptions,
  projectName: string,
  pageSize: number,
  startingToken?: string
): Promise<ListBuildsPage> {
  const args = [
    "codebuild",
    "list-builds-for-project",
    "--project-name",
    projectName,
    "--sort-order",
    "DESCENDING",
    "--max-items",
    String(pageSize),
  ];
  if (startingToken) {
    args.push("--starting-token", startingToken);
  }

  const stdout = await runAws(args, options);
  const parsed = JSON.parse(stdout || "{}");
  return {
    ids: Array.isArray(parsed.ids) ? parsed.ids : [],
    // The CLI injects NextToken for client-side pagination.
    nextToken: parsed.NextToken || parsed.nextToken || undefined,
  };
}

/** Fetches full build details for a set of build IDs (max 100 per call). */
export async function batchGetBuilds(
  options: AwsOptions,
  ids: string[]
): Promise<CodeBuildBuild[]> {
  if (ids.length === 0) {
    return [];
  }
  const args = ["codebuild", "batch-get-builds", "--ids", ...ids];
  const stdout = await runAws(args, options);
  const parsed = JSON.parse(stdout || "{}");
  const builds: CodeBuildBuild[] = Array.isArray(parsed.builds) ? parsed.builds : [];
  return builds;
}

export interface LogEvent {
  timestamp?: number;
  message?: string;
}

/**
 * Fetches CloudWatch log events for a build's log stream, paging forward until
 * no further events are returned or the cap is reached.
 */
export async function getLogEvents(
  options: AwsOptions,
  groupName: string,
  streamName: string,
  maxBatches = 20
): Promise<LogEvent[]> {
  const events: LogEvent[] = [];
  let nextToken: string | undefined;
  for (let i = 0; i < maxBatches; i++) {
    const args = [
      "logs",
      "get-log-events",
      "--log-group-name",
      groupName,
      "--log-stream-name",
      streamName,
      "--start-from-head",
      "--limit",
      "10000",
    ];
    if (nextToken) {
      args.push("--next-token", nextToken);
    }
    const stdout = await runAws(args, options);
    const parsed = JSON.parse(stdout || "{}");
    const batch: LogEvent[] = Array.isArray(parsed.events) ? parsed.events : [];
    events.push(...batch);
    // get-log-events returns the same token when the stream is exhausted.
    if (batch.length === 0 || !parsed.nextForwardToken || parsed.nextForwardToken === nextToken) {
      break;
    }
    nextToken = parsed.nextForwardToken;
  }
  return events;
}
