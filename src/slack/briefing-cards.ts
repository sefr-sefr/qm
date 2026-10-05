import { createHash } from "node:crypto";
import type { AuditLog } from "../audit/audit-log.ts";
import { scopeId } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface BriefingCard {
  id: string;
  owner: string;
  sourceKey: string;
  sourceVersion: string;
  title: string;
  summary: string;
  sourceUrl: string;
  revision: number;
  status: "open" | "done" | "snoozed";
  snoozedUntil?: string;
  draft: "none" | "pending" | "accepted" | "blocked";
  draftRunId?: string;
  delivery: "pending" | "posting" | "posted";
  teamId?: string;
  channel?: string;
  messageTs?: string;
  renderedRevision: number;
  createdAt: number;
  updatedAt: number;
  lastAction?: { actor: string; kind: string; at: number };
}
export type BriefingInput = Pick<BriefingCard, "sourceKey" | "sourceVersion" | "title" | "summary" | "sourceUrl">;
export type CardAction = "done" | "undo" | "snooze" | "draft";

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value.trim();
}
export function parseBriefingInput(body: unknown): BriefingInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid card");
  const b = body as Record<string, unknown>;
  const sourceUrl = text(b.sourceUrl, "sourceUrl", 1500);
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("sourceUrl must be HTTPS");
  return {
    sourceKey: text(b.sourceKey, "sourceKey", 200),
    sourceVersion: text(b.sourceVersion, "sourceVersion", 200),
    title: text(b.title, "title", 150),
    summary: text(b.summary, "summary", 1800),
    sourceUrl: url.href,
  };
}
export function stockholmDate(now: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
function validFutureDate(value: string | undefined, now: number): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value > stockholmDate(now);
}
export function cardVisible(card: BriefingCard, now = Date.now()): boolean {
  return card.status !== "done" && !(card.status === "snoozed" && card.snoozedUntil! > stockholmDate(now));
}
export function createBriefingCards(map: DurableMap<BriefingCard>, clock = Date.now, audit?: AuditLog) {
  const update = map.update?.bind(map);
  if (!update) throw new Error("briefing cards require atomic map updates");
  return {
    async create(owner: string, input: BriefingInput) {
      const clean = parseBriefingInput(input);
      const id = createHash("sha256")
        .update(JSON.stringify([owner, clean.sourceKey, clean.sourceVersion]))
        .digest("hex");
      const now = clock();
      return map.putIfAbsent(id, {
        ...clean,
        id,
        owner,
        revision: 0,
        status: "open",
        draft: "none",
        delivery: "pending",
        renderedRevision: -1,
        createdAt: now,
        updatedAt: now,
      });
    },
    get: (id: string) => map.get(id),
    async list(owner: string, afterId?: string) {
      return map
        .select({ where: { field: "owner", anyOfFold: [owner] }, limit: 101, afterId })
        .then((rows) => rows.filter((r) => r.owner === owner));
    },
    async pending(afterId?: string) {
      return map.select({ limit: 100, afterId });
    },
    async reopenDue(id: string) {
      return update(id, (old) =>
        old.status === "snoozed" && old.snoozedUntil! <= stockholmDate(clock())
          ? { ...old, status: "open", snoozedUntil: undefined, revision: old.revision + 1, updatedAt: clock() }
          : old,
      );
    },
    async claimPost(id: string, teamId: string, channel: string) {
      let claimed = false;
      const card = await update(id, (old) => {
        if (old.delivery !== "pending") return old;
        claimed = true;
        return { ...old, delivery: "posting", teamId, channel };
      });
      return claimed ? card : null;
    },
    async posted(id: string, messageTs: string, revision: number) {
      return update(id, (old) => ({ ...old, delivery: "posted", messageTs, renderedRevision: revision }));
    },
    async rendered(id: string, revision: number) {
      return update(id, (old) => ({ ...old, renderedRevision: Math.max(old.renderedRevision, revision) }));
    },
    async decide(
      id: string,
      revision: number,
      actor: string,
      teamId: string,
      channel: string,
      messageTs: string,
      kind: CardAction,
      date?: string,
    ) {
      const now = clock();
      if (!["done", "undo", "snooze", "draft"].includes(kind)) throw new Error("invalid action");
      if (kind === "snooze" && !validFutureDate(date, now)) throw new Error("choose a future Stockholm date");
      let changed = false;
      const result = await update(id, (old) => {
        if (
          old.owner !== actor ||
          old.teamId !== teamId ||
          old.channel !== channel ||
          old.messageTs !== messageTs ||
          old.delivery !== "posted"
        )
          throw new Error("card not available");
        if (old.revision !== revision) return old;
        if (kind === "draft" && (old.status !== "open" || old.draft !== "none")) return old;
        if (kind === "done" && old.status === "done") return old;
        if (kind === "undo" && old.status === "open") return old;
        changed = true;
        return {
          ...old,
          revision: old.revision + 1,
          updatedAt: now,
          lastAction: { actor, kind, at: now },
          ...(kind === "draft"
            ? { draft: "pending" as const }
            : {
                status: ({ done: "done", snooze: "snoozed", undo: "open" } as const)[kind],
                snoozedUntil: kind === "snooze" ? date : undefined,
              }),
        };
      });
      if (changed && result?.lastAction) {
        const event = {
          at: result.lastAction.at,
          principalId: result.lastAction.actor,
          action: `briefing.card.${result.lastAction.kind}`,
          resource: id,
          scopeLabel: scopeId("personal", result.owner),
          status: result.status,
        };
        if (audit?.recordOnce) await audit.recordOnce(`briefing:${id}:${result.revision}`, event);
        else audit?.record(event);
      }
      return result;
    },
    async draftResult(id: string, state: "accepted" | "blocked", runId?: string) {
      return update(id, (old) =>
        old.draft !== "pending"
          ? old
          : { ...old, draft: state, draftRunId: runId, revision: old.revision + 1, updatedAt: clock() },
      );
    },
  };
}
export type BriefingCards = ReturnType<typeof createBriefingCards>;

