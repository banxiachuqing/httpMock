// 端口默认命名：创建端口时名称选填，留空则按「前缀-序号」自动生成。
// 前缀按端口类型区分：http→API，其余取类型大写（ws→WS、tcp→TCP、udp→UDP、syslog→SYSLOG）。
// 名称仅作展示标签：不要求唯一、不是标识符（端口号才是唯一标识）。

const PREFIX_BY_TYPE = {
  http: 'API',
  ws: 'WS',
  tcp: 'TCP',
  udp: 'UDP',
  syslog: 'SYSLOG',
};

/** 端口类型对应的默认名前缀（http 特判为 API，其余取类型大写）。 */
export function portNamePrefix(type) {
  return PREFIX_BY_TYPE[type] || String(type).toUpperCase();
}

/**
 * 生成该类型下一个默认名：扫描现有端口名中符合「前缀-数字」的，取最大序号 +1；无则从 1 起。
 * 各前缀序号相互独立（API 与 WS 各自编号）；忽略用户自定义名与不符格式的名字。
 * @param {Array<{name?: string}>} ports 现有端口实体
 * @param {string} type 端口类型
 * @returns {string}
 */
export function nextPortName(ports, type) {
  const prefix = portNamePrefix(type);
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const p of ports || []) {
    const m = re.exec(p?.name ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}
