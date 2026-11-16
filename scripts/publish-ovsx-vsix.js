// Publishes the already-packaged .vsix for the current package.json version to
// Open VSX, so it is the identical artifact uploaded to the VS Marketplace.
//
// Auth: set OVSX_PAT in the environment (or pass -p <token>).
//
// By default this uploads with Node's built-in fetch to the same endpoint the
// ovsx CLI uses (POST /api/-/publish). ovsx 1.0.2's own upload failed on
// Windows/Node 24 with an opaque "Not enough memory resources" error even
// though the token and package were fine.
//
// Flags:
//   --cli      use `ovsx --debug publish` instead of fetch
//   --trace    with --cli, also log HTTP/socket activity (NODE_DEBUG)
//   --verbose  print response headers and the full response body
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const pkg = require("../package.json");
const vsix = path.join(__dirname, "..", `${pkg.name}-${pkg.version}.vsix`);

const args = process.argv.slice(2);
const flags = new Set(["--cli", "--trace", "--verbose"]);
const useCli = args.includes("--cli");
const trace = args.includes("--trace");
const verbose = args.includes("--verbose");
const passthrough = args.filter((arg) => !flags.has(arg));

if (!fs.existsSync(vsix)) {
  console.error(`Missing ${path.basename(vsix)}. Run "npm run package" first.`);
  process.exit(1);
}

const stat = fs.statSync(vsix);
const header = Buffer.alloc(4);
const fd = fs.openSync(vsix, "r");
fs.readSync(fd, header, 0, 4, 0);
fs.closeSync(fd);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

const patIndex = passthrough.findIndex((a) => a === "-p" || a === "--pat");
const pat = patIndex >= 0 ? passthrough[patIndex + 1] : process.env.OVSX_PAT;
const registry = (process.env.OVSX_REGISTRY_URL || "https://open-vsx.org").replace(/\/+$/, "");

console.log("--- publish diagnostics ---");
console.log(`package:      ${pkg.name}@${pkg.version} (publisher: ${pkg.publisher})`);
console.log(`vsix:         ${vsix}`);
console.log(`vsix size:    ${stat.size} bytes, zip header ${header.toString("hex")} (expect 504b0304)`);
console.log(`node:         ${process.version} on ${process.platform} ${process.arch}`);
console.log(`memory:       ${mb(os.freemem())} free of ${mb(os.totalmem())}`);
console.log(`token:        ${pat ? "provided" : "NOT set (set OVSX_PAT or pass -p)"}`);
console.log(`registry:     ${registry}`);
console.log(`method:       ${useCli ? "ovsx CLI (--debug)" : "fetch (default)"}`);
console.log("---------------------------");

async function publishWithFetch() {
  if (!pat) {
    console.error("Set OVSX_PAT (or pass -p <token>) before publishing.");
    return 1;
  }
  const url = `${registry}/api/-/publish?token=${encodeURIComponent(pat)}`;
  console.log(`POST ${registry}/api/-/publish?token=*** (${stat.size} bytes)`);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: fs.readFileSync(vsix),
    });
    const text = await response.text();
    console.log(`HTTP ${response.status} ${response.statusText}`);
    if (verbose) {
      for (const [key, value] of response.headers) {
        console.log(`  ${key}: ${value}`);
      }
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }

    if (!response.ok || body?.error) {
      console.error(`Publish failed: ${body?.error ?? body?.message ?? text}`);
      return 1;
    }
    console.log(
      `Published ${body?.namespace ?? pkg.publisher}.${body?.name ?? pkg.name} v${body?.version ?? pkg.version}`
    );
    if (body?.warning) {
      console.log(`Warning: ${body.warning}`);
    }
    if (body?.success) {
      console.log(body.success);
    }
    if (verbose) {
      console.log(text);
    }
    console.log(`${registry}/extension/${pkg.publisher}/${pkg.name}`);
    return 0;
  } catch (err) {
    console.error("Request failed:", err, "\ncause:", err.cause);
    return 1;
  }
}

function publishWithCli() {
  const env = { ...process.env };
  if (trace) {
    env.NODE_DEBUG = "http,net,tls";
  }
  // --debug is a global ovsx option, so it must come before the subcommand.
  const result = spawnSync(
    "npx",
    ["ovsx", "--debug", "publish", vsix, ...passthrough],
    { stdio: "inherit", shell: process.platform === "win32", env }
  );
  if (result.error) {
    console.error("Failed to launch ovsx:", result.error);
  }
  console.log(
    `ovsx exited with code ${result.status}${result.signal ? ` (signal ${result.signal})` : ""}`
  );
  return result.status ?? 1;
}

if (useCli) {
  process.exitCode = publishWithCli();
} else {
  // Set exitCode instead of calling process.exit(): exiting while fetch's
  // handles are still closing triggers a libuv assertion on Windows.
  publishWithFetch().then((code) => {
    process.exitCode = code;
  });
}
