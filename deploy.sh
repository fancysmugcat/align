#!/bin/sh
#
# Publishes web/ to GitHub Pages.
#
# Pages can serve from a folder, but only /docs or the repository root — not
# web/. Rather than rename the folder, this pushes web/ alone to the root of a
# gh-pages branch, which keeps the repository layout as it is and keeps the
# published site free of firmware and Xcode files.
#
# Run `gh auth login` once first. After that this is the whole deploy.

set -e

REPO_NAME="${REPO_NAME:-align}"
BRANCH="gh-pages"
GH="${GH:-gh}"

command -v "$GH" >/dev/null 2>&1 || GH="$HOME/.local/bin/gh"
command -v "$GH" >/dev/null 2>&1 || {
  echo "The GitHub CLI isn't installed. brew install gh" >&2
  exit 1
}

"$GH" auth status >/dev/null 2>&1 || {
  echo "Not logged in to GitHub. Run: $GH auth login" >&2
  exit 1
}

USER_NAME=$("$GH" api user --jq .login)

# Without this, the plain `git push` below has no way to authenticate and sits
# waiting on a username prompt that never comes.
"$GH" auth setup-git --hostname github.com

# Create the repository on the first run; afterwards just push to it.
if ! "$GH" repo view "$USER_NAME/$REPO_NAME" >/dev/null 2>&1; then
  echo "Creating $USER_NAME/$REPO_NAME…"
  "$GH" repo create "$REPO_NAME" --public \
    --description "ALIGN — posture tracker for the ESP32-C3 wearable" \
    --source=. --remote=origin --push
else
  git remote get-url origin >/dev/null 2>&1 \
    || git remote add origin "https://github.com/$USER_NAME/$REPO_NAME.git"
  git push -u origin main
fi

# web/ becomes the root of gh-pages. `git subtree` rewrites the history of that
# folder onto the branch, so the site lands at / rather than /web/.
echo "Publishing web/ to $BRANCH…"
git push origin "$(git subtree split --prefix web main)":refs/heads/"$BRANCH" --force

"$GH" api -X POST "repos/$USER_NAME/$REPO_NAME/pages" \
  -f "source[branch]=$BRANCH" -f "source[path]=/" >/dev/null 2>&1 \
  || "$GH" api -X PUT "repos/$USER_NAME/$REPO_NAME/pages" \
       -f "source[branch]=$BRANCH" -f "source[path]=/" >/dev/null 2>&1 \
  || true

echo
echo "Published: https://$USER_NAME.github.io/$REPO_NAME/"
echo "The first build takes a minute or two."
