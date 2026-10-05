import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { briefingCardRoutes } from "../src/api/routes/briefing-cards.ts";
import { createBriefingCards, type BriefingCard } from "../src/slack/briefing-cards.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";

const INPUT = {
  sourceKey: "task-1",
  sourceVersion: "message-1",
  title: "Review",
  summary: "Read source",
  sourceUrl: "https://example.com/source",
};
async function request(
  options: {
    method?: string;
    scope?: string;
    owner?: string;
    enabled?: boolean;
    member?: boolean;
    body?: unknown;
    after?: string;
    seed?: number;
    limited?: boolean;
  } = {},
) {
  const cards = createBriefingCards(createMemoryMap<BriefingCard>());
  const directory = createDirectoryStore();
  if (options.member !== false)
    await directory.replace([{ principalId: "peter", displayName: "Peter", type: "internal" }]);
  for (let i = 0; i < (options.seed ?? 0); i++) await cards.create("peter", { ...INPUT, sourceKey: `task-${i}` });
  const server = createServer(async (req, res) => {
    const ctx = {
      req,
      res,
      method: options.method ?? "POST",
      url: new URL(`http://localhost/v1/briefing-cards${options.after ? `?after=${options.after}` : ""}`),
      body: options.body ?? INPUT,
      capability: {
        actorId: options.owner ?? "peter",
        scopeId: (options.scope ?? "personal:peter") as ReturnType<typeof scopeId>,
        exp: Date.now() + 60_000,
      },
      deps: {
        briefingCards: options.enabled === false ? undefined : cards,
        directory,
        rateLimiter: options.limited ? { check: async () => ({ allowed: false }) } : undefined,
      },
    } as unknown as ApiCtx;
    try {
      await briefingCardRoutes.find((r) => "method" in r && r.method === ctx.method)!.handle(ctx);
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return { status: response.status, body: (await response.json()) as any, cards };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("card API queues to capability owner, ignores client supplied owner/channel", async () => {
  const r = await request({ body: { ...INPUT, owner: "alice", channel: "C-public" } });
  assert.equal(r.status, 202);
  assert.equal(r.body.card.owner, "peter");
  assert.equal(r.body.card.channel, undefined);
  assert.equal(r.body.card.delivery, "pending");
});
test("card API denies shared scopes, foreign personal scopes and unknown principals", async () => {
  for (const opts of [{ scope: "channel:C1" }, { scope: "personal:alice" }, { member: false }, { owner: "alice" }])
    assert.equal((await request(opts)).status, 403);
});
test("disabled feature fails closed and validates input", async () => {
  assert.equal((await request({ enabled: false })).status, 503);
  assert.equal((await request({ body: { ...INPUT, sourceUrl: "javascript:alert(1)" } })).status, 400);
  assert.equal((await request({ limited: true })).status, 429);
});
test("listing is owner scoped, bounded and exposes a continuation cursor", async () => {
  const r = await request({ method: "GET", seed: 102 });
  assert.equal(r.status, 200);
  assert.equal(r.body.cards.length, 100);
  assert.match(r.body.next, /^[a-f0-9]{64}$/);
  assert.equal((await request({ method: "GET", after: "bad" })).status, 400);
  const rows = await r.cards.list("peter", r.body.next);
  assert.equal(rows.length, 2);
});
