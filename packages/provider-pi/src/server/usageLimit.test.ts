import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { piUsageLimit } from "./usageLimit.ts";

const failedAt = DateTime.makeUnsafe("2026-10-21T21:00:00Z");

describe("piUsageLimit", () => {
  it("resumes a Claude session limit at the next reset in Claude's own time zone", () => {
    expect(
      piUsageLimit(
        "Claude quota exceeded — rate limit (five_hour) — resets 7:50:00 PM: You've hit your session limit · resets 7:50pm (America/Bogota)",
        failedAt,
      ),
    ).toEqual({ resetAt: "2026-10-22T00:50:00.000Z" });
  });

  it("rolls a reset time that already passed today over to tomorrow", () => {
    expect(
      piUsageLimit("You've hit your session limit · resets 3pm (America/Bogota)", failedAt),
    ).toEqual({ resetAt: "2026-10-22T20:00:00.000Z" });
  });

  it("uses the date Claude names for a weekly limit", () => {
    expect(
      piUsageLimit("You've hit your weekly limit · resets Oct 25, 9am (America/Bogota)", failedAt),
    ).toEqual({ resetAt: "2026-10-25T14:00:00.000Z" });
  });

  it("reports a limit without a reset time when the message names no time zone", () => {
    expect(piUsageLimit("429 rate limit exceeded", failedAt)).toEqual({});
  });

  it("leaves other model errors alone", () => {
    expect(piUsageLimit("529 overloaded", failedAt)).toBeUndefined();
    expect(piUsageLimit("Prompt is too long", failedAt)).toBeUndefined();
  });
});
