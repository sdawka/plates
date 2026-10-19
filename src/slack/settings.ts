// Pure settings modal builder and submission parser (timezone, digest time, working hours, reminder cap).

import type { UserPrefsRow } from "../types";
import { SETTINGS_CALLBACK_ID } from "./actions";
import type { Block } from "./blocks";
import { dmAccessBlocks, type DmAccess } from "./dmaccess";
import type { InputValue, ParseResult, ViewValues } from "./modals";

export const SETTINGS_MIN_CAP = 1;
export const SETTINGS_MAX_CAP = 20;

const plain = (text: string) => ({ type: "plain_text", text, emoji: true });
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
const hourOption = (h: number) => ({ text: plain(hourLabel(h)), value: String(h) });
const fail = (block: string, msg: string): { ok: false; errors: Record<string, string> } => ({ ok: false, errors: { [block]: msg } });
const val = (values: ViewValues, id: string): InputValue | undefined => values[id]?.["v"];

function input(id: string, label: string, element: Block, hint?: string): Block {
  return {
    type: "input", block_id: id, optional: false, label: plain(label),
    ...(hint ? { hint: plain(hint) } : {}),
    element: { ...element, action_id: "v" },
  };
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

/** `tz` is the zone to prefill: the saved one, or the user's Slack profile zone when nothing is saved. */
export function buildSettingsModal(prefs: UserPrefsRow, tz: string, dm?: DmAccess): Block {
  const starts = Array.from({ length: 24 }, (_, h) => h);
  const ends = Array.from({ length: 24 }, (_, i) => i + 1);
  return {
    type: "modal",
    callback_id: SETTINGS_CALLBACK_ID,
    title: plain("Plates settings"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      input("tz", "Time zone", { type: "plain_text_input", initial_value: tz, placeholder: plain("e.g. Europe/Berlin") }, "IANA name, used for deadlines, digests and reminders."),
      input("digest", "Daily digest time", { type: "timepicker", initial_time: prefs.digest_time, placeholder: plain("Select time") }, "In your time zone."),
      input("start", "Working hours start", { type: "static_select", options: starts.map(hourOption), initial_option: hourOption(prefs.work_start_hour) }),
      input("end", "Working hours end", { type: "static_select", options: ends.map(hourOption), initial_option: hourOption(prefs.work_end_hour) }, "Reminders only arrive within working hours."),
      input(
        "cap",
        "Daily reminder limit",
        { type: "number_input", is_decimal_allowed: false, min_value: String(SETTINGS_MIN_CAP), max_value: String(SETTINGS_MAX_CAP), initial_value: String(prefs.max_reminders_per_day) },
        "Reminders over the limit wait for your digest.",
      ),
      ...dmAccessBlocks(dm),
    ],
  };
}

/** Merges the submitted values into `prev`, keeping the reminder counters and last digest time. */
export function parseSettingsSubmission(values: ViewValues, prev: UserPrefsRow): ParseResult<UserPrefsRow> {
  const tz = (val(values, "tz")?.value ?? "").trim();
  if (!isValidTz(tz)) return fail("tz", "Enter a valid time zone name, like Europe/Berlin or America/New_York.");

  const digest = val(values, "digest")?.selected_time ?? "";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(digest)) return fail("digest", "Pick a time for the digest.");

  const start = Number(val(values, "start")?.selected_option?.value);
  const end = Number(val(values, "end")?.selected_option?.value);
  if (!Number.isInteger(start) || start < 0 || start > 23) return fail("start", "Pick when your day starts.");
  if (!Number.isInteger(end) || end < 1 || end > 24) return fail("end", "Pick when your day ends.");
  if (end <= start) return fail("end", "Your day has to end after it starts.");

  const rawCap = (val(values, "cap")?.value ?? "").trim();
  const cap = /^\d+$/.test(rawCap) ? Number(rawCap) : NaN;
  if (!(cap >= SETTINGS_MIN_CAP && cap <= SETTINGS_MAX_CAP)) {
    return fail("cap", `Enter a whole number from ${SETTINGS_MIN_CAP} to ${SETTINGS_MAX_CAP}.`);
  }

  return { ok: true, value: { ...prev, tz, digest_time: digest, work_start_hour: start, work_end_hour: end, max_reminders_per_day: cap } };
}
