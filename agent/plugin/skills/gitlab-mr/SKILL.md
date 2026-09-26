---
name: gitlab-mr
description: Get a branch ready for a GitLab merge request. You commit; a trusted publisher pushes and opens the MR after your session. Use when work on an issue is ready for review on GitLab.
---

# Getting a merge request ready

You don't push or open the MR yourself, and can't: your session has no forge token, and
`git push` isn't authenticated. Once your session ends, a trusted publisher step validates
your branch, pushes it, and opens the MR (or reuses the one already open for the branch),
then comments on the issue and labels it for review.

1. Commit everything on the issue branch (`agent/issue-<iid>`, the one you're on). Only
   committed work is published; uncommitted changes and other branches are dropped.

   ```bash
   git add -A && git commit -m "<what changed; what's next, if anything>"
   ```

2. Call `finish` with a summary: what changed and how it was tested. It becomes the MR
   description (the publisher appends `Closes #<iid>`) and the issue comment. The MR title is
   the issue title.

The publisher refuses the whole branch, pushing nothing, if any commit on it:

- adds or changes a submodule (a gitlink or `.gitmodules`),
- touches a `.git` path, or a path outside the repo, including via a symlink,
- adds a credential-looking file (`.env`, `.git-credentials`, `.netrc`, private keys, `*.pem`, ...),
  even if a later commit deletes it again.

If you need any of that, say so in your summary instead of committing it.
