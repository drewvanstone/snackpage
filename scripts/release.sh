#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd "$script_dir/.." && pwd)"
formula_updater="$script_dir/update-homebrew-formula.rb"

github_repo="${SNACKPAGE_GITHUB_REPO:-drewvanstone/snackpage}"
tap_name="${SNACKPAGE_HOMEBREW_TAP:-drewvanstone/tap}"
formula_name="snackpage"
health_url="${SNACKPAGE_HEALTH_URL:-http://127.0.0.1:8765/healthz}"

release_tmp=""
release_archive=""
formula_backup=""
tap_repo=""
tap_formula=""
tap_head=""
formula_modified=0
formula_committed=0
generated_formula_sha=""
source_lock=""
source_lock_owned=0
tap_lock=""
tap_lock_owned=0
source_commit_push_ref=""
source_commit_push_object=""
source_tag_push_ref=""
source_tag_push_object=""
tap_commit_push_ref=""
tap_commit_push_object=""
release_state_file=""
release_state_active=0
release_state_commit=""
version_selection=""

usage() {
  cat <<'EOF'
Usage:
  make release-plan [VERSION=X.Y.Z]
  make release [VERSION=X.Y.Z]

Without VERSION, the next minor version is selected (for example,
v1.8.5 becomes v1.9.0). An explicit VERSION must be stable semantic version.
The target never stages or commits source changes; commit the intended release
on main before running it.
EOF
}

die() {
  printf 'release: %s\n' "$*" >&2
  exit 1
}

step() {
  printf '\n==> %s\n' "$*"
}

run() {
  printf '  +'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}

remove_pinned_ref() {
  local repo="$1"
  local ref="$2"
  local expected_object="$3"
  local current_object

  [ -n "$repo" ] && [ -n "$ref" ] && [ -n "$expected_object" ] || return 0
  current_object="$(git -C "$repo" rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
  [ -n "$current_object" ] || return 0
  if [ "$current_object" != "$expected_object" ]; then
    printf 'release: WARNING: leaving changed temporary ref %s in %s\n' "$ref" "$repo" >&2
    return 0
  fi
  git -C "$repo" update-ref -d "$ref" "$expected_object" >/dev/null 2>&1 ||
    printf 'release: WARNING: could not remove temporary ref %s in %s\n' "$ref" "$repo" >&2
}

