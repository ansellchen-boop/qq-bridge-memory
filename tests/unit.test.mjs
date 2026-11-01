import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bigram, cleanName, cleanText, toMatchExpr, needsLikeFallback, classifyKind } from '../src/tokenize.mjs';
import { openDb, insertMessages, search, recent, stats, getCursor, setCursor, recordGap, listGaps } from '../src/db.mjs';
import { extractSnapshotJson, deriveTime, parseToolMessages, resolveMsgTime } from '../src/backfill.mjs';
import { collectOnce } from '../src/collect.mjs';
import { parseSince, parseUntil, fmtTime } from '../src/time.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── 切词 ──────────────────────────────────────────────────────────
test('bigram：中文逐字两两成对', () => {
  assert.equal(bigram('繁星似尘'), '繁星 星似 似尘');
});

test('bigram：英文数字整段保留并小写', () => {
  const t = bigram('买了5090 GTX 显卡');
  assert.ok(t.includes('5090'));
  assert.ok(t.includes('gtx'));
  assert.ok(t.includes('显卡'));
});

test('bigram：单字保留（否则单字搜不到）', () => {
  assert.equal(bigram('吃'), '吃');
});

test('cleanName：清掉雪人昵称里的控制字符', () => {
  assert.equal(cleanName('\n\f\u0012\nSnuzzle^_^\n\n\n\b%ĀĀ\u0007Ö\u0010\u0000'), 'Snuzzle^_^%ĀĀÖ');
});

test('toMatchExpr：多词 AND 连接', () => {
  assert.equal(toMatchExpr('显卡 涨价'), '"显卡" AND "涨价"');
});

test('needsLikeFallback：单字降级 LIKE，多字走 FTS', () => {
  assert.equal(needsLikeFallback('吃'), true);
  assert.equal(needsLikeFallback('显卡'), false);
});

test('classifyKind：识别 [图片]/[语音]/[表情]', () => {
  assert.equal(classifyKind('[图片]'), 'image');
  assert.equal(classifyKind('[语音]'), 'voice');
  assert.equal(classifyKind('[表情]'), 'sticker');
  assert.equal(classifyKind('普通一句话'), 'text');
});

// ── 存储与检索 ────────────────────────────────────────────────────
function mkDb() {
  return openDb(':memory:');
}

const M = (seq, sender, text, extra = {}) => ({
  seq, messageId: `mid-${seq}`, sender, userId: `u${seq}`, text, plain: text, time: 1700000000000 + seq * 60000, ...extra,
});

test('insertMessages：入库、去重、非法行不拖垮整批', () => {
  const db = mkDb();
  const msgs = [M(1, '繁星似尘', '显卡又涨价了'), M(2, '大白鱼', '买不起')];
  const r1 = insertMessages(db, 'group:1', msgs, 'collect');
  assert.equal(r1.inserted, 2);
  assert.equal(r1.invalid, 0);
  // 同一批再来一次：全跳过
  const r2 = insertMessages(db, 'group:1', msgs, 'collect');
  assert.equal(r2.inserted, 0);
  assert.equal(r2.skipped, 2);
  // 混一条空的、一条没时间的
  const r3 = insertMessages(db, 'group:1', [{ seq: 3, text: '  ', time: 1 }, { seq: 4, text: '有字没时间' }], 'collect');
  assert.equal(r3.inserted, 0);
  assert.equal(r3.invalid, 2);
  db.close();
});

test('search：中文两字词能命中（bigram 全链路）', () => {
  const db = mkDb();
  insertMessages(db, 'group:1', [
    M(1, '繁星似尘', '显卡又涨价了听说5090翻倍'),
    M(2, '小鲸鱼', '白米饭才是硬通货'),
    M(3, '路人', '今天天气不错'),
  ], 'collect');
  const r = search(db, { query: '显卡' });
  assert.equal(r.total, 1);
  assert.match(r.hits[0].text, /显卡/);
  assert.equal(r.mode, 'fts');

  const r2 = search(db, { query: '白米饭' });
  assert.equal(r2.total, 1);
  db.close();
});

test('search：scope 过滤不串场', () => {
  const db = mkDb();
  insertMessages(db, 'group:1', [M(1, '甲', '显卡 news')], 'collect');
  insertMessages(db, 'private:9', [M(2, '老板', '显卡 news')], 'collect');
  assert.equal(search(db, { query: '显卡' }).total, 2);
  assert.equal(search(db, { query: '显卡', scope: 'private:9' }).total, 1);
  db.close();
});

