// Renders RULES as a Markdown page with a Mermaid diagram and a table, so the state machine
// can be read without the code. `npm run diagram` writes docs/state-machine.md; a test keeps it in sync.

import { RULES, STATE_GRAPH, type ActionKind } from "./transitions";

export function renderStateDiagram(): string {
  const lines = ["stateDiagram-v2", "  [*] --> proposed: confirmed"];
  const seen = new Set<string>();
  for (const e of STATE_GRAPH) {
    if (e.to === "unchanged") continue;
    const to = e.to === "pre_snooze" ? "accepted" : e.to;
    const label = e.to === "pre_snooze" ? `${e.action} (back to where it was)` : e.action;
    const key = `${e.from}>${to}>${label}>${e.by}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  ${e.from} --> ${to}: ${label} (${e.by})`);
  }
  lines.push("  closed --> [*]", "  withdrawn --> [*]");

  const rows = (Object.keys(RULES) as ActionKind[]).map((kind) => {
    const r = RULES[kind];
    const who = Object.entries(r.from).map(([role, states]) => `${role}: ${states.join(", ")}`).join("<br>");
    return `| \`${kind}\` | ${who} | ${r.to === "unchanged" ? "(same state)" : r.to === "pre_snooze" ? "state before the snooze" : r.to} |`;
  });

  return [
    "# Ask state machine",
    "",
    "Generated from `RULES` in `src/domain/transitions.ts` by `npm run diagram`. Do not edit by hand.",
    "",
    "Owner's plate: proposed, in_progress, accepted, snoozed. Requester's plate: delivered, rejected, clarify. Ended: closed, withdrawn.",
    "",
    "```mermaid",
    ...lines,
    "```",
    "",
    "| Action | Who, from which states | Lands in |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
