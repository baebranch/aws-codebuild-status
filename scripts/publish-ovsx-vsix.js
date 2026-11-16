// Publishes the already-packaged .vsix for the current package.json version to
// Open VSX, so it is the identical artifact uploaded to the VS Marketplace.
// Auth: set OVSX_PAT in the environment (or pass extra args, e.g. -p <token>).
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const pkg = require("../package.json");
const vsix = path.join(__dirname, "..", `${pkg.name}-${pkg.version}.vsix`);

if (!fs.existsSync(vsix)) {
  console.error(`Missing ${path.basename(vsix)}. Run "npm run package" first.`);
  process.exit(1);
}

const result = spawnSync(
  "npx",
  ["ovsx", "publish", vsix, ...process.argv.slice(2)],
  { stdio: "inherit", shell: process.platform === "win32" }
);
process.exit(result.status ?? 1);
