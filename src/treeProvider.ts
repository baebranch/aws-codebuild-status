import * as vscode from "vscode";
import {
  AwsCliError,
  AwsOptions,
  CodeBuildBuild,
  Ec2HealthCheck,
  Ec2Instance,
  batchGetBuilds,
  getDefaultRegion,
  getEc2InstanceHealth,
  listBuildsForProject,
  listEc2InstancesPage,
  listProjectsPage,
  startBuild as startCodeBuild,
} from "./aws";

type TreeNode =
  | RegionNode
  | CodeBuildSectionNode
  | InstancesSectionNode
  | ProjectNode
  | BuildNode
  | InstanceNode
  | HealthCheckNode
  | LoadMoreNode
  | MessageNode;

const RUNNING_STATUS = "IN_PROGRESS";

type HealthCheckKind = "system" | "instance" | "ebs";

/** Per-project paging state held in memory. */
class ProjectState {
  builds: CodeBuildBuild[] = [];
  nextToken: string | undefined;
  loaded = false;
  loading = false;
  loadingMessage: string | undefined;
  error: string | undefined;
  loadVersion = 0;

  constructor(public readonly region: string, public readonly projectName: string) {}

  get hasMore(): boolean {
    return !!this.nextToken;
  }

  get runningCount(): number {
    return this.builds.filter((build) => build.buildStatus === RUNNING_STATUS).length;
  }
}

/** Per-region state: independent CodeBuild and EC2 section state. */
class RegionState {
  projectStates = new Map<string, ProjectState>();
  projects: string[] = [];
  projectsNextToken: string | undefined;
  projectsLoaded = false;
  projectsLoading = false;
  projectsError: string | undefined;
  projectsVersion = 0;

  instances: Ec2Instance[] = [];
  instancesNextToken: string | undefined;
  instancesLoaded = false;
  instancesLoading = false;
  instancesError: string | undefined;
  instancesVersion = 0;

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

export class CodeBuildSectionNode {
  readonly kind = "codeBuildSection";
  constructor(public readonly state: RegionState) {}
}

export class InstancesSectionNode {
  readonly kind = "instancesSection";
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

export class InstanceNode {
  readonly kind = "instance";
  constructor(public readonly region: string, public readonly instance: Ec2Instance) {}
}

export class HealthCheckNode {
  readonly kind = "healthCheck";
  constructor(
    public readonly instance: Ec2Instance,
    public readonly check: HealthCheckKind
  ) {}
}

export class LoadMoreNode {
  readonly kind = "loadMore";
  constructor(public readonly state: ProjectState) {}
}

export class MessageNode {
  readonly kind = "message";
  constructor(
    public readonly message: string,
    public readonly id?: string,
    public readonly loading = false
  ) {}
}

export type RefreshableNode =
  | RegionNode
  | CodeBuildSectionNode
  | InstancesSectionNode
  | ProjectNode
  | InstanceNode;

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
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function sortBuilds(builds: CodeBuildBuild[]): CodeBuildBuild[] {
  return [...builds].sort((a, b) => {
    const aRunning = a.buildStatus === RUNNING_STATUS ? 1 : 0;
    const bRunning = b.buildStatus === RUNNING_STATUS ? 1 : 0;
    if (aRunning !== bRunning) {
      return bRunning - aRunning;
    }
    return (b.startTime ? new Date(b.startTime).getTime() : 0) -
      (a.startTime ? new Date(a.startTime).getTime() : 0);
  });
}

function healthCheck(instance: Ec2Instance, check: HealthCheckKind): Ec2HealthCheck | undefined {
  switch (check) {
    case "system":
      return instance.systemCheck;
    case "instance":
      return instance.instanceCheck;
    case "ebs":
      return instance.ebsCheck;
  }
}

function healthLabel(check?: Ec2HealthCheck): string {
  if (!check) {
    return "not available";
  }
  if (check.detail && check.status && check.detail !== check.status) {
    return `${check.status} (${check.detail})`;
  }
  return check.detail ?? check.status ?? "unknown";
}

function healthIcon(check?: Ec2HealthCheck): vscode.ThemeIcon {
  const value = `${check?.status ?? ""} ${check?.detail ?? ""}`.toLowerCase();
  if (value.includes("impaired") || value.includes("failed")) {
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
  }
  if (value.includes("ok") || value.includes("passed")) {
    return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
  }
  if (value.includes("initializing")) {
    return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("testing.iconQueued"));
  }
  return new vscode.ThemeIcon("question");
}

function instanceHealthSummary(instance: Ec2Instance): string {
  const checks = [instance.systemCheck, instance.instanceCheck, instance.ebsCheck];
  const passed = checks.filter((check) => {
    const value = `${check?.status ?? ""} ${check?.detail ?? ""}`.toLowerCase();
    return value.includes("ok") || value.includes("passed");
  }).length;
  return `${passed}/3 checks passed`;
}

function instanceIcon(instance: Ec2Instance): vscode.ThemeIcon {
  if (instance.state !== "running") {
    return instance.state === "stopped"
      ? new vscode.ThemeIcon("debug-stop", new vscode.ThemeColor("disabledForeground"))
      : new vscode.ThemeIcon("circle-outline");
  }
  const checks = [instance.systemCheck, instance.instanceCheck, instance.ebsCheck];
  const hasFailure = checks.some((check) => {
    const value = `${check?.status ?? ""} ${check?.detail ?? ""}`.toLowerCase();
    return value.includes("impaired") || value.includes("failed");
  });
  if (hasFailure) {
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
  }
  const checksKnown = checks.every((check) => check !== undefined);
  const allPassed = checksKnown && checks.every((check) => healthIcon(check).id === "pass");
  if (allPassed) {
    return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
  }
  return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("testing.iconQueued"));
}

