import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import {
  createBriefingCards,
  parseBriefingInput,
  briefingCardMessage,
  cardVisible,
  stockholmDate,
  type BriefingCard,
  type CardAction,
} from "../src/slack/briefing-cards.ts";
import { createBriefingCardActions } from "../src/slack/briefing-card-actions.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";

const NOW = Date.parse("2026-10-05T09:00:00Z");
const INPUT = {
  sourceKey: "gmail:thread-1",
  sourceVersion: "message-1",
  title: "Kontrollera inställningarna",
  summary: "Kontrollera åtkomsten till testprojektet.",
  sourceUrl: "https://mail.google.com/mail/u/0/#all/thread-1",
};
async function fixture() {
  const map = createMemoryMap<BriefingCard>();
  const audit = createAuditLog();
  const cards = createBriefingCards(map, () => NOW, audit);
  const initial = await cards.create("reviewer@example.com", INPUT);
  await cards.claimPost(initial.id, "T1", "D1");
  await cards.posted(initial.id, "100.001", 0);
  const decide = (kind: CardAction, revision = 0, date?: string) =>
    cards.decide(initial.id, revision, initial.owner, "T1", "D1", "100.001", kind, date);
  return { map, audit, cards, id: initial.id, initial, decide };
}

test("stable source replay preserves completion and a changed source version gets a new card", async () => {
  const f = await fixture();
  await f.decide("done");
  assert.equal((await f.cards.create(f.initial.owner, INPUT)).status, "done");
  assert.notEqual((await f.cards.create(f.initial.owner, { ...INPUT, sourceVersion: "message-2" })).id, f.id);
});

test("same source in different owners is isolated", async () => {
  const f = await fixture();
  const other = await f.cards.create("alice@example.com", INPUT);
  assert.notEqual(other.id, f.id);
  assert.equal((await f.cards.list("alice@example.com")).length, 1);
  assert.deepEqual(await f.cards.list("nobody@example.com"), []);
});

test("concurrent clicks consume one revision and audit once", async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 20 }, () => f.decide("done")));
  assert.equal((await f.cards.get(f.id))!.revision, 1);
  assert.equal((await f.audit.events()).length, 1);
});

test("stale undo or snooze cannot overwrite a later decision", async () => {
  const f = await fixture();
  await f.decide("done");
  await f.decide("undo");
  assert.equal((await f.cards.get(f.id))!.status, "done");
  await f.decide("undo", 1);
  assert.equal((await f.cards.get(f.id))!.status, "open");
  await f.decide("snooze", 1, "2026-10-07");
  assert.equal((await f.cards.get(f.id))!.status, "open");
});

test("wrong owner, workspace, message and channel fail closed", async () => {
  const f = await fixture();
  for (const [owner, team, channel, ts] of [
    ["alice", "T1", "D1", "100.001"],
    [f.initial.owner, "T2", "D1", "100.001"],
    [f.initial.owner, "T1", "D2", "100.001"],
    [f.initial.owner, "T1", "D1", "101.001"],
  ]) {
    await assert.rejects(f.cards.decide(f.id, 0, owner!, team!, channel!, ts!, "done"));
  }
  assert.equal((await f.cards.get(f.id))!.revision, 0);
});

test("Stockholm date handles DST boundaries and snoozes reappear on the selected date", async () => {
  assert.equal(stockholmDate(Date.parse("2026-10-24T22:30:00Z")), "2026-10-25");
  assert.equal(stockholmDate(Date.parse("2026-10-25T23:30:00Z")), "2026-10-26");
  const f = await fixture();
  const card = await f.decide("snooze", 0, "2026-10-07");
  assert.equal(cardVisible(card!, NOW), false);
  assert.equal(cardVisible(card!, Date.parse("2026-10-06T22:00:00Z")), true);
});

test("invalid, impossible and past snooze dates do not mutate state", async () => {
  const f = await fixture();
  for (const date of [undefined, "2026-02-30", "2026-13-01", "2026-10-05", "2026-10-04", "tomorrow"])
    await assert.rejects(f.decide("snooze", 0, date));
  assert.equal((await f.cards.get(f.id))!.revision, 0);
});

