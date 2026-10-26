// Builds the Clairic state strings and field sets for the two experiments: dates (from the intent cases
// that carry a deadline label) and threads (from eval/cases/extract.jsonl).
import { localDateInfo } from "../../src/extract/dates.ts";
import { nowOf, PEOPLE, tzOf, type ExtractCase, type IntentCase } from "../eval/cases.ts";
import type { ClairicField } from "./client.ts";

export const HORIZON_DAYS = 21; // Jev's choice list covers today + 21 days

const NAMES: Record<string, string> = Object.fromEntries(Object.entries(PEOPLE).map(([name, id]) => [id, name[0]!.toUpperCase() + name.slice(1)]));
export const mentionsToNames = (text: string): string => text.replace(/<@(U[A-Z0-9]+)>/g, (_, id: string) => (id === "UBOT" ? "@Plates" : NAMES[id] ? `@${NAMES[id]}` : `@${id}`));

export function today(c: { now?: string; tz?: string }): { date: string; weekday: string; tz: string } {
  const tz = tzOf(c);
  return { ...localDateInfo(nowOf(c), tz), tz };
}

export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Experiment A: one reply, one or more open asks; does Clairic read the date the reply names? */
export function dateState(c: IntentCase): string {
  const t = today(c);
  const speaker = PEOPLE[c.speaker];
  const role = c.asks.some((a) => PEOPLE[a.owner ?? "bob"] === speaker) ? "owner" : "requester";
  const asks = c.asks.map((a) => `Open ask: "${a.title}" (current deadline: ${a.deadline ?? "none"}).`);
  const text = c.text.trim() ? mentionsToNames(c.text) : "(no text)";
  return [`Today: ${t.weekday} ${t.date} (time zone ${t.tz}).`, ...asks, `Reply from the ${role}: ${text}`].join("\n");
}

export function dateFields(todayDate: string): Record<string, ClairicField> {
  return {
    due_date: { type: "date", instructions: "The calendar day the reply commits to or proposes for the ask. Null when the reply names no day. Relative words (tomorrow, Thursday, next Friday, end of the month, EOD) count from Today." },
    due_at: { type: "datetime", instructions: "When the ask will be done, as a date and time, if the reply says. EOD means 17:00 that day. Null when no day is named." },
    due_estimate: { type: "estimate", instructions: "Best estimate of the day the ask will be done, given the reply.", min: todayDate, max: addDays(todayDate, HORIZON_DAYS), step: 1 },
  };
}

/** Experiment B: a short thread; how many asks does it contain, and what are they? */
export function threadState(c: ExtractCase): string {
  const t = today(c);
  const lines = c.messages.map((m) => `${NAMES[PEOPLE[m.user]] ?? m.user}: ${mentionsToNames(m.text)}`);
  return [`Today: ${t.weekday} ${t.date} (time zone ${t.tz}).`, "Slack thread:", ...lines].join("\n");
}

export function threadFields(): Record<string, ClairicField> {
  return {
    ask_count: { type: "number", integer: true, instructions: "How many distinct things someone in the thread is asked to do, deliver, decide or acknowledge. 0 when nothing is asked." },
    asks: { type: "list", items: "text", instructions: "Each distinct thing someone is asked to do, as a short imperative phrase (e.g. \"Send the Q3 numbers\"). Empty when nothing is asked." },
    first_due: { type: "date", instructions: "The earliest deadline any ask in the thread names, as a calendar day counted from Today. Null when no deadline is named." },
  };
}
