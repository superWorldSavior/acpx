import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import {
  reapSpawnedProcessGroup,
  processGroupLookupErrorIndicatesLive,
  observeLifelineWatchdogExit,
  resolvePackagedLifelineHelper,
  startLifelineWatchdog,
  supportsProcessGroupLifeline,
  type LifelineWatchdog,
  validatePackagedLifelineHelper,
} from "../src/acp/lifeline.js";
import { isProcessAlive } from "../src/process-liveness.js";
import { fileExists, withTempDir } from "./runtime-test-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const LIFELINE_MODULE_PATH = fileURLToPath(new URL("../src/acp/lifeline.js", import.meta.url));

test("process-group lifeline support is explicit by platform", () => {
  assert.equal(supportsProcessGroupLifeline("darwin", "arm64"), true);
  assert.equal(supportsProcessGroupLifeline("darwin", "x64"), true);
  assert.equal(supportsProcessGroupLifeline("linux", "arm64"), true);
  assert.equal(supportsProcessGroupLifeline("linux", "x64"), true);
  assert.equal(supportsProcessGroupLifeline("linux", "ppc64"), false);
  assert.equal(supportsProcessGroupLifeline("win32", "x64"), false);
  assert.equal(supportsProcessGroupLifeline("freebsd", "x64"), false);
  assert.equal(resolvePackagedLifelineHelper("linux", "ppc64"), undefined);
  assert.equal(resolvePackagedLifelineHelper("win32", "x64"), undefined);
});

test("process-group lookup fails safe for every error except ESRCH", () => {
  assert.equal(
    processGroupLookupErrorIndicatesLive(Object.assign(new Error(), { code: "ESRCH" })),
    false,
  );
  assert.equal(
    processGroupLookupErrorIndicatesLive(Object.assign(new Error(), { code: "EPERM" })),
    true,
  );
  assert.equal(
    processGroupLookupErrorIndicatesLive(Object.assign(new Error(), { code: "EIO" })),
    true,
  );
  assert.equal(processGroupLookupErrorIndicatesLive(new Error("unknown lookup failure")), true);
});

test("lifeline adoption replays a watchdog exit recorded before listener attachment", () => {
  const watchdog = Object.assign(new EventEmitter(), {
    exitCode: 0,
    signalCode: null,
  }) as unknown as LifelineWatchdog;
  let exits = 0;

  assert.equal(
    observeLifelineWatchdogExit(watchdog, () => (exits += 1)),
    false,
  );
  assert.equal(exits, 1);
});

test("a watchdog exit remains visible until synchronous client adoption", () => {
  const client = new AcpClient({
    agentCommand: process.execPath,
    cwd: process.cwd(),
    permissionMode: "approve-reads",
  });
  const child = new EventEmitter() as unknown as ChildProcess;
  const watchdogState = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  const watchdog = watchdogState as unknown as LifelineWatchdog;
  const internals = client as unknown as {
    agentLifelines: WeakMap<ChildProcess, LifelineWatchdog>;
    agentProcessGroups: WeakSet<ChildProcess>;
    observeLifelineWatchdog: (watchdog: LifelineWatchdog, child: ChildProcess) => boolean;
    lifelineAdoptionFailed: (child: ChildProcess) => boolean;
  };

  internals.agentProcessGroups.add(child);
  internals.agentLifelines.set(child, watchdog);
  assert.equal(internals.observeLifelineWatchdog(watchdog, child), true);

  watchdogState.exitCode = 0;
  watchdog.emit("exit", 0, null);

  assert.equal(internals.agentLifelines.has(child), false);
  assert.equal(internals.lifelineAdoptionFailed(child), true);
});

