#!/usr/bin/env bash
# Opt-in workspace persistence (README "Persistent workspace images"): one issue's work dir as
# a sparse ext4 image, kept in object storage between jobs and runs instead of the CI cache.
# Runs on the CI host, never in the agent container: it holds the bucket credential, which no
# `docker run` is ever handed.
#
#   persist.sh restore <mountpoint> [--read-only]
#       Download ${PERSISTENCE_BUCKET}/issues/issue-${ISSUE}.img.zst, decompress, `e2fsck -p`
#       (or, if there is none yet, create a fresh PERSISTENCE_SIZE image owned by the current
#       user), and loop-mount it nosuid,nodev on <mountpoint>. --read-only mounts it ro, and
#       its save only unmounts (the publish job reads the work dir as data and changes nothing).
#   persist.sh save <mountpoint>
#       In this order: sync, fstrim, umount, `zstd -1 -T0`, upload to a temp key, keep the old
#       image as .prev, copy the temp key into place, delete the temp key. Never compresses a
#       mounted filesystem. A no-op unless this host's restore succeeded, so a failed restore
#       can't upload an empty image over a good one. Safe to run twice (a retry after a failed
#       upload picks up where it left off).
#   persist.sh delete
#       Delete the issue's image and its .prev (when the issue closes).
#
# Env: PERSISTENCE_BUCKET (s3://bucket[/prefix] or gs://bucket[/prefix]; unset = do nothing),
# ISSUE, PERSISTENCE_SIZE (default 5G), PERSISTENCE_TMP (where the image file lives; default
# $RUNNER_TEMP, then $TMPDIR, then /tmp), PERSISTENCE_UMOUNT_TRIES (default 5, 2s apart). S3
# uses the aws CLI and its usual AWS_* env; GCS uses gcloud, with PERSISTENCE_GCS_KEY (a service
# account key's JSON) if set.
#
# Exit codes: 0 ok (or persistence off), 1 error, 2 usage/config, 3 restore couldn't loop-mount
# on this host (GitLab falls back to its native cache on 3; README "Set up on GitLab").
set -euo pipefail

log() { echo "[persist] $*" >&2; }
die() { log "$1"; exit "${2:-1}"; }

cmd="${1:-}"
[ -n "$cmd" ] || die "usage: persist.sh restore <mountpoint> [--read-only] | save <mountpoint> | delete" 2
if [ -z "${PERSISTENCE_BUCKET:-}" ]; then
  log "PERSISTENCE_BUCKET is unset; nothing to do"
  exit 0
fi
[[ "${ISSUE:-}" =~ ^[0-9]+$ ]] || die "ISSUE must be an issue number" 2
case "$PERSISTENCE_BUCKET" in
  s3://?*) store=s3 ;;
  gs://?*) store=gs ;;
  *) die "PERSISTENCE_BUCKET must start with s3:// or gs://" 2 ;;
esac

url="${PERSISTENCE_BUCKET%/}/issues/issue-$ISSUE.img.zst"
dir="${PERSISTENCE_TMP:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
img="$dir/agent-flywheel-issue-$ISSUE.img"
# Written by a successful restore: the mount mode (rw/ro). save does nothing without it.
state="$img.state"
SUDO=""
[ "$(id -u)" = 0 ] || SUDO=sudo

# CI passes optional settings as possibly-empty env; the aws CLI treats an empty
# AWS_ENDPOINT_URL or AWS_REGION as a value, not as unset.
for v in AWS_ENDPOINT_URL AWS_REGION AWS_DEFAULT_REGION AWS_SESSION_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY PERSISTENCE_GCS_KEY; do
  [ -n "${!v:-}" ] || unset "$v"
done

if [ "$store" = gs ] && ! command -v gcloud >/dev/null; then
  die "gs:// needs the gcloud CLI on the runner (README \"Persistent workspace images\")"
fi
# A GCS key goes into a throwaway gcloud config dir, removed on exit, so nothing of it is left
# in the runner user's ~/.config/gcloud.
if [ "$store" = gs ] && [ -n "${PERSISTENCE_GCS_KEY:-}" ]; then
  CLOUDSDK_CONFIG="$(mktemp -d)"
  export CLOUDSDK_CONFIG
  trap 'rm -rf "$CLOUDSDK_CONFIG"' EXIT
  (umask 077 && printf '%s' "$PERSISTENCE_GCS_KEY" > "$CLOUDSDK_CONFIG/key.json")
  gcloud auth activate-service-account --key-file "$CLOUDSDK_CONFIG/key.json" --quiet >/dev/null 2>&1 \
    || die "gcloud couldn't activate PERSISTENCE_GCS_KEY"
  rm -f "$CLOUDSDK_CONFIG/key.json"
fi

