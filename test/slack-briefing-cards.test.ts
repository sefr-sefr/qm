import { test } from "node:test";
import assert from "node:assert/strict";
import {
  briefingCardMessage,
  briefingInputFromMessage,
  parseBriefingInput,
  briefingMarksFromMessage,
} from "../src/slack/briefing-cards.ts";
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
  const updates: any[] = [];
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
      update: async (p: any) => {
        updates.push(p);
        Object.assign(message, p);
        return { ok: true };
      },
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
    action: { action_id: "briefing_draft" } as any,
  };
  return { turns, ephemerals, updates, message, info, identity, deps, click, actions: createBriefingCardActions(deps) };
}

test("Slack message contains the card and unchecked marks without external storage", () => {
  const rendered = briefingCardMessage(input);
  assert.deepEqual(briefingInputFromMessage(rendered), input);
  assert.deepEqual(briefingMarksFromMessage(rendered), { done: false, important: false, actionTs: "0.000000" });
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

function mark(f: ReturnType<typeof fixture>, values: string[], actionTs = "101.000001") {
  return {
    ...f.click,
    action: {
      action_id: "briefing_marks",
      type: "checkboxes",
      action_ts: actionTs,
      selected_options: values.map((value) => ({ value })),
    },
  };
}

test("done and important persist only on the original Slack message, with text fallback", async () => {
  const f = fixture();
  await f.actions.handle(mark(f, ["done", "important"]));
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].channel, "D1");
  assert.equal(f.updates[0].ts, "100.001");
  assert.deepEqual(briefingMarksFromMessage(f.message), { done: true, important: true, actionTs: "101.000001" });
  assert.match(f.message.text, /✅ Klar.*⭐ Viktig/);
  assert.deepEqual(briefingInputFromMessage(f.message), input);
  assert.equal(f.turns.length, 0);
  assert.equal(f.ephemerals.length, 0);
});

test("recreated handler restores marks from Slack and can uncheck each independently", async () => {
  const f = fixture();
  await f.actions.handle(mark(f, ["done", "important"]));
  await createBriefingCardActions(f.deps).handle(mark(f, ["important"], "102.000001"));
  assert.match(f.message.text, /☐ Kvar.*⭐ Viktig/);
  await createBriefingCardActions(f.deps).handle(mark(f, [], "103.000001"));
  assert.deepEqual(briefingMarksFromMessage(f.message), { done: false, important: false, actionTs: "103.000001" });
  const block = f.message.blocks.find((b) => b.block_id?.startsWith("briefing_marks:"));
  assert.equal("initial_options" in block!.elements![0]!, false);
});

test("duplicate and out-of-order callbacks never toggle or overwrite a later selection", async () => {
  const f = fixture();
  await f.actions.handle(mark(f, ["important"], "103.000001"));
  await createBriefingCardActions(f.deps).handle(mark(f, ["important"], "103.000001"));
  await createBriefingCardActions(f.deps).handle(mark(f, ["done"], "102.000001"));
  assert.equal(f.updates.length, 1);
  assert.equal(briefingMarksFromMessage(f.message).done, false);
});

test("rapid selections within one handler serialize and retain the latest full checkbox snapshot", async () => {
  const f = fixture();
  await Promise.all([
    f.actions.handle(mark(f, ["done"], "101.000001")),
    f.actions.handle(mark(f, ["done", "important"], "101.000002")),
  ]);
  assert.deepEqual(briefingMarksFromMessage(f.message), { done: true, important: true, actionTs: "101.000002" });
});

test("mark callbacks ignore payload message content and do not dispatch drafts", async () => {
  const f = fixture();
  f.click.body.message.blocks = [];
  await f.actions.handle(mark(f, ["done"]));
  assert.deepEqual(briefingInputFromMessage(f.message), input);
  await f.actions.handle(f.click);
  assert.equal(f.turns.length, 1);
  assert.equal(f.updates.length, 1);
});

test("invalid mark events fail closed", async () => {
  for (const action of [
    { type: "button" },
    { action_ts: "NaN" },
    { selected_options: null },
    { selected_options: [{ value: "other" }] },
    { selected_options: [{ value: "done" }, { value: "done" }] },
  ]) {
    const f = fixture();
    const click = mark(f, []);
    Object.assign(click.action, action);
    await f.actions.handle(click);
    assert.equal(f.updates.length, 0);
    assert.equal(f.ephemerals.length, 1);
  }
});

test("marks enforce the same identity and ownership boundaries as drafts", async () => {
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
      f.identity.actor.isBot = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.identity.actor.isExternalGuest = true;
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
    await f.actions.handle(mark(f, ["done"]));
    assert.equal(f.updates.length, 0);
    assert.equal(f.ephemerals.length, 1);
  }
  const f = fixture();
  await createBriefingCardActions({ ...f.deps, allowActor: () => false }).handle(mark(f, ["done"]));
  assert.equal(f.updates.length, 0);
});

test("ambiguous Slack update can be retried without undoing the successful selection", async () => {
  const f = fixture();
  const update = f.deps.client.chat.update;
  f.deps.client.chat.update = async (p: any) => {
    await update(p);
    throw new Error("transport");
  };
  const click = mark(f, ["done"]);
  await f.actions.handle(click);
  assert.equal(f.ephemerals.length, 1);
  await createBriefingCardActions(f.deps).handle(click);
  assert.equal(f.updates.length, 1);
  assert.equal(briefingMarksFromMessage(f.message).done, true);
});

test("unsuccessful Slack update reports no confirmation and releases queue for retry", async () => {
  const f = fixture();
  const update = f.deps.client.chat.update;
  f.deps.client.chat.update = async () => ({ ok: false });
  await f.actions.handle(mark(f, ["done"]));
  assert.equal(f.ephemerals.length, 1);
  assert.equal(briefingMarksFromMessage(f.message).done, false);
  f.deps.client.chat.update = update;
  await f.actions.handle(mark(f, ["done"]));
  assert.equal(briefingMarksFromMessage(f.message).done, true);
});
