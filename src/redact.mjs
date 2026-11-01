// 输出脱敏：跨会话引用时，把能定位到具体人的强标识打掉。
//
// 不打 QQ 号：群里的消息本来就带昵称和号码，打码等于制造假信息，
// 而且 QQ 号是纯数字、和手机号/长数字串长度重叠，规则一多就误伤。
// 打的是「泄露了就真有后果」的那几类：手机、身份证、银行卡、邮箱。

const RULES = [
  // 18 位身份证，末位可以是 X
  [/(?<!\d)(\d{6})\d{8}(\d{3}[\dXx])(?!\d)/g, '$1********$2'],
  // 16–19 位银行卡 / 长数字串
  [/(?<!\d)(\d{4})\d{8,11}(\d{4})(?!\d)/g, '$1********$2'],
  // 11 位手机号
  [/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, '$1****$2'],
  // 邮箱：留首字母和域名
  [/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***$2'],
];

export function redact(text) {
  let s = String(text == null ? '' : text);
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s;
}

export function redactHit(hit) {
  return { ...hit, text: redact(hit.text) };
}
