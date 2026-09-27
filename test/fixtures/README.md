# Scenario fixtures

Each directory is one representative issue, run end to end by `test/fixtures.test.ts` with no
network, Docker, forge token or model key: the real `main()` (or the real prepare → agent →
publish stages), the real `githubTracker`/`gitlabTracker` talking to an in-memory forge
(`test/support/fake-forge.ts`), and a scripted fake agent engine in place of the model
(`test/support/scenario.ts`). Adding a directory adds a test; nothing else needs registering.

## `scenario.json`: the input

| Field | Meaning |
| --- | --- |
| `description` | One line; becomes the test name. |
| `platform` | `github` or `gitlab`: which adapter and wire format the fake forge speaks. |
| `mode` | `main` (the combined local run) or `stages` (the three CI jobs, each with only its own credential). |
| `issue` | The issue as the forge holds it: `number`, `title`, `body`, `author`, `trust` (`trusted`/`untrusted`), `labels`, and `comments` (`author`, `trust`, `text`, `at`; `bot: true` for a comment our tracker posted earlier), plus an optional `defaultBranch`. |
| `env` | Extra env for the run, e.g. `AGENT_TRIGGER`, `MAX_BUDGET_USD`, `MAX_CHAINED_RUNS`. |
| `engine` | What the fake model does: `calls` (ticket tools in order, e.g. `{ "tool": "finish", "input": { "summary": "…" } }`, validated against the tool's real schema), then either `throw` (an error message, e.g. a provider failure) or `result` (`success`, `error_max_turns`, `error_max_budget_usd`). |
| `commits` | How many commits the publisher finds over the base (default 1; 0 means nothing to publish). |
| `forgeFailures` | Forge requests that fail: `method`, `path` (regex over the URL path), `status`, optional `body`, `times`, `skip`. |

## `expected.json`: what must happen

| Field | Meaning |
| --- | --- |
| `prompt` | The trusted input: `null` if the model must never be started, else `includes`/`excludes` substrings of the prompt it was given. |
| `branch`, `base` | The branch every clone, push and PR/MR uses, and the branch it starts from and targets. |
| `outcome` | The last `[outcome] <kind>` the run logged (`none` if it crashed before settling one). |
| `exitCodes` | `[code]` for `main`, `[prepare, agent, publish]` for `stages`. |
| `labels` | The issue's labels afterwards (order-insensitive). |
| `comments` | Regexes, in order, one per comment we posted; no other comment of ours may appear. `commentsExclude` lists substrings none may contain. |
| `clones`, `pushes`, `reviews`, `relays` | How many times the repo was cloned (default 1), the publisher pushed, a PR/MR was opened, and a relay run was dispatched. |
| `toolErrors` | Tool calls the fake engine made that were rejected (invalid input, unknown tool, refused split). |

A few of these (`simple-change`, `clarification-required`, `malicious-comment`) are also the task set
`npm run eval:live` runs against the real model; see the README's "Testing" section.
