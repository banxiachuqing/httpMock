# WebService (SOAP/WSDL) Mock 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 HTTP mock 之上新增 SOAP/WSDL WebService mock：端口分类型（http/ws），WS 端口下同端口多服务按路径分，operation 按 SOAPAction/Body 路由，支持 ?wsdl 分发与动态值表达式。

**Architecture:** 数据模型 data.json v3（ports 加 type、新增 services 嵌套 operations）；mock-engine 按端口类型分流 handler（新增 `src/wsdl.js` WSDL 读写、`src/soap-router.js` 纯函数路由）；API 新增 `src/api-services.js`；前端方案 C 路由分层（`#/port/:p` 按类型分流，`#/port/:p/svc/:sid` 服务详情），页面范式全部复用。

**Tech Stack:** Node ≥18 纯 ESM JavaScript · Express 4 · 原生 node:http · fast-xml-parser（新依赖）· CodeMirror 6 +lang-xml（新 vendor）· vitest+supertest · Playwright headed。

**Spec:** `docs/superpowers/specs/2026-08-15-webservice-mock-design.md`（已批准）。

## Global Constraints

- 纯 JavaScript ESM（`"type": "module"`），无 TS、前端零构建；对齐各文件现有风格。
- 新依赖仅三个，全部进 `dependencies`：`fast-xml-parser`、`@codemirror/lang-xml`、`@lezer/xml`（vendor 静态服务要求 top-level，与现有 `@lezer/*` 显式列出同理）。
- 所有 API 错误走 `AppError(status, code, message)` + 既有错误中间件信封 `{error, code}`。
- `ConfigStore.update(mutator)` 是唯一写入入口；mutator 内改的是 `structuredClone` 的副本。
- 端口 `type` 创建后不可改；operation 匹配大小写敏感；禁用（`enabled:false`）的 service/operation 不提供服务，语义对齐现有 endpoints。
- commit message 用简体中文，格式 `<type>: <描述>`（feat/fix/test/docs/chore）。
- 单测/集成命令：`pnpm vitest run <file>`；全量：`pnpm test`。E2E：`pnpm playwright test <file>`，headed 不可切 headless。
- 改 `public/` 的任何文件，在最后一个任务统一同步 `embed-assets/`（不变量 5）。
- mock 引擎运行时错误不经过 Express 错误中间件，按 spec §7 表格处理。

---

### Task 1: 依赖安装 + data.json v3 迁移 + checkServiceUniqueness

**Files:**
- Modify: `package.json`（+3 dependencies）
- Modify: `src/config-store.js`（v3 默认配置、`_migrate` 链、`checkServiceUniqueness`）
- Modify: `test/unit/config-store-migration.test.js`（v2 断言升级 v3）
- Create: `test/unit/config-store-services.test.js`

**Interfaces:**
- Consumes: 无（地基任务）
- Produces: `ConfigStore.checkServiceUniqueness(services, excludeId?)`（Task 6 用）；config v3 形状 `{version:3, ports:[{port,enabled,type}], endpoints:[], services:[]}`（所有后续任务依赖）

- [ ] **Step 1: 安装依赖**

Run: `pnpm add fast-xml-parser @codemirror/lang-xml @lezer/xml`
Expected: package.json dependencies 多出三行；`node_modules/@lezer/xml` 存在于顶层（vendor 需要）。

- [ ] **Step 2: 更新迁移测试为 v3 期望（RED）**

把 `test/unit/config-store-migration.test.js` 整文件替换为：

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from '../../src/config-store.js';
import { tempDir } from '../helpers/temp-dir.js';

let dir;

beforeEach(() => { dir = tempDir('mock-migrate-'); });
afterEach(() => dir.cleanup());

function writeV1() {
  const v1 = {
    version: 1,
    settings: { storagePath: dir.path, uiPort: 5050, maxBodyBytes: 4194304 },
    endpoints: [
      { id: 'a', method: 'GET', port: 9090, path: '/b', statusCode: 200, response: {}, enabled: true },
      { id: 'b', method: 'GET', port: 8080, path: '/a', statusCode: 200, response: {}, enabled: true },
      { id: 'c', method: 'POST', port: 8080, path: '/c', statusCode: 201, response: {}, enabled: true },
    ],
  };
  fs.writeFileSync(path.join(dir.path, 'data.json'), JSON.stringify(v1));
}

describe('ConfigStore v1 → v3 迁移', () => {
  it('从端点派生 ports 并补 type/services，直达 v3', async () => {
    writeV1();
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.version).toBe(3);
    expect(store.config.ports).toEqual([
      { port: 8080, enabled: true, type: 'http' },
      { port: 9090, enabled: true, type: 'http' },
    ]);
    expect(store.config.services).toEqual([]);
  });

  it('迁移结果落盘', async () => {
    writeV1();
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir.path, 'data.json'), 'utf8'));
    expect(onDisk.version).toBe(3);
    expect(onDisk.ports).toHaveLength(2);
    expect(onDisk.services).toEqual([]);
  });

  it('v2 数据补 type 与 services', async () => {
    const v2 = {
      version: 2,
      settings: { storagePath: dir.path, uiPort: 5050, maxBodyBytes: 4194304 },
      ports: [{ port: 9999, enabled: false }],
      endpoints: [],
    };
    fs.writeFileSync(path.join(dir.path, 'data.json'), JSON.stringify(v2));
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.version).toBe(3);
    expect(store.config.ports).toEqual([{ port: 9999, enabled: false, type: 'http' }]);
    expect(store.config.services).toEqual([]);
  });

  it('v3 数据不动', async () => {
    const v3 = {
      version: 3,
      settings: { storagePath: dir.path, uiPort: 5050, maxBodyBytes: 4194304 },
      ports: [{ port: 9999, enabled: false, type: 'ws' }],
      endpoints: [],
      services: [{ id: 's1', port: 9999, path: '/ws/A', name: 'A', enabled: true, targetNamespace: 'urn:A', wsdl: null, operations: [] }],
    };
    fs.writeFileSync(path.join(dir.path, 'data.json'), JSON.stringify(v3));
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.ports).toEqual([{ port: 9999, enabled: false, type: 'ws' }]);
    expect(store.config.services).toHaveLength(1);
  });

  it('全新存储直接是 version 3 + 空 ports/services', async () => {
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.version).toBe(3);
    expect(store.config.ports).toEqual([]);
    expect(store.config.services).toEqual([]);
  });
});
```

新建 `test/unit/config-store-services.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { ConfigStore } from '../../src/config-store.js';

const store = new ConfigStore({ storagePath: '/nonexistent' });

function svc(id, port, path, enabled = true) {
  return { id, port, path, name: id, enabled, operations: [] };
}

