import * as vscode from "vscode";
import { AwsOptions, getLogEvents } from "./aws";

export const LOGS_SCHEME = "codebuild-logs";

interface LogTarget {
  region: string;
  profile?: string;
  group: string;
  stream: string;
}

/**
 * Backs read-only `codebuild-logs:` documents by fetching CloudWatch log
 * events through the AWS CLI on demand. All parameters are encoded in the URI
 * query so VS Code can re-resolve the content (e.g. on reload).
 */
export class LogsContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = decodeTarget(uri);
    if (!target) {
      return "Unable to determine the log stream for this build.";
    }
    const options: AwsOptions = { region: target.region, profile: target.profile };
    try {
      const events = await getLogEvents(options, target.group, target.stream);
      if (events.length === 0) {
        return "(no log events found for this build)";
      }
      return events.map((e) => (e.message ?? "").replace(/\r?\n$/, "")).join("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Failed to load logs:\n\n${msg}`;
    }
  }
}

export function buildLogUri(
  title: string,
  target: LogTarget
): vscode.Uri {
  const query = new URLSearchParams({
    region: target.region,
    group: target.group,
    stream: target.stream,
  });
  if (target.profile) {
    query.set("profile", target.profile);
  }
  // Path drives the editor tab title; keep it readable and end with .log.
  const safe = title.replace(/[^\w.#-]+/g, "_");
  return vscode.Uri.parse(`${LOGS_SCHEME}:${safe}.log`).with({ query: query.toString() });
}

function decodeTarget(uri: vscode.Uri): LogTarget | undefined {
  const params = new URLSearchParams(uri.query);
  const region = params.get("region") ?? undefined;
  const group = params.get("group") ?? undefined;
  const stream = params.get("stream") ?? undefined;
  if (!region || !group || !stream) {
    return undefined;
  }
  return {
    region,
    group,
    stream,
    profile: params.get("profile") ?? undefined,
  };
}
