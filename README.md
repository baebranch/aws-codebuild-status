# AWS CodeBuild Status

A VS Code extension that shows recent AWS CodeBuild build statuses in a tree view
in the side panel, grouped by region. It uses your locally installed and
configured AWS CLI, so there are no credentials to manage inside the extension.

## Requirements

- The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  (`aws`) must be installed and available on your `PATH`.
- AWS authentication must already be configured (e.g. `aws configure`, SSO, or
  environment variables). The extension reuses whatever the CLI uses.

## Features

- Tree view in a dedicated **AWS CodeBuild** activity bar container.
- Three-level hierarchy: **Region → Project → build history**. Expand a region
  to see its CodeBuild projects, then expand a project to see its recent builds.
- Each project loads the first 20 builds, with a **Load more…** item at the
  bottom of its list to fetch the next page. While a page is loading, that item
  turns into a disabled spinner so it can't be clicked again, then returns to a
  normal button when done.
- Running (in‑progress) builds are sorted to the top of each project's list, and
  a project showing active builds displays a spinner with a "N running" badge.
- Status icons (succeeded / failed / in‑progress), relative start time, and a
  rich hover tooltip with build details.
- Click a build to open its CloudWatch logs in a read‑only editor tab (fetched
  via the AWS CLI). "Open in AWS Console" is still available from the right‑click
  menu.
- Refresh button in the view title.

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
- `aws codebuild batch-get-builds --ids ...` to fetch details for each page, and
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

See [PUBLISHING.md](./PUBLISHING.md) for the full first-time setup.