test('search：单字降级 LIKE', () => {
  const db = mkDb();
  insertMessages(db, 'group:1', [M(1, '甲', '我要吃饭')], 'collect');
  const r = search(db, { query: '吃' });
  assert.equal(r.mode, 'like');
  assert.equal(r.total, 1);
  db.close();
});

test('search：since/until 时间窗', () => {
  const db = mkDb();
  insertMessages(db, 'group:1', [M(1, '甲', '显卡 早期'), M(2, '乙', '显卡 晚期')], 'collect');
  const base = 1700000000000 + 60000;
  const r = search(db, { query: '显卡', sinceMs: base + 1 });
  assert.equal(r.total, 1);
  assert.match(r.hits[0].text, /晚期/);
  db.close();
});

test('recent：正序返回，limit 生效', () => {
  const db = mkDb();
  insertMessages(db, 'group:1', [M(1, '甲', '一'), M(2, '乙', '二'), M(3, '丙', '三')], 'collect');
  const hits = recent(db, { limit: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].text, '二');
  assert.equal(hits[1].text, '三');
  db.close();
});

test('recent：until 必须下推到 SQL，旧日期不能被新消息挤掉', () => {
  const db = mkDb();
  // 2 条月初的，后面堆 400 条新的（超过任何 LIMIT 缓冲）
  const base = 1700000000000;
  insertMessages(db, 'group:1', [
    { seq: 1, messageId: 'old-1', sender: '甲', text: '九月底的事', time: base },
    { seq: 2, messageId: 'old-2', sender: '乙', text: '九月底的事第二条', time: base + 1000 },
  ], 'backfill');
  const many = Array.from({ length: 400 }, (_, i) => ({
    seq: 100 + i, messageId: `new-${i}`, sender: '丙', text: `后来的第${i}句`, time: base + 86_400_000 * 30 + i * 1000,
  }));
  insertMessages(db, 'group:1', many, 'collect');

  const old = recent(db, { untilMs: base + 5000, limit: 40 });
  assert.equal(old.length, 2, '查早期窗口时不该返回 0 条');
  assert.match(old[0].text, /九月底/);

  const latest = recent(db, { limit: 40 });
  assert.equal(latest.length, 40);
  db.close();
});

test('cursors：读写', () => {
  const db = mkDb();
  assert.equal(getCursor(db, 'seq:group:1'), null);
  setCursor(db, 'seq:group:1', 42);
  assert.equal(getCursor(db, 'seq:group:1'), '42');
  setCursor(db, 'seq:group:1', 43);
  assert.equal(getCursor(db, 'seq:group:1'), '43');
  db.close();
});

// ── 回填解析 ──────────────────────────────────────────────────────
test('extractSnapshotJson：括号配平，后面还有别的内容也能提取', () => {
  const text = '【当前时间】2026/10/31\n【本次消息快照】\n{"messages":[{"seq":1,"sender":"甲","text":"含}{括号"}],"recent":[]}\n【后面还有一段】xx';
  const out = extractSnapshotJson(text);
  assert.ok(out);
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].text, '含}{括号');
});

test('extractSnapshotJson：没有标记返回 null', () => {
  assert.equal(extractSnapshotJson('【当前时间】2026/10/31'), null);
});

test('extractSnapshotJson：JSON 坏了不抛，返回 null', () => {
  assert.equal(extractSnapshotJson('【本次消息快照】\n{"messages":[}'), null);
});

// ── 工具返回的消息（10-22 之后的新机制） ──────────────────────────
test('deriveTime：有 ago 用 ago 反推', () => {
  const base = 1793452949055;
  assert.equal(deriveTime({ ago: '52m' }, base), base - 52 * 60000);
  assert.equal(deriveTime({ ago: '2h' }, base), base - 2 * 3600000);
});

test('deriveTime：只有 at 时补到事件那一天', () => {
  const base = new Date(2026, 9, 31, 21, 22, 28).getTime();
  const t = deriveTime({ at: '20:35' }, base);
  const d = new Date(t);
  assert.equal(d.getDate(), 31);
  assert.equal(d.getHours(), 20);
  assert.equal(d.getMinutes(), 35);
});

test('deriveTime：at 比事件晚 → 判为昨天', () => {
  const base = new Date(2026, 9, 31, 0, 20, 0).getTime();
  const t = deriveTime({ at: '23:50' }, base);
  assert.equal(new Date(t).getDate(), 30);
});

