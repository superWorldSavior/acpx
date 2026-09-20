import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { isChildProcessRunning, waitForChildExit, waitForSpawn } from "./client-process.js";

const ARMED_MESSAGE = "ARMED\n";
const ARMED_TIMEOUT_MS = 1_000;
const MAX_HANDSHAKE_OUTPUT = 128;
const UNARMED_STOP_GRACE_MS = 500;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type LifelineManifestEntry = {
  file?: unknown;
  platform?: unknown;
  arch?: unknown;
  sha256?: unknown;
};

type LifelineManifest = {
  schema?: unknown;
  helpers?: unknown;
};

export type LifelineWatchdog = ChildProcessByStdio<Writable, Readable, Readable>;

export function supportsProcessGroupLifeline(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return (platform === "darwin" || platform === "linux") && (arch === "arm64" || arch === "x64");
}

export function resolvePackagedLifelineHelper(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (!supportsProcessGroupLifeline(platform, arch)) {
    return undefined;
  }

  const packageRoot = findPackageRoot();
  if (!packageRoot) {
    return undefined;
  }
  const nativeDir = path.join(packageRoot, "dist", "native");
  const candidate = path.join(nativeDir, helperFilename(platform, arch));
  return validatePackagedLifelineHelper(candidate, nativeDir, packageRoot, platform, arch)
    ? candidate
    : undefined;
}

