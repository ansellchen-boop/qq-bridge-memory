// SQLite 存储层：schema、幂等写入、检索。
// 用 node:sqlite（Node ≥22 内置，远端 v24.21.0 实测 FTS5 可用，sqlite 3.53.4）。

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { bigram, cleanName, cleanText, classifyKind, toMatchExpr, needsLikeFallback } from './tokenize.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY,
  scope     TEXT    NOT NULL,
  message_id TEXT,
  seq       INTEGER,
  sender    TEXT    NOT NULL DEFAULT '',
  user_id   TEXT,
  text      TEXT    NOT NULL,
  kind      TEXT    NOT NULL DEFAULT 'text',
  is_self   INTEGER NOT NULL DEFAULT 0,
  sent_at   INTEGER NOT NULL,
  source    TEXT    NOT NULL,
  tokens    TEXT    NOT NULL,
  dedupe    TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_dedupe ON messages(dedupe);
CREATE INDEX IF NOT EXISTS ix_messages_scope_time ON messages(scope, sent_at);
CREATE INDEX IF NOT EXISTS ix_messages_time ON messages(sent_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  tokens,
  content='messages',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, tokens) VALUES (new.id, new.tokens);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, tokens) VALUES('delete', old.id, old.tokens);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, tokens) VALUES('delete', old.id, old.tokens);
  INSERT INTO messages_fts(rowid, tokens) VALUES (new.id, new.tokens);
END;

CREATE TABLE IF NOT EXISTS cursors (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 漏采台账：轮询间隔内聊太多会永久丢消息，必须留痕可查，不能只打一行日志。
CREATE TABLE IF NOT EXISTS gaps (
  id          INTEGER PRIMARY KEY,
  scope       TEXT    NOT NULL,
  seq_from    INTEGER NOT NULL,
  seq_to      INTEGER NOT NULL,
  missing     INTEGER NOT NULL,
  detected_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_gaps_scope ON gaps(scope, seq_from);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

function sha1(s) {
  return createHash('sha1').update(s).digest('hex');
}

/** 一条消息 → dedupe key。有 messageId 用它，否则用内容指纹。 */
export function dedupeKey(scope, m) {
  const mid = m.messageId != null ? String(m.messageId) : '';
  if (mid) return sha1(`${scope}|mid|${mid}`);
  const t = cleanText(m.text || m.plain || '');
  return sha1(`${scope}|fp|${m.time || m.sent_at || 0}|${cleanName(m.sender)}|${t}`);
}

/**
 * 幂等批量写入。返回 {inserted, skipped}。
 * 单条非法不拖垮整批：逐条 try，坏行计数。
 * @param {object[]} msgs 形状见 AGENTS.md「数据来源」
 */
export function insertMessages(db, scope, msgs, source) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages
      (scope, message_id, seq, sender, user_id, text, kind, is_self, sent_at, source, tokens, dedupe)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let inserted = 0;
  let invalid = 0;
  db.exec('BEGIN');
  try {
    for (const m of msgs) {
      try {
        const text = cleanText(m.plain || m.text || '');
        if (!text) { invalid++; continue; }
        const sentAt = Number(m.time || m.sent_at || 0);
        if (!Number.isFinite(sentAt) || sentAt <= 0) { invalid++; continue; }
        const sender = cleanName(m.sender) || (m.isSelf ? '我' : '');
        const kind = classifyKind(text, m.media);
        const res = stmt.run(
          scope,
          m.messageId != null ? String(m.messageId) : null,
          m.seq != null ? Number(m.seq) : null,
          sender,
          m.userId != null ? String(m.userId) : null,
          text,
          kind,
          m.isSelf ? 1 : 0,
          sentAt,
          source,
          bigram(text),
          dedupeKey(scope, { ...m, text }),
        );
        if (res.changes > 0) inserted++;
      } catch {
        invalid++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { inserted, skipped: msgs.length - inserted - invalid, invalid };
}

function scopeFilter(scope) {
  return scope ? ' AND m.scope = ?' : '';
}

function rowToHit(r) {
  return {
    id: r.id,
    scope: r.scope,
    sender: r.sender,
    userId: r.user_id,
    text: r.text,
    kind: r.kind,
    isSelf: r.is_self === 1,
    at: new Date(Number(r.sent_at)).toISOString(),
    ms: Number(r.sent_at),
  };
}

/**
 * 全文检索。query 走 bigram FTS；太短则 LIKE 兜底。
 * @returns {{hits:object[], mode:'fts'|'like', total:number}}
 */
export function search(db, { query, scope = null, sinceMs = null, untilMs = null, limit = 20, userId = null } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 20, 100));
  const params = [];
  let sql;
  let mode = 'fts';
  const expr = toMatchExpr(query);
  const useLike = needsLikeFallback(query);

  if (useLike || !expr) {
    mode = 'like';
    sql = `
      SELECT m.* FROM messages m
      WHERE m.text LIKE '%' || ? || '%'
        ${scopeFilter(scope)}
        ${sinceMs ? ' AND m.sent_at >= ?' : ''}
        ${untilMs ? ' AND m.sent_at <= ?' : ''}
        ${userId ? ' AND m.user_id = ?' : ''}
      ORDER BY m.sent_at DESC
      LIMIT ?
    `;
    params.push(cleanText(query));
    if (scope) params.push(scope);
    if (sinceMs) params.push(sinceMs);
    if (untilMs) params.push(untilMs);
    if (userId) params.push(userId);
    params.push(lim);
  } else {
    sql = `
      SELECT m.* FROM messages_fts f
      JOIN messages m ON m.id = f.rowid
      WHERE messages_fts MATCH ?
        ${scopeFilter(scope)}
        ${sinceMs ? ' AND m.sent_at >= ?' : ''}
        ${untilMs ? ' AND m.sent_at <= ?' : ''}
        ${userId ? ' AND m.user_id = ?' : ''}
      ORDER BY bm25(messages_fts), m.sent_at DESC
      LIMIT ?
    `;
    params.push(expr);
    if (scope) params.push(scope);
    if (sinceMs) params.push(sinceMs);
    if (untilMs) params.push(untilMs);
    if (userId) params.push(userId);
    params.push(lim);
  }
  const rows = db.prepare(sql).all(...params);
  return { hits: rows.map(rowToHit), mode, total: rows.length };
}

/**
 * 最近流水，按时间正序返回（方便模型顺着读）。
 * untilMs 必须下推到 SQL：先 LIMIT 再在内存里筛 until，
 * 会让「查某一天」在库里已有几百条更新消息时返回 0 条（实测 9-30 有 142 条却查出 0）。
 */
export function recent(db, { scope = null, sinceMs = null, untilMs = null, limit = 60, userId = null } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 60, 300));
  const params = [];
  let sql = `SELECT m.* FROM messages m WHERE 1=1`;
  if (scope) { sql += ' AND m.scope = ?'; params.push(scope); }
  if (sinceMs) { sql += ' AND m.sent_at >= ?'; params.push(sinceMs); }
  if (untilMs) { sql += ' AND m.sent_at <= ?'; params.push(untilMs); }
  if (userId) { sql += ' AND m.user_id = ?'; params.push(userId); }
  sql += ' ORDER BY m.sent_at DESC LIMIT ?';
  params.push(lim);
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToHit).reverse();
}

