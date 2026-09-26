import { test } from "node:test";
import assert from "node:assert/strict";
import { gitlabTracker } from "../src/gitlab.ts";

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

test("gitlab createSubIssue: creates the issue with the agent label in a single call", async (t) => {
  const calls: { url: string; method: string; body: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: (init.body as string) ?? "" });
    if (url.includes("/issues") && init.method === "POST") {
      return jsonResponse({ iid: 17, web_url: "https://gitlab.example/g/p/-/issues/17" });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const tracker = gitlabTracker({ token: "x", apiUrl: "https://gitlab.example/api/v4", project: "g/p", issue: 9 });
  const created = await tracker.createSubIssue({ title: "Sub-task 1", body: "Do the first part." });

  assert.deepEqual(created, { number: 17, url: "https://gitlab.example/g/p/-/issues/17" });
  assert.equal(calls.length, 1, "one call is enough: GitLab actions on a newly-opened issue that already has the label");
  assert.deepEqual(JSON.parse(calls[0]!.body), { title: "Sub-task 1", description: "Do the first part.", labels: "agent" });
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

test("gitlab getTicket: follows x-next-page across 250+ human notes, drops system notes, keeps order", async (t) => {
  // 3 pages of 100 notes each, every 5th one a system note, plus an empty final page.
  const all = Array.from({ length: 300 }, (_, k) => ({
    system: k % 5 === 4,
    author: { id: 10, username: "maintainer" },
    body: `note ${k}`,
    created_at: `t${String(k).padStart(3, "0")}`,
  }));
  const noteUrls: string[] = [];
  let membershipCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/issues/3/notes")) {
      noteUrls.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      const next = page < 4 ? String(page + 1) : "";
      return notesPage(all.slice((page - 1) * 100, page * 100), next);
    }
    if (url.endsWith("/issues/3")) return issueResponse(3);
    if (url.includes("/members/all/")) {
      membershipCalls++;
      return jsonResponse({ access_level: 40 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const tracker = gitlabTracker({ token: "x", apiUrl: "https://gitlab.example/api/v4", project: "g/p", issue: 3 });
  const ticket = await tracker.getTicket();

  assert.equal(noteUrls.length, 4, "three full pages and one empty final page");
  for (const u of noteUrls) {
    const q = new URL(u).searchParams;
    assert.equal(q.get("sort"), "asc");
    assert.equal(q.get("order_by"), "created_at");
    assert.equal(q.getAll("page").length, 1, "page must not be duplicated");
    assert.equal(q.getAll("per_page").length, 1);
  }
  const expected = all.filter((n) => !n.system).map((n) => n.body);
  assert.equal(expected.length, 240);
  assert.deepEqual(ticket.comments.map((c) => c.text), expected);
  assert.equal(ticket.comments.at(-1)!.text, "note 298", "the newest human note must be present");
  assert.equal(membershipCalls, 1, "membership stays cached per user across pages");
});

test("gitlab getTicket: a failing later page throws instead of returning a partial thread", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/issues/3/notes")) {
      const page = new URL(url).searchParams.get("page");
      if (page === "1") return notesPage([{ system: false, author: { id: 10, username: "m" }, body: "a", created_at: "t1" }], "2");
      return new Response("boom", { status: 502 });
    }
    if (url.endsWith("/issues/3")) return issueResponse(3);
    if (url.includes("/members/all/")) return jsonResponse({ access_level: 40 });
    throw new Error(`unexpected fetch ${url}`);
  });

  const tracker = gitlabTracker({ token: "x", apiUrl: "https://gitlab.example/api/v4", project: "g/p", issue: 3 });
  await assert.rejects(tracker.getTicket(), /GitLab GET .*notes.*: 502 boom/);
});

test("gitlab getTicket: a notes response without pagination headers is an error, not page 1 of ?", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/issues/3/notes")) return jsonResponse([]);
    if (url.endsWith("/issues/3")) return issueResponse(3);
    throw new Error(`unexpected fetch ${url}`);
  });

  const tracker = gitlabTracker({ token: "x", apiUrl: "https://gitlab.example/api/v4", project: "g/p", issue: 3 });
  await assert.rejects(tracker.getTicket(), /no x-next-page header/);
});
