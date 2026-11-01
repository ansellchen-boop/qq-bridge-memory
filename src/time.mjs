// 时间解析与格式化。工具入参里的「2h / 3d / 2026-10-30」都过这里。
//
// 两个语义必须分开，不能一个函数糊过去（实测过两种错法都真出过）：
//   since=2026-09-30 → 本地当天 00:00:00.000
//   until=2026-09-30 → 本地当天 23:59:59.999
// 只写 Date.parse('2026-09-30') 会得到 UTC 零点 = 北京时间 08:00，
// 模型问「9 月 30 号聊了什么」就把当天前 8 小时漏掉。
// 非法输入一律抛错，绝不能返回 null —— null 在调用方等于「不限时间」，
// 悄悄把一次查一天变成查全部历史。

const REL = /^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/i;
const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/**
 * @param {*} v 入参原值
 * @param {boolean} endOfDay 纯日期时取当天最后一毫秒（until 用）
 * @returns {number|null} null = 没给；给了但看不懂 → 抛错
 */
function parseBound(v, endOfDay) {
  if (v == null || v === '') return null;
  const s = String(v).trim();

  const rel = REL.exec(s);
  if (rel) return Date.now() - Number(rel[1]) * UNIT[rel[2].toLowerCase()];

  const ymd = YMD.exec(s);
  if (ymd) {
    const [y, mo, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
    const dt = endOfDay ? new Date(y, mo - 1, d, 23, 59, 59, 999) : new Date(y, mo - 1, d, 0, 0, 0, 0);
    // 2026-02-30 这种会被 Date 悄悄滚到下个月，校验回来
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
      throw new Error(`日期不存在：${s}`);
    }
    return dt.getTime();
  }

  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  throw new Error(`时间格式看不懂：${s}（可用 30m / 2h / 3d / 1w / 2026-10-30）`);
}

/** 时间下限。纯日期 = 当天 00:00。解析不了抛错。 */
export function parseSince(v) {
  return parseBound(v, false);
}

/** 时间上限。纯日期 = 当天 23:59:59.999。解析不了抛错。 */
export function parseUntil(v) {
  return parseBound(v, true);
}

/** epoch ms → "2026-10-30 21:14"（本地时区）。 */
export function fmtTime(ms) {
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
