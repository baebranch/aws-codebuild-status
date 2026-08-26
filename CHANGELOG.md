# Change Log

All notable changes to the "AWS Build & Compute Status" extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-08-26

### Added

- Progressive tree updates: CodeBuild project pages, build details, EC2 instance
  pages, and instance health checks appear as their AWS CLI responses arrive.
- Regional **EC2 instances** section with instance-state indicators and nested
  system, instance, and attached-EBS health checks.
- Automatic 90-second status refresh while a loaded project has an in-progress
  build.
- Right-click **Refresh** action on every expandable tree item for scoped,
  non-destructive updates.

### Fixed

- Manual refresh now keeps expanded CodeBuild projects and EC2 instances visible
  while their data is updated in place. Expanded sections refresh sequentially;
  refresh spinners appear on the parent whose children are being updated.
- Removed duplicate IDs from transient loading rows.

## [0.2.0] - 2026-08-16

### Added in 0.2.0

- **Start Build** in the project context menu to trigger a new CodeBuild run
  through the configured local AWS CLI profile and selected region.

## [0.1.0] - 2026-06-25

### Added in 0.1.0

- Tree view in a dedicated **AWS CodeBuild** activity bar container.
- Region → Project → build history hierarchy, driven by the local AWS CLI.
- Per-project pagination with a **Load more…** action that shows a disabled
  spinner while a page is loading.
- Running (in-progress) builds sorted to the top of each project's list, with a
  "N running" badge on active projects.
- Click a build to open its CloudWatch logs in a read-only editor tab.
- "Open in AWS Console" command and status-aware icons, relative times, and
  detailed hover tooltips.
- Settings for regions, AWS CLI profile, and page size.
