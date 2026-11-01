// 历史回填：从 dsh session 归档里抠出群聊/私聊原话。
//
// 归档格式（实测）：/root/.dsh/sessions/<agent-dir>/session-<id>/session.v4.jsonl.zstd
// 每行一个事件。type == "user/message" 的文本里含一段：
//   【本次消息快照】
//   {"messages":[{seq,messageId,sender,userId,text,plain,time,...}],"recent":[...]}
// 这两组数组是桥接喂进去的原始消息副本 —— 历史回填的唯一来源。
//
// scope 归属不靠猜：从 /root/qq-bridge/state/sessions.json 反查 sessionId → scope；
// 查不到就跳过并计入 unresolved（宁可漏，不许错标）。

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { insertMessages } from './db.mjs';

const DEFAULT_AGENT_DIR = '/root/.dsh/sessions/--root-qq-bridge-state-agents--';
const DEFAULT_SESSIONS_JSON = '/root/qq-bridge/state/sessions.json';
const SNAPSHOT_MARK = '【本次消息快照】';

// 10-22 之后 bridge 换了喂法：消息不再写进 prompt 快照，而是走工具返回。
//   mcp__snowluma__qq_wait_for_messages / qq_get_unread_messages → {"ok":true,"key":"group:x","messages":[...]}
// 所以回填有两个数据源，缺一个就会断档（实测：只认快照只到 10-22，之后 9 天全空）。
const TOOL_MSG_RE = /(?:wait_for_messages|get_unread_messages)$/;

/** 工具返回里的消息没有绝对时间，只有 "at":"20:35" / "ago":"52m" —— 用事件时间推。 */
export function deriveTime(m, eventMs) {
  const ago = /^(\d+)\s*(m|h|d)$/i.exec(String(m.ago || '').trim());
  if (ago) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[ago[2].toLowerCase()];
    return eventMs - Number(ago[1]) * unit;
  }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(String(m.at || '').trim());
  if (hm) {
    const d = new Date(eventMs);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    // "at" 比事件时刻晚了 → 那是昨天的这个点
    if (d.getTime() > eventMs + 60_000) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  return eventMs;
}

/**
 * 消息时间：自带的绝对时间优先，只有 at/ago 才用事件时间反推。
 * 绝不能无条件 deriveTime —— 实测 6006 条工具线消息里 4781 条自带 time，
 * 无脑覆盖会让 1735 条偏 >1 分钟、181 条偏 >1 小时（最大 10.96 小时）。
 */
export function resolveMsgTime(m, eventMs) {
  const abs = Number(m.time || m.sent_at || 0);
  if (Number.isFinite(abs) && abs > 0) return abs;
  return deriveTime(m, eventMs);
}

/** 从一个工具返回文本里抠消息数组。不是消息工具 / 解析失败返回 null。 */
export function parseToolMessages(text, eventMs) {
  const s = String(text || '').trim();
  if (!s.startsWith('{')) return null;
  let j;
  try { j = JSON.parse(s); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const key = typeof j.key === 'string' ? j.key : null;
  const arr = Array.isArray(j.messages) ? j.messages : (Array.isArray(j.newMessages) ? j.newMessages : null);
  if (!arr || !arr.length || !key) return null;
  return { scope: key, msgs: arr.map((m) => ({ ...m, time: resolveMsgTime(m, eventMs) })) };
}

/** 从文本里抠出 【本次消息快照】 后面的 JSON 对象。用括号配平，容忍后面还有别的段落。 */
export function extractSnapshotJson(text) {
  const i = text.indexOf(SNAPSHOT_MARK);
  if (i < 0) return null;
  const start = text.indexOf('{', i + SNAPSHOT_MARK.length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let p = start; p < text.length; p++) {
    const c = text[p];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const raw = text.slice(start, p + 1);
        try { return JSON.parse(raw); } catch { return null; }
      }
    }
  }
  return null;
}

/** 读 sessions.json，返回 { sessionId: scope }。读不到返回空表（不抛）。 */
export function loadScopeMap(sessionsJson = DEFAULT_SESSIONS_JSON) {
  try {
    const j = JSON.parse(readFileSync(sessionsJson, 'utf8'));
    const out = {};
    for (const [scope, sid] of Object.entries(j.sessions || {})) out[sid] = scope;
    return out;
  } catch {
    return {};
  }
}

/** 列出 agent 目录下所有 session 归档。 */
export function listArchives(agentDir = DEFAULT_AGENT_DIR) {
  if (!existsSync(agentDir)) return [];
  return readdirSync(agentDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('session-'))
    .map((d) => {
      const file = join(agentDir, d.name, 'session.v4.jsonl.zstd');
      return { sessionId: d.name, dir: join(agentDir, d.name), file, exists: existsSync(file) };
    })
    .filter((a) => a.exists);
}

/** 流式解压 + 逐行回调。zstd 不存在会 reject。回调抛错只计数不吞掉统计。 */
function streamLines(zstdPath, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('zstd', ['-dc', zstdPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let lineErrors = 0;
    let lastError = '';
    child.stderr.on('data', (b) => { err += b.toString().slice(0, 2000); });
    child.on('error', reject);
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      try {
        onLine(line);
      } catch (e) {
        // 单行坏不拖垮整文件，但要报出去 —— 写库失败也走这里，静默吞掉等于骗人
        lineErrors++;
        if (!lastError) lastError = String(e?.message || e);
      }
    });
    child.on('close', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`zstd 退出码 ${code}: ${err.slice(0, 300)}`));
      else resolve({ lineErrors, lastError });
    });
  });
}

