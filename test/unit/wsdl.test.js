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