describe('ConfigStore.checkServiceUniqueness', () => {
  it('(port, path) 冲突抛 DUPLICATE_SERVICE', () => {
    expect(() => store.checkServiceUniqueness([svc('a', 8082, '/ws/A'), svc('b', 8082, '/ws/A')]))
      .toThrowError(/duplicate service/);
  });

  it('不同端口同 path 不冲突', () => {
    expect(() => store.checkServiceUniqueness([svc('a', 8082, '/ws/A'), svc('b', 8083, '/ws/A')]))
      .not.toThrow();
  });

  it('禁用的服务不参与查重', () => {
    expect(() => store.checkServiceUniqueness([svc('a', 8082, '/ws/A'), svc('b', 8082, '/ws/A', false)]))
      .not.toThrow();
  });

  it('excludeId 排除自身（更新场景）', () => {
    expect(() => store.checkServiceUniqueness([svc('a', 8082, '/ws/A'), svc('b', 8082, '/ws/A')], 'b'))
      .not.toThrow();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run test/unit/config-store-migration.test.js test/unit/config-store-services.test.js`
Expected: FAIL（version 期望 3 实为 2；checkServiceUniqueness 不存在）

- [ ] **Step 4: 实现 v3 迁移 + checkServiceUniqueness**

`src/config-store.js` 三处修改：

1) 默认配置（`load()` 的 catch 分支里）改为：

```js
      this.config = {
        version: 3,
        settings: { storagePath: this.storagePath, uiPort: 5050, maxBodyBytes: 4 * 1024 * 1024, theme: 'system' },
        ports: [],
        endpoints: [],
        services: [],
      };
```

2) `_migrate` 替换为链式迁移：

```js
  _migrate(cfg) {
    let out = cfg;
    // v1 → v2：从端点派生 ports
    if (!Array.isArray(out.ports)) {
      const ports = [...new Set((out.endpoints || []).map((e) => e.port))]
        .sort((a, b) => a - b)
        .map((port) => ({ port, enabled: true }));
      out = { ...out, ports, version: 2 };
    }
    // v2 → v3：ports 补 type，补 services
    if (typeof out.version !== 'number' || out.version < 3) {
      out = {
        ...out,
        version: 3,
        ports: out.ports.map((p) => ({ type: 'http', ...p })),
        services: Array.isArray(out.services) ? out.services : [],
      };
    }
    return out;
  }
```

3) `checkUniqueness` 之后新增：

```js
  // WS 服务唯一性：(port, path) 在 enabled 服务间唯一（spec §3）
  checkServiceUniqueness(services, excludeId = null) {
    const seen = new Map();
    for (const s of services) {
      if (s.enabled === false) continue;
      if (excludeId && s.id === excludeId) continue;
      const key = `${s.port}|${s.path}`;
      if (seen.has(key)) {
        throw new AppError(400, 'DUPLICATE_SERVICE', `duplicate service ${s.path} on port ${s.port}`);
      }
      seen.set(key, s.id);
    }
  }
```

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `pnpm vitest run test/unit/config-store-migration.test.js test/unit/config-store-services.test.js test/unit/config-store.test.js test/unit/config-store-backup.test.js`
Expected: PASS（backup 测试若引用默认配置形状也应继续通过；若失败按实际断言对齐 v3 形状修正）

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/config-store.js test/unit/config-store-migration.test.js test/unit/config-store-services.test.js
git commit -m "feat: data.json v3 迁移（端口 type + services）与服务唯一性校验"
```

---

### Task 2: `src/wsdl.js` — WSDL 解析 / 骨架生成 / 地址重写

**Files:**
- Create: `src/wsdl.js`
- Test: `test/unit/wsdl.test.js`

**Interfaces:**
- Consumes: `fast-xml-parser`（Task 1 已装）、`AppError`（`src/errors.js`）
- Produces（Task 4、6 依赖）:
  - `parseWsdl(xmlText)` → `{targetNamespace: string, serviceName?: string, operations: [{name: string, soapAction: string|null}]}`；失败抛 `AppError(400, 'INVALID_WSDL', ...)`
  - `buildSkeletonWsdl(service, address)` → string（最小 doc/lit WSDL）
  - `rewriteAddress(wsdlText, address)` → string（纯正则改写 location 属性值）
  - `escapeXml(s)` → string

- [ ] **Step 1: 写失败测试**

`test/unit/wsdl.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { parseWsdl, buildSkeletonWsdl, rewriteAddress } from '../../src/wsdl.js';

const WSDL_11 = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:tns="http://example.com/user"
                  targetNamespace="http://example.com/user">
  <wsdl:types/>
  <wsdl:message name="getUserRequest"/>
  <wsdl:message name="getUserResponse"/>
  <wsdl:portType name="UserServicePortType">
    <wsdl:operation name="getUser">
      <wsdl:input message="tns:getUserRequest"/>
      <wsdl:output message="tns:getUserResponse"/>
    </wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="UserServiceBinding" type="tns:UserServicePortType">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
    <wsdl:operation name="getUser">
      <soap:operation soapAction="urn:getUser" style="document"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="UserService">
    <wsdl:port name="UserServicePort" binding="tns:UserServiceBinding">
      <soap:address location="http://real-server.example.com/ws/UserService"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`;

const WSDL_12 = WSDL_11
  .replaceAll('xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"', 'xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/"')
  .replaceAll('<soap:', '<soap12:').replaceAll('</soap:', '</soap12:')
  .replace('soapAction="urn:getUser"', 'soapAction="urn:getUser12"');

describe('parseWsdl', () => {
  it('解析 1.1 WSDL：targetNamespace + operation + soapAction', () => {
    const r = parseWsdl(WSDL_11);
    expect(r.targetNamespace).toBe('http://example.com/user');
    expect(r.serviceName).toBe('UserService');
    expect(r.operations).toEqual([{ name: 'getUser', soapAction: 'urn:getUser' }]);
  });

  it('解析 1.2 binding（soap12 前缀）', () => {
    const r = parseWsdl(WSDL_12);
    expect(r.operations).toEqual([{ name: 'getUser', soapAction: 'urn:getUser12' }]);
  });

  it('缺 soapAction 的 operation → soapAction 为 null', () => {
    const noAction = WSDL_11.replace(' soapAction="urn:getUser"', '');
    expect(parseWsdl(noAction).operations).toEqual([{ name: 'getUser', soapAction: null }]);
  });

  it('缺 targetNamespace → INVALID_WSDL', () => {
    const noTns = WSDL_11.replace(' targetNamespace="http://example.com/user"', '');
    expect(() => parseWsdl(noTns)).toThrowError(/targetNamespace/);
  });

  it('畸形 XML → INVALID_WSDL', () => {
    expect(() => parseWsdl('<definitions><unclosed>')).toThrowError(/WSDL/);
    expect(() => parseWsdl('not xml at all')).toThrowError(/WSDL/);
    expect(() => parseWsdl('')).toThrowError(/WSDL/);
  });

  it('非 WSDL 的合法 XML（无 definitions）→ INVALID_WSDL', () => {
    expect(() => parseWsdl('<foo/>')).toThrowError(/definitions/);
  });

  it('没有 portType → operations 空数组（不算错误）', () => {
    const noOps = WSDL_11.replace(/<wsdl:portType[\s\S]*<\/wsdl:portType>/, '');
    expect(parseWsdl(noOps).operations).toEqual([]);
  });
});

describe('rewriteAddress', () => {
  it('重写 soap:address location，其余字节不动', () => {
    const out = rewriteAddress(WSDL_11, 'http://127.0.0.1:8082/ws/UserService');
    expect(out).toContain('location="http://127.0.0.1:8082/ws/UserService"');
    expect(out).not.toContain('real-server.example.com');
  });

  it('soap12:address 也重写；多个 address 全重写', () => {
    const multi = WSDL_12.replace('</wsdl:service>',
      '    <wsdl:port name="P2" binding="tns:UserServiceBinding"><soap12:address location="http://other.example.com/x"/></wsdl:port>\n  </wsdl:service>');
    const out = rewriteAddress(multi, 'http://mock:1/ws/S');
    expect(out).not.toContain('real-server.example.com');
    expect(out).not.toContain('other.example.com');
    expect(out.match(/location="http:\/\/mock:1\/ws\/S"/g)).toHaveLength(2);
  });

  it('无 address 元素 → 原样返回', () => {
    expect(rewriteAddress('<definitions/>', 'http://x/y')).toBe('<definitions/>');
  });

  it('address 中的引号/尖括号被剔除（Host 头注入防护）', () => {
    const out = rewriteAddress(WSDL_11, 'http://evil/"><script>');
    expect(out).not.toContain('<script>');
  });
});

describe('buildSkeletonWsdl', () => {
  const service = {
    name: 'OrderService',
    targetNamespace: 'urn:order',
    operations: [
      { name: 'getOrder', soapAction: 'urn:getOrder', enabled: true },
      { name: 'listOrders', soapAction: null, enabled: true },
      { name: 'disabledOp', soapAction: null, enabled: false },
    ],
  };

  it('生成可被 parseWsdl 解析的骨架（含 address、不含禁用 operation）', () => {
    const xml = buildSkeletonWsdl(service, 'http://127.0.0.1:8082/ws/OrderService');
    expect(xml).toContain('location="http://127.0.0.1:8082/ws/OrderService"');
    const parsed = parseWsdl(xml);
    expect(parsed.targetNamespace).toBe('urn:order');
    expect(parsed.operations).toEqual([
      { name: 'getOrder', soapAction: 'urn:getOrder' },
      { name: 'listOrders', soapAction: 'listOrders' },
    ]);
  });

  it('targetNamespace 含特殊字符时转义', () => {
    const xml = buildSkeletonWsdl({ ...service, targetNamespace: 'urn:a&b"c' }, 'http://h/ws/S');
    expect(xml).toContain('urn:a&amp;b&quot;c');
  });
});
```

注意第二个 skeleton 断言：operation 无 soapAction 时骨架写 `soapAction="{name}"`（兜底用操作名），所以 parse 回来是 `'listOrders'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/wsdl.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/wsdl.js**

```js
// WSDL 三件事（spec §4）：解析 / 骨架生成 / 地址重写
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppError } from './errors.js';

function arr(x) {
  return x == null ? [] : Array.isArray(x) ? x : [x];
}

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 解析 WSDL，提取 targetNamespace / serviceName / operation 列表。
 * 统一开 removeNSPrefix：wsdl:/soap:/soap12: 等前缀全部归一；
 * soapAction 取 binding.operation 下嵌套 soap:operation 的 @_soapAction（文档序首个有效值）。
 * @param {string} xmlText
 * @returns {{ targetNamespace: string, serviceName?: string, operations: Array<{name: string, soapAction: string|null}> }}
 */
export function parseWsdl(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) {
    throw new AppError(400, 'INVALID_WSDL', 'WSDL must be a non-empty string');
  }
  const valid = XMLValidator.validate(xmlText);
  if (valid !== true) {
    throw new AppError(400, 'INVALID_WSDL', `WSDL XML 解析失败: ${valid.err.msg} (line ${valid.err.line})`);
  }
  const doc = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
  }).parse(xmlText);

  const defs = doc?.definitions;
  if (!defs || typeof defs !== 'object') {
    throw new AppError(400, 'INVALID_WSDL', '缺少 definitions 根元素，不是有效的 WSDL');
  }
  const targetNamespace = defs['@_targetNamespace'];
  if (!targetNamespace) {
    throw new AppError(400, 'INVALID_WSDL', 'definitions 缺少 targetNamespace');
  }

  const names = [];
  for (const pt of arr(defs.portType)) {
    for (const op of arr(pt?.operation)) {
      const n = op?.['@_name'];
      if (n && !names.includes(n)) names.push(n);
    }
  }
  const actionByName = new Map();
  for (const b of arr(defs.binding)) {
    for (const op of arr(b?.operation)) {
      const n = op?.['@_name'];
      if (!n || actionByName.has(n)) continue;
      const soapOp = arr(op.operation)[0]; // soap:operation / soap12:operation（removeNSPrefix 后同名）
      const action = soapOp?.['@_soapAction'];
      if (action) actionByName.set(n, action);
    }
  }
  const serviceName = arr(defs.service)[0]?.['@_name'];
  return {
    targetNamespace,
    ...(serviceName ? { serviceName } : {}),
    operations: names.map((name) => ({ name, soapAction: actionByName.get(name) || null })),
  };
}

/**
 * 重写 WSDL 原文里所有 soap:address / soap12:address 的 location 属性值。
 * 纯正则替换，不重建 XML 树（其余字节原样保留）。address 先做 Host 头注入防护。
 */
export function rewriteAddress(wsdlText, address) {
  const safe = String(address).replace(/["'<>&\s]/g, '');
  return wsdlText.replace(
    /(<(?:[A-Za-z_][\w.-]*:)?address\b[^>]*?\blocation\s*=\s*")[^"]*(")/g,
    (_m, p1, p2) => p1 + safe + p2,
  );
}

/**
 * 手工服务（无导入 WSDL）的 ?wsdl 响应：由 operations 反推最小 doc/lit 骨架。
 * 类型统一占位 xsd:anyType；operation 无 soapAction 时用操作名兜底。
 */
export function buildSkeletonWsdl(service, address) {
  const tns = escapeXml(service.targetNamespace || `urn:${service.name || 'service'}`);
  const svcName = escapeXml(service.name || 'Service');
  const ops = (service.operations || []).filter((o) => o.enabled !== false);

  const messages = ops.map((o) =>
    `  <wsdl:message name="${escapeXml(o.name)}Request"><wsdl:part name="parameters" type="xsd:anyType"/></wsdl:message>\n` +
    `  <wsdl:message name="${escapeXml(o.name)}Response"><wsdl:part name="parameters" type="xsd:anyType"/></wsdl:message>`,
  ).join('\n');

  const portTypeOps = ops.map((o) =>
    `    <wsdl:operation name="${escapeXml(o.name)}">\n` +
    `      <wsdl:input message="tns:${escapeXml(o.name)}Request"/>\n` +
    `      <wsdl:output message="tns:${escapeXml(o.name)}Response"/>\n` +
    `    </wsdl:operation>`,
  ).join('\n');

  const bindingOps = ops.map((o) =>
    `      <wsdl:operation name="${escapeXml(o.name)}">\n` +
    `        <soap:operation soapAction="${escapeXml(o.soapAction || o.name)}" style="document"/>\n` +
    `        <wsdl:input><soap:body use="literal"/></wsdl:input>\n` +
    `        <wsdl:output><soap:body use="literal"/></wsdl:output>\n` +
    `      </wsdl:operation>`,
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                  xmlns:tns="${tns}"
                  targetNamespace="${tns}">
  <wsdl:types>
    <xsd:schema targetNamespace="${tns}" elementFormDefault="qualified"/>
  </wsdl:types>
${messages}
  <wsdl:portType name="${svcName}PortType">
${portTypeOps}
  </wsdl:portType>
  <wsdl:binding name="${svcName}Binding" type="tns:${svcName}PortType">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
${bindingOps}
  </wsdl:binding>
  <wsdl:service name="${svcName}">
    <wsdl:port name="${svcName}Port" binding="tns:${svcName}Binding">
      <soap:address location="${escapeXml(address)}"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/wsdl.test.js`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add src/wsdl.js test/unit/wsdl.test.js
git commit -m "feat: WSDL 解析/骨架生成/地址重写模块"
```

---

### Task 3: `src/soap-router.js` — SOAP 版本识别 / 操作名提取 / 匹配 / Fault 生成

**Files:**
- Create: `src/soap-router.js`
- Test: `test/unit/soap-router.test.js`

**Interfaces:**
- Consumes: `fast-xml-parser`、`escapeXml`（`src/wsdl.js`，Task 2）
- Produces（Task 4 依赖）:
  - `detectSoapVersion(contentType)` → `'1.1' | '1.2'`
  - `extractAction(headers)` → `string | null`（node http 的 req.headers，键已小写）
  - `isWellFormedXml(text)` → boolean
  - `extractBodyOperation(bodyText)` → `string | null`（Body 第一个子元素 localName）
  - `matchOperation(service, action, bodyName)` → operation 对象 | null
  - `buildFaultXml(version, kind, message)` → string；kind ∈ `'client' | 'server'`

- [ ] **Step 1: 写失败测试**

`test/unit/soap-router.test.js`：

```js
import { describe, it, expect } from 'vitest';
import {
  detectSoapVersion,
  extractAction,
  isWellFormedXml,
  extractBodyOperation,
  matchOperation,
  buildFaultXml,
} from '../../src/soap-router.js';

describe('detectSoapVersion', () => {
  it('application/soap+xml → 1.2', () => {
    expect(detectSoapVersion('application/soap+xml; charset=utf-8; action="urn:x"')).toBe('1.2');
  });
  it('text/xml 或空 → 1.1', () => {
    expect(detectSoapVersion('text/xml; charset=utf-8')).toBe('1.1');
    expect(detectSoapVersion(undefined)).toBe('1.1');
  });
});

describe('extractAction', () => {
  it('SOAPAction 头去引号去空白', () => {
    expect(extractAction({ soapaction: '"urn:getUser"' })).toBe('urn:getUser');
    expect(extractAction({ soapaction: '  "urn:a"  ' })).toBe('urn:a');
  });
  it('空 SOAPAction（""）视为未提供', () => {
    expect(extractAction({ soapaction: '""' })).toBeNull();
  });
  it('1.2 从 Content-Type action= 参数取', () => {
    expect(extractAction({ 'content-type': 'application/soap+xml; charset=utf-8; action="urn:list"' })).toBe('urn:list');
    expect(extractAction({ 'content-type': 'application/soap+xml; action=urn:plain' })).toBe('urn:plain');
  });
  it('SOAPAction 优先于 action= 参数', () => {
    expect(extractAction({ soapaction: '"urn:a"', 'content-type': 'application/soap+xml; action="urn:b"' })).toBe('urn:a');
  });
  it('都没有 → null', () => {
    expect(extractAction({ 'content-type': 'text/xml' })).toBeNull();
  });
});

describe('isWellFormedXml', () => {
  it('合法/非法/空', () => {
    expect(isWellFormedXml('<a/>')).toBe(true);
    expect(isWellFormedXml('<a>')).toBe(false);
    expect(isWellFormedXml('')).toBe(false);
    expect(isWellFormedXml('plain text')).toBe(false);
  });
});

describe('extractBodyOperation', () => {
  it('取 Body 第一个子元素 localName', () => {
    const body = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://example.com/user">
      <soap:Body><tns:getUser><tns:id>1</tns:id></tns:getUser></soap:Body></soap:Envelope>`;
    expect(extractBodyOperation(body)).toBe('getUser');
  });
  it('前缀无关（ns1/无前缀都一样）', () => {
    const b1 = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ns1:listUsers xmlns:ns1="urn:x"/></soapenv:Body></soapenv:Envelope>`;
    expect(extractBodyOperation(b1)).toBe('listUsers');
    const b2 = `<Envelope><Body><ping/></Body></Envelope>`;
    expect(extractBodyOperation(b2)).toBe('ping');
  });
  it('带 XML 声明与注释也能解析', () => {
    const b = `<?xml version="1.0"?><!-- c --><Envelope><Body><doIt/></Body></Envelope>`;
    expect(extractBodyOperation(b)).toBe('doIt');
  });
  it('畸形 XML / 空 Body → null', () => {
    expect(extractBodyOperation('<Envelope><Body>')).toBeNull();
    expect(extractBodyOperation('<Envelope><Body></Body></Envelope>')).toBeNull();
    expect(extractBodyOperation('')).toBeNull();
  });
});

describe('matchOperation', () => {
  const service = {
    operations: [
      { id: '1', name: 'getUser', soapAction: 'urn:getUser', enabled: true },
      { id: '2', name: 'listUsers', soapAction: null, enabled: true },
      { id: '3', name: 'ghost', soapAction: 'urn:ghost', enabled: false },
    ],
  };
  it('a. action 精确匹配 soapAction', () => {
    expect(matchOperation(service, 'urn:getUser', null)?.id).toBe('1');
  });
  it('b. action 末段匹配 name（urn:/路径/ 两种分隔）', () => {
    expect(matchOperation(service, 'urn:listUsers', null)?.id).toBe('2');
    expect(matchOperation(service, 'http://x.com/getUser', null)?.id).toBe('1');
  });
  it('c. Body localName 兜底', () => {
    expect(matchOperation(service, null, 'listUsers')?.id).toBe('2');
  });
  it('优先级：action 精确 > Body', () => {
    expect(matchOperation(service, 'urn:getUser', 'listUsers')?.id).toBe('1');
  });
  it('禁用 operation 跳过 → 未命中返回 null', () => {
    expect(matchOperation(service, 'urn:ghost', null)).toBeNull();
    expect(matchOperation(service, null, 'ghost')).toBeNull();
  });
  it('全未命中 → null', () => {
    expect(matchOperation(service, 'urn:nope', 'nope')).toBeNull();
  });
});

describe('buildFaultXml', () => {
  it('1.1 server → faultcode soap:Server', () => {
    const xml = buildFaultXml('1.1', 'server', 'no mock for operation X');
    expect(xml).toContain('http://schemas.xmlsoap.org/soap/envelope/');
    expect(xml).toContain('<faultcode>soap:Server</faultcode>');
    expect(xml).toContain('<faultstring>no mock for operation X</faultstring>');
  });
  it('1.1 client → soap:Client', () => {
    expect(buildFaultXml('1.1', 'client', 'bad')).toContain('<faultcode>soap:Client</faultcode>');
  });
  it('1.2 → Code/Reason 结构，server=Receiver client=Sender', () => {
    const xml = buildFaultXml('1.2', 'server', 'oops');
    expect(xml).toContain('http://www.w3.org/2003/05/soap-envelope');
    expect(xml).toContain('<soap:Value>soap:Receiver</soap:Value>');
    expect(buildFaultXml('1.2', 'client', 'bad')).toContain('<soap:Value>soap:Sender</soap:Value>');
  });
  it('message 转义', () => {
    expect(buildFaultXml('1.1', 'server', 'a<b>&"c"')).toContain('a&lt;b&gt;&amp;&quot;c&quot;');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/soap-router.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/soap-router.js**

```js
// SOAP 请求侧纯函数（spec §4）：版本识别 / 操作名提取 / operation 匹配 / Fault 生成
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { escapeXml } from './wsdl.js';

/** @returns {'1.1'|'1.2'} */
export function detectSoapVersion(contentType) {
  return /application\/soap\+xml/i.test(contentType || '') ? '1.2' : '1.1';
}

/**
 * 提取 SOAPAction：1.1 看 SOAPAction 头；1.2 看 Content-Type 的 action= 参数。
 * 去引号去空白；空字符串视为未提供。
 * @param {Record<string, string|string[]|undefined>} headers node http req.headers（键已小写）
 * @returns {string|null}
 */
export function extractAction(headers) {
  const soapAction = headers['soapaction'];
  if (typeof soapAction === 'string') {
    const v = soapAction.trim().replace(/^"|"$/g, '').trim();
    if (v) return v;
  }
  const ct = String(headers['content-type'] || '');
  const m = /(?:^|;)\s*action\s*=\s*"([^"]*)"/i.exec(ct)
    || /(?:^|;)\s*action\s*=\s*([^\s;]+)/i.exec(ct);
  if (m) {
    const v = m[1].trim();
    if (v) return v;
  }
  return null;
}

export function isWellFormedXml(text) {
  if (!text || !text.trim()) return false;
  return XMLValidator.validate(text) === true;
}

/**
 * 取 SOAP Body 第一个子元素的 localName（removeNSPrefix，前缀无关）。
 * 解析失败 / 无 Body / 空 Body → null。
 */
export function extractBodyOperation(bodyText) {
  if (!bodyText || !bodyText.trim()) return null;
  let doc;
  try {
    doc = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
    }).parse(bodyText);
  } catch {
    return null;
  }
  const body = doc?.Envelope?.Body;
  if (!body || typeof body !== 'object') return null;
  for (const k of Object.keys(body)) {
    if (!k.startsWith('@_') && k !== '#text') return k;
  }
  return null;
}

function actionTail(action) {
  const i = Math.max(action.lastIndexOf(':'), action.lastIndexOf('/'));
  return i >= 0 ? action.slice(i + 1) : action;
}

/**
 * 匹配优先级（spec §4）：a. action 精确 = o.soapAction；b. action 末段 = o.name；c. Body localName = o.name。
 * 禁用 operation 跳过；大小写敏感精确比较。
 */
export function matchOperation(service, action, bodyName) {
  const ops = (service.operations || []).filter((o) => o.enabled !== false);
  if (action) {
    const exact = ops.find((o) => o.soapAction && o.soapAction === action);
    if (exact) return exact;
    const tail = actionTail(action);
    if (tail && tail !== action) {
      const byName = ops.find((o) => o.name === tail);
      if (byName) return byName;
    } else if (tail) {
      const byName = ops.find((o) => o.name === tail);
      if (byName) return byName;
    }
  }
  if (bodyName) return ops.find((o) => o.name === bodyName) || null;
  return null;
}

/**
 * 生成版本对应的 SOAP Fault。kind: 'client'（1.1 soap:Client / 1.2 soap:Sender）
 * 或 'server'（1.1 soap:Server / 1.2 soap:Receiver）。
 */
export function buildFaultXml(version, kind, message) {
  const msg = escapeXml(message);
  if (version === '1.2') {
    const value = kind === 'client' ? 'soap:Sender' : 'soap:Receiver';
    return `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><soap:Fault><soap:Code><soap:Value>${value}</soap:Value></soap:Code><soap:Reason><soap:Text xml:lang="zh-CN">${msg}</soap:Text></soap:Reason></soap:Fault></soap:Body></soap:Envelope>`;
  }
  const code = kind === 'client' ? 'soap:Client' : 'soap:Server';
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>${code}</faultcode><faultstring>${msg}</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/soap-router.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/soap-router.js test/unit/soap-router.test.js
git commit -m "feat: SOAP 路由纯函数（版本识别/操作名提取/匹配/Fault）"
```

---
### Task 4: mock-engine WS 处理器

**Files:**
- Modify: `src/mock-engine.js`（start 第三参、handler 分流、createWsHandler）
- Test: `test/unit/mock-engine-ws.test.js`（新建；既有 `mock-engine.test.js` 不动——第三参可选，旧调用兼容）

**Interfaces:**
- Consumes: `src/soap-router.js` 全部导出、`src/wsdl.js` 的 `buildSkeletonWsdl/rewriteAddress`（Task 2/3）
- Produces: `MockEngine.start(endpoints, ports, services)`（Task 6 的 api.js 调用点按此传参）；log 条目新增 `serviceId/operationName` 字段（Task 13 前端日志列依赖）

- [ ] **Step 1: 写失败测试**

`test/unit/mock-engine-ws.test.js`：

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { MockEngine } from '../../src/mock-engine.js';

function req({ port, path, method = 'GET', body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let respBody = '';
      res.on('data', (c) => (respBody += c));
      res.on('end', () => resolve({ status: res.statusCode, body: respBody, headers: res.headers }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

const SOAP11_ENV = (inner) =>
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;

const USER_SERVICE = {
  id: 'svc1',
  port: 18090,
  path: '/ws/UserService',
  name: 'UserService',
  enabled: true,
  targetNamespace: 'http://example.com/user',
  wsdl: null,
  operations: [
    {
      id: 'op1', name: 'getUser', soapAction: 'urn:getUser', enabled: true,
      responseType: 'normal', status: 200,
      responseXml: SOAP11_ENV('<tns:getUserResponse xmlns:tns="http://example.com/user"><tns:name>张三</tns:name></tns:getUserResponse>'),
    },
    {
      id: 'op2', name: 'deleteUser', soapAction: null, enabled: true,
      responseType: 'fault', status: 200,
      responseXml: SOAP11_ENV('<soap:Fault><faultcode>soap:Server</faultcode><faultstring>denied</faultstring></soap:Fault>'),
    },
    {
      id: 'op3', name: 'emptyOp', soapAction: null, enabled: true,
      responseType: 'normal', status: 200, responseXml: '',
    },
    {
      id: 'op4', name: 'ghost', soapAction: null, enabled: false,
      responseType: 'normal', status: 200, responseXml: SOAP11_ENV('<ghostResponse/>'),
    },
  ],
};

const IMPORTED_WSDL = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:tns="http://example.com/order" targetNamespace="http://example.com/order">
  <wsdl:service name="OrderService"><wsdl:port name="p" binding="tns:b">
    <soap:address location="http://real-server.example.com/ws/OrderService"/></wsdl:port></wsdl:service>
</wsdl:definitions>`;

const ORDER_SERVICE = {
  id: 'svc2', port: 18090, path: '/ws/OrderService', name: 'OrderService', enabled: true,
  targetNamespace: 'http://example.com/order', wsdl: IMPORTED_WSDL, operations: [],
};

const PORTS = [{ port: 18090, enabled: true, type: 'ws' }];
const SERVICES = [USER_SERVICE, ORDER_SERVICE];

let engine;
let pushedLogs;

beforeEach(() => { pushedLogs = []; });
afterEach(async () => { if (engine) await engine.stop(); });

async function startWs() {
  engine = new MockEngine({ logBuffer: { push: (e) => pushedLogs.push(e) } });
  const r = await engine.start([], PORTS, SERVICES);
  expect(r.failed).toEqual([]);
}

describe('MockEngine WS：?wsdl', () => {
  it('手工服务 → 返回骨架 WSDL（含 mock 地址）', async () => {
    await startWs();
    const r = await req({ port: 18090, path: '/ws/UserService?wsdl' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/xml/);
    expect(r.body).toContain('targetNamespace="http://example.com/user"');
    expect(r.body).toContain('location="http://127.0.0.1:18090/ws/UserService"');
    expect(r.body).toContain('name="getUser"');
  });

  it('导入 WSDL → 地址重写为 mock 地址', async () => {
    await startWs();
    const r = await req({ port: 18090, path: '/ws/OrderService?WSDL' }); // 查询键大小写不敏感
    expect(r.status).toBe(200);
    expect(r.body).toContain('location="http://127.0.0.1:18090/ws/OrderService"');
    expect(r.body).not.toContain('real-server.example.com');
  });

  it('无 ?wsdl 的 GET → 404 带 hint', async () => {
    await startWs();
    const r = await req({ port: 18090, path: '/ws/UserService' });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).hint).toMatch(/\?wsdl/);
  });
});

describe('MockEngine WS：POST 路由', () => {
  it('SOAPAction 头匹配', async () => {
    await startWs();
    const r = await req({
      port: 18090, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml', soapaction: '"urn:getUser"' },
      body: SOAP11_ENV('<tns:anything xmlns:tns="urn:x"/>'),
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('getUserResponse');
    expect(r.headers['content-type']).toMatch(/text\/xml/);
  });

  it('Body localName 回退（无 SOAPAction）', async () => {
    await startWs();
    const r = await req({
      port: 18090, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: SOAP11_ENV('<getUser xmlns="http://example.com/user"><id>1</id></getUser>'),
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('getUserResponse');
  });

  it('1.2 请求：action= 参数路由，响应 Content-Type 为 application/soap+xml', async () => {
    await startWs();
    const r = await req({
      port: 18090, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'application/soap+xml; charset=utf-8; action="urn:getUser"' },
      body: SOAP11_ENV('<whatever/>').replaceAll('http://schemas.xmlsoap.org/soap/envelope/', 'http://www.w3.org/2003/05/soap-envelope'),
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('getUserResponse');
    expect(r.headers['content-type']).toMatch(/application\/soap\+xml/);
  });

  it('responseType=fault → 500 + 用户 Fault XML', async () => {
    await startWs();
    const r = await req({
      port: 18090, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: SOAP11_ENV('<deleteUser/>'),
    });
    expect(r.status).toBe(500);
    expect(r.body).toContain('<faultstring>denied</faultstring>');
  });

  it('未命中 operation → 500 Server Fault；禁用 operation 按未命中处理', async () => {
    await startWs();
    const r = await req({
      port: 18090, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: SOAP11_ENV('<noSuchOp/>'),
    });
    expect(r.status).toBe(500);
    expect(r.body).toContain('<faultcode>soap:Server</faultcode>');
    expect(r.body).toContain('no mock for operation noSuchOp');

    const g = await req({
      port: 18090, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: SOAP11_ENV('<ghost/>'),
    });
    expect(g.status).toBe(500);
    expect(g.body).toContain('no mock for operation ghost');
  });

  it('1.2 未命中 → Receiver Fault', async () => {
    await startWs();
    const r = await req({
      port: 18090, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'application/soap+xml' },
      body: `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nope/></soap:Body></soap:Envelope>`,
    });
    expect(r.status).toBe(500);
    expect(r.body).toContain('<soap:Value>soap:Receiver</soap:Value>');
  });

  it('responseXml 为空 → 500 Fault no response configured', async () => {
    await startWs();
    const r = await req({
      port: 18090, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: SOAP11_ENV('<emptyOp/>'),
    });
    expect(r.status).toBe(500);
    expect(r.body).toContain('operation emptyOp has no response configured');
  });

  it('畸形 XML：1.1 → 500 Client；1.2 → 400 Sender', async () => {
    await startWs();
    const bad = '<Envelope><Body><unclosed>';
    const r11 = await req({
      port: 18090, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' }, body: bad,
    });
    expect(r11.status).toBe(500);
    expect(r11.body).toContain('soap:Client');

    const r12 = await req({
      port: 18090, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'application/soap+xml' }, body: bad,
    });
    expect(r12.status).toBe(400);
    expect(r12.body).toContain('soap:Sender');
  });

  it('path 未命中 → 404 JSON', async () => {
    await startWs();
    const r = await req({ port: 18090, path: '/ws/Nope', method: 'POST', headers: { 'content-type': 'text/xml' }, body: '<x/>' });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).error).toMatch(/no mock/);
  });
});

describe('MockEngine WS：日志', () => {
  it('命中写 serviceId + operationName；未命中 operationName 为尝试名', async () => {
    await startWs();
    await req({
      port: 18090, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: SOAP11_ENV('<getUser/>'),
    });
    await req({
      port: 18090, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: SOAP11_ENV('<noSuchOp/>'),
    });
    const hit = pushedLogs.find((l) => l.matched === true);
    const miss = pushedLogs.find((l) => l.matched === false && l.method === 'POST');
    expect(hit.serviceId).toBe('svc1');
    expect(hit.operationName).toBe('getUser');
    expect(miss.serviceId).toBe('svc1');
    expect(miss.operationName).toBe('noSuchOp');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/mock-engine-ws.test.js`
Expected: FAIL（ws 端口未实现，18090 无监听 / ECONNREFUSED）

- [ ] **Step 3: 实现 mock-engine WS 分流**

`src/mock-engine.js` 修改：

1) 顶部 import 增加：

```js
import {
  detectSoapVersion,
  extractAction,
  isWellFormedXml,
  extractBodyOperation,
  matchOperation,
  buildFaultXml,
} from './soap-router.js';
import { buildSkeletonWsdl, rewriteAddress } from './wsdl.js';
```

2) `start` 签名改为 `async start(endpoints, ports = null, services = [])`，循环体内（`for (const [port, eps] of byPort.entries())` 里）把 `const router = buildRouter(eps); const server = http.createServer(async (req, res) => {...})` 改为按类型分流：

```js
    for (const [port, eps] of byPort.entries()) {
      const portEntity = Array.isArray(ports) ? ports.find((p) => p.port === port) : null;
      const getMax = () => this.configStore?.config?.settings?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
      const handler = portEntity?.type === 'ws'
        ? createWsHandler({ port, services: services.filter((s) => s.port === port), logBuffer: this.logBuffer, getMax })
        : createHttpHandler({ port, router: buildRouter(eps), logBuffer: this.logBuffer, getMax });
      const server = http.createServer(handler);
```

（`this.servers.set(port, { server, router })` 处 ws 分支没有 router，统一改成 `this.servers.set(port, { server })` —— router 无其他消费方。）

3) 把原内联 handler 提取为模块级函数（逻辑原样，仅参数化）：

```js
function createHttpHandler({ port, router, logBuffer, getMax }) {
  return async (req, res) => {
    const start = Date.now();
    const url = req.url || '/';
    const [pathOnly, queryStr = ''] = url.split('?');
    const matched = router.get(`${port}|${req.method}|${pathOnly}`);

    const { body, truncated } = await readBody(req, getMax());

    if (matched) {
      res.statusCode = matched.statusCode || 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      let responseBody;
      try {
        const { value } = resolve(matched.response);
        responseBody = JSON.stringify(value);
      } catch (err) {
        logBuffer?.push({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          level: 'warn',
          source: 'resolver',
          message: `resolver failed: ${err.message}`,
          endpointId: matched.id,
        });
        responseBody = JSON.stringify(matched.response ?? null);
      }
      res.end(responseBody);
    } else {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `no mock for ${req.method} ${pathOnly}` }));
    }

    logBuffer?.push({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      method: req.method,
      path: pathOnly,
      query: queryStr,
      port,
      status: res.statusCode,
      durationMs: Date.now() - start,
      matched: !!matched,
      endpointId: matched?.id || null,
      requestHeaders: req.headers,
      requestBodyPreview: body,
      requestBodyTruncated: truncated,
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress
          || '',
    });
  };
}
```

4) 新增 WS handler（模块级）。注意实现形态：函数开头统一 `await readBody`（GET 的 body 为空字符串，无害），结果挂到 `req.__wsBody/__wsTruncated` 供日志用；末尾一次 `logRequest()`，无提前 return：

```js
// WS 端口请求处理（spec §4）：?wsdl 分发 + SOAP POST 路由；错误不抛，全部转 Fault/404
function createWsHandler({ port, services, logBuffer, getMax }) {
  const byPath = new Map();
  for (const s of services) {
    if (s.enabled !== false) byPath.set(s.path, s);
  }

  return async (req, res) => {
    const start = Date.now();
    const url = req.url || '/';
    const qi = url.indexOf('?');
    const pathOnly = qi < 0 ? url : url.slice(0, qi);
    const queryStr = qi < 0 ? '' : url.slice(qi + 1);
    const service = byPath.get(pathOnly);

    let matched = false;
    let operationName = null;

    const sendXml = (status, xml, version) => {
      res.statusCode = status;
      res.setHeader('Content-Type', version === '1.2'
        ? 'application/soap+xml; charset=utf-8'
        : 'text/xml; charset=utf-8');
      res.end(xml);
    };
    const send404 = (hint) => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `no mock for ${req.method} ${pathOnly}`, ...(hint ? { hint } : {}) }));
    };

    const { body, truncated } = await readBody(req, getMax());

    if (service && req.method === 'GET') {
      const wantsWsdl = queryStr.toLowerCase().split('&')
        .some((p) => p === 'wsdl' || p.startsWith('wsdl='));
      if (wantsWsdl) {
        matched = true;
        operationName = '?wsdl';
        const host = String(req.headers.host || `127.0.0.1:${port}`).replace(/["'<>&\s]/g, '');
        const address = `http://${host}${service.path}`;
        const xml = service.wsdl
          ? rewriteAddress(service.wsdl, address)
          : buildSkeletonWsdl(service, address);
        sendXml(200, xml, '1.1');
      } else {
        send404('SOAP endpoint, POST requests only; append ?wsdl for WSDL');
      }
    } else if (service && req.method === 'POST') {
      const version = detectSoapVersion(req.headers['content-type']);
      if (!isWellFormedXml(body)) {
        sendXml(version === '1.2' ? 400 : 500,
          buildFaultXml(version, 'client', 'request body is not well-formed XML'), version);
      } else {
        const action = extractAction(req.headers);
        const bodyName = extractBodyOperation(body);
        operationName = bodyName || action || null;
        const op = matchOperation(service, action, bodyName);
        if (!op) {
          sendXml(500, buildFaultXml(version, 'server',
            `no mock for operation ${operationName || '(unknown)'}`), version);
        } else {
          matched = true;
          operationName = op.name;
          if (op.responseType === 'fault') {
            sendXml(500, renderXmlResponse(op.responseXml, logBuffer, op.id), version);
          } else if (!op.responseXml || !op.responseXml.trim()) {
            sendXml(500, buildFaultXml(version, 'server',
              `operation ${op.name} has no response configured`), version);
          } else {
            sendXml(op.status || 200, renderXmlResponse(op.responseXml, logBuffer, op.id), version);
          }
        }
      }
    } else {
      send404();
    }

    logBuffer?.push({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      method: req.method,
      path: pathOnly,
      query: queryStr,
      port,
      status: res.statusCode,
      durationMs: Date.now() - start,
      matched,
      serviceId: service?.id || null,
      operationName,
      requestHeaders: req.headers,
      requestBodyPreview: body,
      requestBodyTruncated: truncated,
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress
          || '',
    });
  };
}
```

5) `renderXmlResponse`（模块级，对齐 HTTP 路径的 resolver-warn 行为）：

```js
// 字符串走 resolve 的混合模式替换；失败保留原文 + warn 日志（对齐 HTTP JSON 路径）
function renderXmlResponse(text, logBuffer, operationId) {
  const { value, errors } = resolve(text ?? '');
  for (const e of errors) {
    logBuffer?.push({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      level: 'warn',
      source: 'resolver',
      message: `resolver failed: ${e.message}`,
      operationId,
    });
  }
  return typeof value === 'string' ? value : String(value);
}
```

- [ ] **Step 4: 跑新测试 + 既有引擎测试**

Run: `pnpm vitest run test/unit/mock-engine-ws.test.js test/unit/mock-engine.test.js`
Expected: 全部 PASS（既有测试验证 HTTP 路径提取后行为不变）

- [ ] **Step 5: Commit**

```bash
git add src/mock-engine.js test/unit/mock-engine-ws.test.js
git commit -m "feat: mock 引擎 WS 端口处理器（?wsdl 分发 + SOAP 路由 + Fault）"
```

---

### Task 5: api-ports 端口类型 + services 级联

**Files:**
- Modify: `src/api-ports.js`（POST 收 type、PUT 拒改 type + 改号级联 services、DELETE 连带删 services）
- Modify: `test/integration/api-ports.test.js`（断言加 type 字段 + 新增级联用例）

**Interfaces:**
- Consumes: config v3（Task 1）
- Produces: `POST /api/ports` 接受 `{port, type?}`，响应体含 `type`（Task 9 前端 `api.createPort(port, type)` 依赖）

- [ ] **Step 1: 更新既有断言 + 新增失败测试（RED）**

`test/integration/api-ports.test.js` 的既有断言全部把 `{ port: 8080, enabled: true }` 改为 `{ port: 8080, enabled: true, type: 'http' }`（含 `toEqual` 的每一处，含 list 断言）。

在文件末尾追加 describe：

```js
describe('端口类型（v3）', () => {
  it('POST 显式 type=ws', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 8090, type: 'ws' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ port: 8090, enabled: true, type: 'ws' });
  });

  it('POST 非法 type → INVALID_VALUE', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 8091, type: 'grpc' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_VALUE');
  });

  it('PUT 传 type → FIELD_IMMUTABLE', async () => {
    await ctx.request.post('/api/ports').send({ port: 8092 });
    const r = await ctx.request.put('/api/ports/8092').send({ type: 'ws' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('FIELD_IMMUTABLE');
  });

  it('改号级联 services', async () => {
    await ctx.request.post('/api/ports').send({ port: 8093, type: 'ws' });
    await store.update((cfg) => {
      cfg.services = [{ id: 's1', port: 8093, path: '/ws/A', name: 'A', enabled: true, targetNamespace: 'urn:A', wsdl: null, operations: [] }];
      return cfg;
    });
    await ctx.request.put('/api/ports/8093').send({ port: 8094 });
    expect(store.config.services[0].port).toBe(8094);
  });

  it('删除端口连带删 services，不动其他端口', async () => {
    await ctx.request.post('/api/ports').send({ port: 8095, type: 'ws' });
    await store.update((cfg) => {
      cfg.services = [
        { id: 's1', port: 8095, path: '/ws/A', name: 'A', enabled: true, targetNamespace: 'urn:A', wsdl: null, operations: [] },
        { id: 's2', port: 9999, path: '/ws/B', name: 'B', enabled: true, targetNamespace: 'urn:B', wsdl: null, operations: [] },
      ];
      return cfg;
    });
    await ctx.request.delete('/api/ports/8095');
    expect(store.config.services.map((s) => s.id)).toEqual(['s2']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/api-ports.test.js`
Expected: FAIL（响应体无 type / FIELD_IMMUTABLE 未实现 / 级联未实现）

- [ ] **Step 3: 实现 api-ports.js 修改**

1) POST 路由改为：

```js
  app.post('/api/ports', async (req, res, next) => {
    try {
      const port = parsePortNumber(req.body?.port);
      const type = req.body?.type ?? 'http';
      if (!['http', 'ws'].includes(type)) {
        throw new AppError(400, 'INVALID_VALUE', "type must be 'http' | 'ws'");
      }
      if (configStore.config.ports.some((p) => p.port === port)) {
        throw new AppError(400, 'DUPLICATE_PORT', `port ${port} already exists`);
      }
      const entity = { port, enabled: true, type };
      await configStore.update((cfg) => {
        cfg.ports = sorted([...cfg.ports, entity]);
        return cfg;
      });
      res.status(201).json(entity);
    } catch (e) { next(e); }
  });
```

2) PUT 路由：解构后加不可变校验；update 的 mutator 里加 services 级联：

```js
      const { port: newPortRaw, enabled, type } = req.body || {};
      if (type !== undefined) {
        throw new AppError(400, 'FIELD_IMMUTABLE', 'port type cannot be changed');
      }
```

```js
        if (newPort !== oldPort) {
          cfg.endpoints = cfg.endpoints.map((e) =>
            e.port === oldPort ? { ...e, port: newPort } : e);
          cfg.services = (cfg.services || []).map((s) =>
            s.port === oldPort ? { ...s, port: newPort } : s);
        }
```

3) DELETE 路由的 mutator 加：

```js
        cfg.services = (cfg.services || []).filter((s) => s.port !== port);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/integration/api-ports.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api-ports.js test/integration/api-ports.test.js
git commit -m "feat: 端口类型字段（http/ws）与 services 级联"
```

---

### Task 6: `src/api-services.js` + api.js 接线

**Files:**
- Create: `src/api-services.js`
- Modify: `src/api.js`（挂载路由、endpoints 类型约束、ensurePortEntity 带 type、config strip、runtime start 传 services）
- Test: `test/integration/api-services.test.js`（新建）、`test/integration/api-endpoints.test.js`（加 PORT_TYPE_MISMATCH 用例）、`test/integration/api-config.test.js`（加 strip 用例）

**Interfaces:**
- Consumes: `parseWsdl`（Task 2）、`checkServiceUniqueness`（Task 1）、config v3
- Produces:
  - `registerServiceRoutes(app, { configStore })`（api.js 挂载）
  - `toPublicService(s)` → 去掉 `wsdl`、加 `hasWsdl`（api.js 的 `GET/PATCH /api/config` 复用）
  - 路由：`POST /api/wsdl/parse`；`POST/PUT/DELETE /api/services[/:id]`；`POST /api/services/:id/wsdl`；`POST/PUT/DELETE /api/services/:id/operations[/:opId]`
  - service 对象形状：spec §3（operations 路由返回**整个 publicService**，前端整体替换）

- [ ] **Step 1: 写失败测试**

`test/integration/api-services.test.js`：

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '../../src/config-store.js';
import { buildApp } from '../helpers/test-server.js';
import { tempDir } from '../helpers/temp-dir.js';

let dir, store, ctx;

beforeEach(async () => {
  dir = tempDir('mock-svc-');
  store = new ConfigStore({ storagePath: dir.path });
  await store.load();
  ctx = buildApp({
    storagePath: dir.path,
    configStore: store,
    logBuffer: { push: () => {}, subscribe: () => () => {} },
    mockEngine: { start: async () => ({ running: [], failed: [] }), stop: async () => {}, getStatus: () => ({}), servers: new Map() },
  });
});

afterEach(() => dir.cleanup());

const MINI_WSDL = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:tns="urn:user" targetNamespace="urn:user">
  <wsdl:portType name="P"><wsdl:operation name="getUser"/><wsdl:operation name="listUsers"/></wsdl:portType>
  <wsdl:binding name="B" type="tns:P">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
    <wsdl:operation name="getUser"><soap:operation soapAction="urn:getUser"/></wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="UserService"><wsdl:port name="pp" binding="tns:B"><soap:address location="http://x/ws/U"/></wsdl:port></wsdl:service>
</wsdl:definitions>`;

async function createWsPort(port = 8082) {
  await ctx.request.post('/api/ports').send({ port, type: 'ws' });
}

describe('POST /api/services', () => {
  it('创建服务：自动补建 ws 端口；响应不含 wsdl 字段', async () => {
    const r = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/UserService', name: 'UserService' });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeTruthy();
    expect(r.body.hasWsdl).toBe(false);
    expect(r.body.wsdl).toBeUndefined();
    expect(r.body.targetNamespace).toBe('urn:UserService');
    expect(r.body.operations).toEqual([]);
    expect(store.config.ports).toEqual([{ port: 8082, enabled: true, type: 'ws' }]);
  });

  it('往 http 端口建服务 → PORT_TYPE_MISMATCH', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    const r = await ctx.request.post('/api/services').send({ port: 8080, path: '/ws/A' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PORT_TYPE_MISMATCH');
  });

  it('(port, path) 冲突 → DUPLICATE_SERVICE；禁用服务不挡', async () => {
    await createWsPort();
    await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A' });
    const dup = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A' });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('DUPLICATE_SERVICE');
  });

  it('path 含 ? → INVALID_PATH', async () => {
    const r = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A?x' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_PATH');
  });

  it('带 wsdl 创建：解析出 operations + targetNamespace', async () => {
    const r = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/U', wsdl: MINI_WSDL });
    expect(r.status).toBe(201);
    expect(r.body.hasWsdl).toBe(true);
    expect(r.body.targetNamespace).toBe('urn:user');
    expect(r.body.operations.map((o) => o.name)).toEqual(['getUser', 'listUsers']);
    expect(r.body.operations[0].soapAction).toBe('urn:getUser');
    expect(r.body.operations[0].responseXml).toContain('getUserResponse');
  });

  it('wsdl 畸形 → INVALID_WSDL', async () => {
    const r = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/U', wsdl: '<bad' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_WSDL');
  });
});

describe('PUT /api/services/:id', () => {
  it('改 path/name/enabled/targetNamespace；传 port → FIELD_IMMUTABLE', async () => {
    await createWsPort();
    const c = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A', name: 'A' });
    const id = c.body.id;
    const r = await ctx.request.put(`/api/services/${id}`).send({ path: '/ws/B', name: 'B', enabled: false, targetNamespace: 'urn:b' });
    expect(r.status).toBe(200);
    expect(r.body.path).toBe('/ws/B');
    expect(r.body.name).toBe('B');
    expect(r.body.enabled).toBe(false);
    expect(r.body.targetNamespace).toBe('urn:b');

    const imm = await ctx.request.put(`/api/services/${id}`).send({ port: 9999 });
    expect(imm.status).toBe(400);
    expect(imm.body.code).toBe('FIELD_IMMUTABLE');
  });

  it('改 path 撞车 → DUPLICATE_SERVICE', async () => {
    await createWsPort();
    await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A' });
    const b = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/B' });
    const r = await ctx.request.put(`/api/services/${b.body.id}`).send({ path: '/ws/A' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DUPLICATE_SERVICE');
  });
});

describe('POST /api/services/:id/wsdl（导入合并）', () => {
  it('同名保留响应配置、新增补默认、多余保留不删', async () => {
    await createWsPort();
    const c = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/U' });
    const id = c.body.id;
    // 手工先建一个 getUser（带自定义响应）和一个 manualOp
    await ctx.request.post(`/api/services/${id}/operations`).send({ name: 'getUser' });
    await ctx.request.post(`/api/services/${id}/operations`).send({ name: 'manualOp' });
    let svc = (await ctx.request.get('/api/config')).body.services.find((s) => s.id === id);
    const getUserOp = svc.operations.find((o) => o.name === 'getUser');
    await ctx.request.put(`/api/services/${id}/operations/${getUserOp.id}`).send({ responseXml: '<custom/>', soapAction: 'urn:custom' });

    const r = await ctx.request.post(`/api/services/${id}/wsdl`).send({ wsdl: MINI_WSDL });
    expect(r.status).toBe(200);
    const ops = r.body.operations.map((o) => o.name);
    expect(ops).toContain('getUser');
    expect(ops).toContain('listUsers');   // 新增
    expect(ops).toContain('manualOp');    // 保留
    const merged = r.body.operations.find((o) => o.name === 'getUser');
    expect(merged.responseXml).toBe('<custom/>');          // 响应配置保留
    expect(merged.soapAction).toBe('urn:getUser');         // soapAction 被 WSDL 更新
    expect(r.body.targetNamespace).toBe('urn:user');
    expect(r.body.hasWsdl).toBe(true);
  });
});

describe('operations CRUD', () => {
  it('新建查重 / 更新 / 删除', async () => {
    await createWsPort();
    const c = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/U' });
    const id = c.body.id;

    const add = await ctx.request.post(`/api/services/${id}/operations`).send({ name: 'getUser', soapAction: 'urn:g' });
    expect(add.status).toBe(201);
    const op = add.body.operations.find((o) => o.name === 'getUser');
    expect(op.soapAction).toBe('urn:g');
    expect(op.responseType).toBe('normal');

    const dup = await ctx.request.post(`/api/services/${id}/operations`).send({ name: 'getUser' });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('DUPLICATE_OPERATION');

    const upd = await ctx.request.put(`/api/services/${id}/operations/${op.id}`)
      .send({ responseType: 'fault', status: 500, responseXml: '<f/>', enabled: false });
    expect(upd.status).toBe(200);
    const updOp = upd.body.operations.find((o) => o.id === op.id);
    expect(updOp.responseType).toBe('fault');
    expect(updOp.enabled).toBe(false);

    const badType = await ctx.request.put(`/api/services/${id}/operations/${op.id}`).send({ responseType: 'weird' });
    expect(badType.status).toBe(400);

    const del = await ctx.request.delete(`/api/services/${id}/operations/${op.id}`);
    expect(del.status).toBe(200);
    expect(del.body.operations).toEqual([]);
  });
});

describe('POST /api/wsdl/parse', () => {
  it('解析预览不落库', async () => {
    const r = await ctx.request.post('/api/wsdl/parse').send({ wsdl: MINI_WSDL });
    expect(r.status).toBe(200);
    expect(r.body.targetNamespace).toBe('urn:user');
    expect(r.body.operations).toHaveLength(2);
    expect(store.config.services ?? []).toEqual([]);
  });

  it('畸形 → INVALID_WSDL', async () => {
    const r = await ctx.request.post('/api/wsdl/parse').send({ wsdl: 'nope' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_WSDL');
  });
});

describe('GET /api/config strip', () => {
  it('services[].wsdl 不返回，替换为 hasWsdl', async () => {
    await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/U', wsdl: MINI_WSDL });
    const cfg = (await ctx.request.get('/api/config')).body;
    const svc = cfg.services.find((s) => s.path === '/ws/U');
    expect(svc.wsdl).toBeUndefined();
    expect(svc.hasWsdl).toBe(true);
    // 存储层仍是完整 wsdl
    expect(store.config.services.find((s) => s.path === '/ws/U').wsdl).toBe(MINI_WSDL);
  });
});
```

`test/integration/api-endpoints.test.js` 追加用例（找个现有 describe 外新增）：

```js
describe('端口类型约束', () => {
  it('往 ws 端口建 endpoint → PORT_TYPE_MISMATCH', async () => {
    await ctx.request.post('/api/ports').send({ port: 8082, type: 'ws' });
    const r = await ctx.request.post('/api/endpoints').send({ method: 'GET', port: 8082, path: '/x', response: {} });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PORT_TYPE_MISMATCH');
  });

  it('往 http 端口（或新端口）建 endpoint 正常，补建的端口带 type:http', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ method: 'GET', port: 8088, path: '/x', response: {} });
    expect(r.status).toBe(201);
    expect(store.config.ports.find((p) => p.port === 8088)).toEqual({ port: 8088, enabled: true, type: 'http' });
  });
});
```

注意：先读该文件确认 `ctx`/`store` 变量名与 setup 形状（应与 api-ports.test.js 同款）；不一致就按该文件实际调整。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/api-services.test.js test/integration/api-endpoints.test.js test/integration/api-config.test.js`
Expected: FAIL（路由不存在）

- [ ] **Step 3: 实现 src/api-services.js**

```js
// /api/services + /api/wsdl —— WebService 一等实体（spec §5）
import crypto from 'node:crypto';
import { AppError } from './errors.js';
import { parseWsdl } from './wsdl.js';

const MAX_NAME_LENGTH = 50;

function validateServiceName(body) {
  if (body.name === undefined) return;
  if (typeof body.name !== 'string') {
    throw new AppError(400, 'INVALID_NAME', 'name must be a string');
  }
  if (body.name.trim().length > MAX_NAME_LENGTH) {
    throw new AppError(400, 'INVALID_NAME', `name must be at most ${MAX_NAME_LENGTH} chars`);
  }
}

function validateServicePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new AppError(400, 'INVALID_PATH', 'path must start with /');
  }
  if (path.includes('?')) {
    throw new AppError(400, 'INVALID_PATH', 'path must not contain ?');
  }
}

function parsePortNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(400, 'INVALID_PORT', 'port must be 1..65535');
  }
  return port;
}

/** 响应层脱敏：wsdl 原文不随 API 返回（可能几十 KB），替换为 hasWsdl 标志 */
export function toPublicService(s) {
  const { wsdl, ...rest } = s;
  return { ...rest, hasWsdl: typeof wsdl === 'string' && wsdl.length > 0 };
}

function defaultResponseXml(name, tns) {
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n  <soap:Body>\n    <tns:${name}Response xmlns:tns="${tns}">\n      <!-- TODO: 响应字段 -->\n    </tns:${name}Response>\n  </soap:Body>\n</soap:Envelope>`;
}

function defaultOperation(name, soapAction, tns) {
  return {
    id: crypto.randomUUID(),
    name,
    soapAction: soapAction || null,
    responseType: 'normal',
    status: 200,
    responseXml: defaultResponseXml(name, tns),
    enabled: true,
  };
}

function findService(cfg, id) {
  const svc = (cfg.services || []).find((s) => s.id === id);
  if (!svc) throw new AppError(404, 'NOT_FOUND', 'service not found');
  return svc;
}

// WS 服务引用的端口：已是 http 型 → 冲突；不存在 → 补建 ws 端口实体
function ensureWsPortEntity(cfg, port) {
  const existing = cfg.ports.find((p) => p.port === port);
  if (existing) {
    if (existing.type !== 'ws') {
      throw new AppError(400, 'PORT_TYPE_MISMATCH', `port ${port} is an http port`);
    }
    return;
  }
  cfg.ports = [...cfg.ports, { port, enabled: true, type: 'ws' }].sort((a, b) => a.port - b.port);
}

export function registerServiceRoutes(app, { configStore }) {
  // WSDL 解析预览（不落库，导入弹窗第一步）
  app.post('/api/wsdl/parse', (req, res, next) => {
    try {
      res.json(parseWsdl(req.body?.wsdl));
    } catch (e) { next(e); }
  });

  app.post('/api/services', async (req, res, next) => {
    try {
      const body = req.body || {};
      const port = parsePortNumber(body.port);
      validateServicePath(body.path);
      validateServiceName(body);
      let wsdl = null;
      let parsed = null;
      if (body.wsdl !== undefined && body.wsdl !== null) {
        if (typeof body.wsdl !== 'string') {
          throw new AppError(400, 'INVALID_WSDL', 'wsdl must be a string');
        }
        parsed = parseWsdl(body.wsdl);
        wsdl = body.wsdl;
      }
      const name = typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : body.path.split('/').pop();
      const targetNamespace = parsed?.targetNamespace
        || (typeof body.targetNamespace === 'string' && body.targetNamespace.trim())
        || `urn:${name}`;
      const service = {
        id: crypto.randomUUID(),
        port,
        path: body.path,
        name,
        enabled: body.enabled !== false,
        targetNamespace,
        wsdl,
        operations: (parsed?.operations || []).map((o) => defaultOperation(o.name, o.soapAction, targetNamespace)),
      };
      const all = [...(configStore.config.services || []), service];
      configStore.checkServiceUniqueness(all);
      await configStore.update((cfg) => {
        cfg.services = all;
        ensureWsPortEntity(cfg, port);
        return cfg;
      });
      res.status(201).json(toPublicService(service));
    } catch (e) { next(e); }
  });

  app.put('/api/services/:id', async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.port !== undefined) {
        throw new AppError(400, 'FIELD_IMMUTABLE', 'service port cannot be changed');
      }
      validateServiceName(body);
      if (body.path !== undefined) validateServicePath(body.path);
      let updated;
      await configStore.update((cfg) => {
        const list = cfg.services || [];
        const idx = list.findIndex((s) => s.id === req.params.id);
        if (idx < 0) throw new AppError(404, 'NOT_FOUND', 'service not found');
        const cur = list[idx];
        updated = { ...cur };
        if (body.name !== undefined && body.name.trim()) updated.name = body.name.trim();
        if (body.path !== undefined) updated.path = body.path;
        if (body.enabled !== undefined) updated.enabled = body.enabled !== false;
        if (body.targetNamespace !== undefined) updated.targetNamespace = String(body.targetNamespace);
        const all = [...list];
        all[idx] = updated;
        if (body.path !== undefined && body.path !== cur.path) {
          configStore.checkServiceUniqueness(all, req.params.id);
        }
        cfg.services = all;
        return cfg;
      });
      res.json(toPublicService(updated));
    } catch (e) { next(e); }
  });

  app.delete('/api/services/:id', async (req, res, next) => {
    try {
      const list = configStore.config.services || [];
      if (!list.some((s) => s.id === req.params.id)) {
        throw new AppError(404, 'NOT_FOUND', 'service not found');
      }
      await configStore.update((cfg) => {
        cfg.services = (cfg.services || []).filter((s) => s.id !== req.params.id);
        return cfg;
      });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  // 导入/替换 WSDL：合并 operations（同名保留响应配置仅更新 soapAction；新增补默认；多余保留）
  app.post('/api/services/:id/wsdl', async (req, res, next) => {
    try {
      const { wsdl } = req.body || {};
      const parsed = parseWsdl(wsdl);
      let updated;
      await configStore.update((cfg) => {
        const svc = findService(cfg, req.params.id);
        const incoming = new Map(parsed.operations.map((p) => [p.name, p]));
        const merged = svc.operations.map((o) =>
          incoming.has(o.name)
            ? { ...o, soapAction: incoming.get(o.name).soapAction ?? o.soapAction }
            : o);
        for (const p of parsed.operations) {
          if (!merged.some((o) => o.name === p.name)) {
            merged.push(defaultOperation(p.name, p.soapAction, parsed.targetNamespace));
          }
        }
        svc.wsdl = wsdl;
        svc.targetNamespace = parsed.targetNamespace;
        svc.operations = merged;
        updated = svc;
        return cfg;
      });
      res.json(toPublicService(updated));
    } catch (e) { next(e); }
  });

  app.post('/api/services/:id/operations', async (req, res, next) => {
    try {
      const { name, soapAction } = req.body || {};
      if (typeof name !== 'string' || !name.trim()) {
        throw new AppError(400, 'INVALID_NAME', 'operation name required');
      }
      let updated;
      await configStore.update((cfg) => {
        const svc = findService(cfg, req.params.id);
        const trimmed = name.trim();
        if (svc.operations.some((o) => o.name === trimmed)) {
          throw new AppError(400, 'DUPLICATE_OPERATION', `duplicate operation ${trimmed}`);
        }
        const action = typeof soapAction === 'string' && soapAction.trim() ? soapAction.trim() : null;
        svc.operations = [...svc.operations, defaultOperation(trimmed, action, svc.targetNamespace)];
        updated = svc;
        return cfg;
      });
      res.status(201).json(toPublicService(updated));
    } catch (e) { next(e); }
  });

  app.put('/api/services/:id/operations/:opId', async (req, res, next) => {
    try {
      const body = req.body || {};
      let updated;
      await configStore.update((cfg) => {
        const svc = findService(cfg, req.params.id);
        const idx = svc.operations.findIndex((o) => o.id === req.params.opId);
        if (idx < 0) throw new AppError(404, 'NOT_FOUND', 'operation not found');
        const cur = svc.operations[idx];
        const nextOp = { ...cur };
        if (body.name !== undefined) {
          if (typeof body.name !== 'string' || !body.name.trim()) {
            throw new AppError(400, 'INVALID_NAME', 'operation name required');
          }
          const trimmed = body.name.trim();
          if (trimmed !== cur.name && svc.operations.some((o) => o.name === trimmed)) {
            throw new AppError(400, 'DUPLICATE_OPERATION', `duplicate operation ${trimmed}`);
          }
          nextOp.name = trimmed;
        }
        if (body.soapAction !== undefined) {
          nextOp.soapAction = typeof body.soapAction === 'string' && body.soapAction.trim()
            ? body.soapAction.trim()
            : null;
        }
        if (body.responseType !== undefined) {
          if (!['normal', 'fault'].includes(body.responseType)) {
            throw new AppError(400, 'INVALID_VALUE', "responseType must be 'normal' | 'fault'");
          }
          nextOp.responseType = body.responseType;
        }
        if (body.status !== undefined) {
          const st = Number(body.status);
          if (!Number.isInteger(st) || st < 100 || st > 599) {
            throw new AppError(400, 'INVALID_VALUE', 'status must be 100..599');
          }
          nextOp.status = st;
        }
        if (body.responseXml !== undefined) {
          if (typeof body.responseXml !== 'string') {
            throw new AppError(400, 'INVALID_VALUE', 'responseXml must be a string');
          }
          nextOp.responseXml = body.responseXml;
        }
        if (body.enabled !== undefined) nextOp.enabled = body.enabled !== false;
        svc.operations = [...svc.operations.slice(0, idx), nextOp, ...svc.operations.slice(idx + 1)];
        updated = svc;
        return cfg;
      });
      res.json(toPublicService(updated));
    } catch (e) { next(e); }
  });

  app.delete('/api/services/:id/operations/:opId', async (req, res, next) => {
    try {
      let updated;
      await configStore.update((cfg) => {
        const svc = findService(cfg, req.params.id);
        if (!svc.operations.some((o) => o.id === req.params.opId)) {
          throw new AppError(404, 'NOT_FOUND', 'operation not found');
        }
        svc.operations = svc.operations.filter((o) => o.id !== req.params.opId);
        updated = svc;
        return cfg;
      });
      res.json(toPublicService(updated));
    } catch (e) { next(e); }
  });
}
```

- [ ] **Step 4: 修改 src/api.js 接线（5 处）**

1) import 区加：

```js
import { registerServiceRoutes, toPublicService } from './api-services.js';
```

2) `withNormalizedName` 后加 config 脱敏助手：

```js
// GET/PATCH /api/config 响应层：services[].wsdl 原文不随全量配置往返（spec §5）
function publicConfig(cfg) {
  return { ...cfg, services: (cfg.services || []).map(toPublicService) };
}
```

3) `GET /api/config` 改为 `res.json(publicConfig(configStore.config))`；`PATCH /api/config` 的 `res.json(configStore.config)` 改为 `res.json(publicConfig(configStore.config))`。

4) `ensurePortEntity` 补建带类型 + 新增 http 端口断言，endpoints POST/PUT 调用：

```js
// 端点引用的端口不在 ports 列表时自动补建（避免运行时静默跳过）
function ensurePortEntity(cfg, port) {
  if (!cfg.ports.some((p) => p.port === port)) {
    cfg.ports = [...cfg.ports, { port, enabled: true, type: 'http' }].sort((a, b) => a.port - b.port);
  }
}

// ws 型端口拒绝挂 HTTP 端点（spec §3 端口类型约束）
function assertHttpPort(cfg, port) {
  const p = cfg.ports.find((x) => x.port === port);
  if (p && p.type === 'ws') {
    throw new AppError(400, 'PORT_TYPE_MISMATCH', `port ${port} is a webservice port`);
  }
}
```

在 POST `/api/endpoints` 的 `configStore.checkUniqueness(all)` 之前加 `assertHttpPort(configStore.config, ep.port);`；PUT `/api/endpoints/:id` 同样在 checkUniqueness 前加 `assertHttpPort(configStore.config, updated.port);`。

5) runtime/start 传 services + 挂载 service 路由（`registerPortRoutes` 行之后）：

```js
      const result = await mockEngine.start(configStore.config.endpoints, configStore.config.ports, configStore.config.services || []);
```

```js
  // Ports CRUD（端口一等实体）
  registerPortRoutes(app, { configStore });

  // WebService services CRUD + WSDL 解析（spec §5）
  registerServiceRoutes(app, { configStore });
```

- [ ] **Step 5: 跑测试确认通过 + 全量集成回归**

Run: `pnpm vitest run test/integration/`
Expected: 全 PASS（注意 api.test.js / api-config.test.js 里若有对 config 精确形状的断言，按 v3 形状修正——大声失败原则：若有既有断言被改，列在 commit message 里）

- [ ] **Step 6: Commit**

```bash
git add src/api-services.js src/api.js test/integration/api-services.test.js test/integration/api-endpoints.test.js test/integration/api-config.test.js
git commit -m "feat: WebService services/operations CRUD 与 WSDL 导入 API"
```

---

### Task 7: api-preview 支持 format:'text'

**Files:**
- Modify: `src/api-preview.js`
- Test: `test/integration/api-preview.test.js`（追加用例）

**Interfaces:**
- Consumes: `resolve`（`src/expression-resolver.js`，字符串混合模式现成）
- Produces: `POST /api/preview` body 加可选 `format:'text'` → 响应 `{ok:true, resolved: string, exprCount, errors}`（Task 12 前端 `api.preview(text, 'text')` 依赖）

- [ ] **Step 1: 追加失败测试**

`test/integration/api-preview.test.js` 末尾追加：

```js
describe('POST /api/preview format:text（WS XML 预览）', () => {
  it('跳过 JSON.parse，直接字符串替换', async () => {
    const r = await ctx.request.post('/api/preview')
      .send({ text: '<name>{{$person.name}}</name>', format: 'text' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.resolved).toMatch(/^<name>.+<\/name>$/);
    expect(r.body.resolved).not.toContain('{{');
    expect(r.body.exprCount).toBe(1);
    expect(r.body.errors).toEqual([]);
  });

  it('非 JSON 文本不报错；未知生成器进 errors 且保留原文', async () => {
    const r = await ctx.request.post('/api/preview')
      .send({ text: '<a>{{$nope.x}}</a>', format: 'text' });
    expect(r.body.ok).toBe(true);
    expect(r.body.resolved).toBe('<a>{{$nope.x}}</a>');
    expect(r.body.errors).toHaveLength(1);
    expect(r.body.errors[0].code).toBe('UNKNOWN_GENERATOR');
  });
});
```

先看该文件现有 setup 的变量名（`ctx`/`request`），按实际调整。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/api-preview.test.js`
Expected: 新用例 FAIL（现状走 JSON.parse 报 json-parse 阶段错误）

- [ ] **Step 3: 实现**

`src/api-preview.js`：抽出错误序列化 + 加 text 分支：

```js
// ResolverError → plain object（ok=true 时不走错误中间件，需手动序列化）
function serializeErrors(errors) {
  return errors.map((e) => ({
    message: e.message,
    code: e.code,
    ...(e.generatorId !== undefined ? { generatorId: e.generatorId } : {}),
    ...(e.from !== undefined ? { from: e.from } : {}),
    ...(e.to !== undefined ? { to: e.to } : {}),
  }));
}
```

`POST /api/preview` 改为：

```js
  app.post('/api/preview', (req, res, next) => {
    try {
      const { text, format } = req.body || {};
      if (typeof text !== 'string') {
        throw new AppError(400, 'INVALID_TEXT', 'text must be a string');
      }
      // WS XML 预览：不做 JSON.parse，直接混合模式替换（spec §5）
      if (format === 'text') {
        const exprCount = countExpressions(text);
        const { value, errors } = resolve(text);
        return res.json({
          ok: true,
          resolved: typeof value === 'string' ? value : String(value),
          exprCount,
          errors: serializeErrors(errors),
        });
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (parseErr) {
        return res.json({ ok: false, stage: 'json-parse', error: parseErr.message, lastResolved: null });
      }
      const exprCount = countExpressions(text);
      const { value, errors } = resolve(parsed);
      res.json({ ok: true, resolved: value, exprCount, errors: serializeErrors(errors) });
    } catch (e) { next(e); }
  });
```

（原内联 errors.map 删除，统一用 serializeErrors。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/integration/api-preview.test.js`
Expected: 全 PASS（旧用例行为不变）

- [ ] **Step 5: Commit**

```bash
git add src/api-preview.js test/integration/api-preview.test.js
git commit -m "feat: /api/preview 支持 format:text（WS XML 动态值预览）"
```

---
### Task 8: 前端基建 — router / editor.js 多实例 / vendor / index.html DOM / styles

**Files:**
- Modify: `public/router.js`（service 路由）
- Modify: `public/editor.js`（createEditor 工厂 + XML 支持 + getActiveEditorView）
- Modify: `server.js`（vendor 静态服务 +lang-xml/@lezer/xml）
- Modify: `public/index.html`（importmap、新建端口类型 radio、WS 视图 DOM、两个新弹窗）
- Modify: `public/styles.css`（ws-port 网格模板 + 徽标样式）

**Interfaces:**
- Consumes: `@codemirror/lang-xml`、`@lezer/xml`（Task 1 已装）
- Produces:
  - `parseRoute` 支持 `{view:'service', port, serviceId}`（Task 13 app.js 依赖）
  - `createEditor({host, language, initialValue?, onChange?, onSelectionChange?})` → `{view, getValue, setValue, destroy}`；`getActiveEditorView()`（Task 12 ws-detail 依赖）
  - index.html 新增 DOM id 全集（后续任务通过 `els` 引用）

- [ ] **Step 1: router.js 加 service 路由**

`public/router.js` 替换 `parseRoute`：

```js
// hash 路由：#/ → 首页；#/port/<port> → 端口详情；#/port/<port>/svc/<serviceId> → WS 服务详情
export function parseRoute(hash) {
  const svc = /^#\/port\/(\d+)\/svc\/([\w-]+)$/.exec(hash || '');
  if (svc) return { view: 'service', port: Number(svc[1]), serviceId: svc[2] };
  const m = /^#\/port\/(\d+)$/.exec(hash || '');
  if (m) return { view: 'port', port: Number(m[1]) };
  return { view: 'home' };
}
```

- [ ] **Step 2: editor.js 重构为多实例工厂**

改动点（保持既有导出签名全部不变）：

1) import 区加 `import { xml } from '@codemirror/lang-xml';`

2) 单例 `host`/`view` 保留；新增注册表：

```js
// 所有 createEditor 实例（主题热切换遍历用）；activeView = 最近聚焦的编辑器（generator 插入目标）
const liveEditors = new Set();
let activeView = null;
```

3) `setEditorTheme` 改为遍历注册表：

```js
export function setEditorTheme(theme) {
  currentEditorTheme = theme === 'light' ? 'light' : 'dark';
  for (const v of liveEditors) {
    v.dispatch({ effects: themeCompartment.reconfigure(themeExtensions(currentEditorTheme, false)) });
  }
}
```

（`themeCompartment`/`currentEditorTheme` 声明保持不变；原 `if (view) ...` 单实例逻辑删除——JSON 主编辑器也走注册表。）

4) 新增 XML lint（lang-xml 不带解析校验，用浏览器原生 DOMParser）：

```js
// XML 语法检查：DOMParser 报 parsererror；尽量从报错文本提取行列定位
function xmlDomLinter(v) {
  const text = v.state.doc.toString();
  if (!text.trim()) return [];
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const err = doc.querySelector('parsererror');
  if (!err) return [];
  const m = /error on line (\d+) at column (\d+)/i.exec(err.textContent || '');
  let from = 0;
  if (m) {
    const line = v.state.doc.line(Math.min(Number(m[1]), v.state.doc.lines));
    from = Math.min(line.from + Number(m[2]) - 1, v.state.doc.length);
  }
  return [{ from, to: Math.min(from + 1, v.state.doc.length), severity: 'error', message: 'XML 语法错误' }];
}
```

5) 新增 `createEditor` + `getActiveEditorView`，`mountEditor` 改为薄封装：

```js
/**
 * 通用编辑器工厂（JSON 主编辑器之外的场景，如 WS XML 响应编辑）。
 * @param {{ host: HTMLElement, language?: 'json'|'xml', initialValue?: string,
 *   onChange?: (text: string) => void, onSelectionChange?: (state: any) => void }} opts
 */
export function createEditor({ host: hostEl, language = 'json', initialValue = '', onChange, onSelectionChange }) {
  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged && !window.__editorProgrammatic) onChange?.(u.state.doc.toString());
    if (u.selectionSet || u.docChanged) onSelectionChange?.(u.state);
  });
  const isXml = language === 'xml';
  const state = EditorState.create({
    doc: initialValue,
    extensions: [
      lineNumbers(),
      history(),
      bracketMatching(),
      indentOnInput(),
      isXml ? xml() : json(),
      linter(isXml ? xmlDomLinter : jsonParseLinter(), { delay: 200 }),
      lintGutter(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      themeCompartment.of(themeExtensions(currentEditorTheme, false)),
      EditorView.domEventHandlers({ focus: (_e, v) => { activeView = v; } }),
      updateListener,
    ],
  });
  const v = new EditorView({ state, parent: hostEl });
  liveEditors.add(v);
  activeView = v;
  return {
    view: v,
    getValue: () => v.state.doc.toString(),
    setValue: (text) => {
      window.__editorProgrammatic = true;
      try {
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
      } finally {
        queueMicrotask(() => { window.__editorProgrammatic = false; });
      }
    },
    destroy: () => {
      liveEditors.delete(v);
      if (activeView === v) activeView = null;
      v.destroy();
    },
  };
}

/** generator 模态框的插入目标：最近聚焦的编辑器，缺省 JSON 主编辑器 */
export function getActiveEditorView() {
  return activeView || view;
}
```

`mountEditor` 改为：

```js
export function mountEditor({ initialValue = '', onChange, onSelectionChange } = {}) {
  if (view) return view;
  const inst = createEditor({ host, language: 'json', initialValue, onChange, onSelectionChange });
  view = inst.view;
  return view;
}
```

（`getValue`/`setValue`/`getEditorView`/`mountReadonlyEditor` 保持原样。）

- [ ] **Step 3: server.js vendor 静态服务**

`server.js` 第 45 行 pkg 数组加 `'lang-xml'`：

```js
  for (const pkg of ['view', 'state', 'lang-json', 'lang-xml', 'lint', 'commands', 'language']) {
```

`transitiveMap` 加一行：

```js
    '@lezer/xml': '@lezer/xml',
```

- [ ] **Step 4: index.html — importmap + 新建端口类型 + WS 视图 DOM + 弹窗**

1) importmap：`"@codemirror/lang-json": ...` 行后加 `"@codemirror/lang-xml": "/vendor/codemirror/lang-xml/dist/index.js",`；`"@lezer/json": ...` 行后加 `"@lezer/xml": "/vendor/@lezer/xml/dist/index.js",`。

2) 新建端口弹窗（`#newPortModal` 的 `.modal-body` 内、`端口号` field 之前）加：

```html
        <div class="field field-wide">
          <label>类型</label>
          <div class="port-type-radios">
            <label><input type="radio" name="newPortType" value="http" checked /> HTTP 接口</label>
            <label><input type="radio" name="newPortType" value="ws" /> WebService (SOAP)</label>
          </div>
          <p class="field-hint">创建后类型不可更改。WebService 端口下按路径挂多个 SOAP 服务。</p>
        </div>
```

3) WS 端口服务网格视图：在 `<!-- 端口详情页页头 -->` 注释行之前插入：

```html
  <!-- WS 端口详情：服务卡片网格（渲染见 views/ws-services.js） -->
  <section class="home-view" id="viewWsPort" hidden>
    <div class="home-header">
      <h2 class="section-label">服务列表</h2>
      <span class="sidebar-count" id="serviceCardCount">0</span>
      <span class="home-hint">点击卡片进入服务详情</span>
    </div>
    <div class="port-card-grid" id="serviceCardGrid"></div>
  </section>

```

4) 服务详情页头：在 `<!-- hash 指向不存在端口时 -->` 注释行之前插入：

```html
  <!-- WS 服务详情页页头 -->
  <header class="port-header" id="serviceHeader" hidden>
    <button class="btn btn-ghost btn-sm" id="backToPortBtn">← 返回服务列表</button>
    <span class="port-header-number" id="serviceHeaderName">—</span>
    <span class="mono service-header-path" id="serviceHeaderPath">—</span>
    <label class="toggle">
      <input type="checkbox" id="serviceEnabledToggle" />
      <span class="toggle-label">启用</span>
    </label>
    <button class="btn btn-ghost btn-sm" id="importWsdlBtn">导入 WSDL</button>
    <button class="btn btn-ghost btn-sm" id="copyServiceAddrBtn">复制地址</button>
    <button class="btn btn-danger btn-sm" id="deleteServiceBtn">删除服务</button>
    <div class="spacer"></div>
  </header>

```

5) `<main class="layout">` 内：在 `<section class="editor" data-reveal="2" id="editor">` 之前插入 WS 侧栏；在 `</main>` 之前（editor `</section>` 之后）插入 WS 编辑器：

```html
    <aside class="sidebar" id="wsSidebarPanel" hidden>
      <div class="sidebar-header">
        <h2 class="section-label">操作列表</h2>
        <span class="sidebar-count" id="operationCount">0</span>
        <button class="btn btn-ghost btn-sm" id="newOperationBtn">
          <span class="plus">+</span> 新建
        </button>
      </div>
      <ul class="endpoint-list" id="operationList" role="listbox" aria-label="操作列表">
        <!-- populated by views/ws-detail.js -->
      </ul>
    </aside>

    <section class="editor" id="wsEditor" hidden>
      <div class="editor-empty" id="wsEditorEmpty">
        <div class="editor-empty-inner">
          <div class="editor-empty-mark">&lt;/&gt;</div>
          <h3 class="editor-empty-title">尚未选择操作</h3>
          <p class="editor-empty-text">从左侧选择一个 operation，或新建一个。</p>
          <button class="btn btn-ghost" id="wsEmptyNewBtn">
            <span class="plus">+</span> 创建第一个操作
          </button>
        </div>
      </div>

      <div class="editor-form" id="wsEditorForm" hidden>
        <div class="editor-header">
          <div class="editor-header-left">
            <h2 class="section-label">编辑操作</h2>
            <span class="endpoint-id mono" id="wsOperationId">id: —</span>
          </div>
          <div class="editor-header-right">
            <span class="last-saved mono" id="wsLastSaved">已保存</span>
          </div>
        </div>

        <div class="form-grid">
          <div class="field">
            <label for="wsOpName">操作名</label>
            <input type="text" id="wsOpName" class="input mono" maxlength="100" autocomplete="off" spellcheck="false" />
          </div>
          <div class="field field-path">
            <label for="wsOpSoapAction">SOAPAction（可空）</label>
            <input type="text" id="wsOpSoapAction" class="input mono" placeholder="urn:getUser" autocomplete="off" spellcheck="false" />
          </div>
          <div class="field field-status">
            <label for="wsOpStatus">状态码</label>
            <input type="number" id="wsOpStatus" class="input mono" min="100" max="599" value="200" />
          </div>
          <div class="field">
            <label for="wsResponseType">响应类型</label>
            <div class="select-wrap">
              <select id="wsResponseType" class="select">
                <option value="normal">正常响应</option>
                <option value="fault">SOAP Fault</option>
              </select>
            </div>
          </div>
        </div>

        <div class="editor-body">
          <div class="editor-split">
            <div class="editor-pane editor-pane-edit">
              <div class="editor-toolbar">
                <div class="toolbar-left">
                  <span class="section-label">响应体</span>
                  <span class="format-hint mono">XML</span>
                </div>
                <div class="toolbar-right">
                  <span class="validation-status" id="wsValidationStatus">
                    <span class="val-mark">·</span>
                    <span class="val-text">空</span>
                  </span>
                  <button class="btn btn-ghost btn-sm" id="wsFormatBtn">格式化</button>
                  <button class="btn btn-ghost btn-sm" id="wsValidateBtn">校验</button>
                  <button class="btn btn-ghost btn-sm" id="wsDynamicBtn" type="button" title="选中要替换的文本（或放好光标），再点这个按钮">动态值</button>
                </div>
              </div>
              <div class="code-editor-wrap" id="wsEditorWrap">
                <div id="xmlEditorHost" class="code-editor"></div>
              </div>
              <div class="editor-meta">
                <span class="mono" id="wsLineCount">0 行</span>
                <span class="meta-sep">·</span>
                <span class="mono" id="wsCharCount">0 字符</span>
              </div>
            </div>

            <div class="editor-pane editor-pane-preview">
              <div class="preview-toolbar">
                <span class="meta is-resolved" id="wsPreviewMeta">
                  <span class="dot"></span>
                  <span id="wsPreviewMetaLabel">就绪</span>
                </span>
                <span class="meta">
                  <span class="sep"></span>
                  <span id="wsPreviewExprStat">表达式 <strong>0</strong></span>
                  <span class="sep"></span>
                  <span id="wsPreviewErrStat">错误 <strong>0</strong></span>
                </span>
                <button class="btn btn-ghost btn-sm" id="wsPreviewRefreshBtn" aria-label="刷新预览">↻</button>
              </div>
              <div class="preview-banner" id="wsPreviewBanner" hidden></div>
              <pre class="preview-pane" id="wsPreviewPane">// 在左侧编辑响应 XML，此处显示解析结果</pre>
            </div>
          </div>
        </div>

        <div class="editor-footer">
          <button class="btn btn-danger" id="wsDeleteOpBtn">删除</button>
          <div class="spacer"></div>
          <button class="btn btn-ghost" id="wsRevertBtn">撤销</button>
          <button class="btn btn-primary" id="wsSaveOpBtn">保存</button>
        </div>
      </div>
    </section>
```

6) 两个新弹窗：在 `<!-- Generator modal -->` 注释行之前插入：

```html
  <!-- New WS service dialog -->
  <div class="modal" id="newServiceModal" hidden>
    <div class="modal-backdrop" id="newServiceBackdrop"></div>
    <div class="modal-panel" role="dialog" aria-labelledby="newServiceTitle" aria-modal="true">
      <div class="modal-header">
        <h2 class="section-label" id="newServiceTitle">新建服务</h2>
        <button class="btn btn-icon" id="newServiceClose" aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="field field-wide">
          <label for="newServiceName">服务名称</label>
          <input type="text" id="newServiceName" class="input" maxlength="50" placeholder="UserService" autocomplete="off" />
        </div>
        <div class="field field-wide">
          <label for="newServicePath">路径</label>
          <input type="text" id="newServicePath" class="input mono" placeholder="/ws/UserService" autocomplete="off" spellcheck="false" />
          <p class="field-hint">以 / 开头、不含 ?；同一端口内唯一。WSDL 地址即 该路径 + ?wsdl。</p>
          <p class="field-hint field-error" id="newServiceError" hidden></p>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="newServiceCancel">取消</button>
        <button class="btn btn-primary" id="newServiceCreate">创建</button>
      </div>
    </div>
  </div>

  <!-- Import WSDL dialog -->
  <div class="modal" id="importWsdlModal" hidden>
    <div class="modal-backdrop" id="importWsdlBackdrop"></div>
    <div class="modal-panel generator-panel" role="dialog" aria-labelledby="importWsdlTitle" aria-modal="true">
      <div class="modal-header">
        <h2 class="section-label" id="importWsdlTitle">导入 WSDL</h2>
        <button class="btn btn-icon" id="importWsdlClose" aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="field field-wide">
          <label for="importWsdlText">WSDL 内容</label>
          <textarea id="importWsdlText" class="input mono" rows="10" spellcheck="false"
            placeholder="粘贴 WSDL XML，或选择本地 .wsdl 文件"></textarea>
        </div>
        <div class="field field-wide">
          <label for="importWsdlFile">或选择文件</label>
          <input type="file" id="importWsdlFile" accept=".wsdl,.xml" />
        </div>
        <p class="field-hint field-error" id="importWsdlError" hidden></p>
        <p class="field-hint" id="importWsdlSummary"></p>
        <pre class="wsdl-preview mono" id="importWsdlPreview" hidden></pre>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="importWsdlParseBtn">解析预览</button>
        <div class="spacer"></div>
        <button class="btn btn-ghost" id="importWsdlCancel">取消</button>
        <button class="btn btn-primary" id="importWsdlConfirm" disabled>确认导入</button>
      </div>
    </div>
  </div>

```

- [ ] **Step 5: styles.css 追加**

文件末尾追加：

```css
/* ============================================================
   WebService 视图（spec 2026-08-15 §6）
   ============================================================ */
/* WS 端口详情：topbar / 端口页头 / 服务网格 / 日志 */
body[data-view='ws-port'] {
  grid-template-rows: 56px auto 1fr 260px;
  grid-template-columns: 1fr;
  grid-template-areas:
    "topbar"
    "porthdr"
    "home"
    "logs";
}

.port-type-badge {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  letter-spacing: 0.08em;
  padding: 1px 6px;
  border: 1px solid currentColor;
  border-radius: 4px;
  opacity: 0.85;
}
.port-type-badge[data-type='http'] { color: #5e6ad2; }
.port-type-badge[data-type='ws'] { color: var(--amber, #f5b84c); }

.port-type-radios {
  display: flex;
  gap: 16px;
}
.port-type-radios label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.service-header-path { color: var(--text-faint, #5a5f6a); font-size: 12px; }

.service-card-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.wsdl-badge {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid currentColor;
}
.wsdl-badge[data-state='loaded'] { color: var(--green, #4ade80); }
.wsdl-badge[data-state='none'] { color: var(--text-faint, #5a5f6a); }

.wsdl-preview {
  max-height: 180px;
  overflow: auto;
  background: var(--panel-bg, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  white-space: pre-wrap;
}
```

- [ ] **Step 6: 手动验证（前端无单测，本任务验证基建不破坏现状）**

```bash
pnpm test          # 后端全量，应全绿（前端改动不影响）
pnpm start         # 起服务，浏览器开首页
```

Expected：现有首页/HTTP 端口详情/编辑器行为与样式无回归；新建端口弹窗出现类型 radio（提交尚不带 type——Task 9 接线）；直接访问 `#/port/5050/svc/abc` 时 parseRoute 已识别 service 路由但 app.js 尚未消费，落在「端口不存在」页，属预期中间态。

- [ ] **Step 7: Commit**

```bash
git add public/router.js public/editor.js server.js public/index.html public/styles.css
git commit -m "feat: 前端基建——service 路由、编辑器多实例工厂、WS 视图 DOM 骨架"
```

---

### Task 9: 首页端口卡片 — 类型徽标 + 新建端口类型选择

**Files:**
- Modify: `public/views/port-cards.js`
- Modify: `public/app.js`（api.createPort 带 type；loadAll 派生 state.services）

**Interfaces:**
- Consumes: `POST /api/ports {port, type}`（Task 5）；index.html radio（Task 8）
- Produces: `api.createPort(port, type)`；`state.services` 在 loadAll/refreshAll 中维护（Task 10+ 依赖）

- [ ] **Step 1: app.js — api.createPort 支持 type + state.services**

1) `api.createPort` 改为：

```js
  async createPort(port, type = "http") {
    const r = await fetch("/api/ports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port, type }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || "创建端口失败");
    return body;
  },
```

（顺手把原 `body.message` 改为 `body.error`——后端错误信封的字段名是 `error`，原写法永远落到兜底文案。）

2) `state` 对象加 `services: [],`（跟在 `endpoints: []` 后）。

