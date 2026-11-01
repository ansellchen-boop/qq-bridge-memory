#!/usr/bin/env node
// qq-bridge-memory MCP server（stdio）：给她三个翻历史的工具。
//
// 为什么手写 JSON-RPC 而不是用 @modelcontextprotocol/sdk：
//   这是 qq-bridge 的外挂，要求「不影响 qq-bridge 正常更新」。零依赖 =
//   /root/qq-bridge-memory 不碰 /root/qq-bridge/node_modules，那边升级/重装依赖我们不受影响。
//   stdio 传输就是「每行一个 JSON-RPC 2.0 消息」，够用且不会因 sdk 大版本变动而废。
//
// 铁律：stdout 只能出 JSON-RPC，任何日志走 stderr。多打一行字就会让客户端解析失败。

import { statSync } from 'node:fs';
import { openDb, search, recent, stats, countMatches, hasUserInScope } from './db.mjs';
import { parseSince, parseUntil, fmtTime } from './time.mjs';
import { loadRelations } from './relations.mjs';
import { resolveAccess } from './access.mjs';
import { redact } from './redact.mjs';

const DB_PATH = process.env.QQ_MEMORY_DB || '/root/qq-bridge-memory/data/messages.db';
const RELATIONS_PATH = process.env.QQ_MEMORY_RELATIONS || '/root/qq-bridge-memory/config/relations.json';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const FALLBACK_PROTOCOL = '2025-06-18';

const db = openDb(DB_PATH);

// 白名单：启动读一次，之后每次调用比分 mtime，改了 relations.json 不用重启 dsh-web
// （重启会掐断正在进行的会话，为了加一个群付这个代价不值得）。
// 读坏了就降级到「谁都不通」，绝不放通 —— 读失败当全通等于配置一错就泄密，
// 那是比崩掉更糟的失败方式。
let relations = { ownerUsers: new Set(), links: [] };
let relMtime = -1;

function reloadRelations(why) {
  try {
    relations = loadRelations(RELATIONS_PATH);
    for (const w of relations.warnings) log('白名单警告：', w);
    log(
      `白名单${why ? `（${why}）` : ''}：owner=${[...relations.ownerUsers].join(',') || '（无）'} links=${relations.links.length}`
    );
  } catch (e) {
    log(`白名单读取失败，跨群一律按「不通」处理：${e?.message || e}`);
    relations = { ownerUsers: new Set(), links: [] };
  }
  try {
    relMtime = statSync(RELATIONS_PATH).mtimeMs;
  } catch {
    relMtime = 0; // 文件不存在：保持空集，等它出现再重载
  }
}

function currentRelations() {
  let mtime = 0;
  try {
    mtime = statSync(RELATIONS_PATH).mtimeMs;
  } catch {
    mtime = 0;
  }
  if (mtime !== relMtime) reloadRelations('配置变了，已重载');
  return relations;
}

reloadRelations();

function log(...a) {
  process.stderr.write(`[qq-bridge-memory] ${a.join(' ')}\n`);
}

/** "2h" / "30m" / "3d" / "1w" / ISO / null → epoch ms。解析不了返回 null。 */

function fmtScope(scope) {
  // group:987654321 → 群 987654321；private:123456789 → 私聊 123456789
  const [kind, id] = String(scope || '').split(':');
  if (kind === 'group') return `群 ${id}`;
  if (kind === 'private') return `私聊 ${id}`;
  return String(scope || '?');
}

function fmtHit(h) {
  const who = h.isSelf ? `${h.sender || '她'}（她自己说的）` : (h.sender || '?');
  return `[${fmtTime(h.ms)}] ${fmtScope(h.scope)} ${who}: ${h.text.replace(/\n/g, ' ⏎ ')}`;
}

function textBlock(text, isError = false) {
  const r = { content: [{ type: 'text', text }] };
  if (isError) r.isError = true;
  return r;
}

