import { execFile } from "child_process";

/**
 * Thin wrapper around the locally installed AWS CLI for CodeBuild and EC2.
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

export interface ListProjectsPage {
  projects: string[];
  nextToken?: string;
}

export interface Ec2HealthCheck {
  status?: string;
  detail?: string;
}

export interface Ec2Instance {
  id: string;
  name?: string;
  state?: string;
  instanceType?: string;
  availabilityZone?: string;
  privateIp?: string;
  publicIp?: string;
  systemCheck?: Ec2HealthCheck;
  instanceCheck?: Ec2HealthCheck;
  ebsCheck?: Ec2HealthCheck;
  /** True once describe-instance-status has answered for this instance. */
  healthLoaded?: boolean;
}

export interface Ec2InstancesPage {
  instances: Ec2Instance[];
  nextToken?: string;
}

export interface Ec2Volume {
  id: string;
  name?: string;
  state?: string;
  sizeGiB?: number;
  volumeType?: string;
  availabilityZone?: string;
  encrypted?: boolean;
  iops?: number;
  /** Instance IDs this volume is attached to (more than one only for Multi-Attach). */
  attachedInstanceIds: string[];
  attachmentDevices: string[];
}

export interface Ec2VolumesPage {
  volumes: Ec2Volume[];
  nextToken?: string;
}

/** Generic page shape used by the simpler list sections. */
export interface ResourcePage<T> {
  items: T[];
  nextToken?: string;
}

export interface Ec2Snapshot {
  id: string;
  name?: string;
  description?: string;
  state?: string;
  progress?: string;
  startTime?: string;
  volumeId?: string;
  volumeSizeGiB?: number;
  encrypted?: boolean;
  storageTier?: string;
}

export interface EcrRepository {
  name: string;
  uri?: string;
  arn?: string;
  createdAt?: string;
  tagMutability?: string;
  scanOnPush?: boolean;
  encryptionType?: string;
}

export interface EcrImage {
  digest: string;
  tags: string[];
  sizeBytes?: number;
  pushedAt?: string;
  lastPulledAt?: string;
  scanStatus?: string;
  mediaType?: string;
}

export interface Ec2Address {
  publicIp: string;
  allocationId?: string;
  associationId?: string;
  name?: string;
  domain?: string;
  networkBorderGroup?: string;
  instanceId?: string;
  networkInterfaceId?: string;
  networkInterfaceOwnerId?: string;
  privateIp?: string;
  /** Resolved from describe-network-interfaces / describe-instances. */
  instanceName?: string;
  interfaceType?: string;
  interfaceDescription?: string;
  vpcId?: string;
  subnetId?: string;
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

/** Lists named profiles known to the AWS CLI. Returns [] if none or on failure. */
export function listProfiles(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      AWS_COMMAND,
      ["configure", "list-profiles"],
      { windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        );
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

/** Starts a new build for the specified CodeBuild project. */
export async function startBuild(
  options: AwsOptions,
  projectName: string
): Promise<CodeBuildBuild | undefined> {
  const stdout = await runAws(
    ["codebuild", "start-build", "--project-name", projectName],
    options
  );
  const parsed = JSON.parse(stdout || "{}");
  return parsed.build as CodeBuildBuild | undefined;
}

export async function listProjectsPage(
  options: AwsOptions,
  nextToken?: string
): Promise<ListProjectsPage> {
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
  return {
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    nextToken: parsed.nextToken || undefined,
  };
}

/** Lists every CodeBuild project name in a region (following pagination). */
export async function listAllProjects(options: AwsOptions): Promise<string[]> {
  const projects: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await listProjectsPage(options, nextToken);
    projects.push(...page.projects);
    nextToken = page.nextToken;
  } while (nextToken);
  return projects;
}

function healthCheck(status: any): Ec2HealthCheck | undefined {
  if (!status) {
    return undefined;
  }
  return {
    status: status.Status,
    detail: Array.isArray(status.Details) ? status.Details[0]?.Status : undefined,
  };
}

function ec2Instance(raw: any): Ec2Instance {
  const name = Array.isArray(raw.Tags)
    ? raw.Tags.find((tag: any) => tag.Key === "Name")?.Value
    : undefined;
  return {
    id: raw.InstanceId,
    name,
    state: raw.State?.Name,
    instanceType: raw.InstanceType,
    availabilityZone: raw.Placement?.AvailabilityZone,
    privateIp: raw.PrivateIpAddress,
    publicIp: raw.PublicIpAddress,
  };
}

/** Lists one EC2 describe-instances page, flattened across reservations. */
export async function listEc2InstancesPage(
  options: AwsOptions,
  nextToken?: string
): Promise<Ec2InstancesPage> {
  const args = ["ec2", "describe-instances", "--max-results", "100"];
  if (nextToken) {
    args.push("--next-token", nextToken);
  }
  const stdout = await runAws(args, options);
  const parsed = JSON.parse(stdout || "{}");
  const instances = Array.isArray(parsed.Reservations)
    ? parsed.Reservations.flatMap((reservation: any) =>
        Array.isArray(reservation.Instances) ? reservation.Instances.map(ec2Instance) : []
      )
    : [];
  return { instances, nextToken: parsed.NextToken || parsed.nextToken || undefined };
}

/**
 * Lists one EBS describe-volumes page. Each volume's Attachments already carry
 * the InstanceId, so no per-volume or per-instance lookups are required.
 */
export async function listEc2VolumesPage(
  options: AwsOptions,
  nextToken?: string
): Promise<Ec2VolumesPage> {
  const args = ["ec2", "describe-volumes", "--max-results", "500"];
  if (nextToken) {
    args.push("--next-token", nextToken);
  }
  const stdout = await runAws(args, options);
  const parsed = JSON.parse(stdout || "{}");
  const volumes: Ec2Volume[] = Array.isArray(parsed.Volumes)
    ? parsed.Volumes.map((raw: any): Ec2Volume => {
        const attachments: any[] = Array.isArray(raw.Attachments) ? raw.Attachments : [];
        return {
          id: raw.VolumeId,
          name: Array.isArray(raw.Tags)
            ? raw.Tags.find((tag: any) => tag.Key === "Name")?.Value
            : undefined,
          state: raw.State,
          sizeGiB: raw.Size,
          volumeType: raw.VolumeType,
          availabilityZone: raw.AvailabilityZone,
          encrypted: raw.Encrypted,
          iops: raw.Iops,
          attachedInstanceIds: attachments.map((a) => a.InstanceId).filter(Boolean),
          attachmentDevices: attachments.map((a) => a.Device).filter(Boolean),
        };
      })
    : [];
  return { volumes, nextToken: parsed.NextToken || parsed.nextToken || undefined };
}

function nameTag(tags: any): string | undefined {
  return Array.isArray(tags) ? tags.find((tag: any) => tag.Key === "Name")?.Value : undefined;
}

/** CLI v1 may emit epoch seconds for timestamps; normalise to ISO strings. */
function isoTime(value: any): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "number") {
    return new Date(value * 1000).toISOString();
  }
  return String(value);
}

