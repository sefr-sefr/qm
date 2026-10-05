import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { audit } from "./shared.ts";
import { parseBriefingInput } from "../../slack/briefing-cards.ts";

async function briefingCards(ctx: ApiCtx): Promise<void> {
  const { capability, deps, res } = ctx;
  if (!capability || capability.scopeId !== `personal:${capability.actorId}` || capability.botActor) {
    return sendJson(res, 403, { error: "personal_scope_required" });
  }
  if (!deps.briefingCards) return sendJson(res, 503, { error: "briefing_cards_not_enabled" });
  const member = await deps.directory?.get(capability.actorId);
  if (!member || member.type !== "internal") return sendJson(res, 403, { error: "internal_member_required" });
  if (ctx.method === "GET") {
    const after = ctx.url.searchParams.get("after") ?? undefined;
    if (after !== undefined && !/^[a-f0-9]{64}$/.test(after)) return sendJson(res, 400, { error: "invalid_cursor" });
    const rows = await deps.briefingCards.list(capability.actorId, after);
    return sendJson(res, 200, { cards: rows.slice(0, 100), ...(rows.length > 100 ? { next: rows[99]!.id } : {}) });
  }
  const rate = await deps.rateLimiter?.check(`briefing-cards:${capability.actorId}`);
  if (rate && !rate.allowed) return sendJson(res, 429, { error: "rate_limited" });
  let input;
  try {
    input = parseBriefingInput(ctx.body);
  } catch {
    return sendJson(res, 400, {
      error: "invalid_card",
      message: "sourceKey, sourceVersion, title, summary and an HTTPS sourceUrl are required",
    });
  }
  const card = await deps.briefingCards.create(capability.actorId, input);
  audit(deps, {
    principalId: capability.actorId,
    action: "briefing.card.request",
    resource: card.id,
    scopeLabel: capability.scopeId,
  });
  return sendJson(res, 202, { card });
}

export const briefingCardRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/briefing-cards", auth: "either", handle: briefingCards },
  { method: "POST", path: "/v1/briefing-cards", auth: "either", handle: briefingCards },
];