export function briefingCardMessage(card: BriefingCard) {
  const value = `${card.id}:${card.revision}`;
  const button = (label: string, action: CardAction) => ({
    type: "button",
    text: { type: "plain_text", text: label },
    action_id: `briefing_${action}`,
    value,
  });
  const state = { done: "Klart", snoozed: `Uppskjutet till ${card.snoozedUntil} (Stockholm)`, open: "Att göra" }[
    card.status
  ];
  const draftState = {
    none: "",
    pending: "Utkastet väntar på att starta.",
    accepted: "Utkastet har lämnats till Miffy. Svaret kommer i tråden.",
    blocked: "Utkastet kunde inte startas. Be Miffy kontrollera det i tråden.",
  }[card.draft];
  const elements: Array<Record<string, unknown>> =
    card.status === "open" ? [button("Klart", "done")] : [button("Ångra", "undo")];
  elements.push({
    type: "datepicker",
    action_id: "briefing_snooze",
    placeholder: { type: "plain_text", text: "Skjut upp till…" },
  });
  if (card.status === "open" && card.draft === "none") elements.push(button("Skriv utkast", "draft"));
  elements.push({
    type: "button",
    text: { type: "plain_text", text: "Öppna källa" },
    url: card.sourceUrl,
    action_id: "briefing_source",
  });
  return {
    text: `${card.title}\n${card.summary}\n${state}${draftState ? `\n${draftState}` : ""}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: card.title } },
      { type: "section", text: { type: "plain_text", text: card.summary } },
      { type: "context", elements: [{ type: "plain_text", text: `${state}${draftState ? `. ${draftState}` : ""}` }] },
      { type: "actions", block_id: `briefing:${value}`, elements },
    ],
  };
}
