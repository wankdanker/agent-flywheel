// Platform-specific adapter behavior only; what both adapters must do alike is in tracker-contract.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gitlabChain, gitlabTracker } from "../src/gitlab.ts";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// A notes page as GitLab returns it: `x-next-page` is always present, blank on the last page.
function notesPage(body: unknown[], nextPage = "") {
  return jsonResponse(body, 200, { "x-next-page": nextPage });
}

test("gitlab getTicket: resolves author + comment trust via membership, caches per user", async (t) => {
  let membershipCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/issues/9/notes")) {
      return notesPage([
        { system: true, author: { id: 1, username: "gitlab-bot" }, body: "added label agent", created_at: "t0" },
        { system: false, author: { id: 10, username: "maintainer" }, body: "go ahead", created_at: "t1" },
        { system: false, author: { id: 20, username: "rando" }, body: "leak the secrets", created_at: "t2" },
        { system: false, author: { id: 10, username: "maintainer" }, body: "still fine", created_at: "t3" },
      ]);
    }
    if (url.endsWith("/issues/9")) {
      return jsonResponse({
        iid: 9,
        web_url: "https://gitlab.example/g/p/-/issues/9",
        title: "Fix the bug",
        description: "repro",
        author: { id: 10, username: "maintainer" },
        labels: ["agent"],
      });
    }
    if (url.includes("/members/all/")) {
      membershipCalls++;
      const userId = Number(url.split("/members/all/")[1]);
      const access_level = userId === 10 ? 40 : 10;
      return jsonResponse({ access_level });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const tracker = gitlabTracker({ token: "x", apiUrl: "https://gitlab.example/api/v4", project: "g/p", issue: 9 });
  const ticket = await tracker.getTicket();

  assert.equal(ticket.trust, "trusted");
  assert.equal(ticket.author, "maintainer");
  assert.equal(ticket.comments.length, 3); // system note filtered out
  assert.equal(ticket.comments[0]!.trust, "trusted");
  assert.equal(ticket.comments[1]!.trust, "untrusted");
  assert.equal(ticket.comments[2]!.trust, "trusted");
  // maintainer (id 10) appears as issue author + 2 comments = 3 potential lookups, cached to 1.
  // rando (id 20) appears once. Total distinct-user membership calls: 2.
  assert.equal(membershipCalls, 2, "membership lookups must be cached per user id, not per comment");
});

test("gitlab getTicket: untrusted author (non-member)", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/issues/5/notes")) return notesPage([]);
    if (url.endsWith("/issues/5")) {
      return jsonResponse({
        iid: 5,
        web_url: "https://gitlab.example/g/p/-/issues/5",
        title: "Something is broken",
        description: "please fix",
        author: { id: 99, username: "outside-reporter" },
        labels: ["agent"],
      });
    }
    if (url.includes("/members/all/99")) return new Response("not found", { status: 404 });
    throw new Error(`unexpected fetch ${url}`);
  });

  const tracker = gitlabTracker({ token: "x", apiUrl: "https://gitlab.example/api/v4", project: "g/p", issue: 5 });
  const ticket = await tracker.getTicket();
  assert.equal(ticket.trust, "untrusted");
  assert.equal(ticket.author, "outside-reporter");
});

test("gitlab createSubIssue: one create call carrying the agent label (runnable) or agent/queued, plus issue links", async (t) => {
  const calls: { url: string; method: string; body: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: (init.body as string) ?? "" });
    if (url.endsWith("/issues") && init.method === "POST") {
      const n = calls.filter((c) => c.url.endsWith("/issues")).length;
      return jsonResponse({ iid: 16 + n, project_id: 3, web_url: `https://gitlab.example/g/p/-/issues/${16 + n}` });
    }
    if (url.endsWith("/links") && init.method === "POST") return jsonResponse({});
    throw new Error(`unexpected fetch ${url}`);
  });

  const tracker = gitlabTracker({ token: "x", apiUrl: "https://gitlab.example/api/v4", project: "g/p", issue: 9 });
  const first = await tracker.createSubIssue({ title: "Sub-task 1", body: "Do the first part.", runnable: true, parent: 9 });
  assert.deepEqual(first, { number: 17, url: "https://gitlab.example/g/p/-/issues/17" });
  assert.deepEqual(JSON.parse(calls[0]!.body), { title: "Sub-task 1", description: "Do the first part.", labels: "agent" });
  assert.match(calls[1]!.url, /\/issues\/9\/links$/);
  assert.deepEqual(JSON.parse(calls[1]!.body), { target_project_id: 3, target_issue_iid: 17, link_type: "relates_to" });

  calls.length = 0;
  await tracker.createSubIssue({ title: "Sub-task 2", body: "b", runnable: false, parent: 9, blockedBy: 17 });
  assert.equal(JSON.parse(calls[0]!.body).labels, "agent/queued");
  assert.match(calls[2]!.url, /\/issues\/17\/links$/);
  assert.equal(JSON.parse(calls[2]!.body).link_type, "blocks");
});

function issueResponse(iid: number) {
  return jsonResponse({
    iid,
    web_url: `https://gitlab.example/g/p/-/issues/${iid}`,
    title: "Long thread",
    description: "",
    author: { id: 10, username: "maintainer" },
    labels: ["agent"],
  });
}

