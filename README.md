# AWS Build & Compute Status

A VS Code extension that shows AWS CodeBuild builds, EC2 instances, EBS volumes
and snapshots, ECR repositories and images, and Elastic IPs in a regional tree
view. It uses your locally installed and configured AWS CLI, so there are no
credentials to manage inside the extension.

## Requirements

- The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  (`aws`) must be installed and available on your `PATH`.
- AWS authentication must already be configured (e.g. `aws configure`, SSO, or
  environment variables). The extension reuses whatever the CLI uses.

## IAM permissions

The configured AWS identity needs these permissions in each region it will use:

| Area | Permissions |
| --- | --- |
| CodeBuild | `codebuild:ListProjects`, `codebuild:ListBuildsForProject`, `codebuild:BatchGetBuilds`, `codebuild:StartBuild` |
| Build logs | `logs:GetLogEvents` |
| EC2 | `ec2:DescribeInstances`, `ec2:DescribeInstanceStatus` |
| EBS | `ec2:DescribeVolumes`, `ec2:DescribeSnapshots` |
| ECR | `ecr:DescribeRepositories`, `ecr:DescribeImages` |
| Elastic IPs | `ec2:DescribeAddresses`, `ec2:DescribeNetworkInterfaces` (optional, for attachment details) |

Each section loads only when expanded, so you only need the permissions for the
sections you use. Scope permissions to the resources appropriate for your
environment.

## Features

- Tree view in a dedicated **AWS Build & Compute** activity bar container.
- Each region contains **CodeBuild projects**, **EC2 instances**,
  **EBS volumes**, **EBS snapshots**, **ECR repositories**, and **Elastic IPs**
  sections. Data is displayed progressively as each AWS CLI page or detail
  response arrives instead of waiting for every query to finish. Region rows
  summarise the counts of loaded sections.
- **CodeBuild**: projects expand to show their recent build history. Each project
  loads the first 20 builds, with a **Load more…** item to fetch the next page.
  Running builds are sorted to the top, display a spinner, and refresh every 90
  seconds while any loaded project has an active build. Click a build to open
  its CloudWatch logs; right-click a project to **Start Build**.
- **EC2 instances** show their lifecycle state and an overall health indicator.
  Expand an instance to view the AWS status checks: **System**, **Instance**,
  and **Attached EBS** (the EBS check is ignored when not applicable). Right-click
  an instance to **Open Instance in AWS Console** or **Copy Instance ID**.
- **Hide terminated instances**: right-click the EC2 instances section to hide
  or show terminated instances. The choice is remembered per AWS profile across
  workspaces. While hidden, counts show as `visible/total` (e.g. `4/6`).
- **EBS volumes** show name and ID, state, size, and the attached instance ID.
  Hover for type, IOPS, availability zone, encryption, and device names. Copy the
  volume ID inline, or the attached instance ID from the context menu.
- **EBS snapshots** (owned by your account) are listed newest first with state,
  progress, size, and age. Copy the snapshot ID or its source volume ID.
- **ECR repositories** expand to list their images, newest push first, with
  tags, short digest, size, and push time. Hover for last pull and scan status.
  Copy the repository URI, an image URI (`uri:tag`, or `uri@digest` when
  untagged), or an image digest.
- **Elastic IPs** show what each address is attached to: the instance name and
  ID, or the network interface type/description (NAT gateway, load balancer,
  etc.). Hover for allocation/association IDs, private IP, VPC, and subnet. Copy
  the public IP, allocation ID, or attached instance/ENI ID.
- **Profile switcher**: click the account icon in the view title bar to pick any
  profile from `aws configure list-profiles`, or `default`. The choice is pinned
  to the current workspace (saved in `.vscode/settings.json`), so each project
  keeps its own profile. With no folder open it is saved in your user settings.
  The active profile is shown in the view header.
- Refresh button in the view title updates all expanded sections. Every
  expandable tree item also has a right-click **Refresh** action for a scoped
  update. Expanded parents are refreshed in place without collapsing their tree
  paths; the active parent shows a spinner while its existing children remain
  visible.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `awsCodeBuild.regions` | `[]` | Regions to query. If empty, the default region from your AWS CLI config is used. |
| `awsCodeBuild.profile` | `""` | Named AWS CLI profile to use. Empty uses the default profile / environment credentials. The profile picker saves this per workspace. |
| `awsCodeBuild.pageSize` | `20` | Number of builds to load per page, per project (1–100). |

## How it works

Under the hood the extension runs:

- `aws codebuild list-projects` to enumerate projects per region,
- `aws codebuild list-builds-for-project --project-name <name> --sort-order DESCENDING --max-items <pageSize>`
  to get build IDs a page at a time (using the CLI's `--starting-token` for
  pagination),
- `aws codebuild batch-get-builds --ids ...` to fetch details for each page,
- `aws codebuild start-build --project-name <name>` when you start a project from
  its context menu,
- `aws logs get-log-events --log-group-name <g> --log-stream-name <s>` to load a
  build's logs into an editor tab on demand,
- `aws ec2 describe-instances` to progressively list instances by region,
- `aws ec2 describe-instance-status --include-all-instances` to retrieve the
  system, instance, and attached-EBS health checks,
- `aws ec2 describe-volumes` to list volumes (attachment instance IDs are part of
  the same response, so no extra calls are needed),
- `aws ec2 describe-snapshots --owner-ids self` to list your snapshots,
- `aws ecr describe-repositories` and `aws ecr describe-images --repository-name <name>`
  (images load when a repository is expanded),
- `aws ec2 describe-addresses`, followed by at most one batched
  `describe-network-interfaces` and one batched `describe-instances` call to
  resolve what each Elastic IP is attached to, and
- `aws configure list-profiles` to populate the profile picker.

The CLI is invoked with `PYTHONIOENCODING=utf-8` so non-ASCII data doesn't
trigger the Windows `'charmap' codec` encoding error.

Commands are executed with an explicit argument array (no shell), so region
names, project names, and resource IDs cannot be interpreted as shell syntax.

## Develop / run locally

```bash
npm install
npm run compile
```

Then press **F5** in VS Code (Run Extension) to launch an Extension Development
Host with the view available in the activity bar.

## Packaging / publishing

```bash
npm run package   # build a .vsix
npm run publish   # publish to the Marketplace (requires a vsce login)
```
