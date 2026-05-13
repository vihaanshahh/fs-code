#!/usr/bin/env bash
set -euo pipefail

# release.sh — orchestrate a full fluidstate release end-to-end.
#
# 1. Validate working tree + remote sync
# 2. Resolve target version (from Cargo.toml, or --version)
# 3. Tag + push (skipped in --dry-run)
# 4. Poll the GitHub `Release` workflow run until terminal state
# 5. Verify the GH Release contains every expected asset
# 6. Notify fs-code-landing to invalidate its release cache
#
# All steps emit progress to stderr so it can be piped or watched.

usage() {
  cat <<'USAGE'
Usage: scripts/release.sh [options]

Options:
  --version vX.Y.Z   Target version. Defaults to the version in Cargo.toml.
  --bump             Run scripts/bump-patch-version.sh first, then use the
                     resulting version. Stages and commits the bump.
  --dry-run          Validate everything and print what *would* happen,
                     but do not tag, push, or call the landing API.
  --skip-revalidate  Skip the landing-site cache flush.
  --landing-url URL  Override the landing site base URL.
                     Default: https://fluidstate.ai
  --no-poll          Do not wait for the GitHub Actions release workflow.
                     Tag + push, then exit.
  --timeout SECONDS  Workflow poll timeout. Default: 1800 (30 min).
  -h, --help         Show this message.

Environment:
  GH_TOKEN / GITHUB_TOKEN  Used by `gh` for API calls (already required by gh).
  FS_LANDING_REVALIDATE_SECRET
                           Shared secret POSTed to the landing's
                           /api/releases/revalidate endpoint. Must match the
                           value set in fs-code-landing's environment.

Exit codes:
  0  success
  1  validation failure (dirty tree, version mismatch, missing assets, ...)
  2  workflow failed or timed out
  3  landing revalidate failed
USAGE
}

# ─── parsing ──────────────────────────────────────────────────────────────────

dry_run=0
do_bump=0
skip_revalidate=0
no_poll=0
explicit_version=""
landing_url="${FS_LANDING_URL:-https://fluidstate.ai}"
timeout_secs=1800

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      explicit_version="${2:-}"
      [ -z "$explicit_version" ] && { echo "release.sh: --version requires an argument" >&2; exit 2; }
      shift 2
      ;;
    --bump)        do_bump=1; shift ;;
    --dry-run)     dry_run=1; shift ;;
    --skip-revalidate) skip_revalidate=1; shift ;;
    --no-poll)     no_poll=1; shift ;;
    --landing-url)
      landing_url="${2:-}"
      [ -z "$landing_url" ] && { echo "release.sh: --landing-url requires an argument" >&2; exit 2; }
      shift 2
      ;;
    --timeout)
      timeout_secs="${2:-}"
      [ -z "$timeout_secs" ] && { echo "release.sh: --timeout requires an argument" >&2; exit 2; }
      shift 2
      ;;
    -h|--help)     usage; exit 0 ;;
    *)             echo "release.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ─── output ───────────────────────────────────────────────────────────────────

if [ -t 2 ]; then
  C_DIM='\033[2m'; C_BOLD='\033[1m'
  C_BLUE='\033[34m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'
  C_RESET='\033[0m'
else
  C_DIM=''; C_BOLD=''; C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi

log()   { printf "${C_DIM}%s${C_RESET} %s\n" "[$(date +%H:%M:%S)]" "$*" >&2; }
step()  { printf "\n${C_BOLD}${C_BLUE}▸${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$*" >&2; }
ok()    { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$*" >&2; }
warn()  { printf "  ${C_YELLOW}⚠${C_RESET} %s\n" "$*" >&2; }
fail()  { printf "  ${C_RED}✗${C_RESET} %s\n" "$*" >&2; }

dry()   {
  if [ "$dry_run" -eq 1 ]; then
    printf "  ${C_YELLOW}↳ dry-run:${C_RESET} %s\n" "$*" >&2
  fi
}

# ─── prerequisites ────────────────────────────────────────────────────────────

step "Prerequisites"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [ ! -f Cargo.toml ] || ! grep -q '^\[workspace\.package\]' Cargo.toml; then
  fail "Cargo.toml with [workspace.package] not found — wrong repo?"
  exit 1
fi
ok "repo: $(basename "$repo_root")"

for bin in gh git curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    fail "required binary not found: $bin"
    exit 1
  fi
done
ok "git, gh, curl available"

if ! gh auth status >/dev/null 2>&1; then
  fail "gh is not authenticated. Run: gh auth login"
  exit 1
fi
ok "gh authenticated"

# Capture the repo slug for assembling REST URLs later.
repo_slug="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
ok "github: $repo_slug"

# ─── working tree state ───────────────────────────────────────────────────────

step "Working tree"

current_branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo "detached")"
ok "branch: $current_branch"