test('parseToolMessages：从 wait_for_messages 返回里抠消息', () => {
  const text = JSON.stringify({
    ok: true, key: 'group:987654321', unreadCount: 2,
    messages: [
      { seq: 7866, messageId: '-1858806052', sender: '风自东来（111）', userId: '2583180493', text: '@狄奥尼索斯 比如', at: '20:35', ago: '52m' },
      { seq: 7867, messageId: '1567579369', sender: '狄奥尼索斯', userId: '1469749857', text: '忘了拍照了', at: '20:36', ago: '51m' },
    ],
  });
  const base = new Date(2026, 9, 31, 21, 22, 0).getTime();
  const p = parseToolMessages(text, base);
  assert.ok(p);
  assert.equal(p.scope, 'group:987654321');
  assert.equal(p.msgs.length, 2);
  assert.ok(p.msgs[0].time < base);
});

test('parseToolMessages：newMessages 空数组 / 不是消息返回 null', () => {
  assert.equal(parseToolMessages(JSON.stringify({ ok: true, key: 'group:1', newMessages: [] }), 1), null);
  assert.equal(parseToolMessages(JSON.stringify({ ok: true, hint: 'x' }), 1), null);
  assert.equal(parseToolMessages('不是 JSON', 1), null);
});

test('parseToolMessages：自带绝对 time 的消息不能被事件时间覆盖', () => {
  const eventMs = new Date(2026, 9, 31, 21, 22, 0).getTime();
  const realTime = new Date(2026, 9, 31, 9, 40, 0).getTime(); // 真实时间比事件早 11 小时
  const text = JSON.stringify({
    ok: true, key: 'group:987654321',
    messages: [
      { seq: 1, messageId: 'a', sender: '甲', text: '带绝对时间', time: realTime },
      { seq: 2, messageId: 'b', sender: '乙', text: '只有 at', at: '20:35' },
    ],
  });
  const p = parseToolMessages(text, eventMs);
  assert.equal(p.msgs[0].time, realTime, '带 time 的必须原样保留');
  assert.notEqual(p.msgs[1].time, eventMs, '只有 at 的才用事件时间推');
  assert.equal(new Date(p.msgs[1].time).getHours(), 20);
});

test('resolveMsgTime：sent_at 也算绝对时间', () => {
  const eventMs = 1793452949055;
  const t = 1793400000000;
  assert.equal(resolveMsgTime({ time: t }, eventMs), t);
  assert.equal(resolveMsgTime({ sent_at: t }, eventMs), t);
  assert.equal(resolveMsgTime({ ago: '52m' }, eventMs), eventMs - 52 * 60000);
  assert.equal(resolveMsgTime({}, eventMs), eventMs); // 什么都没有才退回事件时间
});

// ── 增量采集 ──────────────────────────────────────────────────────
test('collectOnce：读 social-v2.json 入库并写游标', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqmem-'));
  const p = join(dir, 'social-v2.json');
  writeFileSync(p, JSON.stringify({
    conversations: {
      'group:1': { recentMessages: [M(1, '甲', '显卡'), M(2, '乙', '白米饭')] },
      'private:9': { recentMessages: [M(3, '老板', '显卡')] },
    },
  }));
  const db = mkDb();
  const r = collectOnce(db, { path: p });
  assert.equal(r.readOk, true);
  assert.equal(r.totalInserted, 3);
  assert.equal(getCursor(db, 'seq:group:1'), '2');
  assert.equal(stats(db).total, 3);
  // 再跑一次：不重复入库
  const r2 = collectOnce(db, { path: p });
  assert.equal(r2.totalInserted, 0);
  db.close();
});

test('collectOnce：半截 JSON 不动游标、不报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqmem-'));
  const p = join(dir, 'social-v2.json');
  writeFileSync(p, '{"conversations":{"group:1":{"recentMess');
  const db = mkDb();
  const r = collectOnce(db, { path: p });
  assert.equal(r.readOk, false);
  assert.equal(r.totalInserted, 0);
  db.close();
});

test('collectOnce：seq 跳号记 gap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqmem-'));
  const p = join(dir, 'social-v2.json');
  const write = (msgs) => writeFileSync(p, JSON.stringify({ conversations: { 'group:1': { recentMessages: msgs } } }));
  const db = mkDb();
  write([M(1, '甲', 'a'), M(2, '乙', 'b')]);
  collectOnce(db, { path: p });
  // 下一批从 seq 10 开始：3..9 漏了
  write([M(10, '甲', 'c')]);
  const r = collectOnce(db, { path: p });
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].missing, 7);
  // 缺口必须落库，不能只打一行日志
  const ledger = listGaps(db);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].scope, 'group:1');
  assert.equal(ledger[0].from, 3);
  assert.equal(ledger[0].to, 9);
  assert.equal(ledger[0].missing, 7);
  db.close();
});

