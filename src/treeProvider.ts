import * as vscode from "vscode";
import {
  AwsCliError,
  AwsOptions,
  CodeBuildBuild,
  batchGetBuilds,
  getDefaultRegion,
  listAllProjects,
  listBuildsForProject,
} from "./aws";

type TreeNode = RegionNode | ProjectNode | BuildNode | LoadMoreNode | MessageNode;

const RUNNING_STATUS = "IN_PROGRESS";

/** Per-project paging state held in memory. */
class ProjectState {
  builds: CodeBuildBuild[] = [];
  nextToken: string | undefined = undefined;
  loaded = false;
  loading = false;
  error: string | undefined = undefined;

  constructor(public readonly region: string, public readonly projectName: string) {}

  get hasMore(): boolean {
    return !!this.nextToken;
  }

  get runningCount(): number {
    return this.builds.filter((b) => b.buildStatus === RUNNING_STATUS).length;
  }
}

/** Per-region state: the set of projects and their lazily loaded builds. */
class RegionState {
  projectStates = new Map<string, ProjectState>();
  projects: string[] = [];
  loaded = false;
  error: string | undefined = undefined;

  constructor(public readonly region: string) {}

  getOrCreateProject(name: string): ProjectState {
    let state = this.projectStates.get(name);
    if (!state) {
      state = new ProjectState(this.region, name);
      this.projectStates.set(name, state);
    }
    return state;
  }
}

export class RegionNode {
  readonly kind = "region";
  constructor(public readonly state: RegionState) {}
}

export class ProjectNode {
  readonly kind = "project";
  constructor(public readonly state: ProjectState) {}
}

export class BuildNode {
  readonly kind = "build";
  constructor(public readonly region: string, public readonly build: CodeBuildBuild) {}
}

export class LoadMoreNode {
  readonly kind = "loadMore";
  constructor(public readonly state: ProjectState) {}
}

export class MessageNode {
  readonly kind = "message";
  constructor(public readonly message: string) {}
}

function getConfig(): { regions: string[]; profile: string; pageSize: number } {
  const cfg = vscode.workspace.getConfiguration("awsCodeBuild");
  return {
    regions: cfg.get<string[]>("regions", []) ?? [],
    profile: cfg.get<string>("profile", "") ?? "",
    pageSize: cfg.get<number>("pageSize", 20) ?? 20,
  };
}

function statusIcon(status?: string): vscode.ThemeIcon {
  switch (status) {
    case "SUCCEEDED":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    case "FAILED":
    case "FAULT":
    case "STOPPED":
    case "TIMED_OUT":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    case RUNNING_STATUS:
      return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("testing.iconQueued"));
    default:
      return new vscode.ThemeIcon("question");
  }
}

