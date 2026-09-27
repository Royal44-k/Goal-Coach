const ISO_NOW =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export type ParsedCalendarNow = {
  instant: number;
  offsetMinutes: number;
};

export function parseCalendarNow(now: string): ParsedCalendarNow {
  const match = ISO_NOW.exec(now);
  if (!match) {
    throw new RangeError("now must be a valid ISO date-time with an explicit offset");
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59
  ) {
    throw new RangeError("now must be a valid ISO date-time with an explicit offset");
  }

  const instant = Date.parse(now);
  if (Number.isNaN(instant)) {
    throw new RangeError("now must be a valid ISO date-time with an explicit offset");
  }

  if (offset === "Z") {
    return { instant, offsetMinutes: 0 };
  }

  const sign = offset[0] === "+" ? 1 : -1;
  return {
    instant,
    offsetMinutes: sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))),
  };
}

export function calendarDayEndInstant(day: string, offsetMinutes: number): number {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date, 23, 59, 59, 999) - offsetMinutes * 60_000;
}