cleanup() {
  status=$?
  trap - EXIT
  set +e

  if [ "$formula_modified" -eq 1 ] && [ "$formula_committed" -eq 0 ] && [ -n "$formula_backup" ] && [ -f "$formula_backup" ]; then
    restore_formula=1
    current_tap_head="$(git -C "$tap_repo" rev-parse HEAD 2>/dev/null || true)"
    if [ -n "$tap_head" ] && [ "$current_tap_head" != "$tap_head" ]; then
      restore_formula=0
    fi
    if [ -n "$generated_formula_sha" ] && [ -f "$tap_formula" ]; then
      current_formula_sha="$(shasum -a 256 "$tap_formula" 2>/dev/null | awk '{print $1}')"
      [ "$current_formula_sha" = "$generated_formula_sha" ] || restore_formula=0
    fi

    if [ "$restore_formula" -eq 1 ]; then
      git -C "$tap_repo" restore --staged -- "Formula/${formula_name}.rb" >/dev/null 2>&1 || true
      if cp -p "$formula_backup" "$tap_formula"; then
        printf 'release: restored the uncommitted tap formula after failure\n' >&2
      else
        printf 'release: WARNING: could not restore %s from %s\n' "$tap_formula" "$formula_backup" >&2
      fi
    else
      printf 'release: WARNING: tap state changed concurrently; leaving it untouched for review\n' >&2
    fi
  fi

  remove_pinned_ref "$tap_repo" "$tap_commit_push_ref" "$tap_commit_push_object"
  remove_pinned_ref "$root_dir" "$source_tag_push_ref" "$source_tag_push_object"
  remove_pinned_ref "$root_dir" "$source_commit_push_ref" "$source_commit_push_object"

  [ -z "$release_archive" ] || rm -f -- "$release_archive"
  [ -z "$formula_backup" ] || rm -f -- "$formula_backup"
  [ -z "$release_tmp" ] || rmdir -- "$release_tmp" >/dev/null 2>&1 || true

  if [ "$tap_lock_owned" -eq 1 ] && ! rmdir -- "$tap_lock" >/dev/null 2>&1; then
    printf 'release: WARNING: could not remove release lock %s\n' "$tap_lock" >&2
  fi
  if [ "$source_lock_owned" -eq 1 ] && ! rmdir -- "$source_lock" >/dev/null 2>&1; then
    printf 'release: WARNING: could not remove release lock %s\n' "$source_lock" >&2
  fi

  if [ "$status" -ne 0 ]; then
    if [ "$release_state_active" -eq 1 ]; then
      printf 'release: stopped; fix the problem and run make release to resume %s\n' "$tag" >&2
    else
      printf 'release: stopped; fix the reported problem and rerun make release\n' >&2
    fi
  fi
  exit "$status"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

matches_github_remote() {
  local remote_url="$1"
  local repo_slug="$2"

  case "$remote_url" in
    "git@github.com:${repo_slug}" | \
      "git@github.com:${repo_slug}.git" | \
      "https://github.com/${repo_slug}" | \
      "https://github.com/${repo_slug}.git" | \
      "ssh://git@github.com/${repo_slug}" | \
      "ssh://git@github.com/${repo_slug}.git")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

pin_git_ref() {
  local repo="$1"
  local ref="$2"
  local object="$3"
  local existing_object

  existing_object="$(git -C "$repo" rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
  if [ -n "$existing_object" ]; then
    [ "$existing_object" = "$object" ] ||
      die "temporary release ref $ref already points at a different object"
    return 0
  fi
  git -C "$repo" update-ref "$ref" "$object" "" ||
    die "could not create temporary release ref $ref"
}

source_changes() {
  if ! tracked_changes="$(git -C "$root_dir" status --porcelain=v1 --untracked-files=no)"; then
    return 1
  fi
  if ! untracked_changes="$(git -C "$root_dir" -c core.quotePath=false ls-files --others --exclude-standard | sed '/^\.claude\//d')"; then
    return 1
  fi

  if [ -n "$tracked_changes" ]; then
    printf '%s\n' "$tracked_changes"
  fi
  if [ -n "$untracked_changes" ]; then
    printf '%s\n' "$untracked_changes" | sed 's/^/?? /'
  fi
}

assert_source_clean() {
  if ! changes="$(source_changes)"; then
    die "could not inspect the source tree for uncommitted changes"
  fi
  if [ -n "$changes" ]; then
    printf '%s\n' "$changes" >&2
    die "source tree is not release-clean; commit the release and leave unrelated files unstaged"
  fi
}

assert_tap_clean() {
  if ! changes="$(git -C "$tap_repo" status --porcelain=v1 --untracked-files=all)"; then
    die "could not inspect the Homebrew tap for uncommitted changes"
  fi
  if [ -n "$changes" ]; then
    printf '%s\n' "$changes" >&2
    die "Homebrew tap has uncommitted changes: $tap_repo"
  fi
}

assert_tap_base_unchanged() {
  [ "$(git -C "$tap_repo" branch --show-current)" = "main" ] ||
    die "tap branch changed while the release was running"
  [ "$(git -C "$tap_repo" rev-parse HEAD)" = "$tap_head" ] ||
    die "tap HEAD changed while the release was running"

  current_tap_origin="$(git -C "$tap_repo" ls-remote origin refs/heads/main | awk 'NR == 1 { print $1 }')"
  [ "$current_tap_origin" = "$tap_origin_head" ] ||
    die "tap origin/main changed while the release was running; synchronize it and rerun"
}

assert_tap_unchanged() {
  assert_tap_clean
  assert_tap_base_unchanged
}

version_is_greater() {
  IFS=. read -r candidate_major candidate_minor candidate_patch <<<"$1"
  IFS=. read -r current_major current_minor current_patch <<<"$2"

  if ((candidate_major != current_major)); then
    ((candidate_major > current_major))
  elif ((candidate_minor != current_minor)); then
    ((candidate_minor > current_minor))
  else
    ((candidate_patch > current_patch))
  fi
}

is_stable_version() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}

latest_stable_tag() {
  local excluded_tag="${1:-}"
  local candidate_tag
  local candidate_version

  while IFS= read -r candidate_tag; do
    [ "$candidate_tag" = "$excluded_tag" ] && continue
    candidate_version="${candidate_tag#v}"
    if is_stable_version "$candidate_version"; then
      printf '%s\n' "$candidate_tag"
      return 0
    fi
  done < <(git -C "$root_dir" tag --list 'v[0-9]*' --sort=-v:refname)
  return 0
}

