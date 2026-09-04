// 端口内拖拽排序的顺序合并（纯函数，无状态）。
//
// 背景：端口详情页侧栏只渲染当前端口的接口子集，拖拽落点读到的 DOM 顺序
// 也只是该子集；而服务端 PUT /api/endpoints/order 要求提交全量端点 id 的
// 排列。此函数把「当前端口的新顺序」合并回跨端口全量数组：
// 遍历原数组，遇到当前端口端点则依次替换为新顺序里的下一个；
// 其他端口端点保持原位与相对顺序。

/**
 * @param {Array<{id: string, port: number}>} allEndpoints 跨端口全量端点（原顺序）
 * @param {number} port 当前端口
 * @param {string[]} newPortIds 当前端口端点 id 的新排列（来自拖拽后的 DOM 顺序）
 * @returns {Array} 合并后的全量数组（新数组，不改入参）
 */
export function mergePortOrder(allEndpoints, port, newPortIds) {
  const byId = new Map(allEndpoints.map((e) => [e.id, e]));
  // 防御：只接受真实存在且属于当前端口的 id，去重，保持 newPortIds 顺序
  const seen = new Set();
  const queue = [];
  for (const id of newPortIds) {
    const ep = byId.get(id);
    if (!ep || ep.port !== port || seen.has(id)) continue;
    seen.add(id);
    queue.push(ep);
  }
  let i = 0;
  // 当前端口端点依次替换为新顺序；queue 耗尽后（异常输入下）剩余端点原位保留
  return allEndpoints.map((ep) =>
    ep.port === port && i < queue.length ? queue[i++] : ep,
  );
}