function formatRelativeTime(iso?: string): string {
  if (!iso) {
    return "";
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diffMs = Date.now() - then;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) {
    return `${sec}s ago`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/**
 * Orders builds so running builds float to the top, then everything else by
 * start time (newest first). Stable for builds with equal keys.
 */
function sortBuilds(builds: CodeBuildBuild[]): CodeBuildBuild[] {
  return [...builds].sort((a, b) => {
    const aRunning = a.buildStatus === RUNNING_STATUS ? 1 : 0;
    const bRunning = b.buildStatus === RUNNING_STATUS ? 1 : 0;
    if (aRunning !== bRunning) {
      return bRunning - aRunning;
    }
    const aTime = a.startTime ? new Date(a.startTime).getTime() : 0;
    const bTime = b.startTime ? new Date(b.startTime).getTime() : 0;
    return bTime - aTime;
  });
}

export class CodeBuildTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly regionStates = new Map<string, RegionState>();
  private resolvedRegions: string[] | undefined;

  /** Reload everything from scratch. */
  refresh(): void {
    this.regionStates.clear();
    this.resolvedRegions = undefined;
    this._onDidChangeTreeData.fire();
  }

  private get awsOptions(): Omit<AwsOptions, "region"> {
    const { profile } = getConfig();
    return { profile: profile || undefined };
  }

  /** Resolve the list of regions to query (config, or CLI default). */
  private async getRegions(): Promise<string[]> {
    if (this.resolvedRegions) {
      return this.resolvedRegions;
    }
    const { regions } = getConfig();
    if (regions.length > 0) {
      this.resolvedRegions = regions;
      return regions;
    }
    const def = await getDefaultRegion(this.awsOptions);
    this.resolvedRegions = def ? [def] : [];
    return this.resolvedRegions;
  }

  private getOrCreateRegion(region: string): RegionState {
    let state = this.regionStates.get(region);
    if (!state) {
      state = new RegionState(region);
      this.regionStates.set(region, state);
    }
    return state;
  }

  /** Load the list of projects for a region. */
  private async loadProjects(state: RegionState): Promise<void> {
    const options: AwsOptions = { ...this.awsOptions, region: state.region };
    try {
      state.projects = await listAllProjects(options);
      state.loaded = true;
      state.error = undefined;
    } catch (err) {
      state.loaded = true;
      state.error = errorMessage(err);
    }
  }

  /** Load the next page of builds for a project into its state. */
  private async loadBuildPage(state: ProjectState): Promise<void> {
    const { pageSize } = getConfig();
    const options: AwsOptions = { ...this.awsOptions, region: state.region };
    try {
      const page = await listBuildsForProject(
        options,
        state.projectName,
        pageSize,
        state.nextToken
      );
      const details = await batchGetBuilds(options, page.ids);
      const byId = new Map(details.map((b) => [b.id, b]));
      for (const id of page.ids) {
        const build = byId.get(id);
        if (build) {
          state.builds.push(build);
        }
      }
      state.nextToken = page.nextToken;
      state.loaded = true;
      state.error = undefined;
    } catch (err) {
      state.loaded = true;
      state.error = errorMessage(err);
    }
  }

  /** Triggered by the "Load more…" item; ignores re-entrant clicks. */
  async loadMore(state: ProjectState): Promise<void> {
    if (state.loading) {
      return;
    }
    state.loading = true;
    // Re-render so the action becomes a disabled spinner immediately.
    this._onDidChangeTreeData.fire();
    try {
      await this.loadBuildPage(state);
    } finally {
      state.loading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "region": {
        const item = new vscode.TreeItem(
          node.state.region,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon("globe");
        item.contextValue = "region";
        if (node.state.loaded && !node.state.error) {
          const n = node.state.projects.length;
          item.description = `${n} project${n === 1 ? "" : "s"}`;
        }
        return item;
      }
      case "project": {
        const s = node.state;
        const item = new vscode.TreeItem(
          s.projectName,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        const running = s.loaded ? s.runningCount : 0;
        item.iconPath = running
          ? new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("testing.iconQueued"))
          : new vscode.ThemeIcon("project");
        item.contextValue = "project";
        if (running > 0) {
          item.description = `${running} running`;
        }
        item.tooltip = s.projectName;
        return item;
      }
      case "build": {
        const b = node.build;
        const label = b.buildNumber !== undefined ? `#${b.buildNumber}` : b.id;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = statusIcon(b.buildStatus);
        const rel = formatRelativeTime(b.startTime);
        item.description = [b.buildStatus, rel].filter(Boolean).join("  ·  ");
        item.contextValue = "build";
        item.tooltip = this.buildTooltip(b);
        item.command = {
          command: "awsCodeBuild.openLogs",
          title: "View Build Logs",
          arguments: [node],
        };
        return item;
      }
      case "loadMore": {
        if (node.state.loading) {
          const item = new vscode.TreeItem("Loading…", vscode.TreeItemCollapsibleState.None);
          item.iconPath = new vscode.ThemeIcon("loading~spin");
          item.contextValue = "loadingMore";
          // No command while loading -> clicks are inert (button "disabled").
          return item;
        }
        const item = new vscode.TreeItem("Load more…", vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("ellipsis");
        item.contextValue = "loadMore";
        item.command = {
          command: "awsCodeBuild.loadMore",
          title: "Load More",
          arguments: [node],
        };
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("info");
        item.contextValue = "message";
        return item;
      }
    }
  }

  private buildTooltip(b: CodeBuildBuild): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${b.projectName ?? "build"}**\n\n`);
    md.appendMarkdown(`- Status: ${b.buildStatus ?? "unknown"}\n`);
    if (b.buildNumber !== undefined) {
      md.appendMarkdown(`- Build #: ${b.buildNumber}\n`);
    }
    if (b.currentPhase) {
      md.appendMarkdown(`- Phase: ${b.currentPhase}\n`);
    }
    if (b.startTime) {
      md.appendMarkdown(`- Started: ${new Date(b.startTime).toLocaleString()}\n`);
    }
    if (b.endTime) {
      md.appendMarkdown(`- Ended: ${new Date(b.endTime).toLocaleString()}\n`);
    }
    if (b.sourceVersion) {
      md.appendMarkdown(`- Source: ${b.sourceVersion}\n`);
    }
    md.appendMarkdown(`\n_${b.id}_`);
    return md;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      const regions = await this.getRegions();
      if (regions.length === 0) {
        return [
          new MessageNode(
            "No region configured. Set 'awsCodeBuild.regions' or configure a default AWS CLI region."
          ),
        ];
      }
      return regions.map((r) => new RegionNode(this.getOrCreateRegion(r)));
    }

    if (element.kind === "region") {
      const state = element.state;
      if (!state.loaded) {
        await this.loadProjects(state);
      }
      if (state.error) {
        return [new MessageNode(state.error)];
      }
      if (state.projects.length === 0) {
        return [new MessageNode("No CodeBuild projects in this region.")];
      }
      return state.projects.map((name) => new ProjectNode(state.getOrCreateProject(name)));
    }

    if (element.kind === "project") {
      const state = element.state;
      if (!state.loaded) {
        await this.loadBuildPage(state);
      }
      if (state.error) {
        return [new MessageNode(state.error)];
      }
      if (state.builds.length === 0) {
        return [new MessageNode("No builds for this project.")];
      }
      const nodes: TreeNode[] = sortBuilds(state.builds).map(
        (b) => new BuildNode(state.region, b)
      );
      if (state.hasMore || state.loading) {
        nodes.push(new LoadMoreNode(state));
      }
      return nodes;
    }

    return [];
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof AwsCliError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
