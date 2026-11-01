// 跨会话白名单：哪些群之间可以互通。
//
// 默认「没有配置文件 = 谁都不通」，不做隐式放行。
// 只有 group ↔ group 能被配进白名单：私聊内容永不跨会话（见 access.mjs 的第一条规则），
// 所以 private:* 出现在 links 里会被跳过并记警告，而不是静默生效。

import fs from 'node:fs';

const DEFAULT_PATH = '/root/qq-bridge-memory/config/relations.json';

function normalizeLink(x) {
  if (!x || typeof x !== 'object') return null;
  const a = String(x.a || '').trim();
  const b = String(x.b || '').trim();
  if (!/^group:\S+$/.test(a) || !/^group:\S+$/.test(b)) return null;
  if (a === b) return null;
  return { a, b, note: x.note ? String(x.note) : '' };
}

/**
 * @returns {{ownerUsers:Set<string>, links:{a:string,b:string,note:string}[], path:string, warnings:string[]}}
 */
export function loadRelations(path = process.env.QQ_MEMORY_RELATIONS || DEFAULT_PATH) {
  const empty = { ownerUsers: new Set(), links: [], path, warnings: [] };
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return empty;
    throw new Error(`白名单读不了：${path}（${e?.message || e}）`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new Error(`白名单不是合法 JSON：${path}`);
  }
  const warnings = [];
  const ownerUsers = new Set(
    (Array.isArray(cfg.ownerUsers) ? cfg.ownerUsers : []).map((x) => String(x).trim()).filter(Boolean)
  );
  const links = [];
  for (const x of Array.isArray(cfg.links) ? cfg.links : []) {
    const n = normalizeLink(x);
    if (n) links.push(n);
    else warnings.push(`跳过无效 links 项 ${JSON.stringify(x)}（只允许 group:A ↔ group:B，私聊不放白名单）`);
  }
  return { ownerUsers, links, path, warnings };
}

export function isOwner(rel, userId) {
  const u = String(userId || '').trim();
  return !!u && rel.ownerUsers.has(u);
}

/** 双向：配 a↔b 等于两边互相可查。 */
export function isLinked(rel, x, y) {
  if (!x || !y || x === y) return false;
  return rel.links.some((l) => (l.a === x && l.b === y) || (l.a === y && l.b === x));
}
