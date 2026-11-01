// 增量采集：读 /root/qq-bridge/state/social-v2.json 的 recentMessages 入库。
//
// 为什么要轮询：recentMessages 只有最近 60 条，滚动丢弃；不等它丢就得勤采。
// 竞态处理：bridge 正在写时可能读到半截 JSON —— 解析失败当作「本轮没数据」，
// 不报错、不动游标，下一轮再来。
//
// 漏采检测：每个 scope 记最后入库的 seq；下一轮如果最小 seq 比它大 1 以上，
// 说明中间漏了（轮询间隔内聊太多），记进 gaps 让人知道。不静默。

import { readFileSync } from 'node:fs';
import { insertMessages, getCursor, setCursor, recordGap } from './db.mjs';

export const DEFAULT_SOCIAL_JSON = '/root/qq-bridge/state/social-v2.json';

/** 安全读 social-v2.json。解析失败返回 null（半截文件/不存在都算）。 */
export function readSocialState(path = DEFAULT_SOCIAL_JSON) {
  try {
    const raw = readFileSync(path, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !j.conversations) return null;
    return j;
  } catch {
    return null;
  }
}

/**
 * 采集一次。
 * @returns {{scopes: object[], gaps: object[], totalInserted: number, readOk: boolean}}
 */
export function collectOnce(db, { path = DEFAULT_SOCIAL_JSON } = {}) {
  const state = readSocialState(path);
  if (!state) return { scopes: [], gaps: [], totalInserted: 0, readOk: false };

  const scopes = [];
  const gaps = [];
  let totalInserted = 0;

  for (const [scope, conv] of Object.entries(state.conversations || {})) {
    const msgs = Array.isArray(conv?.recentMessages) ? conv.recentMessages : [];
    if (!msgs.length) { scopes.push({ scope, fetched: 0, inserted: 0 }); continue; }

    // 漏采检测：拿本次最小 seq 对比上次游标
    const seqs = msgs.map((m) => Number(m.seq)).filter((n) => Number.isFinite(n));
    const minSeq = seqs.length ? Math.min(...seqs) : null;
    const maxSeq = seqs.length ? Math.max(...seqs) : null;
    const lastSeq = Number(getCursor(db, `seq:${scope}`));

    if (minSeq != null && Number.isFinite(lastSeq) && lastSeq > 0 && minSeq > lastSeq + 1) {
      const gap = { scope, from: lastSeq + 1, to: minSeq - 1, missing: minSeq - 1 - lastSeq };
      gaps.push(gap);
      recordGap(db, gap);
    }

    const r = insertMessages(db, scope, msgs, 'collect');
    totalInserted += r.inserted;

    if (maxSeq != null) setCursor(db, `seq:${scope}`, Math.max(maxSeq, Number.isFinite(lastSeq) ? lastSeq : 0));
    setCursor(db, `collectedAt:${scope}`, Date.now());

    scopes.push({ scope, fetched: msgs.length, inserted: r.inserted, skipped: r.skipped, minSeq, maxSeq });
  }

  return { scopes, gaps, totalInserted, readOk: true };
}
