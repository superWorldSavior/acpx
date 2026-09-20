import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const script = path.join(process.cwd(), "scripts", "build-native-lifeline.mjs");

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function runWithEnv(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("native packaging assembles the canonical four-target manifest", () => {
  const nativeDir = mkdtempSync(path.join(os.tmpdir(), "acpx-native-manifest-"));
  try {
    for (const target of targets) {
      const helper = path.join(nativeDir, `lifeline-${target}`);
      writeFileSync(helper, `fixture:${target}\n`);
      chmodSync(helper, 0o755);
    }

    const result = run("--assemble", "--native-dir", nativeDir);
    assert.equal(result.status, 0, result.stderr);
    const manifestPath = path.join(nativeDir, "lifeline-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schema: string;
      helpers: Record<string, { file: string; platform: string; arch: string; sha256: string }>;
    };
    assert.equal(manifest.schema, "acpx.native-lifeline.v1");
    assert.deepEqual(Object.keys(manifest.helpers), targets);
    for (const target of targets) {
      const entry = manifest.helpers[target];
      assert.equal(entry.file, `lifeline-${target}`);
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    }

    const check = run("--check", "--native-dir", nativeDir);
    assert.equal(check.status, 0, check.stderr);
  } finally {
    rmSync(nativeDir, { recursive: true, force: true });
  }
});

test("native packaging rejects a missing target and a changed helper", () => {
  const nativeDir = mkdtempSync(path.join(os.tmpdir(), "acpx-native-manifest-"));
  try {
    for (const target of targets.slice(1)) {
      writeFileSync(path.join(nativeDir, `lifeline-${target}`), target);
    }
    const missing = run("--assemble", "--native-dir", nativeDir);
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}\n${missing.stderr}`, /darwin-arm64/);

    writeFileSync(path.join(nativeDir, "lifeline-darwin-arm64"), "darwin-arm64");
    assert.equal(run("--assemble", "--native-dir", nativeDir).status, 0);
    writeFileSync(path.join(nativeDir, "lifeline-linux-x64"), "tampered");
    const changed = run("--check", "--native-dir", nativeDir);
    assert.notEqual(changed.status, 0);
    assert.match(`${changed.stdout}\n${changed.stderr}`, /mode|digest/i);
  } finally {
    rmSync(nativeDir, { recursive: true, force: true });
  }
});

test("native packaging skips an unsupported implicit host without inventing a Windows helper", () => {
  const nativeDir = mkdtempSync(path.join(os.tmpdir(), "acpx-native-unsupported-"));
  try {
    const result = runWithEnv(
      { ACPX_NATIVE_PLATFORM: "win32", ACPX_NATIVE_ARCH: "x64" },
      "--native-dir",
      nativeDir,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /unsupported/i);
  } finally {
    rmSync(nativeDir, { recursive: true, force: true });
  }
});

test("native Linux builds request and verify static linkage", () => {
  const builder = readFileSync(
    path.join(process.cwd(), "scripts", "build-native-lifeline.mjs"),
    "utf8",
  );
  assert.match(builder, /target\.platform === "linux"/);
  assert.match(builder, /compilerArgs\.splice\(-2, 0, "-static"\)/);
  assert.match(builder, /static\(?:ally linked|-pie linked\)/);
});

test("native lifeline separates owner-pipe closure from indeterminate errors", () => {
  const source = readFileSync(path.join(process.cwd(), "native", "lifeline.c"), "utf8");
  assert.match(source, /enum owner_pipe_result/);
  assert.match(source, /return OWNER_PIPE_ERROR;/);
  assert.match(source, /if \(result == OWNER_PIPE_EOF\) \{\s+reap_group\(bridge_pgid\);/);
  assert.match(source, /return result == OWNER_PIPE_ERROR \? 1 : 0;/);

  const preArmCheck = source.indexOf('fprintf(stderr, "bridge process group is absent');
  const announceCall = source.indexOf("if (announce_armed() != 0)");
  assert(preArmCheck >= 0 && preArmCheck < announceCall);
});

test("native Darwin builds pin the supported deployment target and modes are strict", () => {
  const builder = readFileSync(
    path.join(process.cwd(), "scripts", "build-native-lifeline.mjs"),
    "utf8",
  );
  assert.match(builder, /-mmacosx-version-min=\$\{macosDeploymentTarget\}/);
  assert.match(builder, /const macosDeploymentTarget = "11\.0"/);

  const nativeDir = mkdtempSync(path.join(os.tmpdir(), "acpx-native-modes-"));
  try {
    for (const target of targets) {
      writeFileSync(path.join(nativeDir, `lifeline-${target}`), `fixture:${target}\n`, {
        mode: 0o755,
      });
    }
    assert.equal(run("--assemble", "--native-dir", nativeDir).status, 0);

    chmodSync(path.join(nativeDir, "lifeline-linux-x64"), 0o755);
    chmodSync(path.join(nativeDir, "lifeline-manifest.json"), 0o600);
    const badManifest = run("--check", "--native-dir", nativeDir);
    assert.notEqual(badManifest.status, 0);
    assert.match(`${badManifest.stdout}\n${badManifest.stderr}`, /mode|digest mismatch/i);

    chmodSync(path.join(nativeDir, "lifeline-manifest.json"), 0o644);
    chmodSync(path.join(nativeDir, "lifeline-linux-x64"), 0o700);
    const badHelper = run("--check", "--native-dir", nativeDir);
    assert.notEqual(badHelper.status, 0);
    assert.match(`${badHelper.stdout}\n${badHelper.stderr}`, /mode|digest mismatch/i);
  } finally {
    rmSync(nativeDir, { recursive: true, force: true });
  }
});
