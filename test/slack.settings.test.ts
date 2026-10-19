import { describe, expect, it } from "vitest";
import { SETTINGS_CALLBACK_ID } from "../src/slack/actions";
import { buildSettingsModal, parseSettingsSubmission } from "../src/slack/settings";
import type { ViewValues } from "../src/slack/modals";
import type { UserPrefsRow } from "../src/types";

const prev: UserPrefsRow = {
  user_id: "U1", tz: "UTC", work_start_hour: 9, work_end_hour: 17, digest_time: "09:00", max_reminders_per_day: 5,
  last_digest_at: 123, updated_at: 5, reminders_day: "2026-10-21", reminders_sent: 3,
};
const values = (o: Partial<Record<"tz" | "digest" | "start" | "end" | "cap", Record<string, unknown>>> = {}): ViewValues => {
  const base = {
    tz: { value: "Europe/Berlin" },
    digest: { selected_time: "08:30" },
    start: { selected_option: { value: "8" } },
    end: { selected_option: { value: "18" } },
    cap: { value: "7" },
    ...o,
  };
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { v }])) as ViewValues;
};
const errors = (r: ReturnType<typeof parseSettingsSubmission>) => (r.ok ? null : r.errors);

describe("settings modal", () => {
  it("prefills the form and uses the settings callback id", () => {
    const view = buildSettingsModal(prev, "Asia/Tokyo") as { callback_id: string; blocks: Record<string, unknown>[] };
    expect(view.callback_id).toBe(SETTINGS_CALLBACK_ID);
    const byId = Object.fromEntries(view.blocks.map((b) => [b.block_id as string, b.element as Record<string, unknown>]));
    expect(Object.keys(byId)).toEqual(["tz", "digest", "start", "end", "cap"]);
    expect(byId.tz).toMatchObject({ type: "plain_text_input", initial_value: "Asia/Tokyo", action_id: "v" });
    expect(byId.digest).toMatchObject({ type: "timepicker", initial_time: "09:00" });
    expect(byId.start).toMatchObject({ type: "static_select", initial_option: { value: "9" } });
    expect(byId.end).toMatchObject({ initial_option: { value: "17" } });
    expect(byId.cap).toMatchObject({ type: "number_input", min_value: "1", max_value: "20", initial_value: "5", is_decimal_allowed: false });
  });
});

describe("parseSettingsSubmission", () => {
  it("merges into the previous prefs and keeps reminder counters", () => {
    const r = parseSettingsSubmission(values(), prev);
    expect(r).toEqual({
      ok: true,
      value: { ...prev, tz: "Europe/Berlin", digest_time: "08:30", work_start_hour: 8, work_end_hour: 18, max_reminders_per_day: 7 },
    });
  });
  it("validates the time zone", () => {
    expect(errors(parseSettingsSubmission(values({ tz: { value: "Mars/Olympus" } }), prev))).toHaveProperty("tz");
    expect(errors(parseSettingsSubmission(values({ tz: { value: "  " } }), prev))).toHaveProperty("tz");
  });
  it("needs a digest time", () => {
    expect(errors(parseSettingsSubmission(values({ digest: {} }), prev))).toHaveProperty("digest");
  });
  it("working hours must end after they start", () => {
    expect(errors(parseSettingsSubmission(values({ start: { selected_option: { value: "18" } }, end: { selected_option: { value: "9" } } }), prev))).toHaveProperty("end");
    expect(errors(parseSettingsSubmission(values({ end: { selected_option: { value: "24" } } }), prev))).toBeNull();
  });
  it("caps the daily reminder limit between 1 and 20", () => {
    for (const bad of ["0", "21", "-1", "2.5", "abc", ""]) {
      expect(errors(parseSettingsSubmission(values({ cap: { value: bad } }), prev))).toHaveProperty("cap");
    }
    for (const good of ["1", "20"]) expect(parseSettingsSubmission(values({ cap: { value: good } }), prev).ok).toBe(true);
  });
});
