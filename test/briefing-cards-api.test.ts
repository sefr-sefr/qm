import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { briefingCardRoutes, postBriefingCard } from "../src/api/routes/briefing-cards.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";

const INPUT = { title: "Review", summary: "Read source", sourceUrl: "https://example.com/source" };
async function request(
  options: {
    scope?: string;
    owner?: string;
    enabled?: boolean;
    member?: boolean;
    body?: unknown;
    limited?: boolean;
  } = {},
) {
  const directory = createDirectoryStore();
  if (options.member !== false)
    await directory.replace([{ principalId: "reviewer", displayName: "Reviewer", type: "internal" }]);
  const server = createServer(async (req, res) => {
    const ctx = {
      req,
      res,
      method: "POST",
      url: new URL("http://localhost/v1/briefing-cards"),
      body: options.body ?? INPUT,
      capability: {
        actorId: options.owner ?? "reviewer",
        scopeId: options.scope ?? "personal:reviewer",
        exp: Date.now() + 60_000,
      },
      deps: {
        slackBriefingCards: options.enabled !== false,
        slackEnvBotToken: "never-used-in-validation-tests",
        directory,
        rateLimiter: options.limited ? { check: async () => ({ allowed: false }) } : undefined,
      },
    } as unknown as ApiCtx;
    try {
      await briefingCardRoutes[0]!.handle(ctx);
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return response.status;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
test("API denies shared/foreign scopes and unknown principals before Slack I/O", async () => {
  for (const opts of [{ scope: "channel:C1" }, { scope: "personal:other" }, { member: false }, { owner: "other" }])
    assert.equal(await request(opts), 403);
});
test("disabled feature, invalid input and rate limit fail before Slack I/O", async () => {
  assert.equal(await request({ enabled: false }), 503);
  assert.equal(await request({ body: { ...INPUT, sourceUrl: "javascript:alert(1)" } }), 400);
  assert.equal(await request({ limited: true }), 429);
});
function slackFixture() {
  const posts: any[] = [];
  const member = {
    id: "U1",
    team_id: "T1",
    profile: { email: "reviewer@example.com" },
    deleted: false,
    is_bot: false,
    is_restricted: false,
    is_ultra_restricted: false,
  };
  const channel = { id: "D1", is_im: true, user: "U1" };
  const client = {
    auth: { test: async () => ({ ok: true, team_id: "T1" }) },
    users: { lookupByEmail: async () => ({ user: member }), info: async () => ({ user: member }) },
    conversations: { open: async () => ({ channel }), info: async () => ({ channel }) },
    chat: {
      postMessage: async (p: any) => {
        posts.push(p);
        return { ok: true, ts: "100.001" };
      },
    },
  };
  return { posts, member, channel, client };
}
test("posts into verified owner DM and returns real Slack receipt without a database", async () => {
  const f = slackFixture();
  const result = await postBriefingCard(f.client, "reviewer@example.com", INPUT);
  assert.deepEqual(result, { channel: "D1", messageTs: "100.001" });
  assert.equal(f.posts[0].channel, "D1");
  assert.equal(f.posts[0].unfurl_links, false);
});
test("wrong or external DM member cannot receive private source content", async () => {
  for (const mutate of [
    (f: ReturnType<typeof slackFixture>) => {
      f.member.profile.email = "other@example.com";
    },
    (f: ReturnType<typeof slackFixture>) => {
      f.member.team_id = "T2";
    },
    (f: ReturnType<typeof slackFixture>) => {
      f.member.deleted = true;
    },
    (f: ReturnType<typeof slackFixture>) => {
      f.member.is_restricted = true;
    },
    (f: ReturnType<typeof slackFixture>) => {
      f.channel.is_im = false;
    },
  ]) {
    const f = slackFixture();
    mutate(f);
    await assert.rejects(postBriefingCard(f.client, "reviewer@example.com", INPUT));
    assert.equal(f.posts.length, 0);
  }
});
test("ambiguous Slack post is not retried", async () => {
  const f = slackFixture();
  let calls = 0;
  f.client.chat.postMessage = async () => {
    calls++;
    throw new Error("timeout");
  };
  await assert.rejects(postBriefingCard(f.client, "reviewer@example.com", INPUT));
  assert.equal(calls, 1);
});
test("no GET endpoint or saved task-state contract", () => {
  assert.equal(briefingCardRoutes.length, 1);
  assert.equal((briefingCardRoutes[0] as any).method, "POST");
});
