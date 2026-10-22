import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

// Pi has no typed rate-limit error: `stopReason` is only "error" and the text is the sole
// carrier. pi-claude-bridge leads with "Claude quota exceeded — rate limit", and Claude Code's
// own wording ("You've hit your session limit", "out of extra usage") follows it.
const LIMIT_PATTERN =
  /\b(?:rate[ -]limit|quota exceeded|usage limit|hit your (?:\w+ )?limit|out of extra usage|429)\b/i;

// Claude Code names the reset in its own zone, e.g. "resets 7:50pm (America/Bogota)" or
// "resets Oct 25, 9am (America/Bogota)". The bridge's "resets 7:50:00 PM" carries no zone.
const RESET_PATTERN =
  /resets\s+(?:([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*\(([^()\s]+)\)/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Whether a Pi model error is a usage or rate limit, with the instant it resets when the
 * message names one. Undefined for any other error.
 */
export function piUsageLimit(
  message: string,
  failedAt: DateTime.DateTime,
): { readonly resetAt?: string } | undefined {
  if (!LIMIT_PATTERN.test(message)) return undefined;
  const resetAt = resetInstant(message, failedAt);
  return resetAt === undefined ? {} : { resetAt };
}

function resetInstant(message: string, failedAt: DateTime.DateTime) {
  const match = RESET_PATTERN.exec(message);
  if (match === null) return undefined;
  const [, monthName, day, hour, minute, meridiem, zoneId] = match;
  if (hour === undefined || meridiem === undefined || zoneId === undefined) return undefined;
  const zone = Option.getOrUndefined(DateTime.zoneMakeNamed(zoneId));
  if (zone === undefined) return undefined;
  const monthIndex = monthName === undefined ? undefined : MONTHS.indexOf(monthName.toLowerCase());
  if (monthIndex === -1) return undefined;
  const hour12 = Number(hour) % 12;
  const reset = DateTime.setParts(DateTime.setZone(failedAt, zone), {
    ...(monthIndex === undefined ? {} : { month: monthIndex + 1, day: Number(day) }),
    hour: meridiem.toLowerCase() === "pm" ? hour12 + 12 : hour12,
    minute: Number(minute ?? 0),
    second: 0,
    millisecond: 0,
  });
  // The message names the next occurrence, so a time already past means the next day, or
  // the next year for a named date.
  const next = DateTime.isGreaterThan(reset, failedAt)
    ? reset
    : DateTime.add(reset, monthIndex === undefined ? { days: 1 } : { years: 1 });
  return DateTime.formatIso(DateTime.toUtc(next));
}
