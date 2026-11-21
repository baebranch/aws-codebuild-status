import * as vscode from "vscode";
import {
  AwsCliError,
  AwsOptions,
  CodeBuildBuild,
  Ec2HealthCheck,
  Ec2Instance,
  Ec2Volume,
  Ec2Snapshot,
  Ec2Address,
  EcrRepository,
  EcrImage,
  ResourcePage,
  batchGetBuilds,
  getDefaultRegion,
  getEc2InstanceHealth,
  listBuildsForProject,
  listEc2Addresses,
  listEc2InstancesPage,
  listEc2SnapshotsPage,
  listEc2VolumesPage,
  listEcrImagesPage,
  listEcrRepositoriesPage,
  listProjectsPage,
  startBuild as startCodeBuild,
} from "./aws";

type TreeNode =
  | RegionNode
  | CodeBuildSectionNode
  | InstancesSectionNode
  | VolumesSectionNode
  | ResourceSectionNode
  | ProjectNode
  | BuildNode
  | InstanceNode
  | VolumeNode
  | SnapshotNode
  | RepositoryNode
  | ImageNode
  | AddressNode
  | HealthCheckNode
  | LoadMoreNode
  | MessageNode;

/** Sections backed by the generic ListState loader. */
export type ResourceSectionKind = "snapshots" | "repositories" | "addresses";

/** Generic in-memory state for a fully-paged list. */
class ListState<T> {
  items: T[] = [];
  loaded = false;
  loading = false;
  error: string | undefined;
  version = 0;
}

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

  volumes: Ec2Volume[] = [];
  volumesNextToken: string | undefined;
  volumesLoaded = false;
  volumesLoading = false;
  volumesError: string | undefined;
  volumesVersion = 0;

  snapshots = new ListState<Ec2Snapshot>();
  repositories = new ListState<EcrRepository>();
  addresses = new ListState<Ec2Address>();
  /** Images per ECR repository name. */
  images = new Map<string, ListState<EcrImage>>();

  constructor(public readonly region: string) {}

  list(section: ResourceSectionKind): ListState<unknown> {
    return this[section] as ListState<unknown>;
  }

  getOrCreateImages(repositoryName: string): ListState<EcrImage> {
    let state = this.images.get(repositoryName);
    if (!state) {
      state = new ListState<EcrImage>();
      this.images.set(repositoryName, state);
    }
    return state;
  }

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

export class VolumesSectionNode {
  readonly kind = "volumesSection";
  constructor(public readonly state: RegionState) {}
}

export class VolumeNode {
  readonly kind = "volume";
  constructor(public readonly region: string, public readonly volume: Ec2Volume) {}
}

export class ResourceSectionNode {
  readonly kind = "resourceSection";
  constructor(public readonly state: RegionState, public readonly section: ResourceSectionKind) {}
}

export class SnapshotNode {
  readonly kind = "snapshot";
  constructor(public readonly region: string, public readonly snapshot: Ec2Snapshot) {}
}

export class RepositoryNode {
  readonly kind = "repository";
  constructor(
    public readonly region: RegionState,
    public readonly repository: EcrRepository
  ) {}

  get images(): ListState<EcrImage> {
    return this.region.getOrCreateImages(this.repository.name);
  }
}

export class ImageNode {
  readonly kind = "image";
  constructor(
    public readonly region: string,
    public readonly repository: EcrRepository,
    public readonly image: EcrImage
  ) {}

  /** repositoryUri:tag when tagged, otherwise repositoryUri@digest. */
  get uri(): string {
    const base = this.repository.uri ?? this.repository.name;
    return this.image.tags.length > 0 ? `${base}:${this.image.tags[0]}` : `${base}@${this.image.digest}`;
  }
}