export class CodeBuildTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly regionStates = new Map<string, RegionState>();
  private readonly codeBuildSectionNodes = new WeakMap<RegionState, CodeBuildSectionNode>();
  private readonly instancesSectionNodes = new WeakMap<RegionState, InstancesSectionNode>();
  private readonly projectNodes = new WeakMap<ProjectState, ProjectNode>();
  private readonly instanceNodes = new WeakMap<Ec2Instance, InstanceNode>();
  private readonly refreshingInstances = new Set<string>();
  private readonly expandedNodeKeys = new Set<string>();
  private resolvedRegions: string[] | undefined;

  /** Tracks expanded paths so a manual refresh reloads only visible children. */
  setExpanded(node: TreeNode, expanded: boolean): void {
    const key = this.nodeKey(node);
    if (!key) {
      return;
    }
    if (expanded) {
      this.expandedNodeKeys.add(key);
    } else {
      this.expandedNodeKeys.delete(key);
    }
  }

  /** Refreshes expanded paths sequentially without removing existing children. */
  async refresh(resetConfiguration = false): Promise<void> {
    if (resetConfiguration) {
      this.regionStates.clear();
      this.resolvedRegions = undefined;
      this.expandedNodeKeys.clear();
      this._onDidChangeTreeData.fire();
      return;
    }

    const regions = [...this.regionStates.values()];
    for (const state of regions) {
      if (this.expandedNodeKeys.has(`codebuild:${state.region}`)) {
        await this.loadProjects(state, true);
      }
    }
    for (const state of regions) {
      if (this.expandedNodeKeys.has(`instances:${state.region}`)) {
        await this.loadInstances(state, true);
      }
    }
    for (const state of regions) {
      for (const project of state.projectStates.values()) {
        if (this.expandedNodeKeys.has(`project:${project.region}:${project.projectName}`)) {
          await this.loadBuildPage(project, true);
        }
      }
    }
  }

  async refreshItem(node: RefreshableNode): Promise<void> {
    switch (node.kind) {
      case "region":
        await this.refreshRegionState(node.state);
        break;
      case "codeBuildSection":
        await this.loadProjects(node.state, true);
        break;
      case "instancesSection":
        await this.loadInstances(node.state, true);
        break;
      case "project":
        await this.loadBuildPage(node.state, true);
        break;
      case "instance":
        await this.refreshInstance(node);
        break;
    }
  }

  private async refreshRegionState(state: RegionState): Promise<void> {
    if (this.expandedNodeKeys.has(`codebuild:${state.region}`)) {
      await this.loadProjects(state, true);
    }
    if (this.expandedNodeKeys.has(`instances:${state.region}`)) {
      await this.loadInstances(state, true);
    }
    for (const project of state.projectStates.values()) {
      if (this.expandedNodeKeys.has(`project:${project.region}:${project.projectName}`)) {
        await this.loadBuildPage(project, true);
      }
    }
  }

  private async refreshInstance(node: InstanceNode): Promise<void> {
    const key = `${node.region}:${node.instance.id}`;
    if (this.refreshingInstances.has(key)) {
      return;
    }
    this.refreshingInstances.add(key);
    const canonicalNode = this.instanceNode(node.region, node.instance);
    this._onDidChangeTreeData.fire(canonicalNode);
    try {
      const health = await getEc2InstanceHealth(
        { ...this.awsOptions, region: node.region },
        [node.instance.id]
      );
      const update = health.get(node.instance.id);
      if (update) {
        Object.assign(node.instance, update);
      }
    } finally {
      this.refreshingInstances.delete(key);
      this._onDidChangeTreeData.fire(canonicalNode);
    }
  }

  hasPendingBuilds(): boolean {
    return [...this.regionStates.values()].some((region) =>
      [...region.projectStates.values()].some((project) => project.runningCount > 0)
    );
  }

  async refreshPendingBuilds(): Promise<void> {
    const pendingProjects = [...this.regionStates.values()].flatMap((region) =>
      [...region.projectStates.values()].filter((project) => project.runningCount > 0)
    );
    await Promise.all(
      pendingProjects.map(async (state) => {
        const ids = state.builds
          .filter((build) => build.buildStatus === RUNNING_STATUS)
          .map((build) => build.id);
        try {
          const updates = await batchGetBuilds(
            { ...this.awsOptions, region: state.region },
            ids
          );
          const byId = new Map(updates.map((build) => [build.id, build]));
          state.builds = state.builds.map((build) => byId.get(build.id) ?? build);
          state.error = undefined;
          this._onDidChangeTreeData.fire(this.projectNode(state));
        } catch (err) {
          state.error = errorMessage(err);
          this._onDidChangeTreeData.fire(this.projectNode(state));
        }
      })
    );
  }

  private get awsOptions(): Omit<AwsOptions, "region"> {
    const { profile } = getConfig();
    return { profile: profile || undefined };
  }

  private async getRegions(): Promise<string[]> {
    if (this.resolvedRegions) {
      return this.resolvedRegions;
    }
    const { regions } = getConfig();
    if (regions.length > 0) {
      this.resolvedRegions = regions;
      return regions;
    }
    const defaultRegion = await getDefaultRegion(this.awsOptions);
    this.resolvedRegions = defaultRegion ? [defaultRegion] : [];
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

  private codeBuildSectionNode(state: RegionState): CodeBuildSectionNode {
    let node = this.codeBuildSectionNodes.get(state);
    if (!node) {
      node = new CodeBuildSectionNode(state);
      this.codeBuildSectionNodes.set(state, node);
    }
    return node;
  }

  private instancesSectionNode(state: RegionState): InstancesSectionNode {
    let node = this.instancesSectionNodes.get(state);
    if (!node) {
      node = new InstancesSectionNode(state);
      this.instancesSectionNodes.set(state, node);
    }
    return node;
  }

  private projectNode(state: ProjectState): ProjectNode {
    let node = this.projectNodes.get(state);
    if (!node) {
      node = new ProjectNode(state);
      this.projectNodes.set(state, node);
    }
    return node;
  }

  private instanceNode(region: string, instance: Ec2Instance): InstanceNode {
    let node = this.instanceNodes.get(instance);
    if (!node) {
      node = new InstanceNode(region, instance);
      this.instanceNodes.set(instance, node);
    }
    return node;
  }

  private nodeKey(node: TreeNode): string | undefined {
    switch (node.kind) {
      case "region":
        return `region:${node.state.region}`;
      case "codeBuildSection":
        return `codebuild:${node.state.region}`;
      case "instancesSection":
        return `instances:${node.state.region}`;
      case "project":
        return `project:${node.state.region}:${node.state.projectName}`;
      case "instance":
        return `instance:${node.region}:${node.instance.id}`;
      default:
        return undefined;
    }
  }

  private invalidateProjects(state: RegionState): void {
    state.projectsVersion++;
    state.projectsNextToken = undefined;
    state.projectsLoaded = false;
    state.projectsLoading = false;
    state.projectsError = undefined;
  }

  private invalidateInstances(state: RegionState): void {
    state.instancesVersion++;
    state.instancesNextToken = undefined;
    state.instancesLoaded = false;
    state.instancesLoading = false;
    state.instancesError = undefined;
  }

  private invalidateProject(state: ProjectState): void {
    state.loadVersion++;
    state.builds = [];
    state.nextToken = undefined;
    state.loaded = false;
    state.loading = false;
    state.loadingMessage = undefined;
    state.error = undefined;
  }

  private fireCodeBuildSection(state: RegionState): void {
    this._onDidChangeTreeData.fire(this.codeBuildSectionNode(state));
  }

  private fireInstancesSection(state: RegionState): void {
    this._onDidChangeTreeData.fire(this.instancesSectionNode(state));
  }

  /** Loads CodeBuild project pages and renders each page as soon as it arrives. */
  private async loadProjects(state: RegionState, reload = false): Promise<void> {
    if (state.projectsLoading || (state.projectsLoaded && !reload)) {
      return;
    }
    if (reload) {
      state.projectsVersion++;
      state.projectsNextToken = undefined;
    }
    const version = state.projectsVersion;
    const seen = new Set<string>();
    state.projectsLoading = true;
    state.projectsError = undefined;
    if (reload) {
      this.fireCodeBuildSection(state);
    }
    try {
      do {
        const page = await listProjectsPage(
          { ...this.awsOptions, region: state.region },
          state.projectsNextToken
        );
        if (version !== state.projectsVersion) {
          return;
        }
        for (const project of page.projects) {
          seen.add(project);
          if (!state.projects.includes(project)) {
            state.projects.push(project);
          }
        }
        state.projectsNextToken = page.nextToken;
        this.fireCodeBuildSection(state);
      } while (state.projectsNextToken);
      if (version === state.projectsVersion) {
        state.projects = state.projects.filter((project) => seen.has(project));
        state.projectsLoaded = true;
      }
    } catch (err) {
      if (version === state.projectsVersion) {
        state.projectsError = errorMessage(err);
      }
    } finally {
      if (version === state.projectsVersion) {
        state.projectsLoading = false;
        this.fireCodeBuildSection(state);
      }
    }
  }

  /** Loads one build page and renders the ID and detail responses independently. */
  private async loadBuildPage(state: ProjectState, reload = false): Promise<void> {
    if (state.loading) {
      return;
    }
    if (reload) {
      state.loadVersion++;
      state.nextToken = undefined;
    }
    const version = state.loadVersion;
    state.loading = true;
    state.loadingMessage = "Loading build IDs…";
    state.error = undefined;
    if (reload) {
      this._onDidChangeTreeData.fire(this.projectNode(state));
    }
    try {
      const { pageSize } = getConfig();
      const page = await listBuildsForProject(
        { ...this.awsOptions, region: state.region },
        state.projectName,
        pageSize,
        state.nextToken
      );
      if (version !== state.loadVersion) {
        return;
      }
      state.nextToken = page.nextToken;
      state.loadingMessage = "Loading build details…";
      this._onDidChangeTreeData.fire(this.projectNode(state));
      const details = await batchGetBuilds(
        { ...this.awsOptions, region: state.region },
        page.ids
      );
      if (version !== state.loadVersion) {
        return;
      }
      const byId = new Map(details.map((build) => [build.id, build]));
      const freshBuilds = page.ids.flatMap((id) => {
        const build = byId.get(id);
        return build ? [build] : [];
      });
      if (reload) {
        const existingById = new Map(state.builds.map((build) => [build.id, build]));
        state.builds = freshBuilds.map((build) => {
          const existing = existingById.get(build.id);
          return existing ? Object.assign(existing, build) : build;
        });
        this._onDidChangeTreeData.fire(this.projectNode(state));
      } else {
        for (const build of freshBuilds) {
          if (!state.builds.some((existing) => existing.id === build.id)) {
            state.builds.push(build);
            this._onDidChangeTreeData.fire(this.projectNode(state));
          }
        }
      }
      state.loaded = true;
    } catch (err) {
      if (version === state.loadVersion) {
        state.error = errorMessage(err);
        state.loaded = true;
      }
    } finally {
      if (version === state.loadVersion) {
        state.loading = false;
        state.loadingMessage = undefined;
        this._onDidChangeTreeData.fire(this.projectNode(state));
      }
    }
  }

  /** Loads EC2 pages and the related health response immediately after each page. */
  private async loadInstances(state: RegionState, reload = false): Promise<void> {
    if (state.instancesLoading || (state.instancesLoaded && !reload)) {
      return;
    }
    if (reload) {
      state.instancesVersion++;
      state.instancesNextToken = undefined;
    }
    const version = state.instancesVersion;
    const seen = new Set<string>();
    state.instancesLoading = true;
    state.instancesError = undefined;
    if (reload) {
      this.fireInstancesSection(state);
    }
    try {
      do {
        const page = await listEc2InstancesPage(
          { ...this.awsOptions, region: state.region },
          state.instancesNextToken
        );
        if (version !== state.instancesVersion) {
          return;
        }
        const existingById = new Map(state.instances.map((instance) => [instance.id, instance]));
        for (const incoming of page.instances) {
          seen.add(incoming.id);
          const existing = existingById.get(incoming.id);
          if (existing) {
            Object.assign(existing, incoming);
          } else {
            state.instances.push(incoming);
          }
        }
        state.instancesNextToken = page.nextToken;
        this.fireInstancesSection(state);

        const health = await getEc2InstanceHealth(
          { ...this.awsOptions, region: state.region },
          page.instances.map((instance) => instance.id)
        );
        if (version !== state.instancesVersion) {
          return;
        }
        for (const instance of state.instances) {
          const update = health.get(instance.id);
          if (update) {
            Object.assign(instance, update);
            this._onDidChangeTreeData.fire(this.instanceNode(state.region, instance));
          }
        }
        this.fireInstancesSection(state);
      } while (state.instancesNextToken);
      if (version === state.instancesVersion) {
        state.instances = state.instances.filter((instance) => seen.has(instance.id));
        state.instancesLoaded = true;
      }
    } catch (err) {
      if (version === state.instancesVersion) {
        state.instancesError = errorMessage(err);
      }
    } finally {
      if (version === state.instancesVersion) {
        state.instancesLoading = false;
        this.fireInstancesSection(state);
      }
    }
  }

  async loadMore(state: ProjectState): Promise<void> {
    await this.loadBuildPage(state);
  }

  async startBuild(node: ProjectNode): Promise<void> {
    const { state } = node;
    const startedBuild = await startCodeBuild(
      { ...this.awsOptions, region: state.region },
      state.projectName
    );
    this.invalidateProject(state);
    await this.loadBuildPage(state);
    if (startedBuild && !state.builds.some((build) => build.id === startedBuild.id)) {
      state.builds.unshift(startedBuild);
      this._onDidChangeTreeData.fire(node);
    }
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "region": {
        const state = node.state;
        const item = new vscode.TreeItem(state.region, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `region:${state.region}`;
        item.iconPath = new vscode.ThemeIcon("globe");
        item.contextValue = "region";
        const descriptions: string[] = [];
        if (state.projectsLoaded) {
          descriptions.push(`${state.projects.length} projects`);
        }
        if (state.instancesLoaded) {
          descriptions.push(`${state.instances.length} instances`);
        }
        item.description = descriptions.join(" · ");
        return item;
      }
      case "codeBuildSection": {
        const state = node.state;
        const item = new vscode.TreeItem("CodeBuild projects", vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `codebuild:${state.region}`;
        item.iconPath = state.projectsLoading && state.projectsLoaded
          ? new vscode.ThemeIcon("loading~spin")
          : new vscode.ThemeIcon("tools");
        item.contextValue = "codeBuildSection";
        item.description = state.projectsLoaded ? `${state.projects.length}` : undefined;
        return item;
      }
      case "instancesSection": {
        const state = node.state;
        const item = new vscode.TreeItem("EC2 instances", vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `instances:${state.region}`;
        item.iconPath = state.instancesLoading && state.instancesLoaded
          ? new vscode.ThemeIcon("loading~spin")
          : new vscode.ThemeIcon("server");
        item.contextValue = "instancesSection";
        item.description = state.instancesLoaded ? `${state.instances.length}` : undefined;
        return item;
      }
      case "project": {
        const state = node.state;
        const item = new vscode.TreeItem(state.projectName, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `project:${state.region}:${state.projectName}`;
        item.iconPath = state.loading && state.loaded
          ? new vscode.ThemeIcon("loading~spin")
          : state.runningCount
            ? new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("testing.iconQueued"))
            : new vscode.ThemeIcon("project");
        item.contextValue = "project";
        item.description = state.runningCount ? `${state.runningCount} running` : undefined;
        item.tooltip = state.projectName;
        return item;
      }
      case "build": {
        const build = node.build;
        const label = build.buildNumber !== undefined ? `#${build.buildNumber}` : build.id;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = `build:${node.region}:${build.id}`;
        item.iconPath = statusIcon(build.buildStatus);
        item.description = [build.buildStatus, formatRelativeTime(build.startTime)]
          .filter(Boolean)
          .join(" · ");
        item.contextValue = "build";
        item.tooltip = this.buildTooltip(build);
        item.command = {
          command: "awsCodeBuild.openLogs",
          title: "View Build Logs",
          arguments: [node],
        };
        return item;
      }
      case "instance": {
        const instance = node.instance;
        const label = instance.name ? `${instance.name} (${instance.id})` : instance.id;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `instance:${node.region}:${instance.id}`;
        item.iconPath = this.refreshingInstances.has(`${node.region}:${instance.id}`)
          ? new vscode.ThemeIcon("loading~spin")
          : instanceIcon(instance);
        item.contextValue = "instance";
        item.description = [instance.state, instanceHealthSummary(instance)].filter(Boolean).join(" · ");
        item.tooltip = this.instanceTooltip(instance);
        return item;
      }
      case "healthCheck": {
        const item = new vscode.TreeItem(
          `${healthCheckTitle(node.check)} check`,
          vscode.TreeItemCollapsibleState.None
        );
        item.id = `health:${node.instance.id}:${node.check}`;
        item.iconPath = healthIcon(healthCheck(node.instance, node.check));
        item.description = healthLabel(healthCheck(node.instance, node.check));
        item.contextValue = "healthCheck";
        return item;
      }
      case "loadMore": {
        const item = new vscode.TreeItem(
          node.state.loading ? node.state.loadingMessage ?? "Loading…" : "Load more…",
          vscode.TreeItemCollapsibleState.None
        );
        item.id = `load-more:${node.state.region}:${node.state.projectName}`;
        item.iconPath = node.state.loading
          ? new vscode.ThemeIcon("loading~spin")
          : new vscode.ThemeIcon("ellipsis");
        item.contextValue = node.state.loading ? "loadingMore" : "loadMore";
        if (!node.state.loading) {
          item.command = {
            command: "awsCodeBuild.loadMore",
            title: "Load More",
            arguments: [node],
          };
        }
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
        item.iconPath = node.loading
          ? new vscode.ThemeIcon("loading~spin")
          : new vscode.ThemeIcon("info");
        item.contextValue = node.loading ? "loading" : "message";
        return item;
      }
    }
  }

  private buildTooltip(build: CodeBuildBuild): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${build.projectName ?? "build"}**\n\n`);
    markdown.appendMarkdown(`- Status: ${build.buildStatus ?? "unknown"}\n`);
    if (build.buildNumber !== undefined) markdown.appendMarkdown(`- Build #: ${build.buildNumber}\n`);
    if (build.currentPhase) markdown.appendMarkdown(`- Phase: ${build.currentPhase}\n`);
    if (build.startTime) markdown.appendMarkdown(`- Started: ${new Date(build.startTime).toLocaleString()}\n`);
    if (build.endTime) markdown.appendMarkdown(`- Ended: ${new Date(build.endTime).toLocaleString()}\n`);
    if (build.sourceVersion) markdown.appendMarkdown(`- Source: ${build.sourceVersion}\n`);
    markdown.appendMarkdown(`\n_${build.id}_`);
    return markdown;
  }

  private instanceTooltip(instance: Ec2Instance): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${instance.name ?? instance.id}**\n\n`);
    markdown.appendMarkdown(`- Instance ID: ${instance.id}\n`);
    markdown.appendMarkdown(`- State: ${instance.state ?? "unknown"}\n`);
    if (instance.instanceType) markdown.appendMarkdown(`- Type: ${instance.instanceType}\n`);
    if (instance.availabilityZone) markdown.appendMarkdown(`- Availability Zone: ${instance.availabilityZone}\n`);
    if (instance.privateIp) markdown.appendMarkdown(`- Private IP: ${instance.privateIp}\n`);
    if (instance.publicIp) markdown.appendMarkdown(`- Public IP: ${instance.publicIp}\n`);
    markdown.appendMarkdown(`\n**Status checks**\n\n`);
    markdown.appendMarkdown(`- System: ${healthLabel(instance.systemCheck)}\n`);
    markdown.appendMarkdown(`- Instance: ${healthLabel(instance.instanceCheck)}\n`);
    markdown.appendMarkdown(`- Attached EBS: ${healthLabel(instance.ebsCheck)}\n`);
    return markdown;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      const regions = await this.getRegions();
      return regions.length > 0
        ? regions.map((region) => new RegionNode(this.getOrCreateRegion(region)))
        : [new MessageNode("No region configured. Set 'awsCodeBuild.regions' or configure a default AWS CLI region.")];
    }

    if (element.kind === "region") {
      return [
        this.codeBuildSectionNode(element.state),
        this.instancesSectionNode(element.state),
      ];
    }

    if (element.kind === "codeBuildSection") {
      const state = element.state;
      if (!state.projectsLoaded && !state.projectsLoading) {
        void this.loadProjects(state);
      }
      const nodes: TreeNode[] = state.projects.map((project) =>
        this.projectNode(state.getOrCreateProject(project))
      );
      if (state.projectsError) {
        nodes.push(new MessageNode(state.projectsError, `projects-error:${state.region}`));
      } else if (state.projectsLoading && !state.projectsLoaded) {
        nodes.push(
          new MessageNode("Loading CodeBuild projects…", undefined, true)
        );
      } else if (state.projectsLoaded && nodes.length === 0) {
        nodes.push(new MessageNode("No CodeBuild projects in this region.", `projects-empty:${state.region}`));
      }
      return nodes;
    }

    if (element.kind === "instancesSection") {
      const state = element.state;
      if (!state.instancesLoaded && !state.instancesLoading) {
        void this.loadInstances(state);
      }
      const nodes: TreeNode[] = state.instances.map((instance) =>
        this.instanceNode(state.region, instance)
      );
      if (state.instancesError) {
        nodes.push(new MessageNode(state.instancesError, `instances-error:${state.region}`));
      } else if (state.instancesLoading && !state.instancesLoaded) {
        nodes.push(
          new MessageNode("Loading EC2 instances…", undefined, true)
        );
      } else if (state.instancesLoaded && nodes.length === 0) {
        nodes.push(new MessageNode("No EC2 instances in this region.", `instances-empty:${state.region}`));
      }
      return nodes;
    }

    if (element.kind === "project") {
      const state = element.state;
      if (!state.loaded && !state.loading) {
        void this.loadBuildPage(state);
      }
      const nodes: TreeNode[] = sortBuilds(state.builds).map(
        (build) => new BuildNode(state.region, build)
      );
      if (state.error) {
        nodes.push(new MessageNode(state.error, `build-error:${state.region}:${state.projectName}`));
      } else if (state.loading && !state.loaded) {
        nodes.push(new LoadMoreNode(state));
      } else if (state.loaded && nodes.length === 0) {
        nodes.push(new MessageNode("No builds for this project.", `build-empty:${state.region}:${state.projectName}`));
      }
      if (!state.loading && state.hasMore) {
        nodes.push(new LoadMoreNode(state));
      }
      return nodes;
    }

    if (element.kind === "instance") {
      return (["system", "instance", "ebs"] as HealthCheckKind[]).map(
        (check) => new HealthCheckNode(element.instance, check)
      );
    }

    return [];
  }
}

function healthCheckTitle(check: HealthCheckKind): string {
  switch (check) {
    case "system":
      return "System";
    case "instance":
      return "Instance";
    case "ebs":
      return "Attached EBS";
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof AwsCliError || err instanceof Error) {
    return err.message;
  }
  return String(err);
}