export async function startLifelineWatchdog(
  helper: string,
  bridgePgid: number,
  handshakeTimeoutMs = ARMED_TIMEOUT_MS,
): Promise<LifelineWatchdog> {
  const watchdog = spawn(helper, [String(bridgePgid)], {
    cwd: path.dirname(helper),
    detached: true,
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as LifelineWatchdog;

  try {
    await waitForSpawn(watchdog);
    await waitForArmed(watchdog, handshakeTimeoutMs);
    watchdog.stdout.destroy();
    watchdog.stderr.destroy();
    unrefWatchdogStdin(watchdog);
    watchdog.unref();
    return watchdog;
  } catch (error) {
    await stopUnarmedWatchdog(watchdog);
    throw error;
  }
}

export function releaseLifelineWatchdog(watchdog: LifelineWatchdog | undefined): void {
  if (!watchdog?.stdin || watchdog.stdin.destroyed) {
    return;
  }
  try {
    watchdog.stdin.once("error", () => {});
    watchdog.stdin.end("R");
  } catch {
    // Best effort after the owner has independently proved the process group empty.
  }
}

export function observeLifelineWatchdogExit(
  watchdog: LifelineWatchdog,
  onExit: () => void,
): boolean {
  let exited = false;
  const handleExit = (): void => {
    exited = true;
    onExit();
  };
  watchdog.once("exit", handleExit);
  if (watchdog.exitCode !== null || watchdog.signalCode !== null) {
    watchdog.removeListener("exit", handleExit);
    handleExit();
  }
  return !exited;
}

export async function reapSpawnedProcessGroup(
  child: ChildProcess,
  termGraceMs: number,
  killGraceMs: number,
): Promise<boolean> {
  if (child.pid === undefined) {
    child.kill("SIGTERM");
    return !isChildProcessRunning(child);
  }

  signalProcessGroup(child.pid, "SIGTERM");
  let reaped = await waitForChildAndProcessGroupExit(child, child.pid, termGraceMs);
  if (!reaped) {
    signalProcessGroup(child.pid, "SIGKILL");
    reaped = await waitForChildAndProcessGroupExit(child, child.pid, killGraceMs);
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  return reaped;
}

export async function waitForChildAndProcessGroupExit(
  child: ChildProcess,
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    if (!isChildProcessRunning(child) && !hasLiveProcessGroup(processGroupId)) {
      return true;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await delay(Math.min(20, remainingMs));
  }
}

export function hasLiveProcessGroup(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return processGroupLookupErrorIndicatesLive(error);
  }
}

export function processGroupLookupErrorIndicatesLive(error: unknown): boolean {
  return errorCode(error) !== "ESRCH";
}

export function validatePackagedLifelineHelper(
  candidate: string,
  nativeDir: string,
  packageRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  try {
    const packageOwnerUid = trustedPackageOwnerUid(packageRoot);
    if (packageOwnerUid === undefined) {
      return false;
    }
    const packageJson = path.join(packageRoot, "package.json");
    if (!isTrustedPackageFile(packageJson, packageRoot, packageOwnerUid, false)) {
      return false;
    }
    const manifestPath = path.join(nativeDir, "lifeline-manifest.json");
    if (
      !hasTrustedLifelineFiles(candidate, manifestPath, nativeDir, packageRoot, packageOwnerUid)
    ) {
      return false;
    }

    return hasExpectedPackagedDigest(candidate, manifestPath, platform, arch);
  } catch {
    return false;
  }
}

function trustedPackageOwnerUid(packageRoot: string): number | undefined {
  const packageRootStat = fs.lstatSync(packageRoot);
  if (!isTrustedPackageDirectory(packageRootStat)) {
    return undefined;
  }
  return isTrustedPackageAncestorChain(packageRoot) ? packageRootStat.uid : undefined;
}

function hasExpectedPackagedDigest(
  candidate: string,
  manifestPath: string,
  platform: NodeJS.Platform,
  arch: string,
): boolean {
  const expectedFilename = helperFilename(platform, arch);
  const entry = readManifestEntry(manifestPath, `${platform}-${arch}`);
  const expectedSha256 = expectedManifestSha256(entry, expectedFilename, platform, arch);
  if (!expectedSha256 || path.basename(candidate) !== expectedFilename) {
    return false;
  }
  const actualSha256 = createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
  return actualSha256 === expectedSha256;
}

function hasTrustedLifelineFiles(
  candidate: string,
  manifestPath: string,
  nativeDir: string,
  packageRoot: string,
  packageOwnerUid: number,
): boolean {
  return (
    isTrustedNativeDirectory(nativeDir, packageRoot, packageOwnerUid) &&
    isTrustedPackageFile(candidate, nativeDir, packageOwnerUid, true) &&
    isTrustedPackageFile(manifestPath, nativeDir, packageOwnerUid, false)
  );
}

function expectedManifestSha256(
  entry: LifelineManifestEntry | undefined,
  expectedFilename: string,
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  if (!entry || entry.file !== expectedFilename) {
    return undefined;
  }
  if (entry.platform !== platform || entry.arch !== arch) {
    return undefined;
  }
  return typeof entry.sha256 === "string" && SHA256_PATTERN.test(entry.sha256)
    ? entry.sha256
    : undefined;
}

function helperFilename(platform: NodeJS.Platform, arch: string): string {
  return `lifeline-${platform}-${arch}`;
}

function readManifestEntry(
  manifestPath: string,
  target: string,
): LifelineManifestEntry | undefined {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as LifelineManifest;
  if (
    manifest.schema !== "acpx.native-lifeline.v1" ||
    typeof manifest.helpers !== "object" ||
    manifest.helpers === null ||
    Array.isArray(manifest.helpers)
  ) {
    return undefined;
  }
  return (manifest.helpers as Record<string, LifelineManifestEntry | undefined>)[target];
}

function findPackageRoot(): string | undefined {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (isAcpxPackageRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isAcpxPackageRoot(candidate: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return parsed.name === "acpx";
  } catch {
    return false;
  }
}

function isTrustedPackageFile(
  candidate: string,
  nativeDir: string,
  packageOwnerUid: number,
  executable: boolean,
): boolean {
  const linkStat = fs.lstatSync(candidate);
  if (
    !linkStat.isFile() ||
    linkStat.isSymbolicLink() ||
    linkStat.uid !== packageOwnerUid ||
    (linkStat.mode & 0o022) !== 0
  ) {
    return false;
  }
  const realNativeDir = fs.realpathSync(nativeDir);
  const realCandidate = fs.realpathSync(candidate);
  if (path.dirname(realCandidate) !== realNativeDir) {
    return false;
  }
  if (executable) {
    fs.accessSync(candidate, fs.constants.X_OK);
  }
  return true;
}

function isTrustedPackageDirectory(stat: fs.Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0;
}

function isTrustedPackageAncestorChain(packageRoot: string): boolean {
  let current = fs.realpathSync(path.dirname(packageRoot));
  while (true) {
    const stat = fs.lstatSync(current);
    if (!isTrustedPackageAncestor(stat)) {
      return false;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return true;
    }
    current = parent;
  }
}

function isTrustedPackageAncestor(stat: fs.Stats): boolean {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return false;
  }
  const mode = stat.mode & 0o7777;
  const isStickyDirectory = (mode & 0o1000) !== 0;
  if ((mode & 0o002) !== 0 && !isStickyDirectory) {
    return false;
  }
  return (mode & 0o020) === 0 || isStickyDirectory || (stat.uid === 0 && stat.gid === 0);
}

function isTrustedNativeDirectory(
  nativeDir: string,
  packageRoot: string,
  packageOwnerUid: number,
): boolean {
  const packageRootStat = fs.lstatSync(packageRoot);
  const distDir = path.join(packageRoot, "dist");
  const distStat = fs.lstatSync(distDir);
  const nativeStat = fs.lstatSync(nativeDir);
  if (
    !isTrustedPackageDirectory(packageRootStat) ||
    !isTrustedPackageDirectory(distStat) ||
    !isTrustedPackageDirectory(nativeStat) ||
    packageRootStat.uid !== packageOwnerUid ||
    distStat.uid !== packageOwnerUid ||
    nativeStat.uid !== packageOwnerUid
  ) {
    return false;
  }
  const realPackageRoot = fs.realpathSync(packageRoot);
  return (
    fs.realpathSync(distDir) === path.join(realPackageRoot, "dist") &&
    fs.realpathSync(nativeDir) === path.join(realPackageRoot, "dist", "native")
  );
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // Best effort; the group may already be gone.
  }
}

function unrefWatchdogStdin(watchdog: LifelineWatchdog): void {
  const stdin = watchdog.stdin as (Writable & { unref?: () => void }) | null;
  stdin?.unref?.();
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function waitForArmed(watchdog: LifelineWatchdog, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(
      () => fail(new Error(`lifeline did not arm within ${timeoutMs}ms`)),
      Math.max(1, timeoutMs),
    );

    const cleanup = (): void => {
      clearTimeout(timer);
      watchdog.stdout.off("data", onData);
      watchdog.off("error", onError);
      watchdog.off("exit", onExit);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (output.length > MAX_HANDSHAKE_OUTPUT) {
        fail(new Error("lifeline handshake exceeded its output limit"));
        return;
      }
      if (output === ARMED_MESSAGE) {
        settled = true;
        cleanup();
        resolve();
        return;
      }
      if (!ARMED_MESSAGE.startsWith(output)) {
        fail(new Error(`invalid lifeline handshake: ${JSON.stringify(output)}`));
      }
    };
    const onError = (error: Error): void => fail(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      fail(new Error(`lifeline exited before arming (code=${code}, signal=${signal})`));
    };

    if (watchdog.exitCode !== null || watchdog.signalCode !== null) {
      onExit(watchdog.exitCode, watchdog.signalCode);
      return;
    }
    watchdog.stdout.on("data", onData);
    watchdog.once("error", onError);
    watchdog.once("exit", onExit);
  });
}

async function stopUnarmedWatchdog(watchdog: LifelineWatchdog): Promise<void> {
  watchdog.stdin.destroy();
  const exited = await waitForChildExit(watchdog, UNARMED_STOP_GRACE_MS);
  if (!exited) {
    // The trusted helper may still be reaping the bridge group. Never kill it
    // before the owner independently proves that group empty.
    watchdog.unref();
  }
  watchdog.stdout.destroy();
  watchdog.stderr.destroy();
}