export class AddressNode {
  readonly kind = "address";
  constructor(public readonly region: string, public readonly address: Ec2Address) {}
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
  | VolumesSectionNode
  | ResourceSectionNode
  | RepositoryNode
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

/** Checks that apply to the instance; an absent/not-applicable EBS check (no EBS volume) is excluded. */
function applicableChecks(instance: Ec2Instance): (Ec2HealthCheck | undefined)[] {
  const checks = [instance.systemCheck, instance.instanceCheck, instance.ebsCheck];
  if (!instance.healthLoaded) {
    return checks;
  }
  return checks.filter((check, index) => {
    if (index !== 2) {
      return true;
    }
    const value = `${check?.status ?? ""} ${check?.detail ?? ""}`.toLowerCase();
    return check !== undefined && !value.includes("not-applicable") && !value.includes("not applicable");
  });
}

function instanceHealthSummary(instance: Ec2Instance): string {
  const checks = applicableChecks(instance);
  const passed = checks.filter((check) => {
    const value = `${check?.status ?? ""} ${check?.detail ?? ""}`.toLowerCase();
    return value.includes("ok") || value.includes("passed");
  }).length;
  return `${passed}/${checks.length} checks passed`;
}

function instanceIcon(instance: Ec2Instance): vscode.ThemeIcon {
  if (instance.state !== "running") {
    return instance.state === "stopped"
      ? new vscode.ThemeIcon("debug-stop", new vscode.ThemeColor("disabledForeground"))
      : new vscode.ThemeIcon("circle-outline");
  }
  const checks = applicableChecks(instance);
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
  private readonly volumesSectionNodes = new WeakMap<RegionState, VolumesSectionNode>();
  private readonly volumeNodes = new WeakMap<Ec2Volume, VolumeNode>();
  private readonly projectNodes = new WeakMap<ProjectState, ProjectNode>();
  private readonly instanceNodes = new WeakMap<Ec2Instance, InstanceNode>();
  private readonly resourceSectionNodes = new WeakMap<RegionState, Map<ResourceSectionKind, ResourceSectionNode>>();
  private readonly repositoryNodes = new WeakMap<EcrRepository, RepositoryNode>();
  private readonly refreshingInstances = new Set<string>();
  private readonly expandedNodeKeys = new Set<string>();
  private resolvedRegions: string[] | undefined;

  constructor(private readonly globalState: vscode.Memento) {}

  private profileKey(): string {
    return getConfig().profile || "default";
  }

  /** Whether terminated instances are hidden for the current AWS profile (stored globally). */
  hideTerminated(): boolean {
    const map = this.globalState.get<Record<string, boolean>>("awsCodeBuild.hideTerminated", {});
    return map[this.profileKey()] === true;
  }

  async setHideTerminated(hide: boolean): Promise<void> {
    const map = { ...this.globalState.get<Record<string, boolean>>("awsCodeBuild.hideTerminated", {}) };
    if (hide) {
      map[this.profileKey()] = true;
    } else {
      delete map[this.profileKey()];
    }
    await this.globalState.update("awsCodeBuild.hideTerminated", map);
    this._onDidChangeTreeData.fire();
  }

  /** "visible/total" while terminated instances are hidden, otherwise just the total. */
  private instanceCount(state: RegionState): string {
    const total = state.instances.length;
    return this.hideTerminated() ? `${this.visibleInstances(state).length}/${total}` : `${total}`;
  }

  private visibleInstances(state: RegionState): Ec2Instance[] {
    return this.hideTerminated()
      ? state.instances.filter((instance) => instance.state !== "terminated")
      : state.instances;
  }

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
      if (this.expandedNodeKeys.has(`volumes:${state.region}`)) {
        await this.loadVolumes(state, true);
      }
    }
    for (const state of regions) {
      await this.refreshExpandedResourceSections(state);
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
      case "volumesSection":
        await this.loadVolumes(node.state, true);
        break;
      case "resourceSection":
        await this.loadResourceSection(node.state, node.section, true);
        break;
      case "repository":
        await this.loadImages(node, true);
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
    if (this.expandedNodeKeys.has(`volumes:${state.region}`)) {
      await this.loadVolumes(state, true);
    }
    await this.refreshExpandedResourceSections(state);
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

  private volumesSectionNode(state: RegionState): VolumesSectionNode {
    let node = this.volumesSectionNodes.get(state);
    if (!node) {
      node = new VolumesSectionNode(state);
      this.volumesSectionNodes.set(state, node);
    }
    return node;
  }

  /** Trailing error / loading / empty message for a ListState-backed list. */
  private listStatusNodes(
    list: ListState<unknown>,
    count: number,
    idPrefix: string,
    loadingMessage: string,
    emptyMessage: string
  ): TreeNode[] {
    if (list.error) {
      return [new MessageNode(list.error, `${idPrefix}:error`)];
    }
    if (list.loading && !list.loaded) {
      return [new MessageNode(loadingMessage, undefined, true)];
    }
    if (list.loaded && count === 0) {
      return [new MessageNode(emptyMessage, `${idPrefix}:empty`)];
    }
    return [];
  }

  private volumeNode(region: string, volume: Ec2Volume): VolumeNode {
    let node = this.volumeNodes.get(volume);
    if (!node) {
      node = new VolumeNode(region, volume);
      this.volumeNodes.set(volume, node);
    }
    return node;
  }

  private resourceSectionNode(state: RegionState, section: ResourceSectionKind): ResourceSectionNode {
    let nodes = this.resourceSectionNodes.get(state);
    if (!nodes) {
      nodes = new Map();
      this.resourceSectionNodes.set(state, nodes);
    }
    let node = nodes.get(section);
    if (!node) {
      node = new ResourceSectionNode(state, section);
      nodes.set(section, node);
    }
    return node;
  }

  private repositoryNode(state: RegionState, repository: EcrRepository): RepositoryNode {
    let node = this.repositoryNodes.get(repository);
    if (!node) {
      node = new RepositoryNode(state, repository);
      this.repositoryNodes.set(repository, node);
    }
    return node;
  }

  private async refreshExpandedResourceSections(state: RegionState): Promise<void> {
    for (const section of RESOURCE_SECTIONS) {
      if (this.expandedNodeKeys.has(`${section}:${state.region}`)) {
        await this.loadResourceSection(state, section, true);
      }
    }
    for (const repository of state.repositories.items) {
      if (this.expandedNodeKeys.has(`repository:${state.region}:${repository.name}`)) {
        await this.loadImages(this.repositoryNode(state, repository), true);
      }
    }
  }

  /**
   * Generic paged loader: follows nextToken until exhausted, merges into the
   * existing items by key (keeping object identity so tree nodes stay stable),
   * drops items no longer returned, and fires `fire` after each page.
   */
  private async loadList<T extends object>(
    list: ListState<T>,
    fetchPage: (nextToken?: string) => Promise<ResourcePage<T>>,
    keyOf: (item: T) => string,
    fire: () => void,
    reload: boolean
  ): Promise<void> {
    if (list.loading || (list.loaded && !reload)) {
      return;
    }
    const version = ++list.version;
    const seen = new Set<string>();
    list.loading = true;
    list.error = undefined;
    if (reload) {
      fire();
    }
    try {
      let nextToken: string | undefined;
      do {
        const page = await fetchPage(nextToken);
        if (version !== list.version) {
          return;
        }
        const existingByKey = new Map(list.items.map((item) => [keyOf(item), item]));
        for (const incoming of page.items) {
          const key = keyOf(incoming);
          seen.add(key);
          const existing = existingByKey.get(key);
          if (existing) {
            Object.assign(existing, incoming);
          } else {
            list.items.push(incoming);
          }
        }
        nextToken = page.nextToken;
        fire();
      } while (nextToken);
      list.items = list.items.filter((item) => seen.has(keyOf(item)));
      list.loaded = true;
    } catch (err) {
      if (version === list.version) {
        list.error = errorMessage(err);
      }
    } finally {
      if (version === list.version) {
        list.loading = false;
        fire();
      }
    }
  }

  private loadResourceSection(
    state: RegionState,
    section: ResourceSectionKind,
    reload = false
  ): Promise<void> {
    const options = { ...this.awsOptions, region: state.region };
    const fire = () => this._onDidChangeTreeData.fire(this.resourceSectionNode(state, section));
    switch (section) {
      case "snapshots":
        return this.loadList(
          state.snapshots,
          (token) => listEc2SnapshotsPage(options, token),
          (s) => s.id,
          fire,
          reload
        );
      case "repositories":
        return this.loadList(
          state.repositories,
          (token) => listEcrRepositoriesPage(options, token),
          (r) => r.name,
          fire,
          reload
        );
      case "addresses":
        return this.loadList(
          state.addresses,
          () => listEc2Addresses(options),
          (a) => a.allocationId ?? a.publicIp,
          fire,
          reload
        );
    }
  }

  private loadImages(node: RepositoryNode, reload = false): Promise<void> {
    const canonical = this.repositoryNode(node.region, node.repository);
    return this.loadList(
      canonical.images,
      (token) =>
        listEcrImagesPage(
          { ...this.awsOptions, region: node.region.region },
          node.repository.name,
          token
        ),
      (image) => image.digest,
      () => this._onDidChangeTreeData.fire(canonical),
      reload
    );
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
      case "volumesSection":
        return `volumes:${node.state.region}`;
      case "resourceSection":
        return `${node.section}:${node.state.region}`;
      case "repository":
        return `repository:${node.region.region}:${node.repository.name}`;
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

  /** Loads EBS volume pages (attachment instance IDs come back in the same response). */
  private async loadVolumes(state: RegionState, reload = false): Promise<void> {
    if (state.volumesLoading || (state.volumesLoaded && !reload)) {
      return;
    }
    if (reload) {
      state.volumesVersion++;
      state.volumesNextToken = undefined;
    }
    const version = state.volumesVersion;
    const seen = new Set<string>();
    state.volumesLoading = true;
    state.volumesError = undefined;
    const fire = () => this._onDidChangeTreeData.fire(this.volumesSectionNode(state));
    if (reload) {
      fire();
    }
    try {
      do {
        const page = await listEc2VolumesPage(
          { ...this.awsOptions, region: state.region },
          state.volumesNextToken
        );
        if (version !== state.volumesVersion) {
          return;
        }
        const existingById = new Map(state.volumes.map((volume) => [volume.id, volume]));
        for (const incoming of page.volumes) {
          seen.add(incoming.id);
          const existing = existingById.get(incoming.id);
          if (existing) {
            Object.assign(existing, incoming);
          } else {
            state.volumes.push(incoming);
          }
        }
        state.volumesNextToken = page.nextToken;
        fire();
      } while (state.volumesNextToken);
      if (version === state.volumesVersion) {
        state.volumes = state.volumes.filter((volume) => seen.has(volume.id));
        state.volumesLoaded = true;
      }
    } catch (err) {
      if (version === state.volumesVersion) {
        state.volumesError = errorMessage(err);
      }
    } finally {
      if (version === state.volumesVersion) {
        state.volumesLoading = false;
        fire();
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
          descriptions.push(`${this.instanceCount(state)} instances`);
        }
        if (state.volumesLoaded) {
          descriptions.push(`${state.volumes.length} volumes`);
        }
        for (const section of RESOURCE_SECTIONS) {
          const list = state.list(section);
          if (list.loaded) {
            descriptions.push(`${list.items.length} ${RESOURCE_SECTION_META[section].noun}`);
          }
        }
        item.description = descriptions.join(" · ");
        return item;
      }
      case "volumesSection": {
        const state = node.state;
        const item = new vscode.TreeItem("EBS volumes", vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `volumes:${state.region}`;
        item.iconPath = state.volumesLoading && state.volumesLoaded
          ? new vscode.ThemeIcon("loading~spin")
          : new vscode.ThemeIcon("database");
        item.contextValue = "volumesSection";
        item.description = state.volumesLoaded ? `${state.volumes.length}` : undefined;
        return item;
      }
      case "volume": {
        const volume = node.volume;
        const label = volume.name ? `${volume.name} (${volume.id})` : volume.id;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = `volume:${node.region}:${volume.id}`;
        item.iconPath = volumeIcon(volume);
        item.contextValue = volume.attachedInstanceIds.length > 0 ? "volumeAttached" : "volume";
        item.description = [
          volume.state,
          volume.sizeGiB !== undefined ? `${volume.sizeGiB} GiB` : undefined,
          volume.attachedInstanceIds.length > 0
            ? `→ ${volume.attachedInstanceIds.join(", ")}`
            : "unattached",
        ]
          .filter(Boolean)
          .join(" · ");
        item.tooltip = this.volumeTooltip(volume);
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
        const hiding = this.hideTerminated();
        item.contextValue = hiding ? "instancesSection.hidingTerminated" : "instancesSection";
        item.description = state.instancesLoaded ? this.instanceCount(state) : undefined;
        item.tooltip = hiding
          ? "Terminated instances are hidden for this profile (visible/total)"
          : undefined;
        return item;
      }
      case "resourceSection": {
        const state = node.state;
        const list = state.list(node.section);
        const meta = RESOURCE_SECTION_META[node.section];
        const item = new vscode.TreeItem(meta.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `${node.section}:${state.region}`;
        item.iconPath = list.loading && list.loaded
          ? new vscode.ThemeIcon("loading~spin")
          : new vscode.ThemeIcon(meta.icon);
        item.contextValue = "resourceSection";
        item.description = list.loaded ? `${list.items.length}` : undefined;
        return item;
      }
      case "snapshot": {
        const snapshot = node.snapshot;
        const label = snapshot.name ? `${snapshot.name} (${snapshot.id})` : snapshot.id;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = `snapshot:${node.region}:${snapshot.id}`;
        item.iconPath = snapshotIcon(snapshot);
        item.contextValue = "snapshot";
        item.description = [
          snapshot.state === "pending" && snapshot.progress
            ? `pending ${snapshot.progress}`
            : snapshot.state,
          snapshot.volumeSizeGiB !== undefined ? `${snapshot.volumeSizeGiB} GiB` : undefined,
          formatRelativeTime(snapshot.startTime),
        ]
          .filter(Boolean)
          .join(" · ");
        item.tooltip = this.snapshotTooltip(snapshot);
        return item;
      }
      case "repository": {
        const repository = node.repository;
        const images = node.images;
        const item = new vscode.TreeItem(repository.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `repository:${node.region.region}:${repository.name}`;
        item.iconPath = images.loading && images.loaded
          ? new vscode.ThemeIcon("loading~spin")
          : new vscode.ThemeIcon("package");
        item.contextValue = "repository";
        item.description = images.loaded ? `${images.items.length} images` : undefined;
        item.tooltip = this.repositoryTooltip(repository);
        return item;
      }
      case "image": {
        const image = node.image;
        const label = image.tags.length > 0 ? image.tags.join(", ") : "<untagged>";
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = `image:${node.region}:${node.repository.name}:${image.digest}`;
        item.iconPath = new vscode.ThemeIcon(
          "tag",
          image.tags.length > 0 ? undefined : new vscode.ThemeColor("disabledForeground")
        );
        item.contextValue = "image";
        item.description = [
          shortDigest(image.digest),
          formatBytes(image.sizeBytes),
          formatRelativeTime(image.pushedAt),
        ]
          .filter(Boolean)
          .join(" · ");
        item.tooltip = this.imageTooltip(node);
        return item;
      }
      case "address": {
        const address = node.address;
        const label = address.name ? `${address.name} (${address.publicIp})` : address.publicIp;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = `address:${node.region}:${address.allocationId ?? address.publicIp}`;
        const attached = !!(address.associationId || address.instanceId || address.networkInterfaceId);
        item.iconPath = new vscode.ThemeIcon(
          "globe",
          new vscode.ThemeColor(attached ? "testing.iconPassed" : "disabledForeground")
        );
        item.contextValue = attached ? "addressAttached" : "address";
        item.description = attached ? `→ ${addressTargetSummary(address)}` : "unassociated";
        item.tooltip = this.addressTooltip(address);
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

  private snapshotTooltip(snapshot: Ec2Snapshot): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${snapshot.name ?? snapshot.id}**\n\n`);
    markdown.appendMarkdown(`- Snapshot ID: ${snapshot.id}\n`);
    markdown.appendMarkdown(`- State: ${snapshot.state ?? "unknown"}${snapshot.progress ? ` (${snapshot.progress})` : ""}\n`);
    if (snapshot.volumeId) markdown.appendMarkdown(`- Source volume: ${snapshot.volumeId}\n`);
    if (snapshot.volumeSizeGiB !== undefined) markdown.appendMarkdown(`- Size: ${snapshot.volumeSizeGiB} GiB\n`);
    if (snapshot.startTime) markdown.appendMarkdown(`- Started: ${new Date(snapshot.startTime).toLocaleString()}\n`);
    if (snapshot.storageTier) markdown.appendMarkdown(`- Storage tier: ${snapshot.storageTier}\n`);
    if (snapshot.encrypted !== undefined) markdown.appendMarkdown(`- Encrypted: ${snapshot.encrypted ? "yes" : "no"}\n`);
    if (snapshot.description) markdown.appendText(`\n${snapshot.description}\n`);
    return markdown;
  }

  private repositoryTooltip(repository: EcrRepository): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${repository.name}**\n\n`);
    if (repository.uri) markdown.appendMarkdown(`- URI: ${repository.uri}\n`);
    if (repository.createdAt) markdown.appendMarkdown(`- Created: ${new Date(repository.createdAt).toLocaleString()}\n`);
    if (repository.tagMutability) markdown.appendMarkdown(`- Tag mutability: ${repository.tagMutability}\n`);
    if (repository.scanOnPush !== undefined) markdown.appendMarkdown(`- Scan on push: ${repository.scanOnPush ? "yes" : "no"}\n`);
    if (repository.encryptionType) markdown.appendMarkdown(`- Encryption: ${repository.encryptionType}\n`);
    return markdown;
  }

  private imageTooltip(node: ImageNode): vscode.MarkdownString {
    const image = node.image;
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${node.repository.name}**\n\n`);
    markdown.appendMarkdown(`- Tags: ${image.tags.length > 0 ? image.tags.join(", ") : "untagged"}\n`);
    markdown.appendMarkdown(`- Digest: ${image.digest}\n`);
    markdown.appendMarkdown(`- URI: ${node.uri}\n`);
    if (image.sizeBytes !== undefined) markdown.appendMarkdown(`- Size: ${formatBytes(image.sizeBytes)}\n`);
    if (image.pushedAt) markdown.appendMarkdown(`- Pushed: ${new Date(image.pushedAt).toLocaleString()}\n`);
    if (image.lastPulledAt) markdown.appendMarkdown(`- Last pulled: ${new Date(image.lastPulledAt).toLocaleString()}\n`);
    if (image.scanStatus) markdown.appendMarkdown(`- Scan: ${image.scanStatus}\n`);
    if (image.mediaType) markdown.appendMarkdown(`- Media type: ${image.mediaType}\n`);
    return markdown;
  }

  private addressTooltip(address: Ec2Address): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${address.name ?? address.publicIp}**\n\n`);
    markdown.appendMarkdown(`- Public IP: ${address.publicIp}\n`);
    if (address.allocationId) markdown.appendMarkdown(`- Allocation ID: ${address.allocationId}\n`);
    if (address.domain) markdown.appendMarkdown(`- Domain: ${address.domain}\n`);
    if (address.networkBorderGroup) markdown.appendMarkdown(`- Network border group: ${address.networkBorderGroup}\n`);
    markdown.appendMarkdown(`\n**Attachment**\n\n`);
    if (!address.associationId && !address.instanceId && !address.networkInterfaceId) {
      markdown.appendMarkdown(`- Not associated\n`);
      return markdown;
    }
    if (address.instanceId) {
      markdown.appendMarkdown(`- Instance: ${address.instanceId}${address.instanceName ? ` (${address.instanceName})` : ""}\n`);
    }
    if (address.networkInterfaceId) markdown.appendMarkdown(`- Network interface: ${address.networkInterfaceId}\n`);
    if (address.interfaceType) markdown.appendMarkdown(`- Interface type: ${address.interfaceType}\n`);
    if (address.interfaceDescription) markdown.appendMarkdown(`- Interface description: ${address.interfaceDescription}\n`);
    if (address.privateIp) markdown.appendMarkdown(`- Private IP: ${address.privateIp}\n`);
    if (address.vpcId) markdown.appendMarkdown(`- VPC: ${address.vpcId}\n`);
    if (address.subnetId) markdown.appendMarkdown(`- Subnet: ${address.subnetId}\n`);
    if (address.associationId) markdown.appendMarkdown(`- Association ID: ${address.associationId}\n`);
    if (address.networkInterfaceOwnerId) markdown.appendMarkdown(`- ENI owner: ${address.networkInterfaceOwnerId}\n`);
    return markdown;
  }

  private volumeTooltip(volume: Ec2Volume): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${volume.name ?? volume.id}**\n\n`);
    markdown.appendMarkdown(`- Volume ID: ${volume.id}\n`);
    markdown.appendMarkdown(`- State: ${volume.state ?? "unknown"}\n`);
    if (volume.sizeGiB !== undefined) markdown.appendMarkdown(`- Size: ${volume.sizeGiB} GiB\n`);
    if (volume.volumeType) markdown.appendMarkdown(`- Type: ${volume.volumeType}\n`);
    if (volume.iops !== undefined) markdown.appendMarkdown(`- IOPS: ${volume.iops}\n`);
    if (volume.availabilityZone) markdown.appendMarkdown(`- Availability Zone: ${volume.availabilityZone}\n`);
    if (volume.encrypted !== undefined) markdown.appendMarkdown(`- Encrypted: ${volume.encrypted ? "yes" : "no"}\n`);
    if (volume.attachedInstanceIds.length > 0) {
      volume.attachedInstanceIds.forEach((id, i) => {
        const device = volume.attachmentDevices[i];
        markdown.appendMarkdown(`- Attached to: ${id}${device ? ` (${device})` : ""}\n`);
      });
    } else {
      markdown.appendMarkdown(`- Attached to: none\n`);
    }
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
        this.volumesSectionNode(element.state),
        ...RESOURCE_SECTIONS.map((section) => this.resourceSectionNode(element.state, section)),
      ];
    }

    if (element.kind === "resourceSection") {
      const state = element.state;
      const section = element.section;
      const list = state.list(section);
      if (!list.loaded && !list.loading) {
        void this.loadResourceSection(state, section);
      }
      let nodes: TreeNode[];
      switch (section) {
        case "snapshots":
          nodes = [...state.snapshots.items]
            .sort((a, b) => timeOf(b.startTime) - timeOf(a.startTime))
            .map((snapshot) => new SnapshotNode(state.region, snapshot));
          break;
        case "repositories":
          nodes = [...state.repositories.items]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((repository) => this.repositoryNode(state, repository));
          break;
        case "addresses":
          nodes = state.addresses.items.map((address) => new AddressNode(state.region, address));
          break;
      }
      const meta = RESOURCE_SECTION_META[section];
      return [...nodes, ...this.listStatusNodes(list, nodes.length, `${section}:${state.region}`, meta.loading, meta.empty)];
    }

    if (element.kind === "repository") {
      const repository = this.repositoryNode(element.region, element.repository);
      const images = repository.images;
      if (!images.loaded && !images.loading) {
        void this.loadImages(repository);
      }
      const nodes: TreeNode[] = [...images.items]
        .sort((a, b) => timeOf(b.pushedAt) - timeOf(a.pushedAt))
        .map((image) => new ImageNode(element.region.region, element.repository, image));
      return [
        ...nodes,
        ...this.listStatusNodes(
          images,
          nodes.length,
          `images:${element.region.region}:${element.repository.name}`,
          "Loading images…",
          "No images in this repository."
        ),
      ];
    }

    if (element.kind === "volumesSection") {
      const state = element.state;
      if (!state.volumesLoaded && !state.volumesLoading) {
        void this.loadVolumes(state);
      }
      const nodes: TreeNode[] = state.volumes.map((volume) =>
        this.volumeNode(state.region, volume)
      );
      if (state.volumesError) {
        nodes.push(new MessageNode(state.volumesError, `volumes-error:${state.region}`));
      } else if (state.volumesLoading && !state.volumesLoaded) {
        nodes.push(new MessageNode("Loading EBS volumes…", undefined, true));
      } else if (state.volumesLoaded && nodes.length === 0) {
        nodes.push(new MessageNode("No EBS volumes in this region.", `volumes-empty:${state.region}`));
      }
      return nodes;
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
      const nodes: TreeNode[] = this.visibleInstances(state).map((instance) =>
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

const RESOURCE_SECTIONS: ResourceSectionKind[] = ["snapshots", "repositories", "addresses"];

const RESOURCE_SECTION_META: Record<
  ResourceSectionKind,
  { label: string; icon: string; noun: string; loading: string; empty: string }
> = {
  snapshots: {
    label: "EBS snapshots",
    icon: "history",
    noun: "snapshots",
    loading: "Loading EBS snapshots…",
    empty: "No EBS snapshots owned by this account in this region.",
  },
  repositories: {
    label: "ECR repositories",
    icon: "archive",
    noun: "repositories",
    loading: "Loading ECR repositories…",
    empty: "No ECR repositories in this region.",
  },
  addresses: {
    label: "Elastic IPs",
    icon: "globe",
    noun: "elastic IPs",
    loading: "Loading Elastic IPs…",
    empty: "No Elastic IPs in this region.",
  },
};

function timeOf(iso?: string): number {
  const time = iso ? new Date(iso).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

function formatBytes(bytes?: number): string | undefined {
  if (bytes === undefined) {
    return undefined;
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function shortDigest(digest: string): string {
  const hash = digest.includes(":") ? digest.split(":")[1] : digest;
  return hash.slice(0, 12);
}

function snapshotIcon(snapshot: Ec2Snapshot): vscode.ThemeIcon {
  switch (snapshot.state) {
    case "completed":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    case "pending":
      return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("testing.iconQueued"));
    case "error":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    default:
      return new vscode.ThemeIcon("history");
  }
}

/** Short "what is this EIP attached to" text for the tree row. */
function addressTargetSummary(address: Ec2Address): string {
  if (address.instanceId) {
    return address.instanceName ? `${address.instanceName} (${address.instanceId})` : address.instanceId;
  }
  if (address.interfaceType && address.interfaceType !== "interface") {
    return `${address.interfaceType} (${address.networkInterfaceId ?? "unknown ENI"})`;
  }
  if (address.interfaceDescription) {
    return address.interfaceDescription;
  }
  return address.networkInterfaceId ?? address.associationId ?? "associated";
}

function volumeIcon(volume: Ec2Volume): vscode.ThemeIcon {
  if (volume.state === "error") {
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
  }
  if (volume.attachedInstanceIds.length > 0) {
    return new vscode.ThemeIcon("database", new vscode.ThemeColor("testing.iconPassed"));
  }
  return new vscode.ThemeIcon("database", new vscode.ThemeColor("disabledForeground"));
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