test("draft request is durable and cannot be requested twice after completion or restart", async () => {
  const f = await fixture();
  await f.decide("draft");
  const restarted = createBriefingCards(f.map, () => NOW);
  assert.equal((await restarted.get(f.id))!.draft, "pending");
  await restarted.draftResult(f.id, "accepted", "run-1");
  await f.decide("draft", 2);
  assert.equal((await restarted.get(f.id))!.draftRunId, "run-1");
  assert.equal((await restarted.get(f.id))!.revision, 2);
});

test("payload validation rejects injection URLs and oversized content", () => {
  for (const sourceUrl of ["javascript:alert(1)", "http://example.com", "https://u:p@example.com"])
    assert.throws(() => parseBriefingInput({ ...INPUT, sourceUrl }));
  assert.throws(() => parseBriefingInput({ ...INPUT, title: "x".repeat(151) }));
  assert.throws(() => parseBriefingInput({ ...INPUT, summary: "x\u0000" }));
});

test("renderer uses plain text and opaque versioned actions, preserves Swedish characters", async () => {
  const f = await fixture();
  const message = briefingCardMessage({ ...f.initial, summary: "<!channel> & åäö 🎉" });
  const encoded = JSON.stringify(message);
  assert.ok(encoded.includes("åäö 🎉"));
  assert.ok(!encoded.includes('"mrkdwn"'));
  const actions = message.blocks.at(-1) as any;
  assert.equal(actions.block_id, `briefing:${f.id}:0`);
  assert.ok(actions.elements.some((e: any) => e.type === "datepicker"));
  assert.ok(actions.elements.some((e: any) => e.url === INPUT.sourceUrl));
});

async function actionFixture() {
  const f = await fixture();
  const events: string[] = [];
  const requests: any[] = [];
  const posts: any[] = [];
  let rejectSubmit = false;
  let rejectUpdate = false;
  let rejectPost = false;
  let external = false;
  const client = {
    users: { lookupByEmail: async () => ({ user: { id: "U1" } }) },
    conversations: {
      open: async () => ({ channel: { id: "D1" } }),
      info: async () => ({ channel: { is_im: true, user: "U1" } }),
    },
    chat: {
      update: async (args: any) => {
        events.push("update");
        if (rejectUpdate) throw new Error("offline");
        posts.push(args);
        return { ok: true };
      },
      postMessage: async (args: any) => {
        events.push("post");
        posts.push(args);
        if (rejectPost) throw new Error("ambiguous timeout");
        return { ok: true, ts: "101.001" };
      },
      postEphemeral: async () => {
        events.push("ephemeral");
      },
    },
  };
  const core = {
    holdEnvelopeReplay: async (_key: string, fn: (lost: Promise<void>) => Promise<unknown>) =>
      fn(new Promise(() => {})),
    submitTurn: async (body: any) => {
      requests.push(body);
      if (rejectSubmit) throw new Error("lost response");
      return { status: "queued", runId: "run-1" };
    },
  } as unknown as SlackCoreClient;
  const directory = {
    classifyUserCached: async (_: any, user: string | undefined) => {
      events.push("classify");
      return { ok: true, actor: { externalId: user === "U1" ? f.initial.owner : "other", isExternalGuest: external } };
    },
  };
  const make = () => createBriefingCardActions({ cards: f.cards, core, directory, client, teamId: () => "T1" });
  const handler = make();
  const click = (kind: string, revision = 0, extra: any = {}) =>
    handler.handle({
      ack: async () => {
        events.push("ack");
      },
      client,
      body: { team: { id: "T1" }, channel: { id: "D1" }, user: { id: "U1" }, message: { ts: "100.001" }, ...extra },
      action: { action_id: `briefing_${kind}`, block_id: `briefing:${f.id}:${revision}`, value: `${f.id}:${revision}` },
    });
  return {
    ...f,
    events,
    requests,
    posts,
    client,
    handler,
    make,
    click,
    submitFails: (v: boolean) => {
      rejectSubmit = v;
    },
    updateFails: (v: boolean) => {
      rejectUpdate = v;
    },
    postFails: (v: boolean) => {
      rejectPost = v;
    },
    external: (v: boolean) => {
      external = v;
    },
  };
}

