---
name: gitlab-mr
description: Push a branch and open a GitLab merge request without the API or glab. Use when work on an issue is ready for review on GitLab.
---

# Opening a merge request

We create MRs with GitLab push options, in the same command as the push:

```bash
git push -u origin HEAD \
  -o merge_request.create \
  -o merge_request.target="$(git remote show origin | sed -n 's/.*HEAD branch: //p')" \
  -o merge_request.title="<issue title>" \
  -o merge_request.description="<what changed, how it was tested> Closes #<issue iid>"
```

- GitLab prints the MR URL in the push output (`remote:` lines). Pass that URL to `finish`.
- If the branch already has an open MR, a plain `git push` updates it; reuse its URL.
- Title: the issue title, unchanged. Description: short summary, test evidence, `Closes #<iid>`.