/** Lists one page of EBS snapshots owned by this account (public snapshots are excluded). */
export async function listEc2SnapshotsPage(
  options: AwsOptions,
  nextToken?: string
): Promise<ResourcePage<Ec2Snapshot>> {
  const args = ["ec2", "describe-snapshots", "--owner-ids", "self", "--max-results", "1000"];
  if (nextToken) {
    args.push("--next-token", nextToken);
  }
  const stdout = await runAws(args, options);
  const parsed = JSON.parse(stdout || "{}");
  const items: Ec2Snapshot[] = Array.isArray(parsed.Snapshots)
    ? parsed.Snapshots.map((raw: any): Ec2Snapshot => ({
        id: raw.SnapshotId,
        name: nameTag(raw.Tags),
        description: raw.Description || undefined,
        state: raw.State,
        progress: raw.Progress,
        startTime: isoTime(raw.StartTime),
        volumeId: raw.VolumeId,
        volumeSizeGiB: raw.VolumeSize,
        encrypted: raw.Encrypted,
        storageTier: raw.StorageTier,
      }))
    : [];
  return { items, nextToken: parsed.NextToken || undefined };
}

/** Lists one page of ECR repositories in the region. */
export async function listEcrRepositoriesPage(
  options: AwsOptions,
  nextToken?: string
): Promise<ResourcePage<EcrRepository>> {
  const args = ["ecr", "describe-repositories", "--max-results", "1000"];
  if (nextToken) {
    args.push("--next-token", nextToken);
  }
  const stdout = await runAws(args, options);
  const parsed = JSON.parse(stdout || "{}");
  const items: EcrRepository[] = Array.isArray(parsed.repositories)
    ? parsed.repositories.map((raw: any): EcrRepository => ({
        name: raw.repositoryName,
        uri: raw.repositoryUri,
        arn: raw.repositoryArn,
        createdAt: isoTime(raw.createdAt),
        tagMutability: raw.imageTagMutability,
        scanOnPush: raw.imageScanningConfiguration?.scanOnPush,
        encryptionType: raw.encryptionConfiguration?.encryptionType,
      }))
    : [];
  return { items, nextToken: parsed.nextToken || parsed.NextToken || undefined };
}

/** Lists one page of images in an ECR repository. */
export async function listEcrImagesPage(
  options: AwsOptions,
  repositoryName: string,
  nextToken?: string
): Promise<ResourcePage<EcrImage>> {
  const args = [
    "ecr",
    "describe-images",
    "--repository-name",
    repositoryName,
    "--max-results",
    "1000",
  ];
  if (nextToken) {
    args.push("--next-token", nextToken);
  }
  const stdout = await runAws(args, options);
  const parsed = JSON.parse(stdout || "{}");
  const items: EcrImage[] = Array.isArray(parsed.imageDetails)
    ? parsed.imageDetails.map((raw: any): EcrImage => ({
        digest: raw.imageDigest,
        tags: Array.isArray(raw.imageTags) ? raw.imageTags : [],
        sizeBytes: raw.imageSizeInBytes,
        pushedAt: isoTime(raw.imagePushedAt),
        lastPulledAt: isoTime(raw.lastRecordedPullTime),
        scanStatus: raw.imageScanStatus?.status,
        mediaType: raw.artifactMediaType ?? raw.imageManifestMediaType,
      }))
    : [];
  return { items, nextToken: parsed.nextToken || parsed.NextToken || undefined };
}