test("unproved cooperative cleanup triggers the native lifeline fallback", () => {
  const client = new AcpClient({
    agentCommand: process.execPath,
    cwd: process.cwd(),
    permissionMode: "approve-reads",
  });
  const child = new EventEmitter() as unknown as ChildProcess;
  const ownerPipe = new PassThrough();
  const watchdog = { stdin: ownerPipe } as unknown as LifelineWatchdog;
  const internals = client as unknown as {
    agentLifelines: WeakMap<ChildProcess, LifelineWatchdog>;
    finishLifelineCleanup: (child: ChildProcess, reaped: boolean) => void;
  };

  internals.agentLifelines.set(child, watchdog);
  internals.finishLifelineCleanup(child, false);

  assert.equal(ownerPipe.destroyed, true);
  assert.equal(internals.agentLifelines.get(child), watchdog);
});

test("packaged helper validation enforces the target manifest and package boundary", async () => {
  await withTempDir("acpx-lifeline-validation-", async (packageRoot) => {
    const nativeDir = path.join(packageRoot, "dist", "native");
    const candidate = path.join(nativeDir, `lifeline-${process.platform}-${process.arch}`);
    const manifest = path.join(nativeDir, "lifeline-manifest.json");
    await fs.mkdir(nativeDir, { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"acpx"}\n', "utf8");
    await fs.writeFile(candidate, "native helper", { mode: 0o755 });
    await writeHelperManifest(manifest, "native helper");

    assert.equal(validatePackagedLifelineHelper(candidate, nativeDir, packageRoot), true);

    await fs.chmod(candidate, 0o775);
    assert.equal(validatePackagedLifelineHelper(candidate, nativeDir, packageRoot), false);
    await fs.chmod(candidate, 0o755);

    const target = path.join(nativeDir, "replacement");
    await fs.writeFile(target, "native helper", { mode: 0o755 });
    await fs.rename(candidate, path.join(nativeDir, "original"));
    await fs.symlink(target, candidate);
    assert.equal(validatePackagedLifelineHelper(candidate, nativeDir, packageRoot), false);
  });
});

test("packaged helper validation rejects mismatched target metadata and digest", async () => {
  await withTempDir("acpx-lifeline-manifest-", async (packageRoot) => {
    const nativeDir = path.join(packageRoot, "dist", "native");
    const candidate = path.join(nativeDir, `lifeline-${process.platform}-${process.arch}`);
    const manifest = path.join(nativeDir, "lifeline-manifest.json");
    await fs.mkdir(nativeDir, { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"acpx"}\n', "utf8");
    await fs.writeFile(candidate, "native helper", { mode: 0o755 });

    await writeHelperManifest(manifest, "native helper", { arch: "mismatched-arch" });
    assert.equal(validatePackagedLifelineHelper(candidate, nativeDir, packageRoot), false);

    await writeHelperManifest(manifest, "different contents");
    assert.equal(validatePackagedLifelineHelper(candidate, nativeDir, packageRoot), false);

    await writeHelperManifest(manifest, "native helper", { schema: "unknown" });
    assert.equal(validatePackagedLifelineHelper(candidate, nativeDir, packageRoot), false);
  });
});

test("packaged helper validation rejects writable and symlinked package boundaries", async () => {
  await withTempDir("acpx-lifeline-boundary-", async (tempDir) => {
    const packageRoot = path.join(tempDir, "package");
    const distDir = path.join(packageRoot, "dist");
    const nativeDir = path.join(distDir, "native");
    const candidate = path.join(nativeDir, `lifeline-${process.platform}-${process.arch}`);
    const manifest = path.join(nativeDir, "lifeline-manifest.json");
    await fs.mkdir(nativeDir, { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"acpx"}\n', "utf8");
    await fs.writeFile(candidate, "native helper", { mode: 0o755 });
    await writeHelperManifest(manifest, "native helper");
    assert.equal(validatePackagedLifelineHelper(candidate, nativeDir, packageRoot), true);

    await fs.chmod(packageRoot, 0o775);
    assert.equal(validatePackagedLifelineHelper(candidate, nativeDir, packageRoot), false);
    await fs.chmod(packageRoot, 0o755);

    await fs.chmod(distDir, 0o775);
    assert.equal(validatePackagedLifelineHelper(candidate, nativeDir, packageRoot), false);
    await fs.chmod(distDir, 0o755);

    await fs.chmod(nativeDir, 0o775);
    assert.equal(validatePackagedLifelineHelper(candidate, nativeDir, packageRoot), false);
    await fs.chmod(nativeDir, 0o755);

    const writableParent = path.join(tempDir, "writable-parent");
    const nestedRoot = path.join(writableParent, "package");
    const nestedNativeDir = path.join(nestedRoot, "dist", "native");
    const nestedCandidate = path.join(
      nestedNativeDir,
      `lifeline-${process.platform}-${process.arch}`,
    );
    const nestedManifest = path.join(nestedNativeDir, "lifeline-manifest.json");
    await fs.mkdir(nestedNativeDir, { recursive: true });
    await fs.writeFile(path.join(nestedRoot, "package.json"), '{"name":"acpx"}\n', "utf8");
    await fs.writeFile(nestedCandidate, "native helper", { mode: 0o755 });
    await writeHelperManifest(nestedManifest, "native helper");
    assert.equal(
      validatePackagedLifelineHelper(nestedCandidate, nestedNativeDir, nestedRoot),
      true,
    );

    await fs.chmod(writableParent, 0o777);
    assert.equal(
      validatePackagedLifelineHelper(nestedCandidate, nestedNativeDir, nestedRoot),
      false,
    );

    const realRoot = path.join(tempDir, "real-package");
    const linkedRoot = path.join(tempDir, "linked-package");
    const realNativeDir = path.join(realRoot, "dist", "native");
    const realCandidate = path.join(realNativeDir, `lifeline-${process.platform}-${process.arch}`);
    const realManifest = path.join(realNativeDir, "lifeline-manifest.json");
    await fs.mkdir(realNativeDir, { recursive: true });
    await fs.writeFile(path.join(realRoot, "package.json"), '{"name":"acpx"}\n', "utf8");
    await fs.writeFile(realCandidate, "native helper", { mode: 0o755 });
    await writeHelperManifest(realManifest, "native helper");
    await fs.symlink(realRoot, linkedRoot, "dir");
    assert.equal(
      validatePackagedLifelineHelper(
        path.join(linkedRoot, "dist", "native", `lifeline-${process.platform}-${process.arch}`),
        path.join(linkedRoot, "dist", "native"),
        linkedRoot,
      ),
      false,
    );

    const symlinkDistRoot = path.join(tempDir, "symlink-dist-package");
    const symlinkDistTarget = path.join(tempDir, "symlink-dist-target");
    const symlinkNativeDir = path.join(symlinkDistRoot, "dist", "native");
    const symlinkCandidate = path.join(
      symlinkNativeDir,
      `lifeline-${process.platform}-${process.arch}`,
    );
    await fs.mkdir(path.join(symlinkDistTarget, "native"), { recursive: true });
    await fs.mkdir(symlinkDistRoot, { recursive: true });
    await fs.writeFile(path.join(symlinkDistRoot, "package.json"), '{"name":"acpx"}\n', "utf8");
    await fs.writeFile(
      path.join(symlinkDistTarget, "native", path.basename(symlinkCandidate)),
      "native helper",
      { mode: 0o755 },
    );
    await writeHelperManifest(
      path.join(symlinkDistTarget, "native", "lifeline-manifest.json"),
      "native helper",
    );
    await fs.symlink(symlinkDistTarget, path.join(symlinkDistRoot, "dist"), "dir");
    assert.equal(
      validatePackagedLifelineHelper(symlinkCandidate, symlinkNativeDir, symlinkDistRoot),
      false,
    );
  });
});

test("lifeline resolves only the verified package-relative target helper", async (t) => {
  if (!supportsProcessGroupLifeline()) {
    t.skip("packaged native lifeline is unavailable on this platform");
    return;
  }

  const expected = path.join(
    process.cwd(),
    "dist",
    "native",
    `lifeline-${process.platform}-${process.arch}`,
  );
  const originalCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousOverride = process.env.ACPX_LIFELINE_HELPER;

  await withTempDir("acpx-lifeline-resolution-", async (tempDir) => {
    const fakeHelper = path.join(tempDir, "lifeline");
    await fs.writeFile(fakeHelper, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    process.env.HOME = tempDir;
    process.env.ACPX_LIFELINE_HELPER = fakeHelper;
    process.chdir(tempDir);
    try {
      assert.equal(resolvePackagedLifelineHelper(), expected);
    } finally {
      process.chdir(originalCwd);
      restoreEnvironment("HOME", previousHome);
      restoreEnvironment("ACPX_LIFELINE_HELPER", previousOverride);
    }
  });
});

test("native lifeline reaps the bridge group on owner-pipe EOF", async (t) => {
  if (!supportsProcessGroupLifeline()) {
    t.skip("native lifeline is unavailable on this platform");
    return;
  }
  const helper = resolvePackagedLifelineHelper();
  assert(helper, "packaged helper must exist before POSIX tests run");

  await withTempDir("acpx-lifeline-native-eof-", async (tempDir) => {
    const tree = await spawnProcessTree(tempDir);
    let watchdog: ChildProcess | undefined;
    try {
      watchdog = await startLifelineWatchdog(helper, tree.bridgePid);
      watchdog.stdin?.destroy();
      await waitUntil(() => !isProcessAlive(tree.bridgePid) && !isProcessAlive(tree.grandchildPid));
      await waitForExit(watchdog);
    } finally {
      watchdog?.stdin?.destroy();
      killProcess(watchdog?.pid);
      killProcessGroup(tree.bridgePid);
      killProcess(tree.grandchildPid);
    }
  });
});

test("native lifeline release exits without reaping a live process group", async (t) => {
  if (!supportsProcessGroupLifeline()) {
    t.skip("native lifeline is unavailable on this platform");
    return;
  }
  const helper = resolvePackagedLifelineHelper();
  assert(helper, "packaged helper must exist before POSIX tests run");

  await withTempDir("acpx-lifeline-release-", async (tempDir) => {
    const tree = await spawnProcessTree(tempDir);
    let watchdog: ChildProcess | undefined;
    try {
      watchdog = await startLifelineWatchdog(helper, tree.bridgePid);
      watchdog.stdin?.end("R");
      await waitForExit(watchdog);
      assert.equal(isProcessAlive(tree.bridgePid), true);
      assert.equal(isProcessAlive(tree.grandchildPid), true);
    } finally {
      watchdog?.stdin?.destroy();
      killProcess(watchdog?.pid);
      killProcessGroup(tree.bridgePid);
      killProcess(tree.grandchildPid);
    }
  });
});

test("an owner can exit naturally while the watchdog pipe remains armed", async (t) => {
  if (!supportsProcessGroupLifeline()) {
    t.skip("native lifeline is unavailable on this platform");
    return;
  }
  const helper = resolvePackagedLifelineHelper();
  assert(helper, "packaged helper must exist before POSIX tests run");

  await withTempDir("acpx-lifeline-owner-exit-", async (tempDir) => {
    const bridgePidFile = path.join(tempDir, "bridge.pid");
    const ownerScript = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { startLifelineWatchdog } from ${JSON.stringify(LIFELINE_MODULE_PATH)};

const bridge = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
});
await new Promise((resolve, reject) => {
  bridge.once("spawn", resolve);
  bridge.once("error", reject);
});
bridge.unref();
await startLifelineWatchdog(${JSON.stringify(helper)}, bridge.pid);
writeFileSync(${JSON.stringify(bridgePidFile)}, String(bridge.pid));
`;
    const owner = spawn(process.execPath, ["--input-type=module", "--eval", ownerScript], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    owner.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    let bridgePid: number | undefined;

    try {
      await waitUntil(() => fileExists(bridgePidFile), 5_000);
      bridgePid = await readPidFile(bridgePidFile);
      await waitForExit(owner, 5_000);
      assert.equal(
        owner.exitCode,
        0,
        `owner failed to exit naturally: ${Buffer.concat(stderr).toString("utf8")}`,
      );
      await waitUntil(() => !isProcessAlive(bridgePid), 5_000);
    } finally {
      killProcess(owner.pid);
      killProcessGroup(bridgePid);
    }
  });
});

test("native lifeline waits for owner-pipe EOF after the bridge leader exits", async (t) => {
  if (!supportsProcessGroupLifeline()) {
    t.skip("native lifeline is unavailable on this platform");
    return;
  }
  const helper = resolvePackagedLifelineHelper();
  assert(helper, "packaged helper must exist before POSIX tests run");

  await withTempDir("acpx-lifeline-leader-exit-", async (tempDir) => {
    const tree = await spawnProcessTree(tempDir, { leaderExits: true });
    let watchdog: ChildProcess | undefined;
    try {
      watchdog = await startLifelineWatchdog(helper, tree.bridgePid);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      assert.equal(
        isProcessAlive(tree.grandchildPid),
        true,
        "a live process-group member must survive while the owner pipe remains open",
      );
      assert.equal(isProcessAlive(watchdog.pid), true);

      watchdog.stdin?.destroy();
      await waitUntil(() => !isProcessAlive(tree.grandchildPid));
      await waitForExit(watchdog);
    } finally {
      watchdog?.stdin?.destroy();
      killProcess(watchdog?.pid);
      killProcessGroup(tree.bridgePid);
      killProcess(tree.grandchildPid);
    }
  });
});

test("native lifeline exits when the entire process group is already absent", async (t) => {
  if (!supportsProcessGroupLifeline()) {
    t.skip("native lifeline is unavailable on this platform");
    return;
  }
  const helper = resolvePackagedLifelineHelper();
  assert(helper, "packaged helper must exist before POSIX tests run");

  await withTempDir("acpx-lifeline-group-gone-", async (tempDir) => {
    const tree = await spawnProcessTree(tempDir, {
      grandchildExits: true,
      leaderExits: true,
    });
    try {
      await waitUntil(() => !isProcessAlive(tree.bridgePid) && !isProcessAlive(tree.grandchildPid));
      await assert.rejects(
        () => startLifelineWatchdog(helper, tree.bridgePid),
        /lifeline exited before arming/,
      );
    } finally {
      killProcessGroup(tree.bridgePid);
      killProcess(tree.grandchildPid);
    }
  });
});

test("native lifeline bounds abrupt cleanup to the bridge process group", async (t) => {
  if (!supportsProcessGroupLifeline()) {
    t.skip("native lifeline is unavailable on this platform");
    return;
  }
  const helper = resolvePackagedLifelineHelper();
  assert(helper, "packaged helper must exist before POSIX tests run");

  await withTempDir("acpx-lifeline-detached-boundary-", async (tempDir) => {
    const tree = await spawnProcessTree(tempDir, { detachedGrandchild: true });
    let watchdog: ChildProcess | undefined;
    try {
      watchdog = await startLifelineWatchdog(helper, tree.bridgePid);
      watchdog.stdin?.destroy();
      await waitUntil(() => !isProcessAlive(tree.bridgePid));
      await waitForExit(watchdog);
      assert.equal(
        isProcessAlive(tree.grandchildPid),
        true,
        "a new-session descendant is outside the native process-group guarantee",
      );
    } finally {
      watchdog?.stdin?.destroy();
      killProcess(watchdog?.pid);
      killProcessGroup(tree.bridgePid);
      killProcess(tree.grandchildPid);
      try {
        await waitUntil(() => !isProcessAlive(tree.grandchildPid), 1_000);
      } catch {
        // Best-effort cleanup must not hide the boundary assertion.
      }
    }
  });
});

test("a failed pre-arm handshake is followed by independent group cleanup", async (t) => {
  if (!supportsProcessGroupLifeline()) {
    t.skip("native lifeline is unavailable on this platform");
    return;
  }

  await withTempDir("acpx-lifeline-arm-failure-", async (tempDir) => {
    const fakeHelper = path.join(tempDir, "fake-helper");
    await fs.writeFile(fakeHelper, "#!/bin/sh\nprintf 'NOT_ARMED\\n'\nexit 2\n", { mode: 0o755 });
    const tree = await spawnProcessTree(tempDir);
    try {
      await assert.rejects(
        () => startLifelineWatchdog(fakeHelper, tree.bridgePid),
        /invalid lifeline handshake|exited before arming/,
      );
      assert.equal(await reapSpawnedProcessGroup(tree.bridge, 500, 500), true);
      assert.equal(isProcessAlive(tree.bridgePid), false);
      assert.equal(isProcessAlive(tree.grandchildPid), false);
    } finally {
      killProcessGroup(tree.bridgePid);
      killProcess(tree.grandchildPid);
    }
  });
});

test("AcpClient rejects a watchdog that exits during lifeline adoption", async (t) => {
  if (!supportsProcessGroupLifeline()) {
    t.skip("native lifeline is unavailable on this platform");
    return;
  }

  await withTempDir("acpx-lifeline-adoption-race-", async (tempDir) => {
    const fakeHelper = path.join(tempDir, "armed-then-exit-helper.mjs");
    const bridgePidFile = path.join(tempDir, "bridge.pid");
    await fs.writeFile(
      fakeHelper,
      '#!/usr/bin/env node\nprocess.stdout.write("ARMED\\n"); process.exit(0);\n',
      { mode: 0o755 },
    );
    const client = new AcpClient({
      agentCommand: process.execPath,
      agentArgv: [
        process.execPath,
        MOCK_AGENT_PATH,
        "--pid-file",
        bridgePidFile,
        "--stay-alive-after-stdin-end",
      ],
      cwd: tempDir,
      permissionMode: "approve-reads",
    });
    const internals = client as unknown as {
      resolveRequiredLifelineHelper: (launch: unknown) => string;
    };
    internals.resolveRequiredLifelineHelper = () => fakeHelper;
    let bridgePid: number | undefined;

    try {
      await assert.rejects(() => client.start(), /Failed to spawn agent command/);
      await waitUntil(() => fileExists(bridgePidFile), 5_000);
      bridgePid = await readPidFile(bridgePidFile);
      await waitUntil(() => !isProcessAlive(bridgePid), 5_000);
    } finally {
      await client.close().catch(() => {});
      killProcessGroup(bridgePid);
      killProcess(bridgePid);
    }
  });
});

test("AcpClient graceful close preserves cleanup and reaps the detached process group", async (t) => {
  if (!supportsProcessGroupLifeline()) {
    t.skip("native lifeline is unavailable on this platform");
    return;
  }

  await withTempDir("acpx-lifeline-close-", async (tempDir) => {
    const bridgePidFile = path.join(tempDir, "bridge.pid");
    const grandchildPidFile = path.join(tempDir, "grandchild.pid");
    const client = new AcpClient({
      agentCommand: process.execPath,
      agentArgv: [
        process.execPath,
        MOCK_AGENT_PATH,
        "--pid-file",
        bridgePidFile,
        "--grandchild-pid-file",
        grandchildPidFile,
        "--grandchild-ignore-sigterm",
        "--stay-alive-after-stdin-end",
      ],
      cwd: tempDir,
      permissionMode: "approve-reads",
    });
    let bridgePid: number | undefined;
    let grandchildPid: number | undefined;

    try {
      await client.start();
      await waitUntil(() => fileExists(bridgePidFile));
      await waitUntil(() => fileExists(grandchildPidFile));
      bridgePid = await readPidFile(bridgePidFile);
      grandchildPid = await readPidFile(grandchildPidFile);

      await client.close();
      await waitUntil(() => !isProcessAlive(bridgePid) && !isProcessAlive(grandchildPid));
    } finally {
      await client.close().catch(() => {});
      killProcessGroup(bridgePid);
      killProcess(grandchildPid);
    }
  });
});

test("detached descendants retain a SIGKILL phase when process-group cleanup is delayed", async (t) => {
  if (!supportsProcessGroupLifeline()) {
    t.skip("native lifeline is unavailable on this platform");
    return;
  }

  await withTempDir("acpx-lifeline-descendant-budget-", async (tempDir) => {
    const fakeBinDir = path.join(tempDir, "bin");
    const delayedPsMarker = path.join(tempDir, "delay-next-ps");
    const bridgePidFile = path.join(tempDir, "bridge.pid");
    const grandchildPidFile = path.join(tempDir, "detached-grandchild.pid");
    await fs.mkdir(fakeBinDir);
    await fs.writeFile(
      path.join(fakeBinDir, "ps"),
      `#!/bin/sh
if [ -n "$ACPX_DELAY_PS_MARKER" ] && [ -f "$ACPX_DELAY_PS_MARKER" ]; then
  rm -f "$ACPX_DELAY_PS_MARKER"
  sleep 5.5
fi
exec /bin/ps "$@"
`,
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    const originalMarker = process.env.ACPX_DELAY_PS_MARKER;
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.ACPX_DELAY_PS_MARKER = delayedPsMarker;
    t.after(() => {
      restoreEnvironment("PATH", originalPath);
      restoreEnvironment("ACPX_DELAY_PS_MARKER", originalMarker);
    });

    const client = new AcpClient({
      agentCommand: process.execPath,
      agentArgv: [
        process.execPath,
        MOCK_AGENT_PATH,
        "--pid-file",
        bridgePidFile,
        "--ignore-sigterm",
        "--grandchild-pid-file",
        grandchildPidFile,
        "--grandchild-ignore-sigterm",
        "--grandchild-detached",
        "--stay-alive-after-stdin-end",
      ],
      cwd: tempDir,
      permissionMode: "approve-reads",
    });
    let bridgePid: number | undefined;
    let grandchildPid: number | undefined;

    try {
      await client.start();
      bridgePid = await readPidFile(bridgePidFile);
      grandchildPid = await readPidFile(grandchildPidFile);
      await fs.writeFile(delayedPsMarker, "delay\n", "utf8");

      await client.close();

      await waitUntil(() => !isProcessAlive(bridgePid) && !isProcessAlive(grandchildPid));
    } finally {
      await client.close().catch(() => {});
      killProcessGroup(bridgePid);
      killProcess(grandchildPid);
    }
  });
});

test("an unexpected lifeline exit also reaps observed descendants outside the process group", async (t) => {
  if (!supportsProcessGroupLifeline()) {
    t.skip("native lifeline is unavailable on this platform");
    return;
  }

  await withTempDir("acpx-lifeline-watchdog-exit-", async (tempDir) => {
    const bridgePidFile = path.join(tempDir, "bridge.pid");
    const grandchildPidFile = path.join(tempDir, "detached-grandchild.pid");
    const client = new AcpClient({
      agentCommand: process.execPath,
      agentArgv: [
        process.execPath,
        MOCK_AGENT_PATH,
        "--pid-file",
        bridgePidFile,
        "--grandchild-pid-file",
        grandchildPidFile,
        "--grandchild-ignore-sigterm",
        "--grandchild-detached",
        "--stay-alive-after-stdin-end",
      ],
      cwd: tempDir,
      permissionMode: "approve-reads",
    });
    let bridgePid: number | undefined;
    let grandchildPid: number | undefined;
    let watchdog: ChildProcess | undefined;

    try {
      await client.start();
      bridgePid = await readPidFile(bridgePidFile);
      grandchildPid = await readPidFile(grandchildPidFile);
      watchdog = lifelineForClient(client);
      assert(watchdog?.pid, "client must retain its armed lifeline");
      assert.equal(isProcessAlive(bridgePid), true);
      assert.equal(isProcessAlive(grandchildPid), true);

      watchdog.kill("SIGKILL");
      await waitUntil(() => !isProcessAlive(bridgePid) && !isProcessAlive(grandchildPid), 5_000);
    } finally {
      await client.close().catch(() => {});
      killProcess(watchdog?.pid);
      killProcessGroup(bridgePid);
      killProcess(grandchildPid);
    }
  });
});

type SpawnedTree = {
  bridge: ChildProcess;
  bridgePid: number;
  grandchildPid: number;
};

async function spawnProcessTree(
  tempDir: string,
  options: { detachedGrandchild?: boolean; grandchildExits?: boolean; leaderExits?: boolean } = {},
): Promise<SpawnedTree> {
  const bridgePidFile = path.join(tempDir, "bridge.pid");
  const grandchildPidFile = path.join(tempDir, "grandchild.pid");
  const grandchildScript = options.grandchildExits
    ? "process.exit(0);"
    : 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
  const bridgeScript = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildScript)}], {
  stdio: "ignore",
  detached: ${JSON.stringify(options.detachedGrandchild ?? false)},
});
grandchild.unref();
fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));
fs.writeFileSync(${JSON.stringify(bridgePidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
${options.leaderExits ? "process.exit(0);" : "setInterval(() => {}, 1000);"}
`;
  const bridge = spawn(process.execPath, ["--eval", bridgeScript], {
    detached: true,
    stdio: "ignore",
  });
  assert(bridge.pid);
  bridge.unref();
  await waitUntil(() => fileExists(bridgePidFile));
  await waitUntil(() => fileExists(grandchildPidFile));
  return {
    bridge,
    bridgePid: await readPidFile(bridgePidFile),
    grandchildPid: await readPidFile(grandchildPidFile),
  };
}

async function readPidFile(filePath: string): Promise<number> {
  const pid = Number((await fs.readFile(filePath, "utf8")).trim());
  assert(Number.isInteger(pid) && pid > 1);
  return pid;
}

function lifelineForClient(client: AcpClient): ChildProcess | undefined {
  const internals = client as unknown as {
    agent?: ChildProcess;
    agentLifelines: WeakMap<ChildProcess, ChildProcess>;
  };
  return internals.agent ? internals.agentLifelines.get(internals.agent) : undefined;
}

async function waitForExit(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("child did not exit in time")), timeoutMs),
    ),
  ]);
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 4_000,
  pollMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function killProcessGroup(pgid: number | undefined): void {
  if (!pgid) {
    return;
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Best effort test cleanup.
  }
}

function killProcess(pid: number | undefined): void {
  if (!pid || !isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best effort test cleanup.
  }
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function writeHelperManifest(
  manifestPath: string,
  helperContents: string,
  overrides: { schema?: string; platform?: string; arch?: string } = {},
): Promise<void> {
  const platform = overrides.platform ?? process.platform;
  const arch = overrides.arch ?? process.arch;
  const sha256 = createHash("sha256").update(helperContents).digest("hex");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      schema: overrides.schema ?? "acpx.native-lifeline.v1",
      helpers: {
        [`${process.platform}-${process.arch}`]: {
          file: `lifeline-${process.platform}-${process.arch}`,
          platform,
          arch,
          sha256,
        },
      },
    })}\n`,
    "utf8",
  );
}
