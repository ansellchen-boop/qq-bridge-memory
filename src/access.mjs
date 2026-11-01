// 跨会话访问控制。
//
// 为什么边界只能做在服务端 + 自报参数：dsh 的 mcp-client 用 buildChildEnv 起子进程
// （qq-bridge/node_modules 里 lib/index.js:26-31），父进程 env 被洗过，sessionId 传不进来。
// 服务端无法知道「这次调用来自哪个会话」，所以 caller / as_user 必填、没有默认值。
//
// 能防的：她随口把 B 群的话搬到 A 群（服务端按 user_id 物理过滤，模型看不见别人的行）。
// 防不住的：有人话术诱导她伪造 as_user。所以这一层是「降低误伤」，不是「硬隔离」。

export class AccessDenied extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccessDenied'; // 让 mcp-server 能区分「被边界挡了」和「真出错了」
  }
}

function label(scope) {
  const [kind, id] = String(scope || '').split(':');
  if (kind === 'group') return `群 ${id}`;
  if (kind === 'private') return `私聊 ${id}`;
  return String(scope || '?');
}

/**
 * @param {object} p
 * @param {string} p.scope      要查的会话
 * @param {string} p.caller     调用方当前所在会话（模型自报）
 * @param {string} p.asUser     当前跟模型说话的人的 QQ 号（模型自报）
 * @param {{ownerUsers:Set,links:object[]}} p.relations
 * @param {(scope:string,userId:string)=>boolean} p.hasUserInScope
 * @returns {{mode:'own'|'owner'|'linked'|'self-only', filterUser:string|null, redact:boolean}}
 */
export function resolveAccess({ scope, caller, asUser, relations, hasUserInScope }) {
  // 1. 查自己所在会话：原样返回，不脱敏（本来就是他在看自己的对话）。
  if (scope === caller) return { mode: 'own', filterUser: null, redact: false };

  // 2. 私聊内容永不跨会话。
  //    注意这条排在 owner 前面：管理员能跨群查全部群聊，但私聊里的原话不搬到群里，
  //    包括「管理员自己在私聊里说过什么」——所以这条对 owner 一样生效。
  if (String(scope).split(':')[0] === 'private') {
    throw new AccessDenied(
      `${label(scope)} 的内容不跨会话提供。私聊只有当事人自己那一侧能查，` +
        `换到群里就不复述了——这条对谁都一样，管理员也一样。`
    );
  }

  // 3. 管理员：跨群可查全部群聊（输出脱敏）。
  if (relations.ownerUsers.has(String(asUser || '').trim())) {
    return { mode: 'owner', filterUser: null, redact: true };
  }

  // 4. 白名单互通的群：全通（输出脱敏）。
  if (relations.links.some((l) => (l.a === caller && l.b === scope) || (l.a === scope && l.b === caller))) {
    return { mode: 'linked', filterUser: null, redact: true };
  }

  // 5. 跨群之前先确认「这话真是这个人说的」：
  //    光判 as_user 在目标群说过话不够 —— 谁都能报一个别人的号，那样「同一个人在不同群里问」
  //    和「冒充一个在那边说过话的人」在服务端看起来一模一样。要求他同时在 caller 里有过发言。
  //    代价：刚进群的人可能还没入库（采集器 1 分钟一次），这条会误挡一分钟。
  if (!hasUserInScope(caller, asUser)) {
    throw new AccessDenied(
      `${asUser} 在${label(caller)}里没有发言记录，没法确认这句话是这个人说的。` +
        `刚进群的话等一分钟（采集器每分钟入库一次）再问。`
    );
  }

  // 6. 默认：只给他自己在那个群说过的话。
  if (!hasUserInScope(scope, asUser)) {
    throw new AccessDenied(
      `${asUser} 在${label(scope)}里没有说话记录，没有属于他的内容可以给你。` +
        `别人的发言不跨群提供。如果这两个群本来就是同一拨人，让管理员在 relations.json 里加一条互通。`
    );
  }
  return { mode: 'self-only', filterUser: asUser, redact: true };
}
