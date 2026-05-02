#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/bump-patch-version.sh [--dry-run] [--stage]

Bumps the workspace package version's patch component:
  0.9.1 -> 0.9.2

Options:
  --dry-run  Print the next version without editing files.
  --stage    Stage Cargo.toml and Cargo.lock after editing.
USAGE
}

dry_run=0
stage=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    --stage)
      stage=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "bump-patch-version: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ "${FS_SKIP_VERSION_BUMP:-}" = "1" ]; then
  exit 0
fi

export LC_ALL=C
export LANG=C

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

current_version="$(
  awk '
    /^\[workspace\.package\]$/ { in_workspace_package = 1; next }
    /^\[/ && $0 !~ /^\[workspace\.package\]$/ { in_workspace_package = 0 }
    in_workspace_package && $1 == "version" {
      gsub(/"/, "", $3)
      print $3
      exit
    }
  ' Cargo.toml
)"

if ! [[ "$current_version" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]]; then
  echo "bump-patch-version: expected numeric x.y.z version, got '$current_version'" >&2
  exit 1
fi

IFS=. read -r major minor patch <<<"$current_version"
next_version="${major}.${minor}.$((patch + 1))"

if [ "$dry_run" -eq 1 ]; then
  echo "$next_version"
  exit 0
fi

export CURRENT_VERSION="$current_version"
export NEXT_VERSION="$next_version"

perl -0pi -e '
  my $old = $ENV{CURRENT_VERSION};
  my $new = $ENV{NEXT_VERSION};
  s/(\[workspace\.package\][^\[]*?version\s*=\s*")\Q$old\E(")/$1$new$2/s
' Cargo.toml

perl -0pi -e '
  my $old = $ENV{CURRENT_VERSION};
  my $new = $ENV{NEXT_VERSION};
  s/(\[\[package\]\]\nname = "(?:fluidstate|fs-agent|fs-core|fs-pty|fs-tui|fs-update)"\nversion = ")\Q$old\E(")/$1$new$2/g
' Cargo.lock

if [ "$stage" -eq 1 ]; then
  git add Cargo.toml Cargo.lock
fi

echo "$next_version"
