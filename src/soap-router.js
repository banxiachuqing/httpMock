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
 * 匹配优先级（spec §4)：a. action 精确 = o.soapAction；b. action 末段 = o.name；c. Body localName = o.name。
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