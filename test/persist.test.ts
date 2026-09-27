// bin/persist.sh (README "Persistent workspace images") against fakes on PATH: `aws`, `gcloud`,
// `sudo`, `mount`/`umount`/`mountpoint`, `fstrim`, `sync`, `e2fsck`, `mkfs.ext4` and `zstd` each
// log their argv and act on a directory standing in for the bucket. A real bucket and real loop
// mounts can't run in CI; what's under test is the order of the steps (never compress while
// mounted), and that no failure path uploads anything over a good image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve("bin/persist.sh");

// `store` maps s3://b/k and gs://b/k to <root>/store/b/k. FAIL_<NAME> makes a fake fail.
const FAKES: Record<string, string> = {
  sudo: `exec "$@"`,
  sync: ``,
  fstrim: ``,
  "mkfs.ext4": ``,
  e2fsck: `exit "\${E2FSCK_CODE:-0}"`,
  mount: `[ -z "\${FAIL_MOUNT:-}" ] || exit 32; echo "\${@: -1}" >> "$FAKE/mounts"`,
  umount: `[ -z "\${FAIL_UMOUNT:-}" ] || exit 32; grep -vxF "$1" "$FAKE/mounts" > "$FAKE/mounts.new" || true; mv "$FAKE/mounts.new" "$FAKE/mounts"`,
  mountpoint: `grep -qxF "$2" "$FAKE/mounts" 2>/dev/null`,
  zstd: `out=; in=; d=
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -d) d=1 ;; -*) ;; *) in="$1" ;; esac; shift; done
if [ -n "$d" ]; then cat > "$out"; else cp "$in" "$out"; fi`,
  aws: `path() { local r="\${1#*://}"; echo "$FAKE/store/$r"; }
if [ "$1" = s3api ]; then
  [ -z "\${FAIL_HEAD:-}" ] || { echo "An error occurred (403) when calling the HeadObject operation: Forbidden" >&2; exit 254; }
  [ -f "$FAKE/store/$4/$6" ] || { echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 254; }
  exit 0
fi
shift; verb="$1"; shift; [ "$1" != --only-show-errors ] || shift
case "$verb" in
  cp)
    case "$2" in *.tmp-*) [ -z "\${FAIL_UPLOAD:-}" ] || exit 1 ;; esac
    if [ "$2" = - ]; then cat "$(path "$1")"
    elif [[ "$2" == s3://* ]]; then mkdir -p "$(dirname "$(path "$2")")"; case "$1" in s3://*) cp "$(path "$1")" "$(path "$2")" ;; *) cp "$1" "$(path "$2")" ;; esac
    else exit 1; fi ;;
  rm) rm "$(path "$1")" ;;
esac`,
  gcloud: `path() { local r="\${1#*://}"; echo "$FAKE/store/$r"; }
[ "$1" != auth ] || { [ -f "$4" ] && cp "$4" "$FAKE/activated-key" && echo "$CLOUDSDK_CONFIG" > "$FAKE/cloudsdk-config"; exit; }
shift
case "$1 $2" in
  "objects describe") [ -f "$(path "$3")" ] || { echo "ERROR: (gcloud.storage.objects.describe) NotFoundError: 404" >&2; exit 1; } ;;
  "cat "*) cat "$(path "$2")" ;;
  "cp "*) mkdir -p "$(dirname "$(path "$3")")"; case "$2" in gs://*) cp "$(path "$2")" "$(path "$3")" ;; *) cp "$2" "$(path "$3")" ;; esac ;;
  "rm "*) rm "$(path "$2")" ;;
esac`,
};

type Run = { status: number | null; stderr: string; calls: string[] };
type Env = Record<string, string>;