latest_remote_stable_tag() {
  local remote_tags
  local object_id
  local ref_name
  local candidate_tag
  local candidate_version
  local latest_tag=""
  local latest_version=""

  if ! remote_tags="$(git -C "$root_dir" ls-remote --refs --tags origin 'refs/tags/v*')"; then
    return 1
  fi
  while IFS=$'\t' read -r object_id ref_name; do
    [ -n "$object_id" ] && [ -n "$ref_name" ] || continue
    candidate_tag="${ref_name#refs/tags/}"
    candidate_version="${candidate_tag#v}"
    is_stable_version "$candidate_version" || continue
    if [ -z "$latest_version" ] || version_is_greater "$candidate_version" "$latest_version"; then
      latest_tag="$candidate_tag"
      latest_version="$candidate_version"
    fi
  done <<<"$remote_tags"
  printf '%s\n' "$latest_tag"
}

next_minor_after_tag() {
  local latest_tag="$1"
  local latest_version
  local latest_major
  local latest_minor
  local latest_patch

  if [ -z "$latest_tag" ]; then
    printf '0.1.0\n'
    return 0
  fi

  latest_version="${latest_tag#v}"
  IFS=. read -r latest_major latest_minor latest_patch <<<"$latest_version"
  printf '%s.%s.0\n' "$latest_major" "$((latest_minor + 1))"
}

next_minor_version() {
  next_minor_after_tag "$(latest_stable_tag)"
}

read_release_state() {
  local stored_record
  local stored_version
  local stored_commit
  local extra

  [ ! -L "$release_state_file" ] ||
    die "release state must not be a symbolic link: $release_state_file"
  [ -e "$release_state_file" ] || return 0
  [ -f "$release_state_file" ] ||
    die "release state is not a regular file: $release_state_file"

  stored_record="$(<"$release_state_file")"
  IFS=' ' read -r stored_version stored_commit extra <<<"$stored_record"
  is_stable_version "$stored_version" ||
    die "invalid release state in $release_state_file; inspect and remove it before retrying"
  [[ "$stored_commit" =~ ^[0-9a-f]{40,64}$ ]] && [ -z "$extra" ] ||
    die "invalid release state in $release_state_file; inspect and remove it before retrying"
  printf '%s %s\n' "$stored_version" "$stored_commit"
}

record_release_state() {
  local stored_record
  local stored_version
  local stored_commit

  stored_record="$(read_release_state)"
  if [ -n "$stored_record" ]; then
    IFS=' ' read -r stored_version stored_commit <<<"$stored_record"
    [ "$stored_version" = "$version" ] ||
      die "in-progress release $stored_version conflicts with requested $version"
    [ "$stored_commit" = "$head_commit" ] ||
      die "in-progress release $stored_version belongs to commit $stored_commit, not HEAD"
  else
    if ! (umask 077; set -C; printf '%s %s\n' "$version" "$head_commit" >"$release_state_file"); then
      die "could not record in-progress release in $release_state_file"
    fi
  fi
  release_state_active=1
  release_state_commit="$head_commit"
}

remote_tag_object() {
  git -C "$root_dir" ls-remote origin "refs/tags/$1" | awk 'NR == 1 { print $1 }'
}

remote_tag_commit() {
  dereferenced="$(git -C "$root_dir" ls-remote origin "refs/tags/$1^{}" | awk 'NR == 1 { print $1 }')"
  if [ -n "$dereferenced" ]; then
    printf '%s\n' "$dereferenced"
  else
    remote_tag_object "$1"
  fi
}

formula_matches_release() {
  grep -Fqx "  url \"$archive_url\"" "$tap_formula" &&
    grep -Fqx "  sha256 \"$archive_sha256\"" "$tap_formula" &&
    ! grep -Eq '^  version "' "$tap_formula"
}

validate_formula() {
  run ruby -c "$tap_formula"
  run brew trust --formula "$tap_name/$formula_name"
  run brew style "$tap_formula"
  run brew audit --strict "$tap_name/$formula_name"
}