3) `loadAll()` 在 `state.endpoints = await api.listEndpoints();` 后加：

```js
  state.services = state.config.services || [];
```

4) `refreshAll()` 在 `state.endpoints = await api.listEndpoints();` 后加：

```js
  state.config = await api.getConfig();
  state.services = state.config.services || [];
```

- [ ] **Step 2: port-cards.js — 徽标 + WS 计数 + 类型提交**

1) `buildCard` 里 `const head = ...` 之后、创建 `num` 之前插入徽标；并把 stats 的「接口」行按类型分流。改动后的关键片段：

```js
function buildCard(p, state, lastEntry, api) {
  const isWs = p.type === 'ws';
  const card = document.createElement('article');
  // ...（className/dataset/tabIndex/role/aria-label 不变）

  const head = document.createElement('header');
  head.className = 'port-card-head';

  const badge = document.createElement('span');
  badge.className = 'port-type-badge';
  badge.dataset.type = isWs ? 'ws' : 'http';
  badge.textContent = isWs ? 'WS' : 'HTTP';

  const num = document.createElement('span');
  // ...（led/toggle 不变）
  head.append(num, badge, led, toggle);
```

2) stats 的「接口」行替换为按类型分流：

```js
  const epRow = document.createElement('div');
  const epDt = document.createElement('dt');
  const epDd = document.createElement('dd');
  if (isWs) {
    const svcs = (state.services || []).filter((s) => s.port === p.port);
    const opsCount = svcs.reduce((n, s) => n + (s.operations?.length || 0), 0);
    epDt.textContent = '服务';
    epDd.textContent = `${svcs.length} 个 · ${opsCount} 操作`;
  } else {
    const eps = state.endpoints.filter((e) => e.port === p.port);
    const disabledCount = eps.filter((e) => e.enabled === false).length;
    epDt.textContent = '接口';
    epDd.textContent = disabledCount > 0
      ? `${eps.length} 个 · ${disabledCount} 个禁用`
      : `${eps.length} 个`;
  }
  epRow.append(epDt, epDd);
```