function fixture(fn: (f: { root: string; mnt: string; store: string; run: (args: string[], env?: Env) => Run }) => void) {
  return () => {
    const root = mkdtempSync(join(tmpdir(), "agent-flywheel-persist-test-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const [name, body] of Object.entries(FAKES)) {
        const file = join(bin, name);
        writeFileSync(file, `#!/usr/bin/env bash\necho "${name} $*" >> "$FAKE/log"\n${body}\n`);
        chmodSync(file, 0o755);
      }
      const mnt = join(root, "agent-work");
      const run = (args: string[], env: Env = {}): Run => {
        writeFileSync(join(root, "log"), "");
        const res = spawnSync("bash", [SCRIPT, ...args], {
          encoding: "utf8",
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            FAKE: root,
            ISSUE: "7",
            PERSISTENCE_BUCKET: "s3://bucket/agent",
            PERSISTENCE_TMP: join(root, "tmp"),
            PERSISTENCE_SIZE: "64M",
            GITHUB_RUN_ID: "99",
            ...env,
          },
        });
        const calls = readFileSync(join(root, "log"), "utf8").split("\n").filter(Boolean);
        return { status: res.status, stderr: res.stderr, calls };
      };
      fn({ root, mnt, store: join(root, "store"), run });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const names = (calls: string[]) => calls.map((c) => c.split(" ")[0]!).filter((n) => n !== "sudo");
const OBJ = "bucket/agent/issues/issue-7.img.zst";

test("with PERSISTENCE_BUCKET unset, every command is a no-op that touches nothing", fixture(({ run }) => {
  for (const args of [["restore", "x"], ["save", "x"], ["delete"]]) {
    const r = run(args, { PERSISTENCE_BUCKET: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, []);
  }
}));

test("first run: a fresh image owned by the runner user, mounted nosuid,nodev; save syncs, trims and unmounts before compressing, then uploads via a temp key", fixture(({ root, mnt, store, run }) => {
  let r = run(["restore", mnt]);
  assert.equal(r.status, 0, r.stderr);
  const uid = String(process.getuid!()), gid = String(process.getgid!());
  assert.deepEqual(names(r.calls), ["aws", "mkfs.ext4", "mount"]);
  assert.match(r.calls[1]!, new RegExp(`-E root_owner=${uid}:${gid} `));
  assert.match(r.calls.find((c) => c.startsWith("mount"))!, /^mount -o loop,nosuid,nodev \S+issue-7\.img \S+agent-work$/);
  const img = join(root, "tmp", "agent-flywheel-issue-7.img");
  assert.equal(readFileSync(img).length, 64 * 1024 * 1024, "PERSISTENCE_SIZE");
  writeFileSync(img, "first image");

  r = run(["save", mnt]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(names(r.calls), ["mountpoint", "sync", "fstrim", "umount", "zstd", "aws", "aws", "aws", "aws"]);
  assert.match(r.calls.find((c) => c.startsWith("zstd"))!, /^zstd -1 -T0 /);
  const aws = r.calls.filter((c) => c.startsWith("aws"));
  assert.match(aws[0]!, new RegExp(`^aws s3 cp --only-show-errors \\S+\\.img\\.zst s3://${OBJ}\\.tmp-99$`));
  assert.match(aws[1]!, /^aws s3api head-object/);
  assert.equal(aws[2], `aws s3 cp --only-show-errors s3://${OBJ}.tmp-99 s3://${OBJ}`);
  assert.equal(aws[3], `aws s3 rm --only-show-errors s3://${OBJ}.tmp-99`);
  assert.equal(readFileSync(join(store, OBJ), "utf8"), "first image");
  assert.ok(!existsSync(join(store, `${OBJ}.prev`)) && !existsSync(join(store, `${OBJ}.tmp-99`)));
  assert.ok(!existsSync(img), "the local image is cleaned up");

  // A second save (GitLab's after_script backstop) is a no-op.
  r = run(["save", mnt]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, []);
}));

test("next run: downloads, decompresses and e2fscks the image; its save keeps the old one as .prev", fixture(({ root, mnt, store, run }) => {
  mkdirSync(dirname(join(store, OBJ)), { recursive: true });
  writeFileSync(join(store, OBJ), "saved image");
  let r = run(["restore", mnt]);
  assert.equal(r.status, 0, r.stderr);
  // The download and `zstd -d` are one pipeline, so they log in either order.
  assert.deepEqual(names(r.calls).slice(3), ["e2fsck", "mount"]);
  assert.deepEqual(r.calls.slice(1, 3).sort(), [`aws s3 cp --only-show-errors s3://${OBJ} -`, r.calls.find((c) => c.startsWith("zstd -d"))!]);
  assert.match(r.calls[3]!, /^e2fsck -p /);
  const img = join(root, "tmp", "agent-flywheel-issue-7.img");
  assert.equal(readFileSync(img, "utf8"), "saved image");
  writeFileSync(img, "newer image");

  r = run(["save", mnt]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(store, OBJ), "utf8"), "newer image");
  assert.equal(readFileSync(join(store, `${OBJ}.prev`), "utf8"), "saved image");

  // e2fsck: 1/2 (fixed) are fine, 4+ (not fixed) fails the restore, with nothing mounted.
  r = run(["restore", mnt], { E2FSCK_CODE: "1" });
  assert.equal(r.status, 0, r.stderr);
  run(["save", mnt]);
  r = run(["restore", mnt], { E2FSCK_CODE: "4" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.prev/);
  assert.ok(!r.calls.some((c) => c.startsWith("mount")));
}));

test("a failed existence check never falls back to a fresh image, and the save that follows uploads nothing", fixture(({ mnt, store, run }) => {
  let r = run(["restore", mnt], { FAIL_HEAD: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Forbidden/);
  assert.deepEqual(names(r.calls), ["aws"]);
  r = run(["save", mnt]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, []);
  assert.ok(!existsSync(store));
}));

test("a host that can't loop-mount exits 3 (GitLab's cue to fall back to its cache), and saves nothing", fixture(({ mnt, store, run }) => {
  let r = run(["restore", mnt], { FAIL_MOUNT: "1" });
  assert.equal(r.status, 3);
  r = run(["save", mnt]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, []);
  assert.ok(!existsSync(store));
}));

test("if umount fails, nothing is compressed or uploaded; a failed upload can be retried without remounting", fixture(({ mnt, store, run }) => {
  assert.equal(run(["restore", mnt]).status, 0);
  let r = run(["save", mnt], { FAIL_UMOUNT: "1" });
  assert.equal(r.status, 1);
  assert.deepEqual(names(r.calls), ["mountpoint", "sync", "fstrim", "umount"]);
  assert.ok(!existsSync(store));

  r = run(["save", mnt], { FAIL_UPLOAD: "1" });
  assert.equal(r.status, 1);
  assert.ok(!existsSync(join(store, OBJ)));
  r = run(["save", mnt]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(names(r.calls).slice(0, 2), ["mountpoint", "zstd"], "already unmounted: straight to compressing");
  assert.ok(existsSync(join(store, OBJ)));
}));

test("--read-only (the publish job) mounts ro and its save only unmounts", fixture(({ mnt, store, run }) => {
  mkdirSync(dirname(join(store, OBJ)), { recursive: true });
  writeFileSync(join(store, OBJ), "saved image");
  let r = run(["restore", mnt, "--read-only"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls.find((c) => c.startsWith("mount"))!, /-o loop,nosuid,nodev,ro /);
  r = run(["save", mnt]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(names(r.calls), ["mountpoint", "sync", "umount"]);
  assert.equal(readFileSync(join(store, OBJ), "utf8"), "saved image");
  // Nothing to mount read-only is an error, not a fresh image.
  rmSync(join(store, OBJ));
  r = run(["restore", mnt, "--read-only"]);
  assert.equal(r.status, 1);
}));

test("gs:// goes through gcloud, with PERSISTENCE_GCS_KEY in a throwaway config dir", fixture(({ root, mnt, store, run }) => {
  const env = { PERSISTENCE_BUCKET: "gs://bucket/agent", PERSISTENCE_GCS_KEY: '{"type":"service_account"}' };
  let r = run(["restore", mnt], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(root, "activated-key"), "utf8"), env.PERSISTENCE_GCS_KEY);
  assert.ok(!existsSync(readFileSync(join(root, "cloudsdk-config"), "utf8").trim()), "config dir removed on exit");
  writeFileSync(join(root, "tmp", "agent-flywheel-issue-7.img"), "gcs image");
  r = run(["save", mnt], env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.some((c) => c === `gcloud storage cp gs://${OBJ}.tmp-99 gs://${OBJ}`));
  assert.equal(readFileSync(join(store, OBJ), "utf8"), "gcs image");
  r = run(["restore", mnt], env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.includes(`gcloud storage cat gs://${OBJ}`));
}));

test("delete removes the image and its .prev; bad config is refused", fixture(({ store, run }) => {
  mkdirSync(dirname(join(store, OBJ)), { recursive: true });
  writeFileSync(join(store, OBJ), "a");
  writeFileSync(join(store, `${OBJ}.prev`), "b");
  let r = run(["delete"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(store, OBJ)) && !existsSync(join(store, `${OBJ}.prev`)));
  assert.equal(run(["delete"]).status, 0, "already gone is fine");

  r = run(["delete"], { PERSISTENCE_BUCKET: "https://bucket" });
  assert.equal(r.status, 2);
  r = run(["delete"], { ISSUE: "7; rm -rf /" });
  assert.equal(r.status, 2);
}));
