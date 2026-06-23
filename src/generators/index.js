// 生成器白名单注册表 —— 服务端单一来源
// 输出类型语义见 specs/2026-06-23-dynamic-response-generator-design.md §3、§4
import { faker, fakerEN, fakerZH_CN } from '@faker-js/faker';

/**
 * @typedef {'string' | 'number' | 'boolean' | 'date'} OutputType
 * @typedef {{ name: string, type: 'int'|'float'|'string'|'locale', default?: any, min?: number, max?: number }} ArgSpec
 * @typedef {{ category: string, label: string, outputType: OutputType, args: ArgSpec[], run: (a: Record<string, any>) => any }} GeneratorDef
 */

/** @type {Record<string, GeneratorDef>} */
export const GENERATORS = {
  // ─── string ────────────────────────────────────────────
  uuid: {
    category: 'string', label: 'UUID v4', outputType: 'string', args: [],
    run: () => faker.string.uuid(),
  },
  'string.alphanumeric': {
    category: 'string', label: '字母数字串', outputType: 'string',
    args: [{ name: 'length', type: 'int', default: 10, min: 1, max: 64 }],
    run: ({ length }) => faker.string.alphanumeric(length),
  },
  'string.nanoid': {
    category: 'string', label: 'Nano ID', outputType: 'string',
    args: [{ name: 'length', type: 'int', default: 21, min: 1, max: 64 }],
    run: ({ length }) => faker.string.nanoid(length),
  },
  'string.symbol': {
    category: 'string', label: '特殊符号', outputType: 'string',
    args: [{ name: 'count', type: 'int', default: 5, min: 1, max: 32 }],
    run: ({ count }) => faker.string.symbol(count),
  },

  // ─── lorem ─────────────────────────────────────────────
  'lorem.word': {
    category: 'lorem', label: '单词', outputType: 'string', args: [],
    run: () => faker.lorem.word(),
  },
  'lorem.sentence': {
    category: 'lorem', label: '句子', outputType: 'string',
    args: [{ name: 'words', type: 'int', default: 7, min: 1, max: 30 }],
    run: ({ words }) => faker.lorem.sentence(words),
  },
  'lorem.paragraph': {
    category: 'lorem', label: '段落', outputType: 'string',
    args: [{ name: 'sentences', type: 'int', default: 3, min: 1, max: 20 }],
    run: ({ sentences }) => faker.lorem.paragraph(sentences),
  },

  // ─── number ────────────────────────────────────────────
  int: {
    category: 'number', label: '整数', outputType: 'number',
    args: [
      { name: 'min', type: 'int', default: 0 },
      { name: 'max', type: 'int', default: 100 },
    ],
    run: ({ min, max }) => faker.number.int({ min, max }),
  },
  float: {
    category: 'number', label: '浮点数', outputType: 'number',
    args: [
      { name: 'min', type: 'float', default: 0 },
      { name: 'max', type: 'float', default: 1 },
      { name: 'fractionDigits', type: 'int', default: 2, min: 0, max: 10 },
    ],
    run: ({ min, max, fractionDigits }) =>
      faker.number.float({ min, max, fractionDigits }),
  },

  // ─── date ──────────────────────────────────────────────
  date: {
    category: 'date', label: 'ISO 日期时间', outputType: 'date', args: [],
    run: () => faker.date.anytime().toISOString(),
  },
  'date.recent': {
    category: 'date', label: '近期日期', outputType: 'date',
    args: [{ name: 'days', type: 'int', default: 7, min: 1, max: 365 }],
    run: ({ days }) => faker.date.recent({ days }).toISOString(),
  },
  'date.past': {
    category: 'date', label: '过去日期', outputType: 'date',
    args: [{ name: 'years', type: 'int', default: 1, min: 1, max: 100 }],
    run: ({ years }) => faker.date.past({ years }).toISOString(),
  },
  'date.future': {
    category: 'date', label: '未来日期', outputType: 'date',
    args: [{ name: 'years', type: 'int', default: 1, min: 1, max: 100 }],
    run: ({ years }) => faker.date.future({ years }).toISOString(),
  },

  // ─── person ────────────────────────────────────────────
  'person.fullName': {
    category: 'person', label: '姓名', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).person.fullName(),
  },
  'person.firstName': {
    category: 'person', label: '名', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).person.firstName(),
  },
  'person.lastName': {
    category: 'person', label: '姓', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).person.lastName(),
  },
  'person.gender': {
    category: 'person', label: '性别', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).person.gender(),
  },
  'person.jobTitle': {
    category: 'person', label: '职业', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).person.jobTitle(),
  },

  // ─── phone ─────────────────────────────────────────────
  'phone.number': {
    category: 'phone', label: '电话号码', outputType: 'string',
    args: [{ name: 'format', type: 'string', default: 'national' }],
    run: ({ format }) => faker.phone.number({ style: format }),
  },

  // ─── internet ──────────────────────────────────────────
  'internet.email': {
    category: 'internet', label: '邮箱', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).internet.email(),
  },
  'internet.url': {
    category: 'internet', label: 'URL', outputType: 'string', args: [],
    run: () => faker.internet.url(),
  },
  'internet.domainName': {
    category: 'internet', label: '域名', outputType: 'string', args: [],
    run: () => faker.internet.domainName(),
  },
  'internet.ip': {
    category: 'internet', label: 'IP 地址', outputType: 'string', args: [],
    run: () => faker.internet.ipv4(),
  },
  'internet.userName': {
    category: 'internet', label: '用户名', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).internet.userName(),
  },
  'internet.password': {
    category: 'internet', label: '密码', outputType: 'string',
    args: [{ name: 'length', type: 'int', default: 12, min: 4, max: 64 }],
    run: ({ length }) => faker.internet.password({ length }),
  },

  // ─── image ─────────────────────────────────────────────
  'image.url': {
    category: 'image', label: '图像 URL', outputType: 'string',
    args: [
      { name: 'width', type: 'int', default: 640, min: 1, max: 4096 },
      { name: 'height', type: 'int', default: 480, min: 1, max: 4096 },
    ],
    run: ({ width, height }) => faker.image.url({ width, height }),
  },
  'image.avatar': {
    category: 'image', label: '头像 URL', outputType: 'string', args: [],
    run: () => faker.image.avatar(),
  },
  'image.dataUri': {
    category: 'image', label: '图像 Data URI', outputType: 'string',
    args: [
      { name: 'width', type: 'int', default: 100, min: 1, max: 1024 },
      { name: 'height', type: 'int', default: 100, min: 1, max: 1024 },
    ],
    run: ({ width, height }) => faker.image.dataUri({ width, height }),
  },

  // ─── location ──────────────────────────────────────────
  'location.street': {
    category: 'location', label: '街道', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).location.street(),
  },
  'location.city': {
    category: 'location', label: '城市', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).location.city(),
  },
  'location.country': {
    category: 'location', label: '国家', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).location.country(),
  },
  'location.zipCode': {
    category: 'location', label: '邮编', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).location.zipCode(),
  },
};