（原 `buildCard` 顶部的 `const eps = ...` / `const disabledCount = ...` 两行删除——已内联进 else 分支。）

3) `endpointLabel` 支持 WS 日志条目的操作名：

```js
function endpointLabel(entry, endpoints) {
  if (entry.operationName) return entry.operationName === '?wsdl' ? '?wsdl' : entry.operationName;
  if (!entry.matched || !entry.endpointId) return `无路由 · ${entry.path}`;
  const ep = endpoints.find((e) => e.id === entry.endpointId);
  if (ep?.name) return ep.name;
  return ep ? `${ep.method} ${ep.path}` : entry.path;
}
```

4) `initNewPortDialog` 的 `open`/`submit` 处理类型：

```js
  const open = () => {
    els.newPortNumber.value = String(nextFreePort(state.ports));
    els.newPortError.hidden = true;
    els.newPortModal.querySelector('input[name="newPortType"][value="http"]').checked = true;
    els.newPortModal.hidden = false;
    els.newPortNumber.focus();
    els.newPortNumber.select();
  };
```

```js
  const submit = async () => {
    const port = Number(els.newPortNumber.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return fail('端口号必须是 1–65535 的整数');
    }
    if (state.ports.some((p) => p.port === port)) {
      return fail(`端口 ${port} 已存在`);
    }
    const type = els.newPortModal.querySelector('input[name="newPortType"]:checked')?.value || 'http';
    try {
      await api.createPort(port, type);
      state.ports = await api.listPorts();
      close();
      navigate(`#/port/${port}`);
    } catch (e) {
      fail(e?.message || '创建失败');
    }
  };
