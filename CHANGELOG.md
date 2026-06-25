# Change Log

All notable changes to the "AWS CodeBuild Status" extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-25

### Added
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
