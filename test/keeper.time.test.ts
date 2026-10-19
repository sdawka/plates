import { describe, expect, it } from "vitest";
import {
  isWorkingDay,
  localDayKey,
  localParts,
  nextLocalTime,
  startOfNextWorkingDay,
  zonedTimeToUtc,
} from "../src/keeper/time";

const NY = "America/New_York";
const KOLKATA = "Asia/Kolkata";
const iso = (s: string) => Date.parse(s);

describe("zonedTimeToUtc", () => {
  it("handles winter and summer offsets", () => {
    expect(zonedTimeToUtc(2026, 1, 15, 9, 0, NY)).toBe(iso("2026-01-15T14:00:00Z"));
    expect(zonedTimeToUtc(2026, 7, 15, 9, 0, NY)).toBe(iso("2026-07-15T13:00:00Z"));
  });

  it("handles the half-hour Kolkata offset", () => {
    expect(zonedTimeToUtc(2026, 10, 19, 9, 0, KOLKATA)).toBe(iso("2026-10-19T03:30:00Z"));
  });

  it("pushes a nonexistent spring-forward time past the gap", () => {
    const t = zonedTimeToUtc(2026, 3, 8, 2, 30, NY);
    expect(t).toBe(iso("2026-03-08T07:30:00Z"));
    expect(localParts(t, NY).hour).toBe(3);
  });

  it("uses the first occurrence in a fall-back overlap", () => {
    expect(zonedTimeToUtc(2026, 11, 1, 1, 30, NY)).toBe(iso("2026-11-01T05:30:00Z"));
  });
});

describe("working days and day keys", () => {
  it("evaluates the weekday in the given zone", () => {
    const t = iso("2026-10-17T22:00:00Z"); // Saturday UTC, still Saturday in NY, Sunday in Kolkata
    expect(isWorkingDay(t, NY)).toBe(false);
    const fri = iso("2026-10-16T22:00:00Z"); // Friday NY, Saturday 03:30 Kolkata
    expect(isWorkingDay(fri, NY)).toBe(true);
    expect(isWorkingDay(fri, KOLKATA)).toBe(false);
  });

  it("builds a local day key", () => {
    expect(localDayKey(iso("2026-10-16T22:00:00Z"), KOLKATA)).toBe("2026-10-17");
    expect(localDayKey(iso("2026-10-16T22:00:00Z"), NY)).toBe("2026-10-16");
  });
});

describe("nextLocalTime", () => {
  it("returns later today when the time has not passed", () => {
    const now = iso("2026-10-19T10:00:00Z"); // Mon 06:00 NY
    expect(nextLocalTime(now, NY, "09:00", true)).toBe(iso("2026-10-19T13:00:00Z"));
  });

  it("rolls to tomorrow when the time has passed, strictly after now", () => {
    const at = iso("2026-10-19T13:00:00Z");
    expect(nextLocalTime(at, NY, "09:00", true)).toBe(iso("2026-10-20T13:00:00Z"));
  });

  it("rolls Friday to Monday for working days only", () => {
    const fri = iso("2026-10-16T20:00:00Z"); // Fri 16:00 NY
    expect(nextLocalTime(fri, NY, "09:00", true)).toBe(iso("2026-10-19T13:00:00Z"));
    expect(nextLocalTime(fri, NY, "09:00", false)).toBe(iso("2026-10-17T13:00:00Z"));
  });

  it("keeps wall time across the November fall-back", () => {
    const now = iso("2026-10-31T20:00:00Z"); // Sat before the change
    expect(nextLocalTime(now, NY, "09:00", false)).toBe(iso("2026-11-01T14:00:00Z")); // EST now
    expect(nextLocalTime(now, NY, "09:00", true)).toBe(iso("2026-11-02T14:00:00Z"));
  });

  it("keeps wall time across the March spring-forward", () => {
    const now = iso("2026-03-07T20:00:00Z");
    expect(nextLocalTime(now, NY, "09:00", false)).toBe(iso("2026-03-08T13:00:00Z")); // EDT
  });

  it("works in Kolkata", () => {
    const now = iso("2026-10-19T04:00:00Z"); // 09:30 IST Monday
    expect(nextLocalTime(now, KOLKATA, "09:00", true)).toBe(iso("2026-10-20T03:30:00Z"));
  });
});

describe("startOfNextWorkingDay", () => {
  it("is the next morning on a weekday", () => {
    expect(startOfNextWorkingDay(iso("2026-10-19T15:00:00Z"), NY, 9)).toBe(iso("2026-10-20T13:00:00Z"));
  });

  it("skips the weekend from Friday", () => {
    expect(startOfNextWorkingDay(iso("2026-10-16T20:00:00Z"), NY, 9)).toBe(iso("2026-10-19T13:00:00Z"));
  });

  it("skips the weekend from Saturday and Sunday", () => {
    expect(startOfNextWorkingDay(iso("2026-10-17T15:00:00Z"), NY, 9)).toBe(iso("2026-10-19T13:00:00Z"));
    expect(startOfNextWorkingDay(iso("2026-10-18T15:00:00Z"), NY, 9)).toBe(iso("2026-10-19T13:00:00Z"));
  });

  it("uses the local day, not the UTC day", () => {
    // Fri 23:00 NY is already Saturday UTC; next working day is still Monday.
    expect(startOfNextWorkingDay(iso("2026-10-17T03:00:00Z"), NY, 9)).toBe(iso("2026-10-19T13:00:00Z"));
  });

  it("handles DST in the result", () => {
    expect(startOfNextWorkingDay(iso("2026-10-30T20:00:00Z"), NY, 9)).toBe(iso("2026-11-02T14:00:00Z"));
  });
});
