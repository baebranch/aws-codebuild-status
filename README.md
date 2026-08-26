# AWS Build & Compute Status

A VS Code extension that shows recent AWS CodeBuild builds and EC2 instances in a
regional tree view. It uses your locally installed and configured AWS CLI, so
there are no credentials to manage inside the extension.

## Requirements

- The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  (`aws`) must be installed and available on your `PATH`.
- AWS authentication must already be configured (e.g. `aws configure`, SSO, or
  environment variables). The extension reuses whatever the CLI uses.

## IAM permissions

The configured AWS identity needs these permissions in each region it will use:
`codebuild:ListProjects`, `codebuild:ListBuildsForProject`,
`codebuild:BatchGetBuilds`, `codebuild:StartBuild`, `ec2:DescribeInstances`,
`ec2:DescribeInstanceStatus`, and `logs:GetLogEvents`. Scope permissions to the
CodeBuild projects, EC2 instances, and log streams appropriate for your
environment.

## Features

- Tree view in a dedicated **AWS Build & Compute** activity bar container.
- Each region contains separate **CodeBuild projects** and **EC2 instances**
  sections. Data is displayed progressively as each AWS CLI page or detail
  response arrives instead of waiting for every query to finish.
- CodeBuild projects expand to show their recent build history. Each project
  loads the first 20 builds, with a **Load more…** item to fetch the next page.
- Running (in-progress) builds are sorted to the top, display a spinner, and
  refresh every 90 seconds while any loaded project has an active build.
- EC2 instances show their lifecycle state and an overall health indicator.
  Expand an instance to view the three AWS status checks: **System**,
  **Instance**, and **Attached EBS**.
- Build status icons, relative start times, rich tooltips, log viewing, and
  **Start Build** from a project’s right-click menu.
- Refresh button in the view title updates all expanded regions. Every expandable
  tree item also has a right-click **Refresh** action for a scoped update.
  Expanded parents are refreshed sequentially in place without collapsing their
  tree paths; the active parent shows a spinner while its existing children
  remain visible.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `awsCodeBuild.regions` | `[]` | Regions to query. If empty, the default region from your AWS CLI config is used. |
| `awsCodeBuild.profile` | `""` | Named AWS CLI profile to use. Empty uses the default profile / environment credentials. |
| `awsCodeBuild.pageSize` | `20` | Number of builds to load per page, per region (1–100). |

## How it works

Under the hood the extension runs:

- `aws codebuild list-projects` to enumerate projects per region,
- `aws codebuild list-builds-for-project --project-name <name> --sort-order DESCENDING --max-items <pageSize>`
  to get build IDs a page at a time (using the CLI's `--starting-token` for
  pagination), and
- `aws codebuild batch-get-builds --ids ...` to fetch details for each page,
- `aws codebuild start-build --project-name <name>` when you start a project from
  its context menu,
- `aws ec2 describe-instances` to progressively list instances by region,
- `aws ec2 describe-instance-status --include-all-instances` to retrieve the
  system, instance, and attached-EBS health checks, and
- `aws logs get-log-events --log-group-name <g> --log-stream-name <s>` to load a
  build's logs into an editor tab on demand.

The CLI is invoked with `PYTHONIOENCODING=utf-8` so non-ASCII build data
doesn't trigger the Windows `'charmap' codec` encoding error.

Commands are executed with an explicit argument array (no shell), so region
names, project names, and build IDs cannot be interpreted as shell syntax.

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