/** @type {{ id: string, label: string, generatorIds: string[] }[]} */
export const CATEGORIES = [
  { id: 'string',   label: '字符串/UUID等',         generatorIds: ['uuid', 'string.alphanumeric', 'string.nanoid', 'string.symbol'] },
  { id: 'lorem',    label: '单词/句子/段落等',       generatorIds: ['lorem.word', 'lorem.sentence', 'lorem.paragraph'] },
  { id: 'number',   label: '数值',                  generatorIds: ['int', 'float'] },
  { id: 'date',     label: '日期/时间相关',           generatorIds: ['date', 'date.recent', 'date.past', 'date.future'] },
  { id: 'person',   label: '姓名/性别/职业等个人资料', generatorIds: ['person.fullName', 'person.firstName', 'person.lastName', 'person.gender', 'person.jobTitle'] },
  { id: 'phone',    label: '电话/手机',              generatorIds: ['phone.number'] },
  { id: 'internet', label: '邮箱/网址/域名/IP/...',   generatorIds: ['internet.email', 'internet.url', 'internet.domainName', 'internet.ip', 'internet.userName', 'internet.password'] },
  { id: 'image',    label: '图像相关',               generatorIds: ['image.url', 'image.avatar', 'image.dataUri'] },
  { id: 'location', label: '地址/区域相关',           generatorIds: ['location.street', 'location.city', 'location.country', 'location.zipCode'] },
];

export const LOCALES = ['zh_CN', 'en'];

function pickFaker(locale) {
  if (locale === 'en') return fakerEN;
  return fakerZH_CN;
}

/**
 * 校验并合并参数，运行生成器。
 * @param {string} id
 * @param {Record<string, any>} args
 */
export function runGenerator(id, args = {}) {
  const def = GENERATORS[id];
  if (!def) throw new Error(`未知生成器：${id}`);
  const merged = {};
  for (const spec of def.args) {
    const raw = args[spec.name] !== undefined ? args[spec.name] : spec.default;
    if (raw === undefined || raw === null || raw === '') {
      if (spec.type === 'int') { merged[spec.name] = spec.default ?? 0; continue; }
      if (spec.type === 'float') { merged[spec.name] = spec.default ?? 0; continue; }
      merged[spec.name] = spec.default ?? '';
      continue;
    }
    if (spec.type === 'int') {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(`参数 ${spec.name} 必须是整数，得到 ${raw}`);
      if (spec.min !== undefined && n < spec.min) throw new Error(`参数 ${spec.name} 必须 ≥ ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) throw new Error(`参数 ${spec.name} 必须 ≤ ${spec.max}`);
      merged[spec.name] = n;
    } else if (spec.type === 'float') {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`参数 ${spec.name} 必须是数字，得到 ${raw}`);
      merged[spec.name] = n;
    } else {
      merged[spec.name] = String(raw);
    }
  }
  try {
    return def.run(merged);
  } catch (err) {
    throw new Error(`生成器 ${id} 执行失败：${err.message}`);
  }
}

export function listGenerators() {
  const out = [];
  for (const cat of CATEGORIES) {
    for (const gid of cat.generatorIds) {
      const g = GENERATORS[gid];
      let sample = null;
      try { sample = runGenerator(gid, {}); } catch { sample = null; }
      out.push({ category: cat.id, generator: { id: gid, ...g }, sample });
    }
  }
  return out;
}

export function getSample(id, partialArgs = {}) {
  try {
    return runGenerator(id, partialArgs);
  } catch {
    return null;
  }
}
