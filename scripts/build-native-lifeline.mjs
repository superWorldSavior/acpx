import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "native", "lifeline.c");
const defaultNativeDir = path.join(repoRoot, "dist", "native");
const supportedTargets = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "arm64"],
  ["linux", "x64"],
];
const targetIds = new Set(supportedTargets.map(([platform, arch]) => `${platform}-${arch}`));
const manifestName = "lifeline-manifest.json";
const schema = "acpx.native-lifeline.v1";
const macosDeploymentTarget = "11.0";

const args = process.argv.slice(2);
const targetArg = optionValue("--target");
const nativeDir = path.resolve(optionValue("--native-dir") ?? defaultNativeDir);
const assemble = args.includes("--assemble");
const check = args.includes("--check");
const clean = args.includes("--clean");

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/build-native-lifeline.mjs [options]

Build one helper for the host (or --target platform-arch), or assemble the
canonical multi-target manifest from already-built helpers.

  --target platform-arch  Build/check one supported target
  --assemble               Require all four helpers and write the manifest
  --check                  Verify helper files and the manifest without building
  --native-dir directory   Use an alternate native output directory
  --clean                  Remove generated native output before building
`);
  process.exit(0);
}

if (clean) {
  rmSync(nativeDir, { recursive: true, force: true });
}

if (assemble) {
  assembleManifest(nativeDir);
} else if (check) {
  checkManifest(nativeDir, targetArg ? [parseTarget(targetArg)] : undefined);
} else {
  const defaultTarget = `${process.env.ACPX_NATIVE_PLATFORM ?? process.platform}-${process.env.ACPX_NATIVE_ARCH ?? process.arch}`;
  if (!targetArg && !targetIds.has(defaultTarget)) {
    console.warn(
      `Native lifeline is unsupported on ${defaultTarget}; skipping local helper build.`,
    );
    process.exit(0);
  }
  const target = parseTarget(targetArg ?? defaultTarget);
  if (target.id !== defaultTarget && process.env.ACPX_ALLOW_CROSS_TARGET !== "1") {
    throw new Error(
      `Refusing to label a ${defaultTarget} binary as ${target.id}; use a matching CI runner or set ACPX_ALLOW_CROSS_TARGET=1 for a real cross compiler`,
    );
  }
  buildTarget(target, nativeDir);
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function parseTarget(value) {
  const match = /^([a-z0-9]+)-([a-z0-9]+)$/.exec(value ?? "");
  if (!match || !targetIds.has(value)) {
    throw new Error(
      `Unsupported lifeline target ${value || "<missing>"}; expected one of ${[...targetIds].join(", ")}`,
    );
  }
  return { id: value, platform: match[1], arch: match[2] };
}

function buildTarget(target, outputDir) {
  if (!existsSync(source)) {
    throw new Error(`Native lifeline source is missing: ${path.relative(repoRoot, source)}`);
  }
  mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, `lifeline-${target.id}`);
  const compiler = process.env.CC ?? "cc";
  const compilerArgs = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output];
  if (target.platform === "linux") {
    compilerArgs.splice(-2, 0, "-static");
  }
  if (target.platform === "darwin") {
    compilerArgs.splice(-2, 0, `-mmacosx-version-min=${macosDeploymentTarget}`);
  }
  const result = spawnSync(compiler, compilerArgs, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  chmodSync(output, 0o755);
  if (target.platform === "linux") {
    assertLinuxHelperIsStatic(output);
  }
  writeManifestForExistingHelpers(outputDir);
  console.log(`Built ${path.relative(repoRoot, output)} for ${target.id} (${sha256(output)})`);
}

function assertLinuxHelperIsStatic(filePath) {
  const result = spawnSync("file", [filePath], { encoding: "utf8" });
  if (
    result.error ||
    result.status !== 0 ||
    !/\bstatic(?:ally linked|-pie linked)\b/i.test(result.stdout)
  ) {
    throw new Error(
      `Linux lifeline helper must be statically linked: ${result.stdout?.trim() || result.stderr?.trim() || filePath}`,
    );
  }
}

function writeManifestForExistingHelpers(outputDir) {
  const helpers = {};
  for (const [platform, arch] of supportedTargets) {
    const id = `${platform}-${arch}`;
    const file = `lifeline-${id}`;
    const filePath = path.join(outputDir, file);
    if (!isRegularFile(filePath)) {
      continue;
    }
    helpers[id] = { file, platform, arch, sha256: sha256(filePath) };
  }
  writeManifest(outputDir, helpers);
}

function assembleManifest(outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const helpers = {};
  for (const [platform, arch] of supportedTargets) {
    const id = `${platform}-${arch}`;
    const file = `lifeline-${id}`;
    const filePath = path.join(outputDir, file);
    if (!isRegularFile(filePath)) {
      throw new Error(`Missing native lifeline helper for ${id}: ${filePath}`);
    }
    chmodSync(filePath, 0o755);
    helpers[id] = { file, platform, arch, sha256: sha256(filePath) };
  }
  writeManifest(outputDir, helpers);
  console.log(`Assembled ${path.relative(repoRoot, path.join(outputDir, manifestName))}`);
}

function checkManifest(outputDir, selectedTargets) {
  const manifestPath = path.join(outputDir, manifestName);
  if (!isRegularFile(manifestPath)) {
    throw new Error(`Missing native lifeline manifest: ${manifestPath}`);
  }
  if (!hasExactMode(manifestPath, 0o644)) {
    throw new Error(`Native lifeline manifest has unexpected mode: ${manifestPath}`);
  }
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (parsed?.schema !== schema || !parsed?.helpers || typeof parsed.helpers !== "object") {
    throw new Error(`Invalid native lifeline manifest schema: ${manifestPath}`);
  }
  const targets = selectedTargets?.length
    ? selectedTargets
    : supportedTargets.map(([platform, arch]) => ({ id: `${platform}-${arch}`, platform, arch }));
  for (const target of targets) {
    const entry = parsed.helpers[target.id];
    if (
      !entry ||
      entry.file !== `lifeline-${target.id}` ||
      entry.platform !== target.platform ||
      entry.arch !== target.arch
    ) {
      throw new Error(`Manifest has no valid entry for ${target.id}`);
    }
    const filePath = path.join(outputDir, entry.file);
    if (
      !isRegularFile(filePath) ||
      !hasExactMode(filePath, 0o755) ||
      sha256(filePath) !== entry.sha256
    ) {
      throw new Error(`Native lifeline helper has invalid mode or digest for ${target.id}`);
    }
  }
  console.log(`Verified ${targets.map((target) => target.id).join(", ")}`);
}

function writeManifest(outputDir, helpers) {
  const sortedHelpers = Object.fromEntries(
    Object.entries(helpers).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  const manifestPath = path.join(outputDir, manifestName);
  writeFileSync(manifestPath, `${JSON.stringify({ schema, helpers: sortedHelpers }, null, 2)}\n`, {
    mode: 0o644,
  });
  chmodSync(manifestPath, 0o644);
}

function hasExactMode(filePath, expectedMode) {
  try {
    return (lstatSync(filePath).mode & 0o777) === expectedMode;
  } catch {
    return false;
  }
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isRegularFile(filePath) {
  try {
    const stat = lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