const TOOLS = [
  {
    name: 'qq_search_history',
    description:
      '翻 QQ 群聊/私聊的历史原话（比当前上下文窗口早的任何时候）。' +
      '想知道「群里之前聊过什么/谁说过什么/那个梗的来龙去脉」时用它。' +
      '多个关键词用空格隔开，要求同时出现（AND），所以要短、要挑最有辨识度的词，' +
      '一两轮搜不到就把词减到一个再搜。scope、caller、as_user 三个都必填。' +
      '查自己所在会话返回全部原话；查别的群要过白名单——不是管理员通常只拿得到 ' +
      'as_user 自己在那个群说过的话，别人的发言不会展开。私聊内容永远不跨会话。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分隔，例如「显卡 涨价」或「白米饭」' },
        scope: {
          type: 'string',
          description: '必填。要查的会话：group:<群号> 或 private:<QQ号>。没有默认值。',
        },
        caller: {
          type: 'string',
          description:
            '必填。你现在所在的会话 key（group:<群号> 或 private:<QQ号>）。' +
            '你在哪个会话里说话就传哪个，不要猜、不要编。',
        },
        as_user: {
          type: 'string',
          description: '必填。现在跟你说话的人的 QQ 号（纯数字）。跨群时用它决定能给他看哪些。',
        },
        since: {
          type: 'string',
          description: '时间下限：相对量（30m / 2h / 3d / 1w）或日期（2026-10-30，按本地自然日 00:00 起）。省略则不限。',
        },
        until: {
          type: 'string',
          description: '时间上限，格式同上；纯日期表示到当天 23:59:59。查某一天就把 since 和 until 都给同一个日期。',
        },
        limit: { type: 'integer', description: '最多返回几条，默认 20，最大 100。' },
      },
      required: ['query', 'scope', 'caller', 'as_user'],
    },
  },
  {
    name: 'qq_recent_history',
    description:
      '按时间顺序看某段历史原话，不需要关键词。' +
      '适合「昨天群里发生了什么」「九月底都在聊什么」这种没有明确关键词的问题。' +
      'scope、caller、as_user 三个都必填；要看某一天，把 since 和 until 一起给同一个日期。' +
      '权限规则和 qq_search_history 一样。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: '必填。要查的会话：group:<群号> 或 private:<QQ号>。没有默认值。',
        },
        caller: {
          type: 'string',
          description: '必填。你现在所在的会话 key（group:<群号> 或 private:<QQ号>）。',
        },
        as_user: { type: 'string', description: '必填。现在跟你说话的人的 QQ 号（纯数字）。' },
        since: { type: 'string', description: '从这里开始（30m / 2h / 3d / 2026-10-30）。' },
        until: { type: 'string', description: '到这里为止；纯日期到当天 23:59:59。' },
        limit: { type: 'integer', description: '最多几条，默认 40，最大 300。' },
      },
      required: ['scope', 'caller', 'as_user'],
    },
  },
  {
    name: 'qq_history_stats',
    description:
      '看历史库覆盖范围：**当前这个会话**存了多少条、最早到最晚是什么时候，以及全库总条数。' +
      '搜之前不确定有没有记录时先看一眼。caller 和 as_user 都必填——' +
      '它只报当前会话的情况，别处有多少条不归它管（要看别的会话得带 scope 去查）。',
    inputSchema: {
      type: 'object',
      properties: {
        caller: { type: 'string', description: '必填。你现在所在的会话 key（group:<群号> 或 private:<QQ号>）。' },
        as_user: { type: 'string', description: '必填。现在跟你说话的人的 QQ 号（纯数字）。' },
      },
      required: ['caller', 'as_user'],
    },
  },
];

/**
 * scope 必填。
 * 不传就报错，绝不默认「群聊+私聊一起查」—— 那等于在群里一句话就能翻出私聊原话。
 * 说明白边界：dsh 的 mcp-client 用 buildChildEnv 起子进程（lib/index.js:26-31），
 * 父进程 env 洗过、sessionId 根本不传进来，所以服务端无法得知「这次调用来自哪个会话」，
 * 只能要求调用方自报。真正防止她把私聊说进群里的是 preset 里的规矩 + 这条硬必填。
 */
function requireScope(args) {
  const s = args.scope == null ? '' : String(args.scope).trim();
  if (!s) {
    throw new Error(
      'scope 必填：传你要查的会话 key（group:<群号> 或 private:<QQ号>）。' +
      '不确定有哪些就用 qq_history_stats 看。这个参数没有默认值，也不会替你猜。'
    );
  }
  if (!/^(group|private):\S+$/.test(s)) {
    throw new Error(`scope 格式不对：${s}（要 group:<群号> 或 private:<QQ号>）`);
  }
  return s;
}

function requireCaller(args) {
  const s = args.caller == null ? '' : String(args.caller).trim();
  if (!s) {
    throw new Error(
      'caller 必填：传你现在所在会话的 key（group:<群号> 或 private:<QQ号>）。' +
      '你在哪个会话说话就传哪个，没有默认值，也不会替你猜。'
    );
  }
  if (!/^(group|private):\S+$/.test(s)) throw new Error(`caller 格式不对：${s}（要 group:<群号> 或 private:<QQ号>）`);
  return s;
}