// ── 时间解析 ──────────────────────────────────────────────────────
test('parseSince：相对量与绝对量', () => {
  const now = Date.now();
  const h2 = parseSince('2h');
  assert.ok(Math.abs(now - h2 - 7_200_000) < 5000);
  assert.equal(parseSince('2026-10-30') !== null, true);
  assert.equal(parseSince(''), null);
  assert.equal(parseSince(null), null);
});

test('parseSince/parseUntil：纯日期按本地自然日，until 到当天最后一毫秒', () => {
  const a = new Date(parseSince('2026-09-30'));
  assert.equal(a.getFullYear(), 2026);
  assert.equal(a.getMonth(), 8);      // 9 月
  assert.equal(a.getDate(), 30);
  assert.equal(a.getHours(), 0);      // 本地零点，不是 UTC 零点（UTC 会变成 08:00）

  const b = new Date(parseUntil('2026-09-30'));
  assert.equal(b.getDate(), 30);
  assert.equal(b.getHours(), 23);
  assert.equal(b.getMinutes(), 59);
  assert.ok(b.getTime() - a.getTime() > 86_000_000); // 覆盖整天
});

test('parseSince：看不懂就抛错，绝不悄悄当「不限时间」', () => {
  assert.throws(() => parseSince('胡说'), /格式看不懂/);
  assert.throws(() => parseUntil('not-a-date'), /格式看不懂/);
  assert.throws(() => parseSince('2026-02-30'), /不存在/); // Date 会滚到 3-2，必须拦
});

