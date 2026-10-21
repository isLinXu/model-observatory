#!/usr/bin/env bash
# One-time user-triggered deployment for Model Observatory.
# Requires GitHub CLI authenticated to a personal GitHub account.
set -Eeuo pipefail

REPO_NAME="${1:-hf-model-observatory}"
if [[ ! "$REPO_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid repository name: $REPO_NAME" >&2
  exit 2
fi
command -v gh >/dev/null || { echo 'Please install GitHub CLI (https://cli.github.com/) and run gh auth login.' >&2; exit 1; }
command -v git >/dev/null || { echo 'git is required.' >&2; exit 1; }
gh auth status >/dev/null || { echo 'Please authenticate first: gh auth login' >&2; exit 1; }
OWNER="$(gh api user --jq .login)"
REPO="$OWNER/$REPO_NAME"
if gh repo view "$REPO" --json name >/dev/null 2>&1; then
  echo "Repository $REPO already exists. Refusing to overwrite. Use another name." >&2
  exit 1
fi
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
if [[ -d .git ]]; then
  echo 'A Git repository is already initialized here. Refusing to modify an existing checkout.' >&2
  exit 1
fi
printf '\nThis creates a PUBLIC GitHub repository: %s\n' "$REPO"
printf 'The Pages site and collected HF public model statistics will be public.\n'
read -r -p "Type 'publish' to continue: " confirmation
[[ "$confirmation" == "publish" ]] || { echo 'Cancelled.'; exit 1; }

git init -b main
git config user.name "$(gh api user --jq .name 2>/dev/null || echo 'GitHub User')"
# GitHub accounts may have a private email address; use no-reply commit identity.
USER_ID="$(gh api user --jq .id)"
git config user.email "${USER_ID}+${OWNER}@users.noreply.github.com"
git add README.md LICENSE .gitignore .github requirements.txt data scripts site tests deploy_once.sh
git commit -m 'feat: add Hugging Face model observatory and Pages collector'
gh repo create "$REPO" --public --description "Daily Hugging Face model download observatory for @gatilin" --source . --remote origin --push

# Choose workflow as the Pages build source. If auto-created in the meantime, update it.
if gh api "repos/$REPO/pages" >/dev/null 2>&1; then
  gh api -X PUT "repos/$REPO/pages" -f build_type=workflow >/dev/null
else
  gh api -X POST "repos/$REPO/pages" -f build_type=workflow >/dev/null
fi

# Push normally triggers the same workflow; a second manual dispatch is safe,
# and guarantees one run after Pages has been configured.
gh workflow run pages.yml --repo "$REPO" --ref main
printf '\nRepository: https://github.com/%s\n' "$REPO"
printf 'Pages:      https://%s.github.io/%s/\n' "$OWNER" "$REPO_NAME"
printf 'Actions:    https://github.com/%s/actions\n' "$REPO"
printf 'The site URL will work only after the Actions workflow completes successfully.\n'