validate_tap_release_commit() {
  local commit="$1"
  local expected_parent="$2"
  local expected_formula_sha="$3"
  local commit_parent
  local commit_paths
  local commit_subject
  local committed_formula_sha
  local committed_formula_mode

  commit_parent="$(git -C "$tap_repo" rev-parse "${commit}^")"
  [ "$commit_parent" = "$expected_parent" ] ||
    die "tap release commit does not have the expected parent"
  commit_subject="$(git -C "$tap_repo" log -1 --format=%s "$commit")"
  [ "$commit_subject" = "$tap_commit_message" ] ||
    die "tap release commit has an unexpected subject"
  commit_paths="$(git -C "$tap_repo" diff-tree --no-commit-id --name-only -r "$commit")"
  [ "$commit_paths" = "Formula/${formula_name}.rb" ] ||
    die "tap release commit changes files other than the formula"
  committed_formula_sha="$(git -C "$tap_repo" show "${commit}:Formula/${formula_name}.rb" | shasum -a 256 | awk '{print $1}')"
  [ "$committed_formula_sha" = "$expected_formula_sha" ] ||
    die "tap release commit contains unexpected formula content"
  committed_formula_mode="$(git -C "$tap_repo" ls-tree "$commit" "Formula/${formula_name}.rb" | awk 'NR == 1 { print $1 }')"
  [ "$committed_formula_mode" = "100644" ] ||
    die "tap release commit gives the formula an unexpected file mode"
}

plan_only=0

case "${1:-}" in
  --plan)
    plan_only=1
    shift
    ;;
  --help|-h)
    usage
    exit 0
    ;;
esac

[ "$#" -le 1 ] || {
  usage >&2
  exit 2
}

