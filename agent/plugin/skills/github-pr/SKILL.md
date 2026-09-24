---
name: github-pr
description: Push a branch and open a GitHub pull request with the gh CLI. Use when work on an issue is ready for review on GitHub.
---

# Opening a pull request

`gh` is installed and already authenticated through `GH_TOKEN`. Run it from inside the clone.

```bash
git push -u origin HEAD
gh pr view --json url -q .url 2>/dev/null || gh pr create \
  --base "$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)" \
  --title "<issue title>" \
  --body "<what changed, how it was tested>

Closes #<issue number>"
```

- `gh pr create` prints the PR URL. Pass that URL to `finish`.
- If the branch already has an open PR, `gh pr view` prints its URL and the push has updated it. Reuse that URL.
- Title: the issue title, unchanged. Body: short summary, test evidence, `Closes #<n>`.
- If the push is rejected because you touched `.github/workflows/`, the token lacks the
  `workflows` permission. Drop those changes, and say in your summary what a human needs to apply by hand.
