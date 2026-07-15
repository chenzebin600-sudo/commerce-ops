const DATE_FORMATTERS = new Map();

function formatter(timeZone) {
  if (!DATE_FORMATTERS.has(timeZone)) {
    DATE_FORMATTERS.set(timeZone, new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }));
  }
  return DATE_FORMATTERS.get(timeZone);
}

export function assertTimeZone(timeZone) {
  const value = String(timeZone || "Asia/Shanghai");
  try {
    formatter(value).format(new Date());
  } catch {
    throw new Error(`不支持的时区：${value}`);
  }
  return value;
}

export function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(formatter(assertTimeZone(timeZone)).formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return parts;
}

function wallTimestamp(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
}

export function zonedDateTimeToUtc(parts, timeZone) {
  const desired = wallTimestamp(parts);
  let guess = desired;
  for (let index = 0; index < 4; index += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const difference = desired - wallTimestamp(actual);
    guess += difference;
    if (!difference) break;
  }
  return new Date(guess);
}

function dateValue(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function dateParts(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addDays(parts, amount) {
  return dateParts(new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount)));
}

function addMonths(parts, amount) {
  return dateParts(new Date(Date.UTC(parts.year, parts.month - 1 + amount, 1)));
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekday(parts) {
  const value = dateValue(parts.year, parts.month, parts.day).getUTCDay();
  return value === 0 ? 7 : value;
}

export function formatDateOnly(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function validateScheduleConfig(scheduleType, rawConfig = {}) {
  const type = ["daily", "weekly", "monthly"].includes(scheduleType) ? scheduleType : "";
  if (!type) throw new Error("执行周期必须是每日、每周或每月。");
  const hour = Number(rawConfig.hour);
  const minute = Number(rawConfig.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("执行时间无效。");
  }
  if (type === "daily") return { hour, minute };
  if (type === "weekly") {
    const weekdays = [...new Set((rawConfig.weekdays || []).map(Number))].filter((day) => Number.isInteger(day) && day >= 1 && day <= 7).sort();
    if (!weekdays.length) throw new Error("每周任务至少选择一个星期。");
    return { weekdays, hour, minute };
  }
  const day = rawConfig.day === "last" ? "last" : Number(rawConfig.day);
  if (day !== "last" && (!Number.isInteger(day) || day < 1 || day > 31)) throw new Error("每月执行日期无效。");
  return { day, monthEndFallback: rawConfig.monthEndFallback !== false, hour, minute };
}

export function nextRunAt({ scheduleType, scheduleConfig, timezone = "Asia/Shanghai" }, after = new Date()) {
  const zone = assertTimeZone(timezone);
  const config = validateScheduleConfig(scheduleType, scheduleConfig);
  const localNow = zonedParts(after, zone);
  let cursor = { year: localNow.year, month: localNow.month, day: localNow.day };
  for (let offset = 0; offset < 800; offset += 1) {
    if (offset) cursor = addDays(cursor, 1);
    let matches = scheduleType === "daily";
    if (scheduleType === "weekly") matches = config.weekdays.includes(weekday(cursor));
    if (scheduleType === "monthly") {
      const lastDay = daysInMonth(cursor.year, cursor.month);
      const target = config.day === "last" ? lastDay : Math.min(config.day, config.monthEndFallback ? lastDay : config.day);
      matches = target <= lastDay && cursor.day === target;
    }
    if (!matches) continue;
    const candidate = zonedDateTimeToUtc({ ...cursor, hour: config.hour, minute: config.minute, second: 0 }, zone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("无法计算下一次执行时间。");
}

export function validatePaymentDateConfig(mode, rawConfig = {}) {
  const supported = ["today", "yesterday", "last_7_days", "last_14_days", "last_30_days", "this_week", "previous_week", "this_month", "previous_month", "relative", "fixed"];
  if (!supported.includes(mode)) throw new Error("付款日期范围模式无效。");
  if (mode === "relative") {
    const startDaysAgo = Number(rawConfig.startDaysAgo);
    const endDaysAgo = Number(rawConfig.endDaysAgo);
    if (!Number.isInteger(startDaysAgo) || !Number.isInteger(endDaysAgo) || startDaysAgo < 0 || endDaysAgo < 0 || startDaysAgo < endDaysAgo) {
      throw new Error("自定义相对日期必须满足开始天数大于等于结束天数。");
    }
    return { startDaysAgo, endDaysAgo };
  }
  if (mode === "fixed") {
    const startDate = String(rawConfig.startDate || "");
    const endDate = String(rawConfig.endDate || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
      throw new Error("固定日期范围无效。");
    }
    return { startDate, endDate };
  }
  return {};
}

export function paymentDateRange(mode, rawConfig, executionTime, timezone = "Asia/Shanghai") {
  const config = validatePaymentDateConfig(mode, rawConfig);
  const local = zonedParts(executionTime, assertTimeZone(timezone));
  const today = { year: local.year, month: local.month, day: local.day };
  let start = today;
  let end = today;
  if (mode === "yesterday") start = end = addDays(today, -1);
  if (mode === "last_7_days") start = addDays(today, -6);
  if (mode === "last_14_days") start = addDays(today, -13);
  if (mode === "last_30_days") start = addDays(today, -29);
  if (mode === "this_week") start = addDays(today, 1 - weekday(today));
  if (mode === "previous_week") {
    const thisMonday = addDays(today, 1 - weekday(today));
    start = addDays(thisMonday, -7);
    end = addDays(thisMonday, -1);
  }
  if (mode === "this_month") start = { year: today.year, month: today.month, day: 1 };
  if (mode === "previous_month") {
    const previous = addMonths(today, -1);
    start = previous;
    end = { ...previous, day: daysInMonth(previous.year, previous.month) };
  }
  if (mode === "relative") {
    start = addDays(today, -config.startDaysAgo);
    end = addDays(today, -config.endDaysAgo);
  }
  if (mode === "fixed") return { startDate: config.startDate, endDate: config.endDate };
  return { startDate: formatDateOnly(start), endDate: formatDateOnly(end) };
}

export function retentionExpiresAt(retentionDays, from = new Date()) {
  if (retentionDays === null || retentionDays === "forever") return null;
  const days = Number(retentionDays);
  if (![7, 30, 90].includes(days)) throw new Error("文件保留天数必须是 7、30、90 或永久。 ");
  return new Date(from.getTime() + days * 86400000);
}

export function scheduleDescription(scheduleType, config) {
  const value = validateScheduleConfig(scheduleType, config);
  const time = `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
  if (scheduleType === "daily") return `每天 ${time}`;
  if (scheduleType === "weekly") return `每周 ${value.weekdays.join("、")} ${time}`;
  return value.day === "last" ? `每月最后一天 ${time}` : `每月 ${value.day} 日 ${time}`;
}
