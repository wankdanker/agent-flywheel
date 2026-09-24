import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { trustFromGithubAssociation, gitlabMemberTrust, GITLAB_DEVELOPER_ACCESS_LEVEL } from "../src/trust.ts";

test("trustFromGithubAssociation trusts owner, member, collaborator", () => {
  for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.equal(trustFromGithubAssociation(a), "trusted");
  }
});

test("trustFromGithubAssociation distrusts everything else", () => {
  for (const a of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", "MANNEQUIN", null, undefined, ""]) {
    assert.equal(trustFromGithubAssociation(a as any), "untrusted");
  }
});

test("gitlabMemberTrust trusts Developer and above", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ access_level: GITLAB_DEVELOPER_ACCESS_LEVEL }), { status: 200 }));
  const trust = await gitlabMemberTrust({ apiUrl: "https://gitlab.example", project: "g/p", token: "t", userId: 1 });
  assert.equal(trust, "trusted");
});

test("gitlabMemberTrust distrusts below Developer", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ access_level: 20 }), { status: 200 }));
  const trust = await gitlabMemberTrust({ apiUrl: "https://gitlab.example", project: "g/p", token: "t", userId: 1 });
  assert.equal(trust, "untrusted");
});

test("gitlabMemberTrust treats a non-member (404) as untrusted, not an error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("not found", { status: 404 }));
  const trust = await gitlabMemberTrust({ apiUrl: "https://gitlab.example", project: "g/p", token: "t", userId: 1 });
  assert.equal(trust, "untrusted");
});

test("gitlabMemberTrust throws on an unexpected API error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("boom", { status: 500 }));
  await assert.rejects(() => gitlabMemberTrust({ apiUrl: "https://gitlab.example", project: "g/p", token: "t", userId: 1 }));
});
