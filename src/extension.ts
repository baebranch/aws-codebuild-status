import * as vscode from "vscode";
import {
  BuildNode,
  CodeBuildTreeProvider,
  InstanceNode,
  LoadMoreNode,
  ProjectNode,
  RefreshableNode,
} from "./treeProvider";
import { listProfiles } from "./aws";
import { LOGS_SCHEME, LogsContentProvider, buildLogUri } from "./logsDocument";

const PENDING_BUILD_REFRESH_INTERVAL_MS = 90_000;

function currentProfile(): string {
  return vscode.workspace.getConfiguration("awsCodeBuild").get<string>("profile", "") || "";
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new CodeBuildTreeProvider();
  let refreshingPendingBuilds = false;
  const pendingBuildRefreshTimer = setInterval(async () => {
    if (refreshingPendingBuilds || !provider.hasPendingBuilds()) {
      return;
    }
    refreshingPendingBuilds = true;
    try {
      await provider.refreshPendingBuilds();
    } finally {
      refreshingPendingBuilds = false;
    }
  }, PENDING_BUILD_REFRESH_INTERVAL_MS);
  context.subscriptions.push(
    new vscode.Disposable(() => clearInterval(pendingBuildRefreshTimer))
  );

  const view = vscode.window.createTreeView("awsCodeBuild.buildsView", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  const updateProfileLabel = (): void => {
    const profile = currentProfile();
    view.description = profile ? `Profile: ${profile}` : "Profile: default";
  };
  updateProfileLabel();

  context.subscriptions.push(
    vscode.commands.registerCommand("awsCodeBuild.selectProfile", async () => {
      const profiles = await listProfiles();
      const current = currentProfile();
      const items: (vscode.QuickPickItem & { value: string })[] = [
        {
          label: "default",
          description: "Default profile / environment credentials",
          picked: !current,
          value: "",
        },
        ...profiles
          .filter((p) => p !== "default")
          .map((p) => ({ label: p, picked: p === current, value: p })),
      ];
      const choice = await vscode.window.showQuickPick(items, {
        title: "Select AWS Profile",
        placeHolder: current ? `Current: ${current}` : "Current: default",
      });
      if (!choice || choice.value === current) {
        return;
      }
      // Pin to the workspace when one is open; otherwise fall back to user settings.
      // The configuration change listener below refreshes the tree.
      const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
      await vscode.workspace
        .getConfiguration("awsCodeBuild")
        .update(
          "profile",
          choice.value,
          hasWorkspace
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global
        );
    }),
    vscode.commands.registerCommand("awsCodeBuild.copyInstanceId", async (node: InstanceNode) => {
      if (node?.instance?.id) {
        await vscode.env.clipboard.writeText(node.instance.id);
        vscode.window.setStatusBarMessage(`Copied ${node.instance.id}`, 3000);
      }
    }),
    vscode.commands.registerCommand(
      "awsCodeBuild.openInstanceInConsole",
      (node: InstanceNode) => {
        if (!node?.instance?.id) {
          return;
        }
        const region = encodeURIComponent(node.region);
        const id = encodeURIComponent(node.instance.id);
        vscode.env.openExternal(
          vscode.Uri.parse(
            `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${id}`
          )
        );
      }
    )
  );

  context.subscriptions.push(
    view.onDidExpandElement((event) => provider.setExpanded(event.element, true)),
    view.onDidCollapseElement((event) => provider.setExpanded(event.element, false))
  );

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
    vscode.commands.registerCommand(
      "awsCodeBuild.refreshItem",
      async (node: RefreshableNode) => {
        if (!node) {
          return;
        }
        try {
          await provider.refreshItem(node);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Unable to refresh item: ${message}`);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("awsCodeBuild.loadMore", (node: LoadMoreNode) => {
      if (node && node.kind === "loadMore") {
        return provider.loadMore(node.state);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("awsCodeBuild.startBuild", async (node: ProjectNode) => {
      if (!node || node.kind !== "project") {
        return;
      }

      const projectName = node.state.projectName;
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Starting CodeBuild project ${projectName}…`,
          },
          () => provider.startBuild(node)
        );
        vscode.window.showInformationMessage(`Started build for ${projectName}.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Unable to start build for ${projectName}: ${message}`);
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
        updateProfileLabel();
        provider.refresh(true);
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