test('fmtTime：输出本地时间格式', () => {
  assert.match(fmtTime(Date.now()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

// ── 跨群白名单与访问控制 ──────────────────────────────────────────
import { loadRelations, isOwner, isLinked } from '../src/relations.mjs';
import { resolveAccess } from '../src/access.mjs';
import { redact } from '../src/redact.mjs';
import { countMatches, hasUserInScope } from '../src/db.mjs';

function tmpJson(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'qqmem-rel-'));
  const p = join(dir, 'relations.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

function mkCrossDb() {
  const db = mkDb();
  insertMessages(db, 'group:A', [
    M(1, '路人甲', '群A 显卡降价了', { userId: '1001' }),
    M(2, '老板', '群A 我也想要一张', { userId: '9001' }),
  ], 'collect');
  insertMessages(db, 'group:B', [
    M(11, '群B某人', '群B 显卡更难买', { userId: '2001' }),
    M(12, '老板', '群B 显卡我上个月就买了', { userId: '9001' }),
  ], 'collect');
  return db;
}

test('relations：文件不存在 = 谁都不通（不做隐式放行）', () => {
  const rel = loadRelations('/nonexistent/relations.json');
  assert.equal(rel.ownerUsers.size, 0);
  assert.equal(rel.links.length, 0);
  assert.equal(isOwner(rel, '123456789'), false);
});

test('relations：私聊不许进白名单，被跳过并记警告', () => {
  const p = tmpJson({ ownerUsers: ['9001'], links: [{ a: 'group:A', b: 'private:9001' }, { a: 'group:A', b: 'group:B', note: '同一拨人' }] });
  const rel = loadRelations(p);
  assert.equal(rel.links.length, 1);
  assert.equal(rel.links[0].b, 'group:B');
  assert.match(rel.warnings[0], /私聊不放白名单/);
  assert.equal(isLinked(rel, 'group:B', 'group:A'), true); // 双向
  assert.equal(isLinked(rel, 'group:A', 'group:C'), false);
});

test('relations：非法 JSON 抛错而不是静默当空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqmem-rel-'));
  const p = join(dir, 'bad.json');
  writeFileSync(p, '{ 这不是 json');
  assert.throws(() => loadRelations(p), /不是合法 JSON/);
});

test('access：查自己所在会话 → own，不脱敏', () => {
  const r = resolveAccess({ scope: 'group:A', caller: 'group:A', asUser: '9999', relations: { ownerUsers: new Set(), links: [] }, hasUserInScope: () => false });
  assert.equal(r.mode, 'own');
  assert.equal(r.filterUser, null);
  assert.equal(r.redact, false);
});

test('access：私聊内容永不跨会话，owner 也被挡', () => {
  const rel = { ownerUsers: new Set(['9001']), links: [{ a: 'group:A', b: 'group:B' }] };
  assert.throws(
    () => resolveAccess({ scope: 'private:9001', caller: 'group:A', asUser: '9001', relations: rel, hasUserInScope: () => true }),
    /不跨会话提供/
  );
  assert.throws(
    () => resolveAccess({ scope: 'private:7777', caller: 'private:9001', asUser: '9001', relations: rel, hasUserInScope: () => true }),
    /不跨会话提供/
  );
});

test('access：owner 跨群全通；白名单群互通；外人只拿自己那几条', () => {
  const owner = resolveAccess({ scope: 'group:B', caller: 'group:A', asUser: '9001', relations: { ownerUsers: new Set(['9001']), links: [] }, hasUserInScope: () => false });
  assert.equal(owner.mode, 'owner');
  assert.equal(owner.filterUser, null);
  assert.equal(owner.redact, true);

  const linked = resolveAccess({ scope: 'group:B', caller: 'group:A', asUser: '2001', relations: { ownerUsers: new Set(), links: [{ a: 'group:A', b: 'group:B' }] }, hasUserInScope: () => false });
  assert.equal(linked.mode, 'linked');
  assert.equal(linked.filterUser, null);

  const selfOnly = resolveAccess({ scope: 'group:B', caller: 'group:A', asUser: '2001', relations: { ownerUsers: new Set(), links: [] }, hasUserInScope: () => true });
  assert.equal(selfOnly.mode, 'self-only');
  assert.equal(selfOnly.filterUser, '2001');
  assert.equal(selfOnly.redact, true);
});

test('access：不在那个群说过话的人，直接拒绝而不是返回空', () => {
  // caller 里说过话（这条能过），但目标群里没有 —— 报「没有说话记录」
  assert.throws(
    () => resolveAccess({ scope: 'group:B', caller: 'group:A', asUser: '3001', relations: { ownerUsers: new Set(), links: [] }, hasUserInScope: (s) => s === 'group:A' }),
    /没有说话记录/
  );
});

test('access：as_user 在目标群说过话、但在当前会话没出现过 → 拒（防冒充别人的号）', () => {
  // 只有「目标群说过话」这一条证据时，冒充一个在那边发过言的人的号也能过。
  // 所以要求他同时在 caller 里有发言 —— 这一条挡的就是伪造 as_user。
  assert.throws(
    () => resolveAccess({ scope: 'group:B', caller: 'group:A', asUser: '3001', relations: { ownerUsers: new Set(), links: [] }, hasUserInScope: (s) => s === 'group:B' }),
    /没法确认这句话是这个人说的/
  );
});

test('access：两边都说过话的人 → self-only，只给 filterUser', () => {
  const r = resolveAccess({ scope: 'group:B', caller: 'group:A', asUser: '3001', relations: { ownerUsers: new Set(), links: [] }, hasUserInScope: () => true });
  assert.equal(r.mode, 'self-only');
  assert.equal(r.filterUser, '3001');
  assert.equal(r.redact, true);
});

test('db：userId 过滤只出本人发言，countMatches 算得出被挡了多少条', () => {
  const db = mkCrossDb();
  assert.equal(hasUserInScope(db, 'group:B', '9001'), true);
  assert.equal(hasUserInScope(db, 'group:B', '1234'), false);

  const all = search(db, { query: '显卡', scope: 'group:B', limit: 20 });
  assert.equal(all.hits.length, 2);

  const mine = search(db, { query: '显卡', scope: 'group:B', limit: 20, userId: '9001' });
  assert.equal(mine.hits.length, 1);
  assert.equal(mine.hits[0].userId, '9001');
  assert.match(mine.hits[0].text, /上个月就买了/);

  const total = countMatches(db, { query: '显卡', scope: 'group:B' });
  const myCount = countMatches(db, { query: '显卡', scope: 'group:B', userId: '9001' });
  assert.equal(total, 2);
  assert.equal(myCount, 1);
  assert.equal(total - myCount, 1); // 「另有 1 条其他人的发言」

  const rec = recent(db, { scope: 'group:B', limit: 20, userId: '9001' });
  assert.equal(rec.length, 1);
  assert.equal(countMatches(db, { scope: 'group:B' }), 2); // 不带 query 也要能数
});

test('redact：手机/身份证/卡号/邮箱打码，QQ 号保留', () => {
  assert.equal(redact('电话 13812345678'), '电话 138****5678');
  assert.equal(redact('身份证 110101199003078888'), '身份证 110101********8888');
  assert.equal(redact('卡号 6222021234567890123'), '卡号 6222********0123');
  assert.equal(redact('邮箱 abc@qq.com 找我'), '邮箱 a***@qq.com 找我');
  assert.equal(redact('QQ 123456789 说的'), 'QQ 123456789 说的');
});
