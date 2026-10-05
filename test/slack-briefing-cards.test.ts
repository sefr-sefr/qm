import { test } from "node:test";
import assert from "node:assert/strict";
import { briefingCardMessage, briefingInputFromMessage, parseBriefingInput } from "../src/slack/briefing-cards.ts";
import { createBriefingCardActions } from "../src/slack/briefing-card-actions.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";

const input = {
  title: "Kontrollera åtkomsten 🎉",
  summary: "Läs källan före svar.",
  sourceUrl: "https://example.com/source",
};
function fixture() {
  const turns: any[] = [];
  const ephemerals: any[] = [];
  let acked = false;
  const message = { ...briefingCardMessage(input), ts: "100.001", user: "UBOT" };
  const info = { channel: { is_im: true, user: "U1" } };
  const identity = { ok: true, actor: { externalId: "reviewer@example.com", isBot: false, isExternalGuest: false } };
  const client = {
    conversations: {
      info: async () => {
        assert.equal(acked, true);
        return info;
      },
      replies: async () => ({ messages: [message] }),
    },
    chat: {
      postEphemeral: async (p: any) => {
        ephemerals.push(p);
      },
    },
  };
  const core = {
    submitTurn: async (p: any) => {
      turns.push(p);
      return { status: "queued", runId: "run-1" };
    },
  } as unknown as SlackCoreClient;
  const deps = {
    core,
    directory: { classifyUserCached: async () => identity },
    client,
    teamId: () => "T1",
    botUserId: () => "UBOT",
  };
  const click = {
    ack: async () => {
      acked = true;
    },
    body: { team: { id: "T1" }, user: { id: "U1" }, channel: { id: "D1" }, message: { ts: "100.001", blocks: [] } },
    action: { action_id: "briefing_draft" },
  };
  return { turns, ephemerals, message, info, identity, deps, click, actions: createBriefingCardActions(deps) };
}

test("Slack message is the card: roundtrips without IDs, status or storage", () => {
  const rendered = briefingCardMessage(input);
  assert.deepEqual(briefingInputFromMessage(rendered), input);
  assert.equal(JSON.stringify(rendered).includes("briefing_done"), false);
  assert.equal(JSON.stringify(rendered).includes("datepicker"), false);
  assert.ok(JSON.stringify(rendered).includes("briefing_source"));
});
test("reject invalid text and source URLs", () => {
  for (const sourceUrl of ["http://example.com", "javascript:alert(1)", "https://user:pass@example.com", "bad"])
    assert.throws(() => parseBriefingInput({ ...input, sourceUrl }));
  assert.throws(() => parseBriefingInput({ ...input, title: "x".repeat(151) }));
  assert.throws(() => parseBriefingInput({ ...input, summary: "a\nb" }));
  assert.throws(() => briefingInputFromMessage({ blocks: [] }));
});
test("ack first, read actual bot message, submit read-only draft in same DM thread", async () => {
  const f = fixture();
  await f.actions.handle(f.click);
  assert.equal(f.turns.length, 1);
  const turn = f.turns[0];
  assert.equal(turn.readOnly, true);
  assert.equal(turn.liveActor, false);
  assert.equal(turn.async, true);
  assert.equal(turn.actor.externalId, "reviewer@example.com");
  assert.equal(turn.deliveryTarget, "D1:100.001");
  assert.match(turn.text, /https:\/\/example.com\/source/);
  assert.equal(f.ephemerals.length, 0);
});
test("repeated clicks and restarted handlers use core's existing run deduplication key", async () => {
  const f = fixture();
  await f.actions.handle(f.click);
  await createBriefingCardActions(f.deps).handle(f.click);
  assert.equal(f.turns[0].idempotencyKey, f.turns[1].idempotencyKey);
});
test("source link needs only acknowledgement", async () => {
  const f = fixture();
  f.click.action.action_id = "briefing_source";
  await f.actions.handle(f.click);
  assert.equal(f.turns.length, 0);
});
test("reject cross-workspace, wrong DM, revoked membership and foreign authored cards", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.click.body.team.id = "T2";
    },
    (f: ReturnType<typeof fixture>) => {
      f.info.channel.user = "U2";
    },
    (f: ReturnType<typeof fixture>) => {
      f.info.channel.is_im = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.identity.ok = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.identity.actor.isExternalGuest = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.identity.actor.isBot = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.message.user = "OTHERBOT";
    },
    (f: ReturnType<typeof fixture>) => {
      f.message.ts = "other";
    },
  ]) {
    const f = fixture();
    mutate(f);
    await f.actions.handle(f.click);
    assert.equal(f.turns.length, 0);
    assert.equal(f.ephemerals.length, 1);
  }
});
test("ambiguous draft response gives no false success, retry uses same key", async () => {
  const f = fixture();
  f.deps.core.submitTurn = async () => {
    throw new Error("transport");
  };
  await f.actions.handle(f.click);
  assert.equal(f.ephemerals.length, 1);
});
test("actor allowlist is enforced", async () => {
  const f = fixture();
  await createBriefingCardActions({ ...f.deps, allowActor: () => false }).handle(f.click);
  assert.equal(f.turns.length, 0);
});
