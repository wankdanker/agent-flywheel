---
name: notion-ticket
description: Work out which repo a Notion ticket targets, and keep this project's own ticket-to-repo mapping current. Use when working a ticket sourced from Notion, before cloning anything.
---

# Finding the repo for a Notion ticket

A Notion ticket, unlike a GitHub/GitLab issue, isn't filed on any particular repo. Work
out the target repo in this order, and stop at the first one that gives a clear answer:

1. **An explicit repo on the ticket.** The prompt already names one if the ticket had a
   resolvable `Repo`-style property or a repo URL in its body — look there first.
2. **This project's own mapping**, in `agent/notion-repo-map.md`. Read it and see if the
   ticket's title, content, or any labels match a row.
3. **Ask.** If neither gives a confident answer, call `ask_question` with your best guess
   and stop. Don't guess silently — a wrong repo means work landing in the wrong place.

## Doing the work

Once the repo is confirmed (by step 1, step 2, or a human answering step 3):

- Clone it, branch, and do the requested work there, same as any other ticket.
- Open its PR/MR with the `github-pr` or `gitlab-mr` skill, whichever matches that repo's
  host (github.com vs. a GitLab host) — not necessarily the same skill this repo itself
  would use.

## Updating the mapping

If you had to fall back to step 2 or step 3 above, add or correct a row in
`agent/notion-repo-map.md` for next time, and open a **second** PR — against *this* repo
(agent-flywheel), with `github-pr` — carrying just that mapping change. It's expected and
fine to end up with two PRs out of one ticket: one for the requested work, one for our own
knowledge. Don't mix the two into one branch or one PR.

Skip the mapping update if step 1 already gave a confident, explicit repo — there's
nothing new to learn from those.

## Notes

- The Notion "tickets" database schema (property names for status, assignee, etc.) isn't
  fully pinned down yet — see `.env.example` for the `NOTION_*` env vars the tracker reads
  and their current best-guess defaults. If you find yourself needing the real schema,
  query `https://api.notion.com/v1/databases/{database_id}` and note what you find in
  your final summary rather than hardcoding assumptions here.
