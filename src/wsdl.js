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