```

- [ ] **Step 3: 手动验证**

`pnpm start` → 新建端口选 WebService → 首页出现带 WS（琥珀色）徽标的卡片，计数行显示「0 个 · 0 操作」；HTTP 端口卡片带 HTTP 徽标、接口计数不变。

- [ ] **Step 4: Commit**

```bash
git add public/views/port-cards.js public/app.js
git commit -m "feat: 端口卡片类型徽标与新建端口类型选择"
```

---

### Task 10: WS 端口服务网格页（views/ws-services.js）+ app.js 路由分流

**Files:**
- Create: `public/views/ws-services.js`
- Modify: `public/app.js`（api service 方法、els 注册、effectiveView/applyRoute 重写、renderWsPortPage、refreshAll 分流）

**Interfaces:**
- Consumes: Task 6 的 services API；Task 8 的 DOM；Task 9 的 state.services
- Produces:
  - `renderServiceCards(state, {grid, countEl, api, onNewService, onImport, onChanged})`
  - `initNewServiceDialog({els, state, api, onCreated})` → `{open, close}`
  - `serviceAddress(s)` → string（Task 11/12 复用）
  - app.js 的 `effectiveView(route)` 分流（Task 12 在其上加 service 分支渲染）

- [ ] **Step 1: app.js — api 新方法 + els 注册**

api 对象追加（放在 `preview` 方法后）：

```js
  async preview(text, format) {
    return (
      await fetch("/api/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(format ? { text, format } : { text }),
      })
    ).json();
  },
  async createService(body) {
    const r = await fetch("/api/services", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "创建服务失败");
    return json;
  },
  async updateService(id, body) {
    const r = await fetch(`/api/services/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "更新服务失败");
    return json;
  },
  async deleteService(id) {
    const r = await fetch(`/api/services/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) throw new Error("删除服务失败");
  },
  async importServiceWsdl(id, wsdl) {
    const r = await fetch(`/api/services/${id}/wsdl`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wsdl }),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "导入 WSDL 失败");
    return json;
  },
  async parseWsdl(wsdl) {
    const r = await fetch("/api/wsdl/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wsdl }),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "WSDL 解析失败");
    return json;
  },
  async createOperation(serviceId, body) {
    const r = await fetch(`/api/services/${serviceId}/operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "新建操作失败");
    return json;
  },
  async updateOperation(serviceId, opId, body) {
    const r = await fetch(`/api/services/${serviceId}/operations/${opId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "保存操作失败");
    return json;
  },
  async deleteOperation(serviceId, opId) {
    const r = await fetch(`/api/services/${serviceId}/operations/${opId}`, {
      method: "DELETE",
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "删除操作失败");
    return json;
  },
```

（注意：这会把原 `preview(text)` 替换为 `preview(text, format)`——JSON 路径不传 format，行为不变。）

els 对象追加：

```js
  // WS 视图
  viewWsPort: $("#viewWsPort"),
  serviceCardGrid: $("#serviceCardGrid"),
  serviceCardCount: $("#serviceCardCount"),
  serviceHeader: $("#serviceHeader"),
  backToPortBtn: $("#backToPortBtn"),
  serviceHeaderName: $("#serviceHeaderName"),
  serviceHeaderPath: $("#serviceHeaderPath"),
  serviceEnabledToggle: $("#serviceEnabledToggle"),
  importWsdlBtn: $("#importWsdlBtn"),
  copyServiceAddrBtn: $("#copyServiceAddrBtn"),
  deleteServiceBtn: $("#deleteServiceBtn"),
  wsSidebarPanel: $("#wsSidebarPanel"),
  operationCount: $("#operationCount"),
  operationList: $("#operationList"),
  newOperationBtn: $("#newOperationBtn"),
  wsEditor: $("#wsEditor"),
  wsEditorEmpty: $("#wsEditorEmpty"),
  wsEditorForm: $("#wsEditorForm"),
  wsEmptyNewBtn: $("#wsEmptyNewBtn"),

  // 新建服务弹窗
  newServiceModal: $("#newServiceModal"),
  newServiceBackdrop: $("#newServiceBackdrop"),
  newServiceClose: $("#newServiceClose"),
  newServiceCancel: $("#newServiceCancel"),
  newServiceCreate: $("#newServiceCreate"),
  newServiceName: $("#newServiceName"),
  newServicePath: $("#newServicePath"),
  newServiceError: $("#newServiceError"),

  // 导入 WSDL 弹窗
  importWsdlModal: $("#importWsdlModal"),
  importWsdlBackdrop: $("#importWsdlBackdrop"),
  importWsdlClose: $("#importWsdlClose"),
  importWsdlCancel: $("#importWsdlCancel"),
  importWsdlParseBtn: $("#importWsdlParseBtn"),
  importWsdlConfirm: $("#importWsdlConfirm"),
  importWsdlText: $("#importWsdlText"),
  importWsdlFile: $("#importWsdlFile"),
  importWsdlError: $("#importWsdlError"),
  importWsdlSummary: $("#importWsdlSummary"),
  importWsdlPreview: $("#importWsdlPreview"),
```

- [ ] **Step 2: 创建 views/ws-services.js**

```js
// WS 端口详情页：服务卡片网格 + 新建服务弹窗（spec §6.②）
import { navigate } from '../router.js';

/** 服务的访问地址（注意：UI 端口 ≠ mock 端口，必须用 service.port） */
export function serviceAddress(s) {
  return `${location.protocol}//${location.hostname}:${s.port}${s.path}`;
}

function buildServiceCard(s, { api, onImport, onChanged }) {
  const card = document.createElement('article');
  card.className = 'port-card service-card';
  card.dataset.serviceId = s.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `服务 ${s.name} 详情`);

  const head = document.createElement('header');
  head.className = 'port-card-head';
  const name = document.createElement('span');
  name.className = 'service-name';
  name.textContent = s.name;
  const wsdlBadge = document.createElement('span');
  wsdlBadge.className = 'wsdl-badge';
  wsdlBadge.dataset.state = s.hasWsdl ? 'loaded' : 'none';
  wsdlBadge.textContent = s.hasWsdl ? 'WSDL' : '无 WSDL';
  head.append(name, wsdlBadge);

  const stats = document.createElement('dl');
  stats.className = 'port-card-stats';
  const pathRow = document.createElement('div');
  const pathDt = document.createElement('dt');
  pathDt.textContent = '路径';
  const pathDd = document.createElement('dd');
  pathDd.className = 'mono';
  pathDd.textContent = s.path;
  pathRow.append(pathDt, pathDd);
  const opRow = document.createElement('div');
  const opDt = document.createElement('dt');
  opDt.textContent = '操作';
  const opDd = document.createElement('dd');
  const opCount = (s.operations || []).length;
  const disabledCount = (s.operations || []).filter((o) => o.enabled === false).length;
  opDd.textContent = disabledCount > 0 ? `${opCount} 个 · ${disabledCount} 个禁用` : `${opCount} 个`;
  opRow.append(opDt, opDd);
  stats.append(pathRow, opRow);

  const actions = document.createElement('div');
  actions.className = 'service-card-actions';
  const mkBtn = (label, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost btn-sm';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  actions.append(
    mkBtn('复制地址', '复制服务地址', () => navigator.clipboard.writeText(serviceAddress(s))),
    mkBtn('?wsdl', '复制 WSDL 地址', () => navigator.clipboard.writeText(`${serviceAddress(s)}?wsdl`)),
    mkBtn('导入', '导入 / 替换 WSDL', () => onImport(s)),
    mkBtn('删除', '删除服务', async () => {
      if (!confirm(`确认删除服务 ${s.name}（${s.path}）？其下 ${opCount} 个操作将一并删除。`)) return;
      try {
        await api.deleteService(s.id);
        await onChanged();
      } catch (e) {
        alert('删除失败：' + (e?.message || '未知错误'));
      }
    }),
  );

  card.append(head, stats, actions);
  const open = () => navigate(`#/port/${s.port}/svc/${s.id}`);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return card;
}

export function renderServiceCards(state, { grid, countEl, api, onNewService, onImport, onChanged }) {
  const port = state.route.port;
  const services = (state.services || []).filter((s) => s.port === port);
  grid.innerHTML = '';
  countEl.textContent = String(services.length);
  if (services.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'port-empty-hint';
    hint.textContent = '这个 WebService 端口还没有服务。点击"+ 新建服务"创建第一个。';
    grid.appendChild(hint);
  }
  for (const s of services) {
    grid.appendChild(buildServiceCard(s, { api, onImport, onChanged }));
  }
  const newCard = document.createElement('button');
  newCard.type = 'button';
  newCard.className = 'port-card port-card-new';
  newCard.id = 'newServiceCard';
  newCard.innerHTML = '<span class="plus">+</span><span>新建服务</span>';
  newCard.addEventListener('click', onNewService);
  grid.appendChild(newCard);
}

export function initNewServiceDialog({ els, state, api, onCreated }) {
  const open = () => {
    els.newServiceName.value = '';
    els.newServicePath.value = '/ws/';
    els.newServiceError.hidden = true;
    els.newServiceModal.hidden = false;
    els.newServiceName.focus();
  };
  const close = () => {
    els.newServiceModal.hidden = true;
  };
  const fail = (msg) => {
    els.newServiceError.textContent = msg;
    els.newServiceError.hidden = false;
  };
  const submit = async () => {
    const name = els.newServiceName.value.trim();
    const path = els.newServicePath.value.trim();
    if (!path.startsWith('/')) return fail('路径必须以 / 开头');
    if (path.includes('?')) return fail('路径不能包含 ?');
    try {
      const svc = await api.createService({
        port: state.route.port,
        path,
        ...(name ? { name } : {}),
      });
      await onCreated(svc);
      close();
      navigate(`#/port/${svc.port}/svc/${svc.id}`);
    } catch (e) {
      fail(e?.message || '创建失败');
    }
  };
  els.newServiceClose.addEventListener('click', close);
  els.newServiceBackdrop.addEventListener('click', close);
  els.newServiceCancel.addEventListener('click', close);
  els.newServiceCreate.addEventListener('click', submit);
  els.newServicePath.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  return { open, close };
}
```

- [ ] **Step 3: app.js — effectiveView 分流 + renderWsPortPage + boot 接线**

1) import 区加：

```js
import { renderServiceCards, initNewServiceDialog, serviceAddress } from "./views/ws-services.js";
import { initImportWsdlDialog } from "./views/ws-import.js";
```

（`ws-import.js` 在 Task 11 创建；本任务先建一个只含占位导出的文件让页面能跑：
`export function initImportWsdlDialog() { return { open: () => alert('导入功能接线中'), close: () => {} }; }`
Task 11 再替换为完整实现。）

2) `applyRoute` 整函数替换为：

```js
function currentPortEntity(route) {
  return state.ports.find((p) => p.port === route.port) || null;
}

function effectiveView(route) {
  if (route.view === "home") return "home";
  const portEntity = currentPortEntity(route);
  if (!portEntity) return "not-found";
  if (route.view === "service") {
    const svc = (state.services || []).find(
      (s) => s.id === route.serviceId && s.port === route.port,
    );
    return svc ? "service" : "not-found";
  }
  return portEntity.type === "ws" ? "ws-port" : "port";
}

async function applyRoute(route) {
  if (
    state.dirty &&
    (state.route.view === "port" || state.route.view === "service") &&
    !confirm("有未保存的修改，是否放弃？")
  ) {
    suppressHash = true;
    location.hash =
      state.route.view === "service"
        ? `#/port/${state.route.port}/svc/${state.route.serviceId}`
        : `#/port/${state.route.port}`;
    return;
  }
  state.route = route;
  state.dirty = false;

  if (route.view !== "home" && !currentPortEntity(route)) {
    // 端口可能刚被创建（API 直接建 / 另一标签页），拉一次最新数据再判断
    try {
      state.ports = await api.listPorts();
      state.endpoints = await api.listEndpoints();
      state.config = await api.getConfig();
      state.services = state.config.services || [];
    } catch {}
  }

  const ev = effectiveView(route);
  document.body.dataset.view = ev === "not-found" ? "port" : ev;
  els.viewHome.hidden = ev !== "home";
  els.viewWsPort.hidden = ev !== "ws-port";
  els.portHeader.hidden = !(ev === "port" || ev === "ws-port");
  els.serviceHeader.hidden = ev !== "service";
  els.portNotFound.hidden = ev !== "not-found";
  els.sidebarPanel.hidden = ev !== "port";
  els.wsSidebarPanel.hidden = ev !== "service";
  els.editor.hidden = ev !== "port";
  els.wsEditor.hidden = ev !== "service";
  els.logsPanel.hidden = ev === "home";

  if (ev === "home") renderHome();
  if (ev === "port" || ev === "ws-port") renderPortHeader(state, els);
  if (ev === "port") {
    // CodeMirror 在 hidden 容器里挂载过，显示后需要重新测量
    getEditorView()?.requestMeasure();
    renderEndpointList();
    renderEditor();
    renderLogsInitial();
  }
  if (ev === "ws-port") {
    renderWsPortPage();
    renderLogsInitial();
  }
  if (ev === "service") {
    renderServicePage();
    renderLogsInitial();
  }
}

function renderWsPortPage() {
  renderServiceCards(state, {
    grid: els.serviceCardGrid,
    countEl: els.serviceCardCount,
    api,
    onNewService: () => newServiceDialog.open(),
    onImport: (svc) => importWsdlDialog.open(svc),
    onChanged: refreshAll,
  });
}

// service 视图的渲染在 Task 12 由 ws-detail.js 提供；此处先占位
function renderServicePage() {}
```

3) `refreshAll` 末尾按视图分流刷新：

```js
  render();
  if (state.route.view === "port" || state.route.view === "ws-port") {
    renderPortHeader(state, els);
  }
  if (state.route.view === "ws-port") renderWsPortPage();
```

4) 日志按端口过滤含 service 视图（`visibleLogs`/`updateLogsCount` 里的 `state.route.view === "port"` 判断改为 `state.route.view !== "home"`）。

5) boot（`loadAll().then(...)` 末尾、`startRouter` 之前）加：

```js
  newServiceDialog = initNewServiceDialog({
    els,
    state,
    api,
    onCreated: async () => {
      state.config = await api.getConfig();
      state.services = state.config.services || [];
    },
  });
  importWsdlDialog = initImportWsdlDialog({
    els,
    api,
    onImported: async () => {
      state.config = await api.getConfig();
      state.services = state.config.services || [];
      if (state.route.view === "ws-port") renderWsPortPage();
      if (state.route.view === "service") renderServicePage();
    },
  });
```

并在文件顶部 `let newPortDialog = null;` 旁加：

```js
let newServiceDialog = null;
let importWsdlDialog = null;
```

- [ ] **Step 4: 手动验证**

`pnpm start` → 新建 WS 端口 → 点击进入：看到「服务列表」网格 + 新建服务卡片 → 新建 UserService `/ws/UserService` → 自动跳进服务详情（此时详情还是空占位，hash 已是 `#/port/:p/svc/:id`）→ 返回服务列表 → 卡片显示路径/操作数/无 WSDL → 删除服务正常。

- [ ] **Step 5: Commit**

```bash
git add public/views/ws-services.js public/views/ws-import.js public/app.js
git commit -m "feat: WS 端口服务网格页与路由类型分流"
```

---
### Task 11: 导入 WSDL 弹窗（views/ws-import.js 完整实现）

**Files:**
- Modify: `public/views/ws-import.js`（替换 Task 10 的占位实现）

**Interfaces:**
- Consumes: `api.parseWsdl` / `api.importServiceWsdl`（Task 10 已加）；index.html 弹窗 DOM（Task 8）
- Produces: `initImportWsdlDialog({els, api, onImported})` → `{open(service), close}`（Task 10 app.js 已按此接线；Task 12 服务详情页头复用）

- [ ] **Step 1: 完整实现 ws-import.js（整文件替换占位）**

```js
// 导入 WSDL 弹窗：粘贴/本地文件 → 解析预览（新增/更新/保留计数）→ 确认合并（spec §5/§6.③）
export function initImportWsdlDialog({ els, api, onImported }) {
  let target = null;   // 目标 service 对象（来自 state.services，含 operations/hasWsdl）
  let parsed = null;   // 最近一次解析预览结果

  const reset = () => {
    els.importWsdlText.value = '';
    els.importWsdlFile.value = '';
    els.importWsdlPreview.hidden = true;
    els.importWsdlPreview.textContent = '';
    els.importWsdlSummary.textContent = '';
    els.importWsdlError.hidden = true;
    els.importWsdlConfirm.disabled = true;
    parsed = null;
  };

  const open = (service) => {
    target = service;
    reset();
    els.importWsdlModal.hidden = false;
    els.importWsdlText.focus();
  };
  const close = () => {
    els.importWsdlModal.hidden = true;
  };
  const fail = (msg) => {
    els.importWsdlError.textContent = msg;
    els.importWsdlError.hidden = false;
  };

  els.importWsdlFile.addEventListener('change', async () => {
    const f = els.importWsdlFile.files?.[0];
    if (!f) return;
    els.importWsdlText.value = await f.text();
  });

  els.importWsdlParseBtn.addEventListener('click', async () => {
    const text = els.importWsdlText.value.trim();
    if (!text) return fail('请先粘贴 WSDL 内容或选择文件');
    els.importWsdlError.hidden = true;
    try {
      parsed = await api.parseWsdl(text);
    } catch (e) {
      parsed = null;
      els.importWsdlPreview.hidden = true;
      els.importWsdlSummary.textContent = '';
      els.importWsdlConfirm.disabled = true;
      return fail(e?.message || 'WSDL 解析失败');
    }
    const existing = new Set((target.operations || []).map((o) => o.name));
    const incoming = new Set(parsed.operations.map((o) => o.name));
    const add = parsed.operations.filter((o) => !existing.has(o.name)).length;
    const upd = parsed.operations.length - add;
    const keep = (target.operations || []).filter((o) => !incoming.has(o.name)).length;
    els.importWsdlSummary.textContent = `将新增 ${add} 个、更新 ${upd} 个、保留 ${keep} 个操作（同名操作的响应配置会保留）`;
    els.importWsdlPreview.textContent = parsed.operations.length
      ? parsed.operations
          .map((o) => `${o.name}${o.soapAction ? `  (${o.soapAction})` : ''}`)
          .join('\n')
      : '（未解析到 operation，导入后可在详情页手工添加）';
    els.importWsdlPreview.hidden = false;
    els.importWsdlConfirm.disabled = false;
  });

  els.importWsdlConfirm.addEventListener('click', async () => {
    if (!parsed || !target) return;
    try {
      const updated = await api.importServiceWsdl(target.id, els.importWsdlText.value.trim());
      await onImported(updated);
      close();
    } catch (e) {
      fail(e?.message || '导入失败');
    }
  });

  els.importWsdlClose.addEventListener('click', close);
  els.importWsdlBackdrop.addEventListener('click', close);
  els.importWsdlCancel.addEventListener('click', close);
  return { open, close };
}
```

- [ ] **Step 2: 手动验证**

`pnpm start` → WS 端口 → 服务卡片点「导入」→ 粘贴一段 WSDL → 解析预览出 operation 列表与计数 → 确认导入 → 卡片操作数变化、WSDL 徽标变绿。文件选择同样验证一次。

- [ ] **Step 3: Commit**

```bash
git add public/views/ws-import.js
git commit -m "feat: 导入 WSDL 弹窗（解析预览与合并确认）"
```

---

### Task 12: 服务详情页（views/ws-detail.js）+ app.js 收尾接线

**Files:**
- Create: `public/views/ws-detail.js`
- Modify: `public/app.js`（els 补全、renderServicePage 实装、日志结果列、generator 插入目标、Ctrl+S）

**Interfaces:**
- Consumes: `createEditor`（Task 8）、`serviceAddress`（Task 10）、operations API（Task 10 已加）
- Produces: `initServiceDetail({els, state, api, refreshAll, importDialog})`；`renderServiceDetail()`（app.js 的 `renderServicePage` 调它）

- [ ] **Step 1: app.js — els 补全 + 接线修改**

1) els 对象追加：

```js
  // WS 服务详情编辑区
  xmlEditorHost: $("#xmlEditorHost"),
  wsOperationId: $("#wsOperationId"),
  wsOpName: $("#wsOpName"),
  wsOpSoapAction: $("#wsOpSoapAction"),
  wsOpStatus: $("#wsOpStatus"),
  wsResponseType: $("#wsResponseType"),
  wsValidationStatus: $("#wsValidationStatus"),
  wsFormatBtn: $("#wsFormatBtn"),
  wsValidateBtn: $("#wsValidateBtn"),
  wsDynamicBtn: $("#wsDynamicBtn"),
  wsLineCount: $("#wsLineCount"),
  wsCharCount: $("#wsCharCount"),
  wsPreviewMeta: $("#wsPreviewMeta"),
  wsPreviewMetaLabel: $("#wsPreviewMetaLabel"),
  wsPreviewExprStat: $("#wsPreviewExprStat"),
  wsPreviewErrStat: $("#wsPreviewErrStat"),
  wsPreviewRefreshBtn: $("#wsPreviewRefreshBtn"),
  wsPreviewBanner: $("#wsPreviewBanner"),
  wsPreviewPane: $("#wsPreviewPane"),
  wsLastSaved: $("#wsLastSaved"),
  wsDeleteOpBtn: $("#wsDeleteOpBtn"),
  wsRevertBtn: $("#wsRevertBtn"),
  wsSaveOpBtn: $("#wsSaveOpBtn"),
```

2) `state` 加 `selectedOperationId: null,`（跟在 `selectedId` 后）。

