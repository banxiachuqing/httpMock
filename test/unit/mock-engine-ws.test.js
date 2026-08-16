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
  port: 18094,
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
  id: 'svc2', port: 18094, path: '/ws/OrderService', name: 'OrderService', enabled: true,
  targetNamespace: 'http://example.com/order', wsdl: IMPORTED_WSDL, operations: [],
};

const PORTS = [{ port: 18094, enabled: true, type: 'ws' }];
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
    const r = await req({ port: 18094, path: '/ws/UserService?wsdl' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/xml/);
    expect(r.body).toContain('targetNamespace="http://example.com/user"');
    expect(r.body).toContain('location="http://127.0.0.1:18094/ws/UserService"');
    expect(r.body).toContain('name="getUser"');
  });

  it('导入 WSDL → 地址重写为 mock 地址', async () => {
    await startWs();
    const r = await req({ port: 18094, path: '/ws/OrderService?WSDL' }); // 查询键大小写不敏感
    expect(r.status).toBe(200);
    expect(r.body).toContain('location="http://127.0.0.1:18094/ws/OrderService"');
    expect(r.body).not.toContain('real-server.example.com');
  });

  it('无 ?wsdl 的 GET → 404 带 hint', async () => {
    await startWs();
    const r = await req({ port: 18094, path: '/ws/UserService' });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).hint).toMatch(/\?wsdl/);
  });
});

describe('MockEngine WS：POST 路由', () => {
  it('SOAPAction 头匹配', async () => {
    await startWs();
    const r = await req({
      port: 18094, path: '/ws/UserService', method: 'POST',
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
      port: 18094, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: SOAP11_ENV('<getUser xmlns="http://example.com/user"><id>1</id></getUser>'),
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('getUserResponse');
  });

  it('1.2 请求：action= 参数路由，响应 Content-Type 为 application/soap+xml', async () => {
    await startWs();
    const r = await req({
      port: 18094, path: '/ws/UserService', method: 'POST',
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
      port: 18094, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: SOAP11_ENV('<deleteUser/>'),
    });
    expect(r.status).toBe(500);
    expect(r.body).toContain('<faultstring>denied</faultstring>');
  });

  it('未命中 operation → 500 Server Fault；禁用 operation 按未命中处理', async () => {
    await startWs();
    const r = await req({
      port: 18094, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: SOAP11_ENV('<noSuchOp/>'),
    });
    expect(r.status).toBe(500);
    expect(r.body).toContain('<faultcode>soap:Server</faultcode>');
    expect(r.body).toContain('no mock for operation noSuchOp');

    const g = await req({
      port: 18094, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: SOAP11_ENV('<ghost/>'),
    });
    expect(g.status).toBe(500);
    expect(g.body).toContain('no mock for operation ghost');
  });

  it('1.2 未命中 → Receiver Fault', async () => {
    await startWs();
    const r = await req({
      port: 18094, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'application/soap+xml' },
      body: `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nope/></soap:Body></soap:Envelope>`,
    });
    expect(r.status).toBe(500);
    expect(r.body).toContain('<soap:Value>soap:Receiver</soap:Value>');
  });

  it('responseXml 为空 → 500 Fault no response configured', async () => {
    await startWs();
    const r = await req({
      port: 18094, path: '/ws/UserService', method: 'POST',
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
      port: 18094, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' }, body: bad,
    });
    expect(r11.status).toBe(500);
    expect(r11.body).toContain('soap:Client');

    const r12 = await req({
      port: 18094, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'application/soap+xml' }, body: bad,
    });
    expect(r12.status).toBe(400);
    expect(r12.body).toContain('soap:Sender');
  });

  it('path 未命中 → 404 JSON', async () => {
    await startWs();
    const r = await req({ port: 18094, path: '/ws/Nope', method: 'POST', headers: { 'content-type': 'text/xml' }, body: '<x/>' });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).error).toMatch(/no mock/);
  });
});

describe('MockEngine WS：日志', () => {
  it('命中写 serviceId + operationName；未命中 operationName 为尝试名', async () => {
    await startWs();
    await req({
      port: 18094, path: '/ws/UserService', method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: SOAP11_ENV('<getUser/>'),
    });
    await req({
      port: 18094, path: '/ws/UserService', method: 'POST',
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