[[ "$github_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  die "invalid SNACKPAGE_GITHUB_REPO: $github_repo"
[[ "$tap_name" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  die "invalid SNACKPAGE_HOMEBREW_TAP: $tap_name"

command -v git >/dev/null 2>&1 || die "required command not found: git"
resolved_root="$(git -C "$root_dir" rev-parse --show-toplevel 2>/dev/null || true)"
[ "$resolved_root" = "$root_dir" ] || die "not the root of a Git checkout: $root_dir"
source_git_common="$(git -C "$root_dir" rev-parse --path-format=absolute --git-common-dir)"
release_state_file="$source_git_common/snackpage-release-version"

raw_version="${1:-}"
stored_release_record="$(read_release_state)"
if [ -n "$stored_release_record" ]; then
  IFS=' ' read -r stored_release_version release_state_commit <<<"$stored_release_record"
  if [ -n "$raw_version" ] && [ "${raw_version#v}" != "$stored_release_version" ]; then
    die "release $stored_release_version is already in progress; omit VERSION to resume it"
  fi
  version="$stored_release_version"
  version_selection="resume"
  release_state_active=1
elif [ -n "$raw_version" ]; then
  version="${raw_version#v}"
  is_stable_version "$version" ||
    die "VERSION must be a stable semantic version such as 1.9.0"
  version_selection="explicit"
else
  version="$(next_minor_version)"
  version_selection="automatic"
fi

tag="v$version"
archive_url="https://github.com/${github_repo}/archive/refs/tags/${tag}.tar.gz"
tap_commit_message="snackpage $version"

if [ "$plan_only" -eq 1 ]; then
  case "$version_selection" in
    automatic)
      selection_message="Automatically selected the next minor release."
      ;;
    resume)
      selection_message="An in-progress release will be resumed."
      ;;
    *)
      selection_message="Using the explicitly requested release version."
      ;;
  esac
  cat <<EOF
Release plan for $tag

$selection_message

  1. Require a clean, committed main branch (untracked .claude/ is ignored).
  2. Verify origin, GitHub authentication, the version/tag, and a clean tap.
  3. Run make check before publishing anything.
  4. Create/push $tag and main, then create the GitHub release.
  5. Download the published tag archive and calculate its SHA-256.
  6. Update, validate, commit, and push $tap_name/$formula_name.
  7. Upgrade Homebrew, restart snackpage, and poll $health_url.
  8. Verify the installed binary reports snackpage $version.

The workflow detects already-completed remote stages. Once publication starts,
plain make release resumes this version after a network or Homebrew failure.
EOF
  exit 0
fi

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

step "Checking local release prerequisites"
for command_name in awk brew cp curl gh git grep make mkdir mktemp rm rmdir ruby sed shasum sleep tar; do
  require_command "$command_name"
done

[ "$(git -C "$root_dir" rev-parse --show-toplevel 2>/dev/null || true)" = "$root_dir" ] ||
  die "not the root of a Git checkout: $root_dir"
[ -f "$formula_updater" ] || die "formula updater is missing: $formula_updater"
run ruby -c "$formula_updater"

source_lock="$source_git_common/snackpage-release.lock"
if ! mkdir "$source_lock" 2>/dev/null; then
  die "another release may be running; if not, remove the stale lock: $source_lock"
fi
source_lock_owned=1

locked_release_record="$(read_release_state)"
release_state_active=0
release_state_commit=""
if [ -n "$locked_release_record" ]; then
  IFS=' ' read -r locked_release_version locked_release_commit <<<"$locked_release_record"
  [ -z "$raw_version" ] || [ "${raw_version#v}" = "$locked_release_version" ] ||
    die "release $locked_release_version is already in progress; omit VERSION to resume it"
  version="$locked_release_version"
  version_selection="resume"
  release_state_active=1
  release_state_commit="$locked_release_commit"
elif [ "$version_selection" = "resume" ]; then
  die "in-progress release state changed while acquiring the release lock; rerun make release"
elif [ "$version_selection" = "automatic" ]; then
  version="$(next_minor_version)"
fi
tag="v$version"
archive_url="https://github.com/${github_repo}/archive/refs/tags/${tag}.tar.gz"
tap_commit_message="snackpage $version"

for brew_command in audit services style trust; do
  brew help "$brew_command" >/dev/null 2>&1 ||
    die "Homebrew does not provide the required '$brew_command' command"
done
gh release create --help >/dev/null 2>&1 ||
  die "GitHub CLI does not provide the required release command"

current_branch="$(git -C "$root_dir" branch --show-current)"
[ "$current_branch" = "main" ] || die "releases must run from main (current branch: ${current_branch:-detached})"
assert_source_clean

origin_url="$(git -C "$root_dir" remote get-url origin 2>/dev/null || true)"
matches_github_remote "$origin_url" "$github_repo" ||
  die "origin is $origin_url, expected the $github_repo GitHub repository"

run git -C "$root_dir" fetch --prune --tags origin
git -C "$root_dir" rev-parse --verify refs/remotes/origin/main >/dev/null ||
  die "origin/main does not exist"
git -C "$root_dir" merge-base --is-ancestor origin/main HEAD ||
  die "local main does not contain origin/main; pull/rebase before releasing"
source_origin_head="$(git -C "$root_dir" rev-parse origin/main)"

if ! published_latest_tag="$(latest_remote_stable_tag)"; then
  die "could not determine the latest published stable tag from origin"
fi
if [ "$version_selection" = "automatic" ]; then
  version="$(next_minor_after_tag "$published_latest_tag")"
  tag="v$version"
  archive_url="https://github.com/${github_repo}/archive/refs/tags/${tag}.tar.gz"
  tap_commit_message="snackpage $version"
  if [ -n "$published_latest_tag" ]; then
    printf '  Automatically selected %s after published release %s\n' "$tag" "$published_latest_tag"
  else
    printf '  Automatically selected %s; origin has no stable release tags\n' "$tag"
  fi
fi

run git -C "$root_dir" push --dry-run origin main

head_commit="$(git -C "$root_dir" rev-parse HEAD)"
if [ "$release_state_active" -eq 1 ] && [ "$release_state_commit" != "$head_commit" ]; then
  die "in-progress $tag release belongs to commit $release_state_commit; restore that checkout before resuming"
fi
local_tag_object=""
local_tag_commit=""
if git -C "$root_dir" rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  local_tag_object="$(git -C "$root_dir" rev-parse "refs/tags/$tag")"
  local_tag_commit="$(git -C "$root_dir" rev-list -n 1 "$tag")"
  [ "$local_tag_commit" = "$head_commit" ] ||
    die "$tag already exists locally at $local_tag_commit, not HEAD $head_commit"
fi

published_tag_object="$(remote_tag_object "$tag")"
published_tag_commit=""
if [ -n "$published_tag_object" ]; then
  published_tag_commit="$(remote_tag_commit "$tag")"
  [ "$published_tag_commit" = "$head_commit" ] ||
    die "$tag already exists on origin at $published_tag_commit, not HEAD $head_commit"

  if [ -z "$local_tag_object" ]; then
    run git -C "$root_dir" fetch origin "refs/tags/$tag:refs/tags/$tag"
    local_tag_object="$(git -C "$root_dir" rev-parse "refs/tags/$tag")"
    local_tag_commit="$(git -C "$root_dir" rev-list -n 1 "$tag")"
  fi
  [ "$local_tag_object" = "$published_tag_object" ] ||
    die "local and origin copies of $tag have different tag objects"
elif [ -n "$local_tag_object" ] && [ "$(git -C "$root_dir" cat-file -t "refs/tags/$tag")" != "tag" ]; then
  die "local-only $tag is lightweight; recreate it as an annotated tag before releasing"
fi

if [ -z "$published_tag_object" ]; then
  latest_tag="$published_latest_tag"
  latest_version="${latest_tag#v}"
  if is_stable_version "$latest_version" &&
    ! version_is_greater "$version" "$latest_version"; then
    die "$tag must be greater than the latest published release, $latest_tag"
  fi
  if [ -n "$latest_tag" ]; then
    latest_tag_commit="$(git -C "$root_dir" rev-list -n 1 "$latest_tag")"
    [ "$latest_tag_commit" != "$head_commit" ] ||
      die "HEAD has no commits after $latest_tag; refusing an empty version release"
    git -C "$root_dir" merge-base --is-ancestor "$latest_tag_commit" HEAD ||
      die "$latest_tag is not an ancestor of HEAD"
  fi
fi

run gh auth status
resolved_repo="$(gh repo view "$github_repo" --json nameWithOwner --jq .nameWithOwner)"
[ "$resolved_repo" = "$github_repo" ] || die "GitHub repository resolved as $resolved_repo"
repo_permission="$(gh repo view "$github_repo" --json viewerPermission --jq .viewerPermission)"
case "$repo_permission" in
  ADMIN|MAINTAIN|WRITE)
    ;;
  *)
    die "GitHub authentication has $repo_permission permission on $github_repo; write access is required"
    ;;