3) import 区加：

```js
import { initServiceDetail, renderServiceDetail } from "./views/ws-detail.js";
import { getActiveEditorView } from "./editor.js";
```

（`getActiveEditorView` 并入既有 `from "./editor.js"` 的 import 列表。）

4) Task 10 的占位 `function renderServicePage() {}` 替换为：

```js
function renderServicePage() {
  renderServiceDetail();
}
```

5) boot 里（`importWsdlDialog = ...` 之后）加：

```js
  initServiceDetail({
    els,
    state,
    api,
    refreshAll,
    importDialog: () => importWsdlDialog,
  });
```

6) 日志结果列显示 operation 名（`renderLogEntry` 的 `row.innerHTML` 里 `<span class="log-result">...` 改为无内容占位，其后用 textContent 赋值——operationName 来自请求数据，不能进 innerHTML）：

```js
    <span class="log-result"></span>
```

```js
  row.querySelector(".log-path").textContent = entry.path;
  row.querySelector(".log-result").textContent = entry.matched
    ? entry.operationName
      ? `✓ ${entry.operationName}`
      : "匹配"
    : entry.serviceId
      ? `✗ Fault${entry.operationName ? ` · ${entry.operationName}` : ""}`
      : "无路由";
```

7) generator 插入目标改 active editor（`generatorInsertBtn` 的 click handler 里）：