test("callback acknowledges before I/O and concurrent draft clicks enqueue once", async () => {
  const f = await actionFixture();
  await Promise.all([f.click("draft"), f.click("draft")]);
  assert.equal(f.events[0], "ack");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].deliveryTarget, "D1:100.001");
  assert.equal(f.requests[0].conversation.threadRef, "dm:D1:100.001");
  assert.equal(f.requests[0].liveActor, false);
  assert.match(f.requests[0].text, /Skicka inget/);
});

test("callback rejects another user or workspace without posting card content", async () => {
  const f = await actionFixture();
  await f.click("done", 0, { user: { id: "U2" } });
  await f.click("done", 0, { team: { id: "T2" } });
  assert.equal(f.posts.length, 0);
  assert.equal((await f.cards.get(f.id))!.revision, 0);
  assert.equal(f.events.filter((e) => e === "ephemeral").length, 2);
});

test("revoked/external membership blocks a pending draft", async () => {
  const f = await actionFixture();
  await f.decide("draft");
  f.external(true);
  await f.handler.reconcileOne(f.id);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.cards.get(f.id))!.draft, "blocked");
});

test("ambiguous core response recovers with the identical idempotency key", async () => {
  const f = await actionFixture();
  f.submitFails(true);
  await f.click("draft");
  assert.equal((await f.cards.get(f.id))!.draft, "pending");
  f.submitFails(false);
  await f.make().reconcileOne(f.id);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].idempotencyKey, f.requests[1].idempotencyKey);
  assert.equal((await f.cards.get(f.id))!.draft, "accepted");
});

test("Slack update failure retains state and a sweep repairs the card", async () => {
  const f = await actionFixture();
  f.updateFails(true);
  await f.click("done");
  assert.equal((await f.cards.get(f.id))!.status, "done");
  assert.equal((await f.cards.get(f.id))!.renderedRevision, 0);
  f.updateFails(false);
  await f.make().sweep();
  assert.equal((await f.cards.get(f.id))!.renderedRevision, 1);
});

test("new card is posted into the verified owner's DM only", async () => {
  const f = await actionFixture();
  const fresh = await f.cards.create(f.initial.owner, { ...INPUT, sourceVersion: "message-2" });
  await f.handler.reconcileOne(fresh.id);
  assert.equal((await f.cards.get(fresh.id))!.delivery, "posted");
  assert.equal(f.posts[0].channel, "D1");
});

test("ambiguous initial Slack post is not repeated after restart", async () => {
  const f = await actionFixture();
  const fresh = await f.cards.create(f.initial.owner, { ...INPUT, sourceVersion: "message-2" });
  f.postFails(true);
  await assert.rejects(f.handler.reconcileOne(fresh.id));
  f.postFails(false);
  await f.make().reconcileOne(fresh.id);
  assert.equal(f.events.filter((e) => e === "post").length, 1);
  assert.equal((await f.cards.get(fresh.id))!.delivery, "posting");
});

test("an expired snooze reopens atomically and restores draft actions without reposting", async () => {
  const f = await fixture();
  await f.decide("snooze", 0, "2026-10-07");
  const later = createBriefingCards(f.map, () => Date.parse("2026-10-07T08:00:00Z"));
  await Promise.all([later.reopenDue(f.id), later.reopenDue(f.id)]);
  const card = (await later.get(f.id))!;
  assert.equal(card.status, "open");
  assert.equal(card.revision, 2);
  assert.equal(card.messageTs, "100.001");
  assert.ok(JSON.stringify(briefingCardMessage(card)).includes("briefing_draft"));
});