function requireAsUser(args) {
  const s = args.as_user == null ? '' : String(args.as_user).trim();
  if (!s) throw new Error('as_user 必填：传现在跟你说话的人的 QQ 号（纯数字），跨群时要用它判断能给他看哪些。');
  if (!/^\d{4,12}$/.test(s)) throw new Error(`as_user 格式不对：${s}（要 QQ 号，纯数字）`);
  return s;
}

/** 解析 scope + caller + as_user，过访问控制。被拒就抛 AccessDenied。 */
function guard(args) {
  const scope = requireScope(args);
  const caller = requireCaller(args);
  const asUser = requireAsUser(args);
  const access = resolveAccess({
    scope,
    caller,
    asUser,
    relations: currentRelations(),
    hasUserInScope: (s, u) => hasUserInScope(db, s, u),
  });
  return { scope, caller, asUser, access };
}

/** 权限模式写在标题下面一行，让她知道「为什么少」而不是以为「库里没有」。 */
function accessNote(access, asUser) {
  if (access.mode === 'own') return '';
  if (access.mode === 'owner') return '（管理员视角：跨群可查全部群聊，手机/证件/卡号已打码）';
  if (access.mode === 'linked') return '（这两个群已互通，可查全部群聊，手机/证件/卡号已打码）';
  return `（跨群访问：只给 ${asUser} 自己在那个群说过的话，别人的发言不展开；手机/证件/卡号已打码）`;
}

/** 被挡掉多少条。用 countMatches 数，不能用 hits.length 反推（那个已被 limit 砍过）。 */
function countOthers({ query = null, scope, sinceMs, untilMs, filterUser }) {
  if (!filterUser) return 0;
  const all = countMatches(db, { query, scope, sinceMs, untilMs });
  const mine = countMatches(db, { query, scope, sinceMs, untilMs, userId: filterUser });
  return Math.max(0, all - mine);
}

function callTool(name, args) {
  if (name === 'qq_search_history') {
    const q = String(args.query || '').trim();
    if (!q) return textBlock('query 不能为空：给一个关键词再搜。空字符串会把整库倒出来。', true);
    const sinceMs = parseSince(args.since);
    const untilMs = parseUntil(args.until);
    const limit = Number(args.limit) || 20;
    const { scope, asUser, access } = guard(args);
    const r = search(db, { query: q, scope, sinceMs, untilMs, limit, userId: access.filterUser });
    const head = `搜「${q}」在 ${fmtScope(scope)}` +
      `${sinceMs ? ` 从 ${fmtTime(sinceMs)}` : ''}${untilMs ? ` 到 ${fmtTime(untilMs)}` : ''}：命中 ${r.total} 条` +
      `${r.mode === 'like' ? '（单字/短词，按字面匹配）' : ''}`;
    const note = accessNote(access, asUser);
    const others = countOthers({ query: q, scope, sinceMs, untilMs, filterUser: access.filterUser });
    const tail = others ? `（另有 ${others} 条其他人的发言，不在本群展开）` : '';
    const fmt = (h) => fmtHit(access.redact ? { ...h, text: redact(h.text) } : h);
    if (!r.hits.length) {
      const extra = others ? `\n${tail}` : '';
      return textBlock(`${head}\n${note ? note + '\n' : ''}（没有你查得到的命中。可能是没聊过，也可能是关键词太窄——换一个更有辨识度的词，或者用 qq_recent_history 按时间看。）${extra}`);
    }
    return textBlock([head, ...[note].filter(Boolean), ...r.hits.map(fmt), ...[tail].filter(Boolean)].join('\n'));
  }

  if (name === 'qq_recent_history') {
    const sinceMs = parseSince(args.since);
    const untilMs = parseUntil(args.until);
    const limit = Number(args.limit) || 40;
    const { scope, asUser, access } = guard(args);
    const hits = recent(db, { scope, sinceMs, untilMs, limit, userId: access.filterUser });
    // 总数单独数：hits 已被 limit 砍过，拿 hits.length 当总数会把「还有更多」说成「就这么点」。
    const total = countMatches(db, { scope, sinceMs, untilMs, userId: access.filterUser });
    const head = `最近的历史原话 · ${fmtScope(scope)}` +
      `${sinceMs ? ` 从 ${fmtTime(sinceMs)}` : ''}${untilMs ? ` 到 ${fmtTime(untilMs)}` : ''}` +
      `：共 ${total} 条${total > hits.length ? `，这里给最近 ${hits.length} 条` : '（全部）'}`;
    const note = accessNote(access, asUser);
    const others = countOthers({ query: null, scope, sinceMs, untilMs, filterUser: access.filterUser });
    const tail = others ? `（另有 ${others} 条其他人的发言，不在本群展开）` : '';
    const fmt = (h) => fmtHit(access.redact ? { ...h, text: redact(h.text) } : h);
    if (!hits.length) {
      return textBlock(`${head}\n${note ? note + '\n' : ''}（这段时间没有你查得到的记录。用 qq_history_stats 看看库覆盖到什么时候。）${others ? '\n' + tail : ''}`);
    }
    return textBlock([head, ...[note].filter(Boolean), ...hits.map(fmt), ...[tail].filter(Boolean)].join('\n'));
  }

  if (name === 'qq_history_stats') {
    // 这里也要 caller：无参数的 stats 等于给任何会话一份「别的群有多少条、时间跨度多长」
    // 的目录，边界做得再细也白搭。
    const caller = requireCaller(args);
    requireAsUser(args);
    const s = stats(db);
    const mine = s.byScope.find((x) => x.scope === caller);
    const lines = [];
    if (mine) {
      lines.push(
        `${fmtScope(caller)} 存了 ${mine.count} 条原话，` +
          `${mine.first ? fmtTime(Date.parse(mine.first)) : '?'} → ${mine.last ? fmtTime(Date.parse(mine.last)) : '?'}`
      );
    } else {
      lines.push(`${fmtScope(caller)} 还没有入库记录（采集器每分钟扫一次，刚聊的可能还没进来）`);
    }
    if (!s.total) lines.push('（库还是空的，回填还没跑）');
    else lines.push(`（全库共 ${s.total} 条。别的会话有多少条不在这里报，要看就带 scope 去查。）`);
    return textBlock(lines.join('\n'));
  }

  throw new Error(`未知工具：${name}`);
}