```js
  const view = getActiveEditorView();
  if (!view) return;
```

（原 `const view = getEditorView();`。`dynamicValueToolbarBtn` 的 anchor 逻辑是 JSON 专用的，保持 `getEditorView()` 不动。）

8) `refreshAll` 末尾补 service 视图刷新（`if (state.route.view === "ws-port") renderWsPortPage();` 之后）：

```js
  if (state.route.view === "service") renderServicePage();
```

9) Ctrl+S 支持 WS 表单（keydown handler 里）：

```js
    if (!els.editorForm.hidden) saveEndpoint();
    else if (!els.wsEditorForm.hidden) els.wsSaveOpBtn.click();
```

- [ ] **Step 2: 创建 views/ws-detail.js**

```js
// WS 服务详情页：operation 侧栏 + XML 响应编辑（spec §6.③）
import { navigate } from '../router.js';
import { createEditor } from '../editor.js';
import { serviceAddress } from './ws-services.js';

let ctx = null;        // { els, state, api }
let xmlEditor = null;  // createEditor 实例（懒挂载）
let previewTimer = null;

function currentService(state) {
  return (
    (state.services || []).find(
      (s) => s.id === state.route.serviceId && s.port === state.route.port,
    ) || null
  );
}

function currentOperation(state) {
  const s = currentService(state);
  return s?.operations.find((o) => o.id === state.selectedOperationId) || null;
}

function replaceService(state, updated) {
  const i = (state.services || []).findIndex((s) => s.id === updated.id);
  if (i >= 0) state.services[i] = updated;
}

function wsMarkDirty() {
  const { state, els } = ctx;
  if (state.dirty) return;
  state.dirty = true;
  els.wsLastSaved.textContent = '未保存';
  els.wsLastSaved.style.color = 'var(--amber)';
}

function wsFlash(text, color) {
  const { state, els } = ctx;
  els.wsLastSaved.textContent = text;
  els.wsLastSaved.style.color = `var(--${color})`;
  setTimeout(() => {
    els.wsLastSaved.style.color = state.dirty ? 'var(--amber)' : '';
    els.wsLastSaved.textContent = state.dirty ? '未保存' : '已保存';
  }, 1600);
}

// ====== 渲染 ======

export function renderServiceDetail() {
  const { state, els } = ctx;
  const s = currentService(state);
  if (!s) return;
  els.serviceHeaderName.textContent = s.name;
  els.serviceHeaderPath.textContent = s.path;
  els.serviceEnabledToggle.checked = s.enabled !== false;

  ensureXmlEditor();
  xmlEditor?.view.requestMeasure();

  // 选中项兜底：未选或已失效时选第一个 operation
  if (!currentOperation(state)) {
    state.selectedOperationId = s.operations[0]?.id || null;
  }
  renderOperationList();
  renderOperationEditor();
}

function renderOperationList() {
  const { state, els } = ctx;
  const s = currentService(state);
  const ops = s?.operations || [];
  els.operationCount.textContent = String(ops.length);
  els.operationList.innerHTML = '';
  for (const op of ops) {
    const li = document.createElement('li');
    li.className =
      'endpoint-item' + (op.id === state.selectedOperationId ? ' selected' : '');
    li.dataset.id = op.id;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', op.id === state.selectedOperationId ? 'true' : 'false');

    const nameRow = document.createElement('div');
    nameRow.className = 'endpoint-name-row';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'endpoint-name';
    nameSpan.textContent = op.name;
    const badge = document.createElement('span');
    badge.className = 'port-type-badge';
    badge.dataset.type = op.responseType === 'fault' ? 'ws' : 'http';
    badge.textContent = op.responseType === 'fault' ? 'Fault' : String(op.status || 200);
    nameRow.append(nameSpan, badge);

    const meta = document.createElement('div');
    meta.className = 'endpoint-meta';
    const action = document.createElement('span');
    action.className = 'endpoint-path';
    action.textContent = op.soapAction || '（按 Body 匹配）';
    meta.append(action);

    li.append(nameRow, meta);
    li.addEventListener('click', () => {
      if (state.dirty && !confirm('有未保存的修改，是否放弃？')) return;
      state.selectedOperationId = op.id;
      state.dirty = false;
      renderOperationList();
      renderOperationEditor();
    });
    els.operationList.appendChild(li);
  }
}

function renderOperationEditor() {
  const { state, els } = ctx;
  const op = currentOperation(state);
  if (!op) {
    els.wsEditorEmpty.hidden = false;
    els.wsEditorForm.hidden = true;
    return;
  }
  els.wsEditorEmpty.hidden = true;
  els.wsEditorForm.hidden = false;
  els.wsOperationId.textContent = `id: ${op.id.slice(0, 8)}…`;
  if (!state.dirty) {
    els.wsOpName.value = op.name;
    els.wsOpSoapAction.value = op.soapAction || '';
    els.wsOpStatus.value = op.status || 200;
    els.wsResponseType.value = op.responseType || 'normal';
    xmlEditor?.setValue(op.responseXml || '');
    els.wsLastSaved.textContent = '已保存';
    els.wsLastSaved.style.color = '';
  }
  updateWsMeta();
  validateWsXml();
  scheduleWsPreview();
}

// ====== 编辑器 / 校验 / 预览 ======

function ensureXmlEditor() {
  if (xmlEditor) return;
  xmlEditor = createEditor({
    host: ctx.els.xmlEditorHost,
    language: 'xml',
    onChange: () => {
      wsMarkDirty();
      updateWsMeta();
      validateWsXml();
      scheduleWsPreview();
    },
  });
}

function updateWsMeta() {
  const { els } = ctx;
  const text = xmlEditor ? xmlEditor.getValue() : '';
  const lines = text === '' ? 0 : text.split('\n').length;
  els.wsLineCount.textContent = `${lines} 行`;
  els.wsCharCount.textContent = `${text.length} 字符`;
}

function setWsValidation(state_, text) {
  const { els } = ctx;
  els.wsValidationStatus.dataset.state = state_;
  els.wsValidationStatus.querySelector('.val-text').textContent = text;
  els.wsValidationStatus.querySelector('.val-mark').textContent =
    state_ === 'valid' ? '✓' : state_ === 'invalid' ? '✗' : '·';
}

function validateWsXml() {
  const text = xmlEditor ? xmlEditor.getValue().trim() : '';
  if (!text) return setWsValidation('empty', '空');
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) return setWsValidation('invalid', 'XML 不合法');
  setWsValidation('valid', '合法');
}

// 面向元素型 SOAP XML 的简单缩进格式化；混合内容（文本与子元素同行）不做美化
function formatXml(text) {
  const compact = text.replace(/>\s+</g, '><').trim();
  const tokens = compact.match(/<[^>]+>|[^<]+/g) || [];
  let indent = 0;
  const lines = [];
  for (const tok of tokens) {
    if (/^<\//.test(tok)) indent = Math.max(0, indent - 1);
    if (/\S/.test(tok)) lines.push('  '.repeat(indent) + tok);
    if (/^<[^!?/](?:[^>]*[^/])?>$/.test(tok)) indent++;
  }
  return lines.join('\n');
}

function scheduleWsPreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshWsPreview, 300);
}

async function refreshWsPreview() {
  const { els, api } = ctx;
  const text = xmlEditor ? xmlEditor.getValue() : '';
  if (!text.trim()) {
    els.wsPreviewPane.textContent = '// 在左侧编辑响应 XML，此处显示解析结果';
    setWsPreviewMeta('', '就绪', 0, 0);
    els.wsPreviewBanner.hidden = true;
    return;
  }
  let res;
  try {
    res = await api.preview(text, 'text');
  } catch {
    els.wsPreviewBanner.textContent = '预览暂不可用';
    els.wsPreviewBanner.hidden = false;
    setWsPreviewMeta('has-errors', '离线', 0, 1);
    return;
  }
  els.wsPreviewBanner.hidden = true;
  els.wsPreviewPane.textContent = res.resolved;
  setWsPreviewMeta(
    res.errors.length > 0 ? 'has-errors' : 'is-resolved',
    res.errors.length > 0 ? '部分解析' : '已解析',
    res.exprCount,
    res.errors.length,
  );
}

function setWsPreviewMeta(state_, label, exprCount, errCount) {
  const { els } = ctx;
  els.wsPreviewMeta.className = 'meta ' + state_;
  els.wsPreviewMetaLabel.textContent = label;
  els.wsPreviewExprStat.innerHTML = `表达式 <strong>${exprCount}</strong>`;
  els.wsPreviewErrStat.innerHTML = `错误 <strong>${errCount}</strong>`;
  els.wsPreviewErrStat.style.display = errCount > 0 ? '' : 'none';
}

// ====== 事件接线 ======

export function initServiceDetail({ els, state, api, refreshAll, importDialog }) {
  ctx = { els, state, api };

  els.backToPortBtn.addEventListener('click', () =>
    navigate(`#/port/${state.route.port}`));

  els.serviceEnabledToggle.addEventListener('change', async () => {
    const s = currentService(state);
    if (!s) return;
    try {
      const updated = await api.updateService(s.id, {
        enabled: els.serviceEnabledToggle.checked,
      });
      replaceService(state, updated);
    } catch (e) {
      els.serviceEnabledToggle.checked = !els.serviceEnabledToggle.checked;
      alert('切换失败：' + (e?.message || '未知错误'));
    }
  });

  els.importWsdlBtn.addEventListener('click', () => {
    const s = currentService(state);
    if (s) importDialog().open(s);
  });

  els.copyServiceAddrBtn.addEventListener('click', () => {
    const s = currentService(state);
    if (s) navigator.clipboard.writeText(serviceAddress(s));
  });

  els.deleteServiceBtn.addEventListener('click', async () => {
    const s = currentService(state);
    if (!s) return;
    if (state.dirty && !confirm('有未保存的修改，删除服务将放弃这些修改。继续？')) return;
    state.dirty = false;
    if (
      !confirm(
        `确认删除服务 ${s.name}（${s.path}）？其下 ${(s.operations || []).length} 个操作将一并删除。`,
      )
    )
      return;
    try {
      await api.deleteService(s.id);
      await refreshAll();
      navigate(`#/port/${s.port}`);
    } catch (e) {
      alert('删除失败：' + (e?.message || '未知错误'));
    }
  });

  const createOp = async () => {
    const s = currentService(state);
    if (!s) return;
    try {
      const updated = await api.createOperation(s.id, {
        name: `op${(s.operations || []).length + 1}`,
      });
      replaceService(state, updated);
      state.selectedOperationId =
        updated.operations[updated.operations.length - 1]?.id || null;
      state.dirty = false;
      renderServiceDetail();
    } catch (e) {
      alert('新建操作失败：' + (e?.message || '未知错误'));
    }
  };
  els.newOperationBtn.addEventListener('click', createOp);
  els.wsEmptyNewBtn.addEventListener('click', createOp);

  for (const f of [els.wsOpName, els.wsOpSoapAction, els.wsOpStatus, els.wsResponseType]) {
    f.addEventListener('input', () => wsMarkDirty());
  }

  els.wsFormatBtn.addEventListener('click', () => {
    if (!xmlEditor) return;
    const text = xmlEditor.getValue();
    if (!text.trim()) return;
    xmlEditor.setValue(formatXml(text));
    wsMarkDirty();
    setWsValidation('valid', '已格式化');
    updateWsMeta();
    scheduleWsPreview();
  });

  els.wsValidateBtn.addEventListener('click', () => validateWsXml());

  els.wsDynamicBtn.addEventListener('click', () => {
    if (!xmlEditor) return;
    const view = xmlEditor.view;
    const sel = view.state.selection.main;
    const text = view.state.doc.toString();
    const selected = text.slice(sel.from, sel.to);
    const m = /\{\{\$[a-zA-Z_][^}]*\}\}/.exec(selected);
    window.__openGeneratorModal?.({
      from: sel.from,
      to: sel.to,
      currentValue: selected,
      initialExpr: m ? m[0] : null,
      hasQuotes: true, // XML 纯文本插入，不包引号
    });
  });

  els.wsSaveOpBtn.addEventListener('click', async () => {
    const s = currentService(state);
    const op = currentOperation(state);
    if (!s || !op) return;
    const body = {
      name: els.wsOpName.value.trim(),
      soapAction: els.wsOpSoapAction.value.trim(),
      status: Number(els.wsOpStatus.value) || 200,
      responseType: els.wsResponseType.value,
      responseXml: xmlEditor ? xmlEditor.getValue() : '',
    };
    try {
      const updated = await api.updateOperation(s.id, op.id, body);
      replaceService(state, updated);
      state.selectedOperationId = op.id;
      state.dirty = false;
      renderOperationList();
      wsFlash('已保存', 'green');
    } catch (e) {
      wsFlash('✗ 保存失败', 'red');
    }
  });

  els.wsRevertBtn.addEventListener('click', () => {
    state.dirty = false;
    renderOperationEditor();
  });

  els.wsDeleteOpBtn.addEventListener('click', async () => {
    const s = currentService(state);
    const op = currentOperation(state);
    if (!s || !op) return;
    if (!confirm(`确认删除操作 ${op.name}？`)) return;
    try {
      const updated = await api.deleteOperation(s.id, op.id);
      replaceService(state, updated);
      state.selectedOperationId = updated.operations[0]?.id || null;
      state.dirty = false;
      renderServiceDetail();
    } catch (e) {
      alert('删除失败：' + (e?.message || '未知错误'));
    }
  });

  els.wsPreviewRefreshBtn.addEventListener('click', () => refreshWsPreview());
}
```

- [ ] **Step 3: 手动验证（走完整链路）**

`pnpm start` → WS 端口 → UserService → 导入 WSDL（Task 11）→ 侧栏出现 operation 列表 → 选中 getUser → XML 编辑器显示默认模板（语法高亮）→ 改字段/动态值插入 → 预览面板显示替换结果 → 保存 → 启动引擎 → `curl -X POST http://127.0.0.1:18790/ws/UserService -H 'content-type: text/xml' -H 'soapaction: "urn:getUser"' -d '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><x/></soap:Body></soap:Envelope>'` 返回响应 XML；日志结果列显示 `✓ getUser`。

