#!/usr/bin/env node
// qqmem —— qq-memory 的命令行入口。
// 子命令：backfill / collect / search / recent / stats
//
// 约定：默认库 /root/qq-memory/data/messages.db，可用 --db 或 QQ_MEMORY_DB 覆盖。

import { openDb, search, recent, stats, getCursor } from '../src/db.mjs';
import { backfillAll, listArchives, loadScopeMap } from '../src/backfill.mjs';
import { collectOnce } from '../src/collect.mjs';
import { loadRelations } from '../src/relations.mjs';
import { parseSince, parseUntil } from '../src/time.mjs';

const DEFAULT_DB = process.env.QQ_MEMORY_DB || '/root/qq-memory/data/messages.db';

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

function fmtTime(iso) {
  // 2026-10-31T13:45:00.000Z → 2026-10-31 21:45（本地时区）
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function printHits(hits, mode) {
  if (!hits.length) { console.log('（没有命中）'); return; }
  for (const h of hits) {
    console.log(`[${fmtTime(h.at)}] ${h.scope} ${h.sender || '?'}${h.isSelf ? '（她自己）' : ''}: ${h.text}`);
  }
  console.log(`\n—— ${hits.length} 条（${mode === 'like' ? 'LIKE 兜底' : 'FTS bigram'}）`);
}

const cmds = {
  async backfill({ flags }) {
    const db = openDb(flags.db || DEFAULT_DB);
    const scopeMap = {};
    if (flags.map) Object.assign(scopeMap, JSON.parse(flags.map));
    console.log(`开始回填…库=${flags.db || DEFAULT_DB}`);
    const r = await backfillAll(db, {
      only: typeof flags.only === 'string' ? flags.only : undefined,
      scopeMap,
      onProgress: (p) => console.log(`  … ${p.sessionId.slice(0, 13)} 快照 ${p.snapshots} 条，已入库 ${p.inserted}`),
    });
    for (const d of r.done) {
      console.log(`✓ ${d.sessionId.slice(0, 13)} → ${d.scope || '(只扫工具源)'}`);
      if (d.snapshots || d.raw) {
        console.log(`    快照线：快照 ${d.snapshots}，原始 ${d.raw}，入库 ${d.inserted}，重复 ${d.skipped}，非法 ${d.invalid}`);
      }
      if (d.toolBatches) {
        console.log(`    工具线：批次 ${d.toolBatches}，原始 ${d.toolMessages}，入库 ${d.toolInserted}，非法 ${d.toolInvalid}`);
      }
      if (d.lineErrors) {
        console.log(`    ⚠ 有 ${d.lineErrors} 行处理出错（写库失败等），首条：${d.lastError}`);
      }
    }
    if (r.noSnapshotScope.length) {
      console.log(`ℹ 这些 session 在 sessions.json 里查不到 scope，只扫了工具源（快照线跳过）：`);
      for (const s of r.noSnapshotScope) console.log(`    ${s}`);
    }
    console.log(JSON.stringify(stats(db), null, 2));
    db.close();
  },

  async archives() {
    const map = loadScopeMap();
    for (const a of listArchives()) {
      const scope = map[a.sessionId] || '(未归属)';
      console.log(`${a.sessionId.slice(0, 13)}  ${scope}`);
    }
  },

  async collect({ flags }) {
    const db = openDb(flags.db || DEFAULT_DB);
    const r = collectOnce(db, flags.path ? { path: flags.path } : {});
    if (!r.readOk) {
      console.log('✗ social-v2.json 读不到或不是完整 JSON（bridge 可能在写），本轮不动游标');
      db.close();
      return;
    }
    for (const s of r.scopes) {
      console.log(`${s.scope}: 取 ${s.fetched} 条，新入库 ${s.inserted}${s.minSeq != null ? `，seq ${s.minSeq}–${s.maxSeq}` : ''}`);
    }
    for (const g of r.gaps) {
      console.log(`⚠ 漏采 ${g.scope}: seq ${g.from}–${g.to} 共 ${g.missing} 条没赶上（轮询间隔内聊太多）`);
    }
    console.log(`合计新入库 ${r.totalInserted} 条`);
    db.close();
  },

  async search({ flags, pos }) {
    const q = pos.join(' ').trim();
    if (!q) { console.error('用法：qqmem search <关键词> [--scope group:xxx] [--since 3d] [--until 2026-10-30] [--limit 20]'); process.exit(2); }
    const db = openDb(flags.db || DEFAULT_DB);
    const r = search(db, {
      query: q,
      scope: typeof flags.scope === 'string' ? flags.scope : null,
      sinceMs: parseSince(typeof flags.since === 'string' ? flags.since : null),
      untilMs: parseUntil(typeof flags.until === 'string' ? flags.until : null),
      limit: Number(flags.limit || 20),
      userId: typeof flags.user === 'string' ? flags.user : null,
    });
    printHits(r.hits, r.mode);
    db.close();
  },

  async recent({ flags }) {
    const db = openDb(flags.db || DEFAULT_DB);
    const hits = recent(db, {
      scope: typeof flags.scope === 'string' ? flags.scope : null,
      sinceMs: parseSince(typeof flags.since === 'string' ? flags.since : null),
      untilMs: parseUntil(typeof flags.until === 'string' ? flags.until : null),
      limit: Number(flags.limit || 20),
      userId: typeof flags.user === 'string' ? flags.user : null,
    });
    printHits(hits, 'recent');
    db.close();
  },

  async relations({ flags }) {
    const rel = loadRelations(typeof flags.path === 'string' ? flags.path : undefined);
    console.log(`白名单文件：${rel.path}`);
    console.log(rel.ownerUsers.size ? `  owner：${[...rel.ownerUsers].join(', ')}` : '  owner：无（没人能跨群查全部群聊）');
    if (!rel.links.length) {
      console.log('  links：无（群之间互不相通，跨群只能看到本人自己的发言）');
    } else {
      console.log('  links：');
      for (const l of rel.links) console.log(`    ${l.a} ↔ ${l.b}${l.note ? `  # ${l.note}` : ''}`);
    }
    for (const w of rel.warnings) console.log(`  ⚠ ${w}`);
    if (!rel.links.length && !rel.ownerUsers.size) console.log('  → 注意：白名单为空，跨群查询一律只返回 as_user 自己的发言。');
  },

  async stats({ flags }) {
    const db = openDb(flags.db || DEFAULT_DB);
    const s = stats(db);
    console.log(`总计 ${s.total} 条`);
    for (const x of s.byScope) console.log(`  ${x.scope}: ${x.count} 条（${x.first || '-'} → ${x.last || '-'}）`);
    for (const x of s.bySource) console.log(`  来源 ${x.source}: ${x.count}`);
    for (const sc of s.byScope) {
      console.log(`  游标 ${sc.scope}: seq=${getCursor(db, `seq:${sc.scope}`) || '-'}`);
    }
    db.close();
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === '-h' || cmd === '--help' || !cmds[cmd]) {
  console.log('用法：qqmem <backfill|archives|collect|search|recent|stats|relations> [参数]');
  console.log('  backfill [--only <sessionId片段>] [--map \'{"session-xx":"group:123"}\'] [--db 路径]');
  console.log('  archives                          列归档与归属');
  console.log('  collect                           增量采集 social-v2.json');
  console.log('  search <关键词> [--scope] [--user] [--limit]');
  console.log('  recent [--scope] [--user] [--limit]');
  console.log('  stats');
  console.log('  relations [--path 文件]            看跨群白名单（owner / links）');
  process.exit(cmd ? 2 : 0);
}

try {
  await cmds[cmd](parseArgs(rest));
} catch (e) {
  console.error('✗', e?.message || e);
  if (process.env.QQMEM_DEBUG) console.error(e);
  process.exit(1);
}