// ── JSON-RPC 管道 ────────────────────────────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  try {
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      const version = PROTOCOLS.includes(asked) ? asked : FALLBACK_PROTOCOL;
      send({
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'qq-bridge-memory', version: '0.1.0' },
          instructions:
            '这是 QQ 群聊/私聊的历史原话库。当前上下文里只有最近几十条消息，' +
            '更早的事情用 qq_search_history 或 qq_recent_history 去翻。' +
            '两个工具都必须传 scope / caller / as_user：scope 是要查的会话，' +
            'caller 是你现在说话的会话，as_user 是跟你说话的人的 QQ 号——都没有默认值，' +
            '你在哪个会话就填哪个，别猜、别编。' +
            '查自己所在会话能拿到全部原话；查别的群要过白名单，不是管理员通常只拿得到 ' +
            'as_user 自己在那里说过的话，返回里会附一句「另有 N 条其他人的发言」——' +
            '意思是确实还有更多，但你看不到，不要去猜那部分内容。' +
            '私聊内容永远不跨会话，群里也不复述。被边界挡住时工具会直接报错，' +
            '照实说「这个我在群里不能讲」，不要改口说「没有记录」。' +
            '回答里引用历史时，说清是谁在什么时候说的，别把私聊内容说成群里的。',
        },
      });
      return;
    }

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;

    if (method === 'ping') { send({ id, result: {} }); return; }

    if (method === 'tools/list') {
      send({ id, result: { tools: TOOLS } });
      return;
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const result = callTool(name, args);
        send({ id, result });
      } catch (e) {
        const denied = e?.name === 'AccessDenied';
        send({
          id,
          result: {
            content: [
              {
                type: 'text',
                text: denied
                  ? `这个不能查：${e.message}`
                  : `查历史失败：${e?.message || e}`,
              },
            ],
            isError: true,
          },
        });
      }
      return;
    }

    if (isNotification) return;
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    log('handler error', e?.message || e);
    if (!isNotification) send({ id, error: { code: -32603, message: String(e?.message || e) } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('跳过坏行'); continue; }
    handle(msg);
  }
});

process.stdin.on('end', () => {
  try { db.close(); } catch { /* 已关 */ }
  process.exit(0);
});

// 自测：node src/mcp-server.mjs test
if (process.argv[2] === 'test') {
  console.log(JSON.stringify(TOOLS.map((t) => t.name)));
  const r = callTool('qq_history_stats', { caller: 'group:selftest', as_user: '10000' });
  console.log(r.content[0].text);
  db.close();
  process.exit(0);
}

log(`ready · db=${DB_PATH}`);