- [ ] **Step 4: Commit**

```bash
git add public/views/ws-detail.js public/app.js
git commit -m "feat: WS 服务详情页（operation 编辑 + XML 编辑器 + 预览）"
```

---

### Task 13: E2E — ws-happy-path.spec.js

**Files:**
- Create: `test/e2e/ws-happy-path.spec.js`

**Interfaces:**
- Consumes: `bootServer`/`hitMock`（`test/e2e/helpers.js` 现成）；全部 UI DOM id（Task 8/10/12）

- [ ] **Step 1: 写 E2E**

```js
import { test, expect } from '@playwright/test';
import { bootServer, hitMock } from './helpers.js';

const WSDL = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:tns="http://example.com/user"
                  targetNamespace="http://example.com/user">
  <wsdl:types/>
  <wsdl:message name="getUserRequest"/>
  <wsdl:message name="getUserResponse"/>
  <wsdl:message name="listUsersRequest"/>
  <wsdl:message name="listUsersResponse"/>
  <wsdl:portType name="UserServicePortType">
    <wsdl:operation name="getUser">
      <wsdl:input message="tns:getUserRequest"/>
      <wsdl:output message="tns:getUserResponse"/>
    </wsdl:operation>
    <wsdl:operation name="listUsers">
      <wsdl:input message="tns:listUsersRequest"/>
      <wsdl:output message="tns:listUsersResponse"/>
    </wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="UserServiceBinding" type="tns:UserServicePortType">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
    <wsdl:operation name="getUser">
      <soap:operation soapAction="urn:getUser"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
    <wsdl:operation name="listUsers">
      <soap:operation soapAction="urn:listUsers"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="UserService">
    <wsdl:port name="UserServicePort" binding="tns:UserServiceBinding">
      <soap:address location="http://real-server.example.com/ws/UserService"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`;

const SOAP_CALL = (inner) =>
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;

let ctx;

test.beforeAll(async () => {
  ctx = await bootServer();
});

test.afterAll(async () => {
  await ctx.cleanup();
});

test('WS happy path：建 WS 端口 → 建服务 → 导入 WSDL → 启动 → SOAP 调用', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(ctx.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  // 1. UI 新建 WS 端口（类型选择是本次入口改动的核心）
  await page.click('#newPortCard');
  await page.check('input[name="newPortType"][value="ws"]');
  await page.fill('#newPortNumber', '18790');
  await page.click('#newPortCreate');
  await page.waitForFunction(() => location.hash === '#/port/18790');
  await page.waitForSelector('#viewWsPort:not([hidden])');
  // 首页卡片应带 WS 徽标（回首页验证后返回）
  await page.goto(`${ctx.baseURL}/#/`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  const badge = await page.textContent('.port-card[data-port="18790"] .port-type-badge');
  expect(badge).toBe('WS');
  await page.click('.port-card[data-port="18790"]');
  await page.waitForSelector('#viewWsPort:not([hidden])');

  // 2. UI 新建服务
  await page.click('#newServiceCard');
  await page.fill('#newServiceName', 'UserService');
  await page.fill('#newServicePath', '/ws/UserService');
  await page.click('#newServiceCreate');
  await page.waitForFunction(() => /^#\/port\/18790\/svc\//.test(location.hash));
  await page.waitForSelector('#wsSidebarPanel:not([hidden])');

  // 3. 导入 WSDL（粘贴 → 解析预览 → 确认合并）
  await page.click('#importWsdlBtn');
  await page.fill('#importWsdlText', WSDL);
  await page.click('#importWsdlParseBtn');
  await page.waitForSelector('#importWsdlPreview:not([hidden])');
  const summary = await page.textContent('#importWsdlSummary');
  expect(summary).toContain('新增 2');
  await page.click('#importWsdlConfirm');
  await page.waitForSelector('#importWsdlModal', { state: 'hidden' });
  await expect(page.locator('#operationList li')).toHaveCount(2);

  // 4. 选中 getUser（编辑器已有默认模板），直接保存
  await page.click('#operationList li:first-child');
  await page.waitForSelector('#wsEditorForm:not([hidden])');
  const xml = await page.textContent('#xmlEditorHost .cm-content');
  expect(xml).toContain('getUserResponse');
  await page.click('#wsSaveOpBtn');
  await page.waitForTimeout(300);

  // 5. 启动引擎
  await page.click('#startStopBtn');
  await page.waitForTimeout(600);

  // 6. SOAP 1.1 调用：SOAPAction 路由
  const r1 = await hitMock(18790, '/ws/UserService', {
    method: 'POST',
    headers: { 'content-type': 'text/xml', soapaction: '"urn:getUser"' },
    body: SOAP_CALL('<x/>'),
  });
  expect(r1.status).toBe(200);
  expect(r1.body).toContain('getUserResponse');

  // 7. Body localName 回退（无 SOAPAction）
  const r2 = await hitMock(18790, '/ws/UserService', {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body: SOAP_CALL('<listUsers/>'),
  });
  expect(r2.status).toBe(200);
  expect(r2.body).toContain('listUsersResponse');

  // 8. ?wsdl 地址重写为 mock 地址
  const w = await hitMock(18790, '/ws/UserService?wsdl');
  expect(w.status).toBe(200);
  expect(w.body).toContain('127.0.0.1:18790/ws/UserService');
  expect(w.body).not.toContain('real-server.example.com');

  // 9. 日志结果列出现 operation 名
  await page.waitForTimeout(500);
  const logText = await page.textContent('#logsBody');
  expect(logText).toContain('✓ getUser');
});
```

- [ ] **Step 2: 跑 E2E**

Run: `pnpm playwright test test/e2e/ws-happy-path.spec.js`
Expected: PASS（headed，不切 headless）。失败则按报错修实现（不许改测试预期来迁就 bug）。

- [ ] **Step 3: 全量 E2E 回归**

Run: `pnpm test:e2e`
Expected: 既有 spec（happy-path / json-editor / port-cards / port-detail / port-conflict / logs-order / theme 等）全部通过；若有因 UI 改动（徽标、结果列）失败的既有断言，按新行为更新并在 commit message 里说明。

- [ ] **Step 4: Commit**

```bash
git add test/e2e/ws-happy-path.spec.js
git commit -m "test: WS happy path E2E（建端口/导 WSDL/SOAP 调用）"
```

---

### Task 14: embed-assets 同步 + 全量回归 + CLAUDE.md

**Files:**
- Sync: `embed-assets/public/*`、`embed-assets/vendor/@codemirror/lang-xml`、`embed-assets/vendor/@lezer/xml`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 编译产物与 dev 一致（不变量 5）；文档反映新架构

- [ ] **Step 1: embed-assets 同步并校验**

```bash
rsync -a --delete public/ embed-assets/public/
# pnpm 的 node_modules 包是符号链接，必须 -L 解引用复制（既有 vendor 都是实体文件）
cp -RL node_modules/@codemirror/lang-xml embed-assets/vendor/@codemirror/
cp -RL node_modules/@lezer/xml embed-assets/vendor/@lezer/
diff -rq public/ embed-assets/public/   # 应无输出
ls embed-assets/vendor/@codemirror/lang-xml/dist/index.js embed-assets/vendor/@lezer/xml/dist/index.js
```

- [ ] **Step 2: 打包烟测（验证嵌入资源在编译产物里可用）**

```bash
bun build.mjs bun-darwin-arm64 /tmp/mockserver-ws-check
MOCK_HOST=127.0.0.1 /tmp/mockserver-ws-check &
sleep 1
curl -s http://127.0.0.1:5050/api/health        # → {"ok":true}
curl -s http://127.0.0.1:5050/vendor/codemirror/lang-xml/dist/index.js | head -c 100   # 非 404
kill %1 && rm /tmp/mockserver-ws-check
```

（5050 被占时按启动日志里的实际端口替换。）

- [ ] **Step 3: 全量回归**

Run: `pnpm test && pnpm test:e2e`
Expected: 全绿。

- [ ] **Step 4: 更新 CLAUDE.md**

四处修改：

1) 模块职责表追加三行：

```markdown
| `src/wsdl.js` | WSDL 解析/骨架生成/地址重写 | `parseWsdl` 抛 `INVALID_WSDL`；`rewriteAddress` 纯正则改写 location，不重建 XML 树 |
| `src/soap-router.js` | SOAP 版本识别/操作名提取/operation 匹配/Fault 生成 | 纯函数；匹配优先级：action 精确 > action 末段 > Body localName |
| `src/api-services.js` | `/api/services` + `/api/wsdl` 路由 | `toPublicService` 剥 wsdl 原文换 `hasWsdl`；operations 路由返回整个 service |
```

2) 前端小节的路由说明改为：`router.js — hash 路由（#/ 首页，#/port/<port> 详情——ws 端口渲染服务网格，#/port/<port>/svc/<id> WS 服务详情）`，views 列表补 `ws-services.js / ws-import.js / ws-detail.js` 一句话职责。

3) 全局状态键补 `services / selectedOperationId`。

4) 关键不变量追加：

```markdown
9. **端口分类型**：`type: 'http'|'ws'` 创建后不可改；资源类型必须与端口类型匹配（`PORT_TYPE_MISMATCH`）。
10. **WS 路由优先级**：`?wsdl` > SOAPAction 精确 > action 末段 > Body localName > Fault；匹配大小写敏感。
11. **WSDL 分发必须重写地址**：`?wsdl` 返回时 `soap:address location` 重写为 mock 自身地址（含骨架生成场景）。
12. **`GET /api/config` 不含 `services[].wsdl` 原文**（只有 `hasWsdl`）；存储层完整保留。
```

5) 文件指纹 `MockEngine.start` 行改为：`(endpoints, ports, services)` — src/mock-engine.js — 1 caller in src/api.js。

- [ ] **Step 5: Commit**

```bash
git add embed-assets/ CLAUDE.md
git commit -m "chore: embed-assets 同步（WS 视图 + lang-xml vendor）与 CLAUDE.md 更新"
```

---

## 完成定义（DoD）

- `pnpm test` 与 `pnpm test:e2e` 全绿（headed）
- 手动链路：新建 WS 端口 → 新建服务 → 导入 WSDL → 编辑 operation → 启动 → SOAP 1.1/1.2 调用命中 → `?wsdl` 地址重写 → 日志显示 operation 名
- `bun build.mjs` 产物 smoke 通过
- CLAUDE.md 反映新模块与不变量
