// 中文切词与文本清洗。所有检索都必须过这里，保证写入和查询用同一套切法。
//
// 为什么不用 FTS5 内置分词器（实测，2026-10-31）：
//   tokenize='unicode61' → 中文整句是一个 token，MATCH '繁星' 命中 0
//   tokenize='trigram'   → 两字词全废（'繁星' / '显卡' / '电脑' 全 0 命中）
//   手工 bigram（繁星似尘 → 繁星/星似/似尘）→ 全对
// 单字查询（'吃'）bigram 切不出 token，查询层降级 LIKE。

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g;

/** 去掉控制字符/零宽字符，压空白。雪人写进来的昵称带一堆 \f\u0012 这类东西。 */
export function cleanName(s) {
  if (typeof s !== 'string') return '';
  return s.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
}

/** 消息正文清洗：去控制字符，保留换行语义但压成单行。 */
export function cleanText(s) {
  if (typeof s !== 'string') return '';
  return s.replace(CONTROL, '').replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();
}

/**
 * 中文 bigram 切词。返回空格分隔的 token 串，直接进 FTS5 的 tokens 列。
 * 汉字逐字两两成对；ASCII/数字整段保留（不切碎），保证 "5090" "gtx" 这类能整段命中。
 */
export function bigram(s) {
  const text = cleanText(s);
  if (!text) return '';
  // 先按「连续汉字」和「连续 ASCII 字母数字」切成 run，标点/空白/emoji 天然当边界被丢弃。
  // 必须分开处理：整段按字符两两配会把「买了5090」切成 买了/了5/50/09/90，5090 就搜不到了。
  const runs = text.match(/\p{Script=Han}+|[A-Za-z0-9_]+/gu) || [];
  const out = [];
  for (const run of runs) {
    const chars = [...run];
    if (!/\p{Script=Han}/u.test(run)) {
      // 英文/数字整段保留，小写。不切碎，保证 "5090" "gtx" 能整段命中
      out.push(run.toLowerCase());
      continue;
    }
    if (chars.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  }
  return out.join(' ');
}

/** 查询串 → FTS5 MATCH 表达式。返回 null 表示该走 LIKE 兜底（太短/切不出 token）。 */
export function toMatchExpr(query) {
  const toks = bigram(query).split(' ').filter(Boolean);
  if (!toks.length) return null;
  // 单字查询切不出 bigram 时，tokens 里就是那个单字本身，仍可用
  return toks.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}

/** 查询是否短到只能靠 LIKE（单字，或纯标点）。 */
export function needsLikeFallback(query) {
  const t = cleanText(query);
  if (!t) return true;
  const toks = bigram(t).split(' ').filter(Boolean);
  return toks.length === 0 || ([...t].length <= 1);
}

/** 从消息体判断类型。雪人把非文字消息写成 [图片] / [语音] / [表情]。 */
export function classifyKind(text, media) {
  const t = (text || '').trim();
  if (Array.isArray(media) && media.length) {
    const kinds = media.map((m) => m?.kind).filter(Boolean);
    if (kinds.includes('image')) return 'image';
    if (kinds.includes('voice')) return 'voice';
    if (kinds.includes('file')) return 'file';
  }
  if (/^\[图片\]/.test(t)) return 'image';
  if (/^\[语音\]/.test(t)) return 'voice';
  if (/^\[表情\]|^\[动画表情\]/.test(t)) return 'sticker';
  if (/^\[文件\]/.test(t)) return 'file';
  if (/^\[视频\]/.test(t)) return 'video';
  return 'text';
}