esac

tap_repo="$(brew --repository "$tap_name" 2>/dev/null || true)"
[ -n "$tap_repo" ] || die "Homebrew tap is not installed; run: brew tap $tap_name"
git -C "$tap_repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  die "Homebrew tap is not a Git checkout: $tap_repo"
tap_formula="$tap_repo/Formula/${formula_name}.rb"
[ -f "$tap_formula" ] || die "formula not found: $tap_formula"
tap_git_common="$(git -C "$tap_repo" rev-parse --path-format=absolute --git-common-dir)"
tap_lock="$tap_git_common/snackpage-release.lock"
if ! mkdir "$tap_lock" 2>/dev/null; then
  die "another tap release may be running; if not, remove the stale lock: $tap_lock"
fi
tap_lock_owned=1
assert_tap_clean

tap_owner="${tap_name%%/*}"
tap_short_name="${tap_name#*/}"
tap_github_repo="${tap_owner}/homebrew-${tap_short_name}"
tap_origin_url="$(git -C "$tap_repo" remote get-url origin 2>/dev/null || true)"
matches_github_remote "$tap_origin_url" "$tap_github_repo" ||
  die "tap origin is $tap_origin_url, expected the $tap_github_repo GitHub repository"

tap_branch="$(git -C "$tap_repo" branch --show-current)"
[ "$tap_branch" = "main" ] || die "Homebrew tap must be on main (current branch: ${tap_branch:-detached})"
run git -C "$tap_repo" fetch --prune origin
git -C "$tap_repo" rev-parse --verify refs/remotes/origin/main >/dev/null ||
  die "tap origin/main does not exist"
if ! git -C "$tap_repo" merge-base --is-ancestor origin/main HEAD; then
  if git -C "$tap_repo" merge-base --is-ancestor HEAD origin/main; then
    die "tap main is behind origin/main; run 'git -C \"$tap_repo\" pull --ff-only'"
  fi
  die "tap main has diverged from origin/main"
fi
run git -C "$tap_repo" push --dry-run origin main
tap_permission="$(gh repo view "$tap_github_repo" --json viewerPermission --jq .viewerPermission)"
case "$tap_permission" in
  ADMIN|MAINTAIN|WRITE)
    ;;
  *)
    die "GitHub authentication has $tap_permission permission on $tap_github_repo; write access is required"
    ;;
esac

tap_resume_commit=0
tap_head="$(git -C "$tap_repo" rev-parse HEAD)"
tap_origin_head="$(git -C "$tap_repo" rev-parse origin/main)"
if [ "$tap_head" != "$tap_origin_head" ]; then
  tap_ahead_count="$(git -C "$tap_repo" rev-list --count origin/main..HEAD)"
  tap_ahead_subject="$(git -C "$tap_repo" log -1 --format=%s)"
  tap_ahead_paths="$(git -C "$tap_repo" diff --name-only origin/main..HEAD)"
  if [ "$tap_ahead_count" != "1" ] ||
    [ "$tap_ahead_subject" != "$tap_commit_message" ] ||
    [ "$tap_ahead_paths" != "Formula/${formula_name}.rb" ]; then
    die "tap has unpushed commits unrelated to this release"
  fi
  tap_resume_commit=1
fi

for formula_pattern in '^  url "[^"]+"$' '^  sha256 "[0-9a-f]+"$'; do
  formula_matches="$(grep -Ec "$formula_pattern" "$tap_formula" || true)"
  [ "$formula_matches" = "1" ] ||
    die "$tap_formula does not have the expected release field shape"
