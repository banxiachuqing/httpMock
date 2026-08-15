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