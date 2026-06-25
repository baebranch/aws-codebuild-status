import * as vscode from "vscode";
import { BuildNode, CodeBuildTreeProvider, LoadMoreNode } from "./treeProvider";
import { LOGS_SCHEME, LogsContentProvider, buildLogUri } from "./logsDocument";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new CodeBuildTreeProvider();

  const view = vscode.window.createTreeView("awsCodeBuild.buildsView", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      LOGS_SCHEME,
      new LogsContentProvider()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("awsCodeBuild.refresh", () => provider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("awsCodeBuild.loadMore", (node: LoadMoreNode) => {
      if (node && node.kind === "loadMore") {
        return provider.loadMore(node.state);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("awsCodeBuild.openLogs", (node: BuildNode) =>
      openLogs(node)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("awsCodeBuild.openInConsole", (node: BuildNode) => {
      const target = node?.build?.logs?.deepLink ?? consoleUrl(node);
      if (target) {
        vscode.env.openExternal(vscode.Uri.parse(target));
      } else {
        vscode.window.showInformationMessage("No console link is available for this build.");
      }
    })
  );

  // Reload when relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("awsCodeBuild.regions") ||
        e.affectsConfiguration("awsCodeBuild.profile") ||
        e.affectsConfiguration("awsCodeBuild.pageSize")
      ) {
        provider.refresh();
      }
    })
  );
}

export function deactivate(): void {
  // no-op
}

/** Opens a build's CloudWatch logs in a read-only editor tab. */
async function openLogs(node: BuildNode): Promise<void> {
  const build = node?.build;
  const group = build?.logs?.groupName;
  const stream = build?.logs?.streamName;
  if (!group || !stream) {
    vscode.window.showInformationMessage(
      "This build has no CloudWatch log stream (it may not have started logging yet)."
    );
    return;
  }
  const profile =
    vscode.workspace.getConfiguration("awsCodeBuild").get<string>("profile", "") || undefined;
  const title =
    build.buildNumber !== undefined
      ? `${build.projectName ?? "build"}-${build.buildNumber}`
      : build.id;
  const uri = buildLogUri(title, {
    region: node.region,
    profile,
    group,
    stream,
  });

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Loading CodeBuild logs…" },
    async () => {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
      vscode.languages.setTextDocumentLanguage(doc, "log").then(undefined, () => {
        /* 'log' language may be unavailable; ignore. */
      });
    }
  );
}

/** Best-effort CodeBuild console URL when no deepLink is present. */
function consoleUrl(node: BuildNode): string | undefined {
  if (!node?.build?.id) {
    return undefined;
  }
  const region = node.region;
  const id = encodeURIComponent(node.build.id);
  const project = node.build.projectName
    ? encodeURIComponent(node.build.projectName)
    : undefined;
  if (!project) {
    return `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects?region=${region}`;
  }
  return `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects/${project}/build/${id}?region=${region}`;
}
