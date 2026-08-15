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