if [ "$current_branch" != "main" ]; then
  warn "not on main — releasing from '$current_branch'"
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  if [ "$do_bump" -eq 1 ] && [ "$dry_run" -eq 0 ]; then
    fail "working tree dirty — commit or stash before --bump"
    exit 1
  fi
  warn "working tree has uncommitted changes (will be ignored)"
else
  ok "working tree clean"
fi

git fetch --tags --quiet origin "$current_branch" 2>/dev/null || true
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/$current_branch" 2>/dev/null || echo "")"
if [ -n "$remote_sha" ] && [ "$local_sha" != "$remote_sha" ]; then
  warn "local HEAD differs from origin/$current_branch"
  warn "  local:  $local_sha"
  warn "  remote: $remote_sha"
else
  ok "in sync with origin/$current_branch"
fi

# ─── version resolution ───────────────────────────────────────────────────────

step "Version"

read_workspace_version() {
  awk '
    /^\[workspace\.package\]$/ { in_wp = 1; next }
    /^\[/ && $0 !~ /^\[workspace\.package\]$/ { in_wp = 0 }
    in_wp && $1 == "version" {
      gsub(/"/, "", $3); print $3; exit
    }
  ' Cargo.toml
}

if [ "$do_bump" -eq 1 ]; then
  if [ "$dry_run" -eq 1 ]; then
    next="$(scripts/bump-patch-version.sh --dry-run)"
    ok "would bump Cargo.toml to $next"
    target_version="$next"
  else
    target_version="$(scripts/bump-patch-version.sh --stage)"
    git commit -m "chore: bump version to v${target_version} [skip version bump]" >/dev/null
    ok "bumped + committed v$target_version"
  fi
elif [ -n "$explicit_version" ]; then
  target_version="${explicit_version#v}"
  ok "explicit version: v$target_version"
else
  target_version="$(read_workspace_version)"
  ok "Cargo.toml version: v$target_version"
fi

if ! [[ "$target_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "expected x.y.z version, got '$target_version'"
  exit 1
fi

tag="v$target_version"

if git rev-parse "$tag" >/dev/null 2>&1; then
  fail "tag $tag already exists locally"
  exit 1
fi
if git ls-remote --tags origin "refs/tags/$tag" | grep -q "$tag"; then
  fail "tag $tag already exists on origin"
  exit 1
fi
ok "tag $tag is available"

if gh release view "$tag" >/dev/null 2>&1; then
  fail "release $tag already published on GitHub"
  exit 1
fi
ok "no existing release for $tag"

# ─── tag + push ───────────────────────────────────────────────────────────────

step "Tag + push"

if [ "$dry_run" -eq 1 ]; then
  dry "git tag -a $tag -m \"$tag\""
  dry "git push origin $tag"
else
  git tag -a "$tag" -m "$tag"
  ok "created annotated tag $tag at $local_sha"

  git push origin "$tag"
  ok "pushed $tag to origin"
fi

# ─── workflow poll ────────────────────────────────────────────────────────────

if [ "$no_poll" -eq 1 ]; then
  step "Workflow poll skipped (--no-poll)"
else
  step "Polling Release workflow"

  if [ "$dry_run" -eq 1 ]; then
    dry "gh run watch (release.yml @ $tag)"
    last_run_id="$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || echo "")"
    if [ -n "$last_run_id" ]; then
      ok "would watch run $last_run_id (most recent on release.yml)"
    fi
  else
    # Wait for the workflow run for this tag to appear.
    deadline=$(( $(date +%s) + timeout_secs ))
    run_id=""
    while [ -z "$run_id" ]; do
      if [ "$(date +%s)" -ge "$deadline" ]; then
        fail "timed out waiting for workflow to start"
        exit 2
      fi
      run_id="$(gh run list \
        --workflow=release.yml \
        --event=push \
        --limit 20 \
        --json databaseId,headBranch,event,status,createdAt \
        -q "[.[] | select(.headBranch == \"$tag\")] | .[0].databaseId" 2>/dev/null || true)"
      if [ -z "$run_id" ]; then
        sleep 5
      fi
    done
    ok "run $run_id queued (https://github.com/$repo_slug/actions/runs/$run_id)"

    # Stream until complete. `gh run watch` exits non-zero on failure.
    if gh run watch "$run_id" --exit-status; then
      ok "workflow succeeded"
    else
      fail "workflow failed (run $run_id)"
      exit 2
    fi
  fi
fi

# ─── release asset verification ───────────────────────────────────────────────

step "Verify release assets"

expected_assets=(
  "fluidstate-aarch64-apple-darwin.tar.gz"
  "fluidstate-x86_64-apple-darwin.tar.gz"
  "fluidstate-x86_64-unknown-linux-gnu.tar.gz"
  "fluidstate-darwin-aarch64"
  "fluidstate-darwin-x86_64"
  "fluidstate-linux-x86_64"
  "checksums.sha256"
)

if [ "$dry_run" -eq 1 ]; then
  dry "gh release view $tag --json assets"
  for a in "${expected_assets[@]}"; do
    printf "    ${C_DIM}• %s${C_RESET}\n" "$a" >&2
  done
else
  # Up to ~2 minutes for the release to appear (gh release create is the last
  # step of the workflow, so this is usually instant by now).
  release_deadline=$(( $(date +%s) + 120 ))
  while ! gh release view "$tag" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$release_deadline" ]; then
      fail "release $tag never appeared on GitHub after workflow success"
      exit 2
    fi
    sleep 3
  done

  asset_list="$(gh release view "$tag" --json assets -q '.assets[].name')"
  missing=()
  for a in "${expected_assets[@]}"; do
    if ! grep -Fxq "$a" <<< "$asset_list"; then
      missing+=("$a")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    fail "release $tag is missing assets:"
    for m in "${missing[@]}"; do
      printf "       %s\n" "$m" >&2
    done
    exit 1
  fi

  asset_count="$(wc -l <<< "$asset_list" | tr -d ' ')"
  ok "all ${#expected_assets[@]} expected assets present (release has $asset_count total)"
fi

# ─── notify landing ───────────────────────────────────────────────────────────

step "Notify landing"

if [ "$skip_revalidate" -eq 1 ]; then
  warn "skipped (--skip-revalidate)"
elif [ "$dry_run" -eq 1 ]; then
  dry "POST $landing_url/api/releases/revalidate"
  dry "  body: {\"tag\":\"$tag\"}"
  if [ -z "${FS_LANDING_REVALIDATE_SECRET:-}" ]; then
    warn "FS_LANDING_REVALIDATE_SECRET unset — real run will need it"
  fi
  # We still do a HEAD check so the URL is at least reachable.
  if curl -fsI --max-time 5 "$landing_url" >/dev/null 2>&1; then
    ok "landing $landing_url reachable"
  else
    warn "landing $landing_url not reachable from here (ok in dry-run)"
  fi
else
  if [ -z "${FS_LANDING_REVALIDATE_SECRET:-}" ]; then
    fail "FS_LANDING_REVALIDATE_SECRET not set — cannot flush landing cache"
    fail "  (release is published, just rerun with the env var to notify the site)"
    exit 3
  fi

  http_code="$(curl -sS -o /tmp/fs-release-revalidate.out -w '%{http_code}' \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${FS_LANDING_REVALIDATE_SECRET}" \
    --data "{\"tag\":\"$tag\"}" \
    --max-time 15 \
    "$landing_url/api/releases/revalidate" || true)"

  if [ "$http_code" = "200" ]; then
    ok "landing revalidated (HTTP $http_code)"
    body="$(cat /tmp/fs-release-revalidate.out 2>/dev/null || true)"
    [ -n "$body" ] && printf "    ${C_DIM}%s${C_RESET}\n" "$body" >&2
  else
    fail "landing revalidate failed (HTTP $http_code)"
    cat /tmp/fs-release-revalidate.out >&2 || true
    exit 3
  fi
fi

# ─── done ─────────────────────────────────────────────────────────────────────

step "Done"
if [ "$dry_run" -eq 1 ]; then
  printf "  ${C_YELLOW}dry-run complete — nothing was published.${C_RESET}\n" >&2
  printf "  Re-run without ${C_BOLD}--dry-run${C_RESET} to release ${C_BOLD}%s${C_RESET}.\n" "$tag" >&2
else
  printf "  ${C_GREEN}released ${C_BOLD}%s${C_RESET} ${C_GREEN}— https://github.com/%s/releases/tag/%s${C_RESET}\n" \
    "$tag" "$repo_slug" "$tag" >&2
fi