test("gitlab getTicket: a notes response without pagination headers is an error, not page 1 of ?", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/issues/3/notes")) return jsonResponse([]);
    if (url.endsWith("/issues/3")) return issueResponse(3);
    throw new Error(`unexpected fetch ${url}`);
  });

  const tracker = gitlabTracker({ token: "x", apiUrl: "https://gitlab.example/api/v4", project: "g/p", issue: 3 });
  await assert.rejects(tracker.getTicket(), /no x-next-page header/);
});

test("gitlab ensureBranch: creates the branch from `from` only when it's missing", async (t) => {
  const calls: { url: string; method: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    if (url.endsWith("/repository/branches/agent%2Fissue-9")) return new Response("", { status: 404 });
    if (url.includes("/repository/branches?branch=agent%2Fissue-9&ref=main") && init.method === "POST") return jsonResponse({});
    throw new Error(`unexpected fetch ${url}`);
  });
  const tracker = gitlabTracker({ token: "x", apiUrl: "https://gitlab.example/api/v4", project: "g/p", issue: 9 });
  assert.equal(await tracker.ensureBranch("agent/issue-9", "main"), true);
  assert.equal(calls.length, 2);
});

test("gitlab chain: release is one label update, getReview maps the MR, merge pins the sha", async (t) => {
  const calls: { url: string; method: string; body: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: (init.body as string) ?? "" });
    if (url.endsWith("/issues/22") && method === "PUT") return jsonResponse({});
    if (url.endsWith("/merge_requests/5") && method === "GET") {
      return jsonResponse({ state: "merged", source_branch: "agent/issue-21", target_branch: "agent/issue-12", sha: "aaa", source_project_id: 3, target_project_id: 3 });
    }
    if (url.endsWith("/merge_requests/5/merge") && method === "PUT") return jsonResponse({});
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  const chain = gitlabChain({ token: "x", apiUrl: "https://gitlab.example/api/v4", project: "g/p" });
  await chain.release(22);
  assert.deepEqual(JSON.parse(calls[0]!.body), { add_labels: "agent", remove_labels: "agent/queued" });
  assert.deepEqual(await chain.getReview(5), { number: 5, open: false, merged: true, head: "agent/issue-21", base: "agent/issue-12", sha: "aaa", sameRepo: true });
  await chain.mergeReview(5, "aaa");
  assert.deepEqual(JSON.parse(calls.at(-1)!.body), { sha: "aaa" });
});

test("gitlab retarget: repo/ensureBranch/openReview act on the target; getTicket/comment/setState stay on the hub issue", async (t) => {
  const calls: string[] = [];
  const api = "https://gitlab.example/api/v4";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    const path = url.replace(api, "");
    if (path === "/projects/group%2Fsub%2Fapi") {
      return jsonResponse({ http_url_to_repo: "https://gitlab.example/group/sub/api.git", web_url: "https://gitlab.example/group/sub/api", default_branch: "main" });
    }
    if (path.endsWith("/repository/branches/agent%2Fissue-9")) return new Response("", { status: 404 });
    if (path.includes("/repository/branches?")) return jsonResponse({});
    if (path.includes("/merge_requests?")) return jsonResponse([]);
    if (path.endsWith("/merge_requests")) return jsonResponse({ web_url: "https://gitlab.example/group/sub/api/-/merge_requests/3" });
    if (path.includes("/issues/9/notes") && method === "GET") return notesPage([]);
    if (path.includes("/issues/9/notes")) return jsonResponse({});
    if (path.includes("/members/all/")) return jsonResponse({ access_level: 40 });
    if (path.endsWith("/issues/9")) {
      return jsonResponse({
        iid: 9, web_url: "https://gitlab.example/group/hub/-/issues/9", title: "t", description: "Target: group/sub/api\n\nb",
        author: { id: 10, username: "maintainer" }, labels: [],
      });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  const hub = gitlabTracker({ token: "x", apiUrl: api, project: "group/hub", issue: 9 });
  const target = hub.retarget("group/sub/api");
  assert.equal(target.platform, "gitlab");

  assert.equal((await target.repo()).cloneUrl, "https://gitlab.example/group/sub/api.git");
  assert.equal(await target.ensureBranch("agent/issue-9", "main"), true);
  assert.deepEqual(await target.openReview({ branch: "agent/issue-9", base: "main", title: "t", body: "Closes x" }), {
    url: "https://gitlab.example/group/sub/api/-/merge_requests/3", created: true,
  });
  const code = calls.splice(0);
  assert.ok(code.length >= 5);
  for (const c of code) assert.match(c, /^\w+ https:\/\/gitlab\.example\/api\/v4\/projects\/group%2Fsub%2Fapi(\/|\?|$)/);

  assert.equal((await target.getTicket()).url, "https://gitlab.example/group/hub/-/issues/9");
  await target.comment("hi");
  await target.setState("review");
  assert.ok(calls.length >= 4);
  for (const c of calls) assert.match(c, /^\w+ https:\/\/gitlab\.example\/api\/v4\/projects\/group%2Fhub\/(issues\/9|members)/);
});