/**
 * 回填一个归档。两个数据源都扫：
 *   1) user/message 里的【本次消息快照】 —— 9/30–10/22 的老机制
 *   2) tool/result 里 qq_wait_for_messages / qq_get_unread_messages 的返回 —— 10/22 之后
 * scope 参数只用于数据源 1（快照本身不带 scope）；数据源 2 自带 key，以它为准。
 * @returns {{sessionId, scope, lines, snapshots, raw, inserted, skipped, invalid, toolBatches, toolMessages, toolInserted, toolInvalid}}
 */
export async function backfillArchive(db, archive, scope, { onProgress = null } = {}) {
  let lines = 0;
  let snapshots = 0;
  let raw = 0;
  let inserted = 0;
  let skipped = 0;
  let invalid = 0;
  let toolBatches = 0;
  let toolMessages = 0;
  let toolInserted = 0;
  let toolInvalid = 0;
  const callNames = new Map();

  let lineErrors = 0;
  let lastError = '';

  const streamed = await streamLines(archive.file, (line) => {
    lines++;
    // 快路径：跟这两个类型无关的行直接跳
    const maybeUser = line.includes('"user/message"');
    const maybeTool = line.includes('"tool/call"') || line.includes('"tool/result"');
    if (!maybeUser && !maybeTool) return;

    let evt;
    try { evt = JSON.parse(line); } catch { return; }

    if (evt.type === 'tool/call') {
      const d = evt.data || {};
      if (d.callId) {
        callNames.set(d.callId, String(d.name || ''));
        if (callNames.size > 4000) callNames.delete(callNames.keys().next().value);
      }
      return;
    }

    if (evt.type === 'tool/result') {
      const msg = evt.data?.message;
      const cid = msg?.toolCallId;
      const name = cid ? callNames.get(cid) : null;
      if (!name || !TOOL_MSG_RE.test(name)) return;
      if (msg?.isError) return;
      const text = (msg.content || []).filter((c) => c?.type === 'text').map((c) => c.text || '').join('');
      const parsed = parseToolMessages(text, Number(evt.time) || 0);
      if (!parsed) return;
      toolBatches++;
      toolMessages += parsed.msgs.length;
      const r = insertMessages(db, parsed.scope, parsed.msgs, 'backfill-tool');
      toolInserted += r.inserted;
      toolInvalid += r.invalid;
      if (onProgress && toolBatches % 100 === 0) {
        onProgress({ sessionId: archive.sessionId, snapshots, inserted, toolBatches, toolInserted });
      }
      return;
    }

    if (evt.type !== 'user/message') return;
    if (!scope) return;
    const text = (evt.data?.content || [])
      .filter((c) => c?.type === 'text')
      .map((c) => c.text || '')
      .join('');
    if (!text.includes(SNAPSHOT_MARK)) return;
    const snap = extractSnapshotJson(text);
    if (!snap) return;
    snapshots++;
    const evtMs = Number(evt.time) || 0;
    // 快照里也有不带 time 的消息（实测 1674/4916 条只有 at/ago），用事件时间兜底推
    const batch = [...(snap.messages || []), ...(snap.recent || [])].map((m) => ({
      ...m,
      time: resolveMsgTime(m, evtMs),
    }));
    raw += batch.length;
    const r = insertMessages(db, scope, batch, 'backfill');
    inserted += r.inserted;
    skipped += r.skipped;
    invalid += r.invalid;
    if (onProgress && snapshots % 100 === 0) onProgress({ sessionId: archive.sessionId, snapshots, inserted, toolBatches, toolInserted });
  });

  return {
    sessionId: archive.sessionId, scope, lines,
    snapshots, raw, inserted, skipped, invalid,
    toolBatches, toolMessages, toolInserted, toolInvalid,
    lineErrors: streamed.lineErrors, lastError: streamed.lastError,
  };
}

/**
 * 全量回填。
 * scope 查不到的 session 也会扫 —— 工具返回自带 scope，不依赖映射表；
 * 只是它的 prompt 快照那部分（老机制）没法归属，记进 noSnapshotScope 报告出来，不猜。
 * @param {object} opts {agentDir, sessionsJson, scopeMap: {sessionId: scope}, only?: string}
 */
export async function backfillAll(db, opts = {}) {
  const agentDir = opts.agentDir || DEFAULT_AGENT_DIR;
  const scopeMap = { ...loadScopeMap(opts.sessionsJson), ...(opts.scopeMap || {}) };
  const archives = listArchives(agentDir);
  const done = [];
  const noSnapshotScope = [];
  for (const a of archives) {
    if (opts.only && !a.sessionId.includes(opts.only)) continue;
    const scope = scopeMap[a.sessionId] || null;
    if (!scope) noSnapshotScope.push(a.sessionId);
    done.push(await backfillArchive(db, a, scope, { onProgress: opts.onProgress }));
  }
  return { done, noSnapshotScope };
}