/**
 * Lists Elastic IPs (describe-addresses is not paginated), then enriches
 * associated ones with at most two batched lookups: one describe-network-interfaces
 * for the attached ENIs (type, description, VPC/subnet, owning instance) and one
 * describe-instances for the Name tags of attached instances.
 */
export async function listEc2Addresses(options: AwsOptions): Promise<ResourcePage<Ec2Address>> {
  const stdout = await runAws(["ec2", "describe-addresses"], options);
  const parsed = JSON.parse(stdout || "{}");
  const items: Ec2Address[] = Array.isArray(parsed.Addresses)
    ? parsed.Addresses.map((raw: any): Ec2Address => ({
        publicIp: raw.PublicIp ?? raw.CarrierIp ?? raw.AllocationId,
        allocationId: raw.AllocationId,
        associationId: raw.AssociationId,
        name: nameTag(raw.Tags),
        domain: raw.Domain,
        networkBorderGroup: raw.NetworkBorderGroup,
        instanceId: raw.InstanceId || undefined,
        networkInterfaceId: raw.NetworkInterfaceId || undefined,
        networkInterfaceOwnerId: raw.NetworkInterfaceOwnerId,
        privateIp: raw.PrivateIpAddress,
      }))
    : [];

  // Enrichment is best effort: a missing permission should not hide the IPs.
  const eniIds = [...new Set(items.map((a) => a.networkInterfaceId).filter(Boolean) as string[])];
  if (eniIds.length > 0) {
    try {
      const eniOut = await runAws(
        ["ec2", "describe-network-interfaces", "--filters", `Name=network-interface-id,Values=${eniIds.join(",")}`],
        options
      );
      const enis = JSON.parse(eniOut || "{}").NetworkInterfaces ?? [];
      const byId = new Map<string, any>(enis.map((eni: any) => [eni.NetworkInterfaceId, eni]));
      for (const address of items) {
        const eni = address.networkInterfaceId ? byId.get(address.networkInterfaceId) : undefined;
        if (!eni) {
          continue;
        }
        address.interfaceType = eni.InterfaceType;
        address.interfaceDescription = eni.Description || undefined;
        address.vpcId = eni.VpcId;
        address.subnetId = eni.SubnetId;
        address.instanceId ??= eni.Attachment?.InstanceId || undefined;
      }
    } catch {
      /* ignore enrichment failures */
    }
  }

  const instanceIds = [...new Set(items.map((a) => a.instanceId).filter(Boolean) as string[])];
  if (instanceIds.length > 0) {
    try {
      // A filter (rather than --instance-ids) does not fail on unknown IDs.
      const instOut = await runAws(
        ["ec2", "describe-instances", "--filters", `Name=instance-id,Values=${instanceIds.join(",")}`],
        options
      );
      const reservations = JSON.parse(instOut || "{}").Reservations ?? [];
      const names = new Map<string, string | undefined>();
      for (const reservation of reservations) {
        for (const instance of reservation.Instances ?? []) {
          names.set(instance.InstanceId, nameTag(instance.Tags));
        }
      }
      for (const address of items) {
        if (address.instanceId) {
          address.instanceName = names.get(address.instanceId);
        }
      }
    } catch {
      /* ignore enrichment failures */
    }
  }

  return { items };
}

/** Returns EC2 system, instance, and attached-EBS status checks by instance ID. */
export async function getEc2InstanceHealth(
  options: AwsOptions,
  instanceIds: string[]
): Promise<Map<string, Pick<Ec2Instance, "systemCheck" | "instanceCheck" | "ebsCheck" | "healthLoaded">>> {
  if (instanceIds.length === 0) {
    return new Map();
  }
  const stdout = await runAws(
    [
      "ec2",
      "describe-instance-status",
      "--include-all-instances",
      "--instance-ids",
      ...instanceIds,
    ],
    options
  );
  const parsed = JSON.parse(stdout || "{}");
  const health = new Map<
    string,
    Pick<Ec2Instance, "systemCheck" | "instanceCheck" | "ebsCheck" | "healthLoaded">
  >();
  // Every requested instance gets an entry so "answered, but no check" (e.g. no
  // attached EBS status) is distinguishable from "not loaded yet".
  for (const id of instanceIds) {
    health.set(id, { healthLoaded: true });
  }
  if (Array.isArray(parsed.InstanceStatuses)) {
    for (const status of parsed.InstanceStatuses) {
      if (!status.InstanceId) {
        continue;
      }
      health.set(status.InstanceId, {
        systemCheck: healthCheck(status.SystemStatus),
        instanceCheck: healthCheck(status.InstanceStatus),
        ebsCheck: healthCheck(status.AttachedEbsStatus),
        healthLoaded: true,
      });
    }
  }
  return health;
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
