import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createBriefingCards, type BriefingCard } from "../src/slack/briefing-cards.ts";

const url = process.env.BRIEFING_TEST_DATABASE_URL;
test(
  "Postgres cards persist across connections, serialize competing decisions and preserve owner isolation",
  { skip: !url && "set BRIEFING_TEST_DATABASE_URL to an isolated test database" },
  async () => {
    const table = `briefing_test_${Date.now()}`;
    const a = createPostgresMapFactory(url!);
    const b = createPostgresMapFactory(url!);
    const input = {
      sourceKey: "thread-1",
      sourceVersion: "message-1",
      title: "Kontrollera åäö 🎉",
      summary: "Verifiera innan svar.",
      sourceUrl: "https://example.com/",
    };
    const writer = createBriefingCards(a.map<BriefingCard>(table));
    const reader = createBriefingCards(b.map<BriefingCard>(table));
    try {
      const [one, two] = await Promise.all([writer.create("peter", input), reader.create("peter", input)]);
      assert.equal(one.id, two.id);
      assert.equal((await reader.list("peter")).length, 1);
      await writer.claimPost(one.id, "T1", "D1");
      await writer.posted(one.id, "100.001", 0);
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? writer : reader).decide(one.id, 0, "peter", "T1", "D1", "100.001", "draft"),
        ),
      );
      assert.equal((await reader.get(one.id))!.revision, 1);
      assert.equal((await reader.get(one.id))!.draft, "pending");
      assert.deepEqual(await reader.list("alice"), []);
      await assert.rejects(reader.decide(one.id, 1, "alice", "T1", "D1", "100.001", "done"));
      await a.pool.close();
      const restarted = createPostgresMapFactory(url!);
      try {
        const store = createBriefingCards(restarted.map<BriefingCard>(table));
        assert.equal((await store.get(one.id))!.title, input.title);
        await store.decide(one.id, 1, "peter", "T1", "D1", "100.001", "done");
        assert.equal((await store.create("peter", input)).status, "done");
      } finally {
        await restarted.pool.close();
      }
    } finally {
      await b.pool.q(`DROP TABLE IF EXISTS ${table}`);
      await b.pool.close();
      await a.pool.close();
    }
  },
);