/**
 * 数命中总数，不受 limit 截断影响。
 * 跨群时用它算「另有 N 条别人的发言」——不能拿 hits.length 反推，
 * 因为 hits 已经被 limit 砍过，N 会偏小甚至为 0。
 */
export function countMatches(db, { query = null, scope = null, sinceMs = null, untilMs = null, userId = null } = {}) {
  const params = [];
  let sql;
  const expr = query ? toMatchExpr(query) : null;
  const useLike = query ? needsLikeFallback(query) || !expr : false;

  if (query && !useLike) {
    sql = `SELECT COUNT(*) c FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ?`;
    params.push(expr);
  } else if (query) {
    sql = `SELECT COUNT(*) c FROM messages m WHERE m.text LIKE '%' || ? || '%'`;
    params.push(cleanText(query));
  } else {
    sql = `SELECT COUNT(*) c FROM messages m WHERE 1=1`;
  }
  if (scope) { sql += ' AND m.scope = ?'; params.push(scope); }
  if (sinceMs) { sql += ' AND m.sent_at >= ?'; params.push(sinceMs); }
  if (untilMs) { sql += ' AND m.sent_at <= ?'; params.push(untilMs); }
  if (userId) { sql += ' AND m.user_id = ?'; params.push(userId); }
  return Number(db.prepare(sql).get(...params).c) || 0;
}

/** 某人在某个会话里有没有发言记录。跨群访问时用来判断「是不是真的没说话」还是「被边界挡了」。 */
export function hasUserInScope(db, scope, userId) {
  if (!scope || !userId) return false;
  const r = db.prepare('SELECT COUNT(*) c FROM messages WHERE scope = ? AND user_id = ? LIMIT 1').get(scope, String(userId));
  return Number(r?.c) > 0;
}

export function stats(db) {
  const total = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  const byScope = db.prepare(`
    SELECT scope, COUNT(*) c, MIN(sent_at) a, MAX(sent_at) b FROM messages GROUP BY scope ORDER BY c DESC
  `).all().map((r) => ({
    scope: r.scope,
    count: Number(r.c),
    first: r.a ? new Date(Number(r.a)).toISOString() : null,
    last: r.b ? new Date(Number(r.b)).toISOString() : null,
  }));
  const bySource = db.prepare('SELECT source, COUNT(*) c FROM messages GROUP BY source').all()
    .map((r) => ({ source: r.source, count: Number(r.c) }));
  return { total: Number(total), byScope, bySource };
}

export function getCursor(db, name) {
  const r = db.prepare('SELECT value FROM cursors WHERE name = ?').get(name);
  return r ? r.value : null;
}

export function setCursor(db, name, value) {
  db.prepare('INSERT INTO cursors(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
    .run(name, String(value));
}

/** 记一条漏采缺口（seq_from..seq_to 永久缺失）。 */
export function recordGap(db, { scope, from, to, missing }) {
  db.prepare('INSERT INTO gaps(scope, seq_from, seq_to, missing, detected_at) VALUES (?,?,?,?,?)')
    .run(String(scope), Number(from), Number(to), Number(missing), Date.now());
}

/** 漏采台账（最近的在前）。 */
export function listGaps(db, limit = 50) {
  return db.prepare('SELECT * FROM gaps ORDER BY detected_at DESC LIMIT ?').all(Math.max(1, Number(limit) || 50))
    .map((r) => ({ scope: r.scope, from: r.seq_from, to: r.seq_to, missing: r.missing, detectedAt: r.detected_at }));
}
