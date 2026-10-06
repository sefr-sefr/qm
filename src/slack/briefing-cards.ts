export interface BriefingInput {
  title: string;
  summary: string;
  sourceUrl: string;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value))
    throw new Error("invalid card text");
  return value.trim();
}

export function parseBriefingInput(body: unknown): BriefingInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid card");
  const b = body as Record<string, unknown>;
  const url = new URL(text(b.sourceUrl, 1500));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("source must be HTTPS");
  return { title: text(b.title, 150), summary: text(b.summary, 1800), sourceUrl: url.href };
}

export interface BriefingMarks {
  done: boolean;
  important: boolean;
  actionTs: string;
}

const markOptions = [
  { text: { type: "plain_text", text: "Klar" }, value: "done" },
  { text: { type: "plain_text", text: "Viktig" }, value: "important" },
];

export function briefingMarksFromMessage(message: { blocks?: any[] }): BriefingMarks {
  const block = message.blocks?.find((b) => b.block_id?.startsWith("briefing_marks:"));
  const selected = block?.elements?.find((e: any) => e.action_id === "briefing_marks")?.initial_options ?? [];
  return {
    done: selected.some((o: any) => o.value === "done"),
    important: selected.some((o: any) => o.value === "important"),
    actionTs: block?.block_id.slice("briefing_marks:".length) ?? "0.000000",
  };
}

export function parseBriefingMarksAction(action: any): BriefingMarks {
  if (
    action.type !== "checkboxes" ||
    !/^\d{1,16}\.\d{6}$/.test(action.action_ts ?? "") ||
    !Array.isArray(action.selected_options) ||
    action.selected_options.length > 2 ||
    action.selected_options.some((o: any) => !o || !["done", "important"].includes(o.value)) ||
    new Set(action.selected_options.map((o: any) => o.value)).size !== action.selected_options.length
  )
    throw new Error("invalid marks");
  return {
    done: action.selected_options.some((o: any) => o.value === "done"),
    important: action.selected_options.some((o: any) => o.value === "important"),
    actionTs: action.action_ts,
  };
}

export function briefingCardMessage(
  input: BriefingInput,
  marks: BriefingMarks = { done: false, important: false, actionTs: "0.000000" },
) {
  const card = parseBriefingInput(input);
  const status = `${marks.done ? "✅ Klar" : "☐ Kvar"}${marks.important ? " · ⭐ Viktig" : ""}`;
  const selected = markOptions.filter((o) => (o.value === "done" ? marks.done : marks.important));
  return {
    text: `${status}\n${card.title}\n${card.summary}\n${card.sourceUrl}\nSvara i tråden för att diskutera.`,
    blocks: [
      { type: "header", block_id: "briefing_title", text: { type: "plain_text", text: card.title } },
      { type: "section", block_id: "briefing_summary", text: { type: "plain_text", text: card.summary } },
      { type: "context", block_id: "briefing_status", elements: [{ type: "plain_text", text: status }] },
      {
        type: "actions",
        block_id: `briefing_marks:${marks.actionTs}`,
        elements: [
          {
            type: "checkboxes",
            action_id: "briefing_marks",
            options: markOptions,
            ...(selected.length ? { initial_options: selected } : {}),
          },
        ],
      },
      {
        type: "actions",
        block_id: "briefing_actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Öppna källa" },
            url: card.sourceUrl,
            action_id: "briefing_source",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Skriv utkast" },
            action_id: "briefing_draft",
            value: "draft",
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "plain_text",
            text: "Markeringarna gäller bara här i Slack. Svara i tråden för att diskutera. Morgondagens brief läser källorna på nytt.",
          },
        ],
      },
    ],
  };
}

export function briefingInputFromMessage(message: { blocks?: any[] }): BriefingInput {
  const blocks = message.blocks ?? [];
  const title = blocks.find((b) => b.block_id === "briefing_title")?.text;
  const summary = blocks.find((b) => b.block_id === "briefing_summary")?.text;
  const actions = blocks.find((b) => b.block_id === "briefing_actions")?.elements;
  if (
    title?.type !== "plain_text" ||
    summary?.type !== "plain_text" ||
    !Array.isArray(actions) ||
    !actions.some((a) => a.action_id === "briefing_draft")
  )
    throw new Error("not a briefing card");
  return parseBriefingInput({
    title: title.text,
    summary: summary.text,
    sourceUrl: actions.find((a) => a.action_id === "briefing_source")?.url,
  });
}