done
explicit_version_lines="$(grep -Ec '^  version "[^"]+"$' "$tap_formula" || true)"
[ "$explicit_version_lines" -le 1 ] ||
  die "$tap_formula has more than one explicit version field"

step "Running every project quality gate"
run make -C "$root_dir" check
assert_source_clean
[ "$(git -C "$root_dir" rev-parse HEAD)" = "$head_commit" ] ||
  die "HEAD changed while release checks were running"
current_source_origin="$(git -C "$root_dir" ls-remote origin refs/heads/main | awk 'NR == 1 { print $1 }')"
[ "$current_source_origin" = "$source_origin_head" ] ||
  die "origin/main changed while release checks were running; synchronize it and rerun"
assert_tap_unchanged
record_release_state

step "Publishing source tag and GitHub release"
assert_source_clean
[ "$(git -C "$root_dir" rev-parse HEAD)" = "$head_commit" ] ||
  die "HEAD changed immediately before publication"
if [ -z "$local_tag_object" ]; then
  run git -C "$root_dir" tag -a "$tag" "$head_commit" -m "snackpage $tag"
  local_tag_object="$(git -C "$root_dir" rev-parse "refs/tags/$tag")"
fi

source_commit_push_ref="refs/snackpage-release/${tag}/commit"
source_commit_push_object="$head_commit"
pin_git_ref "$root_dir" "$source_commit_push_ref" "$source_commit_push_object"

if [ -z "$published_tag_object" ]; then
  source_tag_push_ref="refs/snackpage-release/${tag}/tag"
  source_tag_push_object="$local_tag_object"
  pin_git_ref "$root_dir" "$source_tag_push_ref" "$source_tag_push_object"
  run git -C "$root_dir" push --atomic origin \
    "$source_commit_push_ref:refs/heads/main" \
    "$source_tag_push_ref:refs/tags/$tag"
else
  run git -C "$root_dir" push origin "$source_commit_push_ref:refs/heads/main"
fi

published_main_commit="$(git -C "$root_dir" ls-remote origin refs/heads/main | awk 'NR == 1 { print $1 }')"
[ "$published_main_commit" = "$head_commit" ] ||
  die "origin/main did not publish the expected source commit"
published_tag_object="$(remote_tag_object "$tag")"
[ "$published_tag_object" = "$local_tag_object" ] ||
  die "origin did not publish the expected $tag object"
published_tag_commit="$(remote_tag_commit "$tag")"
[ "$published_tag_commit" = "$head_commit" ] ||
  die "origin did not publish $tag at the expected commit"

if release_state="$(gh release view "$tag" \
  --repo "$github_repo" \
  --json isDraft,isPrerelease \
  --jq 'if .isDraft then "draft" elif .isPrerelease then "prerelease" else "stable" end' 2>/dev/null)"; then
  [ "$release_state" = "stable" ] ||
    die "existing GitHub release $tag is marked $release_state; publish it as a stable release or remove it"
  printf '  Stable GitHub release %s already exists; continuing\n' "$tag"
else
  run gh release create "$tag" \
    --repo "$github_repo" \
    --verify-tag \
    --title "$tag" \
    --generate-notes \
    --latest
fi

step "Calculating the published archive checksum"
release_tmp_base="${TMPDIR:-/tmp}"
release_tmp_base="${release_tmp_base%/}"
release_tmp="$(mktemp -d "$release_tmp_base/snackpage-release.XXXXXX")"
release_archive="$release_tmp/${tag}.tar.gz"
run curl --fail --location --retry 5 --retry-delay 2 --retry-connrefused \
  --output "$release_archive" "$archive_url"
run tar -tzf "$release_archive" >/dev/null
archive_sha256="$(shasum -a 256 "$release_archive" | awk '{print $1}')"
[[ "$archive_sha256" =~ ^[0-9a-f]{64}$ ]] || die "could not calculate the archive SHA-256"
printf '  SHA-256: %s\n' "$archive_sha256"

step "Updating and publishing the Homebrew formula"
assert_tap_unchanged
expected_tap_commit="$tap_origin_head"
tap_push_needed=0
if [ "$tap_resume_commit" -eq 1 ]; then
  formula_matches_release ||
    die "the tap's unpushed $tap_commit_message commit does not match the published archive"
  validate_formula
  tap_release_formula_sha="$(shasum -a 256 "$tap_formula" | awk '{print $1}')"
  validate_tap_release_commit "$tap_head" "$tap_origin_head" "$tap_release_formula_sha"
  formula_committed=1
  expected_tap_commit="$tap_head"
  tap_push_needed=1
elif formula_matches_release; then
  validate_formula
  expected_tap_commit="$tap_head"
  printf '  Formula already describes %s; continuing\n' "$tag"
else
  formula_backup="$release_tmp/${formula_name}.rb.before"
  run cp -p "$tap_formula" "$formula_backup"
  formula_modified=1
  run ruby "$formula_updater" "$tap_formula" "$archive_url" "$version" "$archive_sha256"
  generated_formula_sha="$(shasum -a 256 "$tap_formula" | awk '{print $1}')"
  run git -C "$tap_repo" diff --check
  validate_formula
  assert_tap_base_unchanged
  current_formula_sha="$(shasum -a 256 "$tap_formula" | awk '{print $1}')"
  if [ "$current_formula_sha" != "$generated_formula_sha" ]; then
    formula_modified=0
    die "tap formula changed concurrently; it was left untouched for manual review"
  fi
  tap_worktree_changes="$(git -C "$tap_repo" status --porcelain=v1 --untracked-files=all)"
  [ "$tap_worktree_changes" = " M Formula/${formula_name}.rb" ] || {
    printf '%s\n' "$tap_worktree_changes" >&2
    die "tap gained changes other than the release formula update"
  }
  run git -C "$tap_repo" add "Formula/${formula_name}.rb"
  staged_formula_sha="$(git -C "$tap_repo" show ":Formula/${formula_name}.rb" | shasum -a 256 | awk '{print $1}')"
  if [ "$staged_formula_sha" != "$generated_formula_sha" ]; then
    git -C "$tap_repo" restore --staged -- "Formula/${formula_name}.rb" >/dev/null 2>&1 || true
    formula_modified=0
    die "staged formula changed concurrently; it was left untouched for manual review"
  fi
  run git -C "$tap_repo" commit -m "$tap_commit_message"
  formula_committed=1
  expected_tap_commit="$(git -C "$tap_repo" rev-parse HEAD)"
  validate_tap_release_commit "$expected_tap_commit" "$tap_head" "$generated_formula_sha"
  post_commit_changes="$(git -C "$tap_repo" status --porcelain=v1 --untracked-files=all)"
  if [ -n "$post_commit_changes" ]; then
    printf '%s\n' "$post_commit_changes" >&2
    die "tap gained changes while creating the release commit; it was left for manual review"
  fi
  tap_push_needed=1
fi

if [ "$tap_push_needed" -eq 1 ]; then
  tap_commit_push_ref="refs/snackpage-release/${tag}/commit"
  tap_commit_push_object="$expected_tap_commit"
  pin_git_ref "$tap_repo" "$tap_commit_push_ref" "$tap_commit_push_object"
  run git -C "$tap_repo" push origin "$tap_commit_push_ref:refs/heads/main"
fi

published_tap_head="$(git -C "$tap_repo" ls-remote origin refs/heads/main | awk 'NR == 1 { print $1 }')"
[ "$published_tap_head" = "$expected_tap_commit" ] ||
  die "tap origin/main did not reach the expected release commit"

step "Upgrading and restarting the installed service"
run brew trust --formula "$tap_name/$formula_name"
run brew update
if brew list --versions "$formula_name" | grep -Eq '[0-9]'; then
  run brew upgrade "$tap_name/$formula_name"
else
  run brew install "$tap_name/$formula_name"
fi
run brew services restart "$formula_name"

installed_binary="$(brew --prefix "$formula_name")/bin/$formula_name"
[ -x "$installed_binary" ] || die "installed binary not found: $installed_binary"
installed_version="$("$installed_binary" version)"
[ "$installed_version" = "snackpage $version" ] ||
  die "installed binary reported '$installed_version', expected 'snackpage $version'"

attempt=0
until health_response="$(curl --fail --silent --show-error --max-time 1 "$health_url" 2>/dev/null)" &&
  [ "$health_response" = "ok" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || die "service did not become healthy at $health_url within 10 seconds"
  sleep 0.2
done

release_url="$(gh release view "$tag" --repo "$github_repo" --json url --jq .url)"
completed_release_state="$(read_release_state)"
[ "$completed_release_state" = "$version $head_commit" ] ||
  die "release state changed before completion; inspect $release_state_file"
run rm -f -- "$release_state_file"
release_state_active=0
printf '\nReleased %s\n' "$tag"
printf '  GitHub: %s\n' "$release_url"
printf '  Installed: %s\n' "$installed_version"
printf '  Browser: http://127.0.0.1:8765\n'