# Object store verbs. obj_exists: 0 exists, 1 doesn't, anything else is an error (so a
# permission or network error is never mistaken for "first run" and a fresh image uploaded
# over the real one).
obj_exists() {
  local err rest
  err="$(mktemp)"
  if [ "$store" = s3 ]; then
    rest="${1#s3://}"
    aws s3api head-object --bucket "${rest%%/*}" --key "${rest#*/}" >/dev/null 2>"$err" && { rm -f "$err"; return 0; }
  else
    gcloud storage objects describe "$1" >/dev/null 2>"$err" && { rm -f "$err"; return 0; }
  fi
  if grep -qiE 'not ?found|404|NoSuchKey' "$err"; then rm -f "$err"; return 1; fi
  cat "$err" >&2; rm -f "$err"
  return 2
}
obj_get() { if [ "$store" = s3 ]; then aws s3 cp --only-show-errors "$1" -; else gcloud storage cat "$1"; fi; }
obj_cp() { if [ "$store" = s3 ]; then aws s3 cp --only-show-errors "$1" "$2"; else gcloud storage cp "$1" "$2"; fi; }
obj_rm() { if [ "$store" = s3 ]; then aws s3 rm --only-show-errors "$1"; else gcloud storage rm "$1"; fi; }

restore() {
  local mnt="$1" mode="${2:-rw}" code=0
  [ ! -e "$state" ] || die "$img is already restored on this host; save it first"
  mkdir -p "$dir" "$mnt"
  rm -f "$img" "$img.zst"
  obj_exists "$url" || code=$?
  case "$code" in
    0)
      log "restoring $url"
      obj_get "$url" | zstd -d -q -f -o "$img" || { rm -f "$img"; die "couldn't download or decompress $url"; }
      # 0 = clean, 1 = fixed, 2 = fixed (reboot advised, meaningless for an image); 4+ = not fixed.
      e2fsck -p "$img" || [ $? -lt 4 ] \
        || die "e2fsck couldn't repair $url; roll back by copying issue-$ISSUE.img.zst.prev over it, or delete it to start fresh"
      ;;
    1)
      [ "$mode" = rw ] || die "no image at $url to mount read-only"
      local size="${PERSISTENCE_SIZE:-5G}"
      log "no image at $url yet; creating a fresh $size one"
      truncate -s "$size" "$img"
      # Owned by whoever runs this (the CI runner user), who is also who the container runs
      # as, so neither side ever needs a chown. No blocks reserved for root.
      mkfs.ext4 -q -F -m 0 -E "root_owner=$(id -u):$(id -g)" "$img"
      ;;
    *) die "couldn't check for $url" ;;
  esac
  # nosuid,nodev: the agent writes this filesystem with permissions bypassed, and the host
  # mounts it again later.
  local opts="loop,nosuid,nodev"
  [ "$mode" = rw ] || opts="$opts,ro"
  $SUDO mount -o "$opts" "$img" "$mnt" || { rm -f "$img"; die "couldn't loop-mount $img on this host" 3; }
  echo "$mode" > "$state"
  log "mounted issue #$ISSUE's workspace on $mnt ($mode)"
}

save() {
  local mnt="$1" mode
  if [ ! -f "$state" ]; then
    log "nothing restored on this host; nothing to save"
    return 0
  fi
  mode="$(cat "$state")"
  # Strict order: the image is only read once the filesystem is cleanly unmounted.
  if mountpoint -q "$mnt"; then
    sync
    [ "$mode" = ro ] || $SUDO fstrim "$mnt" || true
    local tries=0
    until $SUDO umount "$mnt"; do
      tries=$((tries + 1))
      [ "$tries" -lt "${PERSISTENCE_UMOUNT_TRIES:-5}" ] || die "couldn't unmount $mnt; not uploading a mounted filesystem"
      sleep 2
    done
  fi
  if [ "$mode" = ro ]; then
    rm -f "$img" "$state"
    log "unmounted $mnt (read-only; nothing to upload)"
    return 0
  fi
  zstd -1 -T0 -q -f "$img" -o "$img.zst"
  # Atomic from a reader's point of view: the real key only ever holds a complete upload.
  local tmp="$url.tmp-${GITHUB_RUN_ID:-${CI_JOB_ID:-$$}}"
  obj_cp "$img.zst" "$tmp" || die "couldn't upload to $tmp"
  local code=0
  obj_exists "$url" || code=$?
  case "$code" in
    0) obj_cp "$url" "$url.prev" || die "couldn't keep the previous image as $url.prev" ;;
    1) ;;
    *) die "couldn't check for $url" ;;
  esac
  obj_cp "$tmp" "$url" || die "couldn't copy $tmp to $url"
  obj_rm "$tmp" || log "couldn't delete $tmp (harmless; a bucket lifecycle rule can expire it)"
  rm -f "$img" "$img.zst" "$state"
  log "saved issue #$ISSUE's workspace to $url"
}

delete() {
  local u code
  for u in "$url" "$url.prev"; do
    code=0
    obj_exists "$u" || code=$?
    case "$code" in
      0) obj_rm "$u" ;;
      1) log "no $u" ;;
      *) die "couldn't check for $u" ;;
    esac
  done
}

case "$cmd" in
  restore)
    [ -n "${2:-}" ] || die "usage: persist.sh restore <mountpoint> [--read-only]" 2
    case "${3:-}" in
      "") restore "$2" rw ;;
      --read-only) restore "$2" ro ;;
      *) die "unknown option ${3}" 2 ;;
    esac
    ;;
  save)
    [ -n "${2:-}" ] || die "usage: persist.sh save <mountpoint>" 2
    save "$2"
    ;;
  delete) delete ;;
  *) die "unknown command $cmd" 2 ;;
esac
