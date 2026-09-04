// mergePortOrder：端口详情页拖拽排序时，DOM 只有当前端口的接口子集，
// 需要把「当前端口的新顺序」合并回跨端口全量数组——其他端口端点原位保留，
// 输出必须是输入的排列，才能通过服务端 PUT /api/endpoints/order 的全量排列校验。
import { describe, it, expect } from 'vitest';
import { mergePortOrder } from '../../public/port-order.js';

const ep = (id, port) => ({ id, port, method: 'GET', path: `/${id}` });

describe('mergePortOrder（端口内拖拽排序合并回全局数组）', () => {
  it('当前端口内重排，其他端口端点原位保留', () => {
    const all = [ep('a1', 9000), ep('b1', 1000), ep('a2', 9000), ep('b2', 1000), ep('a3', 9000)];
    const out = mergePortOrder(all, 9000, ['a3', 'a1', 'a2']);
    expect(out.map((e) => e.id)).toEqual(['a3', 'b1', 'a1', 'b2', 'a2']);
  });

  it('输出是输入的排列（不丢 id、不增 id）', () => {
    const all = [ep('a1', 9000), ep('b1', 1000), ep('a2', 9000)];
    const out = mergePortOrder(all, 9000, ['a2', 'a1']);
    expect([...out.map((e) => e.id)].sort()).toEqual(['a1', 'a2', 'b1']);
  });

  it('当前端口端点的相对顺序与 newPortIds 一致', () => {
    const all = [ep('a1', 9000), ep('a2', 9000), ep('a3', 9000)];
    const out = mergePortOrder(all, 9000, ['a3', 'a2', 'a1']);
    expect(out.filter((e) => e.port === 9000).map((e) => e.id)).toEqual(['a3', 'a2', 'a1']);
  });

  it('顺序未变时输出等价数组', () => {
    const all = [ep('a1', 9000), ep('b1', 1000)];
    const out = mergePortOrder(all, 9000, ['a1']);
    expect(out.map((e) => e.id)).toEqual(['a1', 'b1']);
  });

  it('当前端口没有接口 / newPortIds 为空时原样返回', () => {
    const all = [ep('b1', 1000), ep('b2', 1000)];
    expect(mergePortOrder(all, 9000, []).map((e) => e.id)).toEqual(['b1', 'b2']);
    expect(mergePortOrder([], 9000, [])).toEqual([]);
  });

  it('防御：newPortIds 混入其他端口 / 未知 / 重复 id 时忽略，不产出重复或丢失', () => {
    const all = [ep('a1', 9000), ep('b1', 1000), ep('a2', 9000)];
    const out = mergePortOrder(all, 9000, ['b1', 'ghost', 'a2', 'a2', 'a1']);
    expect([...out.map((e) => e.id)].sort()).toEqual(['a1', 'a2', 'b1']);
    expect(out.filter((e) => e.port === 9000).map((e) => e.id)).toEqual(['a2', 'a1']);
  });

  it('不修改输入数组（不可变更新）', () => {
    const all = [ep('a1', 9000), ep('a2', 9000)];
    const snapshot = all.map((e) => e.id);
    mergePortOrder(all, 9000, ['a2', 'a1']);
    expect(all.map((e) => e.id)).toEqual(snapshot);
  });
});
