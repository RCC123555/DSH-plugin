// hardware-quote · 铁木五金产品核价引擎（零 npm 依赖）
//
// 移植自旧版 2.4.1 `_legacy/calculate.mjs`（业务公式唯一真相），逐字段保留旧输出，
// 版本号升为 3.0.0，并按 CONTRACT.md 新增：
//   - blockingIssues: [{code, message, severity:'weight'|'dimensions'|'packaging'|'input', draftAllowed}]
//   - draftOnly: boolean（仅缺价类问题阻塞，允许导出「待核价」草稿）
// 修复旧版 P0：`--allow-draft` 只能放行缺价（missing_price），
// 不得放行重量矛盾 / 尺寸缺失 / 包装不完整 / 未确认暂估等问题。
//
// 口径来源：_legacy/references.orig/quotation-rules.md、pricing-basis.md
// 铁/木 5 元/kg；开料弯形焊接打磨合计 3 元/kg（按本体金属重量）；
// 喷涂 2.5 元/kg；纸箱全搭侧封 4.2 元/m²；EPS 425 元/m³；固定包装 12.1 元/件；
// r=0.085、k=0.9、t=0.1（7%～10% 为 P/Q 含税净利率口径）。

import {is1688, validatePriceEvidence, priceFromAverage} from './lookup.mjs';

export const VERSION = '3.0.1';
export const PROCESSING_RATE_PER_KG = 3;
export const DEFAULT_RATES = Object.freeze({metal: 5, wood: 5, coating: 2.5, carton: 4.2, tax: 0.1, netMargin: 0.085, managementToProfit: 0.9});
export const FIXED_PACKAGING = Object.freeze([
  {name: '条形码/贴标', quantity: 1, unitPrice: 1.5},
  {name: '说明书', quantity: 1, unitPrice: 2.5},
  {name: '护角', quantity: 8, unitPrice: 0.2},
  {name: '装柜人工', quantity: 1, unitPrice: 1.5},
  {name: '包装人工', quantity: 1, unitPrice: 5},
]);

const present = v => v !== null && v !== undefined;
const finite = v => typeof v === 'number' && Number.isFinite(v);

// blockingIssues.severity 的问题分类（不是日志级别）。未登记的 code 归入 'input'。
const ISSUE_CATEGORIES = Object.freeze({
  // 重量口径
  missing_net_weight_basis: 'weight',
  invalid_weight_membership: 'weight',
  invalid_weight_source: 'weight',
  missing_weight_basis: 'weight',
  weight_without_items: 'weight',
  accessory_weight_conflict: 'weight',
  weight_split: 'weight',
  missing_packaging_weight: 'weight',
  missing_extras_weight: 'weight',
  invalid_estimated_net: 'weight',
  missing_accessory_weight: 'weight',
  negative_accessory_weight: 'weight',
  negative_body_weight: 'weight',
  missing_net_weight: 'weight',
  missing_body_weight: 'weight',
  gross_below_net: 'weight',
  gross_weight_balance: 'weight',
  missing_material_split: 'weight',
  no_metal_coating: 'weight',
  // 尺寸缺失/无效
  product_dimensions: 'dimensions',
  carton_dimensions: 'dimensions',
  wood_dimensions: 'dimensions',
  // 包装不完整/无效
  missing_protection: 'packaging',
  pack_dimensions: 'packaging',
  invalid_eps_requirement: 'packaging',
  missing_eps_exception: 'packaging',
  invalid_eps_clearance: 'packaging',
  insufficient_eps_coverage: 'packaging',
});

const issueCategory = code => ISSUE_CATEGORIES[code] ?? 'input';

export function dimensionsCm(d) {
  if (!d || !['cm', 'mm', 'm'].includes(d.unit)) throw new Error('尺寸必须指定cm、mm或m。');
  const factor = {cm: 1, mm: 0.1, m: 100}[d.unit];
  const out = {};
  for (const key of ['length', 'width', 'height']) {
    if (!finite(d[key]) || d[key] <= 0) throw new Error(`尺寸${key}必须为正数。`);
    out[key] = d[key] * factor;
  }
  return out;
}

export function cartonAreaM2(d) {const c = dimensionsCm(d); return (c.length + 2 * c.height + 2) * (2 * c.width + 3 * c.height + 2) / 10000;}

export function cartonPrice(d, rate = 4.2) {return cartonAreaM2(d) * rate;}

export function pricing(C, r = 0.085, k = 0.9, t = 0.1) {
  const den = 1 - r * (1 + k) * (1 + t);
  if (![C, r, k, t].every(finite) || C < 0 || r < 0 || r >= 1 || k < 0 || k >= 1 || t < 0 || t > 1 || den <= 0) throw new Error('成本或利润、管理费、税金参数无效。');
  const profit = C * r * (1 + t) / den, management = profit * k, beforeTax = C + profit + management, tax = beforeTax * t;
  const afterTax = beforeTax + tax;
  return {profit, management, beforeTax, tax, afterTax, netMargin: afterTax === 0 ? null : profit / afterTax};
}

export function quoteDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`;
}

export function calculate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('报价输入必须为JSON对象。');
  const issues = [], assumptions = [...(input.assumptions ?? [])];
  const issue = (code, message, severity = 'blocking') => issues.push({code, message, severity});
  const value = (v, label, {defaultValue = null, positive = false} = {}) => {
    if (!present(v)) return defaultValue;
    if (!finite(v) || v < 0 || (positive && v === 0)) {issue('invalid_number', `${label}必须为${positive ? '正' : '非负'}数。`); return null;} return v;
  };
  const p = input.product ?? {}, order = input.order ?? {}, pack = input.packaging ?? {}, processing = input.processing ?? {};
  const rates = {...DEFAULT_RATES, ...(input.rates ?? {})};
  for (const [key, v] of Object.entries(rates)) if (!finite(v) || v < 0) issue('invalid_rate', `${key}单价或比例无效。`);
  if (rates.netMargin >= 1 || rates.tax > 1 || rates.managementToProfit >= 1 || 1 - rates.netMargin * (1 + rates.managementToProfit) * (1 + rates.tax) <= 0) issue('invalid_profit_parameters', '利润、管理费或税金比例无法形成有效报价。');
  if (rates.netMargin < 0.07 || rates.netMargin > 0.10) issue('margin_range', '指定含税净利率超出常规7%～10%，请核对。', 'warning');
  const quantity = value(order.quantity, '采购产品数量', {defaultValue: 500, positive: true});
  const unitsPerCarton = value(order.unitsPerCarton, '每箱产品数', {defaultValue: 1, positive: true});
  if (quantity !== null && !Number.isInteger(quantity)) issue('invalid_order', '采购产品数量必须为整数。');
  if (unitsPerCarton !== null && !Number.isInteger(unitsPerCarton)) issue('invalid_carton_quantity', '每箱产品数必须为整数。');
  if (!p.name) issue('missing_name', '请提供产品名称。');
  let productDimensions = null, cartonDimensions = null;
  try {productDimensions = dimensionsCm(p.dimensions);} catch (e) {issue('product_dimensions', `产品${e.message}`);}
  try {cartonDimensions = dimensionsCm(p.cartonDimensions);} catch (e) {issue('carton_dimensions', `外箱${e.message}`);}
  if (!['metal', 'wood', 'mixed'].includes(p.material)) issue('missing_material', '请将产品本体材质分类为metal、wood或mixed。');
  const date = p.date ?? quoteDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) issue('invalid_date', '报价日期必须为有效的YYYY-MM-DD。');
  if (typeof processing.needsCoating !== 'boolean') issue('missing_coating', '请判断产品本体是否需要喷涂。');

  function normalizeItem(item, index, isProtection = false) {
    const label = `${isProtection ? '保护包材' : '配件'}${index + 1}（${item.name ?? '未命名'}）`;
    const count = value(item.quantity, `${label}数量`);
    if (!present(item.quantity)) issue('missing_quantity', `${label}缺少每件产品用量。`);
    if (!item.name) issue('missing_item_name', `${label}缺少名称。`);
    if (!isProtection && count !== null && !Number.isInteger(count)) issue('accessory_count', `${label}数量必须为整数。`);
    let unitPrice = value(item.unitPrice, `${label}单价`), sourceType = item.sourceType ?? 'pending';
    let sourceLabel = item.provider ?? '', url = item.url ?? '', sourceNotes = item.notes ?? '';
    let pricingUnit = isProtection ? (item.pricing ?? 'piece') : 'piece';
    if (item.templateKey === 'm6-flange-screw') {
      if (!/内六角.*法兰/.test(item.name ?? '') || !/^M6[×x*]15(?:MM)?$/i.test((item.spec ?? '').replace(/\s/g, ''))) issue('template_spec', `${label}与模板内六角法兰面M6×15螺丝不匹配。`);
      else if (!present(item.unitPrice) && item.sourceType !== 'pending') {unitPrice = 0.1; sourceType = 'template'; sourceLabel = '对外报价BOM表 G14';}
    }
    if (item.templateKey === 'm6-nut') {
      if (!/螺母/.test(item.name ?? '') || !/^M6$/i.test((item.spec ?? '').trim())) issue('template_spec', `${label}与模板M6螺母不匹配。`);
      else if (!present(item.unitPrice) && item.sourceType !== 'pending') {unitPrice = 0.2; sourceType = 'template'; sourceLabel = '对外报价BOM表 G15';}
    }
    if (isProtection && item.templateKey === 'eps-15-volume') {
      if (item.material !== 'EPS' || pricingUnit !== 'volume' || (present(item.densityKgM3) && item.densityKgM3 !== 15)) issue('template_eps', `${label}的425元/m³模板价格只适用于15kg/m³ EPS体积参考。`);
      else if (!present(item.unitPrice) && item.sourceType !== 'pending') {unitPrice = 425; sourceType = 'template'; sourceLabel = '纸箱单价核算：泡沫片计算 F18'; sourceNotes += ' 原表列头为元/平方，但公式按体积换算，采用元/m³。';}
    }
    if (!['user', 'web', 'template', 'estimate', 'pending'].includes(sourceType)) issue('invalid_source', `${label}的来源类型无效。`);
    if (sourceType === 'web' && (!/^https?:\/\//.test(url) || !item.provider || !/^\d{4}-\d{2}-\d{2}$/.test(item.queriedAt ?? '') || !item.quoteUnit)) {
      issue('missing_source', `${label}联网价格需要供应商/平台、具体链接、查询日期和原始报价单位。`); unitPrice = null;
    }
    if (sourceType === 'estimate') issue('estimated_price', `${label}单价为暂估${item.estimateApproved === true ? '，已由用户确认' : '，未由用户确认，待核价'}。`, item.estimateApproved === true ? 'warning' : 'blocking');
    if (url && (typeof url !== 'string' || !/^https?:\/\//.test(url))) {issue('invalid_url', `${label}参考链接必须为http或https物料网页。`); url = ''; unitPrice = null;}
    if (!present(unitPrice) || sourceType === 'pending') {issue('missing_price', `${label}待核价；用户未补充单价时优先在1688用文字或图片搜索，未找到有效价格可留空并导出待核价草稿，无需追问单价。`); unitPrice = null;}
    let dimensions = null, baseQuantity = count;
    if (isProtection && !['piece', 'volume', 'area', 'length'].includes(pricingUnit)) {issue('pricing_unit', `${label}计价方式无效。`); baseQuantity = null;}
    if (isProtection && ['volume', 'area', 'length'].includes(pricingUnit)) {
      try {dimensions = dimensionsCm(item.dimensions); if (count !== null) baseQuantity = count * (pricingUnit === 'volume' ? dimensions.length * dimensions.width * dimensions.height / 1e6 : pricingUnit === 'area' ? dimensions.length * dimensions.width / 1e4 : dimensions.length / 100);}
      catch (e) {issue('pack_dimensions', `${label}：${e.message}`); baseQuantity = null;}
    } else if (isProtection && item.dimensions) {try {dimensions = dimensionsCm(item.dimensions);} catch (e) {issue('pack_dimensions', `${label}：${e.message}`);}}
    const demand = baseQuantity !== null && quantity !== null ? baseQuantity * quantity : null;
    if (sourceType === 'web' && is1688(url)) {
      const e = item.priceEvidence;
      const aggregate = e?.method === 'arithmetic_mean';
      const evidenceIssues = aggregate ? [] : validatePriceEvidence(e, demand);
      if (aggregate) {
        try {
          const pr = priceFromAverage(e, demand);
          if (pr.url !== url || pr.queriedAt !== item.queriedAt || !finite(unitPrice) || Math.abs(pr.unitPrice - unitPrice) > 1e-9) evidenceIssues.push('录入均价、日期或主链接与样本不一致');
          for (const k of ['minOrderQty', 'priceTierMinQty', 'priceTierMaxQty']) if (present(item[k])) evidenceIssues.push('均价不能伪造单一供应商MOQ或档位');
        } catch (err) {evidenceIssues.push(err.message);}
        const targetUnit = isProtection ? ({piece: item.unit ?? '个', volume: 'm³', area: 'm²', length: 'm'}[pricingUnit]) : (item.unit ?? '个');
        if (e.targetUnit !== targetUnit) evidenceIssues.push('均价目标单位与BOM不一致');
      }
      if (e && typeof e === 'object' && !aggregate) {
        if (e.url !== url) evidenceIssues.push('浏览器证据链接与所录商品链接不同');
        if (e.queriedAt !== item.queriedAt) evidenceIssues.push('浏览器证据日期与单价日期不同');
        if (finite(e.originalPrice) && finite(e.targetUnitsPerQuoteUnit) && e.targetUnitsPerQuoteUnit > 0 && unitPrice !== null && Math.abs(unitPrice - e.originalPrice / e.targetUnitsPerQuoteUnit) > 1e-9) evidenceIssues.push('录入单价与原报价单位换算不一致');
        const targetUnit = isProtection ? ({piece: item.unit ?? '个', volume: 'm³', area: 'm²', length: 'm'}[pricingUnit]) : (item.unit ?? '个');
        if (e.targetUnit !== targetUnit) evidenceIssues.push(`证据目标单位必须与BOM的${targetUnit}一致`);
        for (const [field, original] of [['minOrderQty', 'minOrderQty'], ['priceTierMinQty', 'tierMinQty'], ['priceTierMaxQty', 'tierMaxQty']]) {
          if (present(e[original]) && (!finite(item[field]) || Math.abs(item[field] - e[original] * e.targetUnitsPerQuoteUnit) > 1e-9)) evidenceIssues.push(`${field}未按原报价单位同步换算`);
          if (!present(e[original]) && present(item[field])) evidenceIssues.push(`${field}在浏览器证据中未公布，不能自行补造`);
        }
      }
      if (evidenceIssues.length) {issue('lookup_evidence', `${label}1688单价待核：${evidenceIssues.join('；')}`); unitPrice = null; sourceType = 'pending'; sourceNotes += ` 1688证据待补：${evidenceIssues.join('；')}`;}
    }
    for (const [field, caption] of [['minOrderQty', '起订量'], ['priceTierMinQty', '价格档位下限'], ['priceTierMaxQty', '价格档位上限']]) {
      if (present(item[field]) && (!finite(item[field]) || item[field] < 0)) issue('invalid_tier', `${label}${caption}无效。`);
    }
    if (demand !== null && present(item.minOrderQty) && demand + 1e-9 < item.minOrderQty) {issue('below_moq', `${label}需求量${demand}低于起订量${item.minOrderQty}，需另选价格或确认采购口径。`); unitPrice = null;}
    if (demand !== null && ((present(item.priceTierMinQty) && demand + 1e-9 < item.priceTierMinQty) || (present(item.priceTierMaxQty) && demand - 1e-9 > item.priceTierMaxQty))) {issue('outside_tier', `${label}采购量不在所选价格档位内。`); unitPrice = null;}
    const weightKgPerUnit = value(item.weightKgPerUnit, `${label}单件重量`);
    const includedInNetWeight = isProtection ? false : (item.includedInNetWeight ?? true);
    if (!isProtection && typeof includedInNetWeight !== 'boolean') issue('invalid_weight_membership', `${label}includedInNetWeight必须为布尔值。`);
    const weightSourceType = item.weightSourceType ?? 'user';
    const weightBasis = item.weightBasis ?? (weightSourceType === 'user' ? '用户提供单件重量' : item.notes ?? '');
    if (weightKgPerUnit !== null && !['user', 'web', 'estimate'].includes(weightSourceType)) issue('invalid_weight_source', `${label}重量来源无效。`);
    if (weightKgPerUnit !== null && weightSourceType !== 'user' && !weightBasis) issue('missing_weight_basis', `${label}估重或联网重量必须说明依据。`);
    const density = value(item.densityKgM3, `${label}密度`, {defaultValue: item.templateKey === 'eps-15-volume' ? 15 : null, positive: true});
    const weightKg = weightKgPerUnit !== null && count !== null ? weightKgPerUnit * count : dimensions && density !== null && count !== null ? dimensions.length * dimensions.width * dimensions.height / 1e6 * density * count : null;
    return {...item, quantity: count, unitPrice, sourceType, sourceLabel, url, notes: sourceNotes, pricing: pricingUnit, dimensions, baseQuantity, demand, weightKgPerUnit, weightKg, weightSourceType, weightBasis, includedInNetWeight, cost: unitPrice !== null && baseQuantity !== null ? unitPrice * baseQuantity : null};
  }
  const accessories = (input.accessories ?? []).map((item, i) => normalizeItem(item, i));
  if (!Array.isArray(input.accessories)) issue('missing_accessories', '请提供配件数组，无配件时明确填写空数组。');
  const protection = (pack.protection ?? []).map((item, i) => normalizeItem(item, i, true));
  if (!Array.isArray(pack.protection)) issue('missing_protection', '请提供保护包材数组，无保护包材时明确填写空数组。');
  const requireTopBottomEps = pack.requireTopBottomEps ?? true;
  if (typeof requireTopBottomEps !== 'boolean') issue('invalid_eps_requirement', 'requireTopBottomEps必须为布尔值。');
  const clearance = value(pack.topBottomClearanceCm, 'EPS长宽合计预留', {defaultValue: 3});
  const faces = cartonDimensions ? Object.values(cartonDimensions).sort((a, b) => b - a) : [];
  const requiredLength = faces.length && clearance !== null ? faces[0] - clearance : null, requiredWidth = faces.length && clearance !== null ? faces[1] - clearance : null;
  let fullPanelsPerCarton = null;
  if (requireTopBottomEps === false) {if (!pack.epsExceptionBasis) issue('missing_eps_exception', '不使用上下整片EPS时必须记录用户明确的替代包装或免用依据。');}
  else if (requireTopBottomEps === true && requiredLength !== null && requiredWidth !== null && unitsPerCarton !== null) {
    if (requiredLength <= 0 || requiredWidth <= 0) issue('invalid_eps_clearance', 'EPS长宽预留超过箱面尺寸。');
    else {
      fullPanelsPerCarton = protection.filter(x => x.material === 'EPS' && x.dimensions && x.quantity !== null).reduce((count, x) => {const sides = [x.dimensions.length, x.dimensions.width].sort((a, b) => b - a); return count + (sides[0] + 1e-9 >= requiredLength && sides[1] + 1e-9 >= requiredWidth ? x.quantity * unitsPerCarton : 0);}, 0);
      if (fullPanelsPerCarton + 1e-9 < 2) issue('insufficient_eps_coverage', `每箱顶部和底部各需至少1整片EPS（共2片），每片至少${requiredLength}×${requiredWidth}cm；小垫条/垫块不能替代整面缓冲，目前完整覆盖仅${fullPanelsPerCarton}片/箱。`);
    }
  }
  const epsCoverage = {required: requireTopBottomEps, clearanceCm: clearance, minimumLengthCm: requiredLength, minimumWidthCm: requiredWidth, fullPanelsPerCarton};
  const gross = value(p.grossWeightKg, '毛重', {positive: true});
  const suppliedNet = value(p.netWeightKg, '输入净重', {positive: true});
  const netWeightBasis = p.netWeightBasis;
  if (suppliedNet !== null && !['assembled', 'body'].includes(netWeightBasis)) issue('missing_net_weight_basis', '净重必须标记netWeightBasis=assembled（组装整件）或body（旧版主料本体）；旧输入不可直接重跑。');
  let net = netWeightBasis === 'body' ? null : suppliedNet, body = netWeightBasis === 'body' ? suppliedNet : null, netOrigin = netWeightBasis === 'body' ? 'body' : 'user';
  let metal = value(p.metalWeightKg, '金属重量'), wood = value(p.woodWeightKg, '木材重量');
  const weightEstimates = input.weightEstimates ?? {};
  const assembledAccessories = accessories.filter(x => x.includedInNetWeight !== false), extras = accessories.filter(x => x.includedInNetWeight === false);
  const groupWeight = (items, field, basisField, label) => {
    const supplied = value(weightEstimates[field], `${label}合计重量`);
    const detailed = items.every(x => x.weightKg !== null) ? items.reduce((s, x) => s + x.weightKg, 0) : null;
    if (supplied !== null && items.length === 0 && supplied > 0) issue('weight_without_items', `${label}重量为正但没有对应BOM，请补齐明细。`);
    if (supplied !== null && !weightEstimates[basisField]) issue('missing_weight_basis', `${label}合计重量必须说明依据。`);
    if (supplied !== null && detailed !== null && Math.abs(supplied - detailed) > 0.01) issue('accessory_weight_conflict', `${label}合计重量与逐项重量不一致。`);
    return supplied ?? detailed;
  };
  let accessoryWeight = groupWeight(assembledAccessories, 'accessoriesKg', 'accessoriesBasis', '组装配件');
  const extrasWeight = groupWeight(extras, 'extrasKg', 'extrasBasis', '非组装附带件');
  const packagingWeight = value(weightEstimates.packagingKg, '包材合计估重');
  let netEstimated = false;
  if (p.material === 'metal' && metal !== null) wood = wood ?? 0;
  if (p.material === 'wood' && wood !== null) metal = metal ?? 0;
  if (metal !== null && wood !== null) {
    const materialBody = metal + wood;
    if (body !== null && Math.abs(body - materialBody) > 0.01) issue('weight_split', '旧版本体重量与明确铁木分重不一致。');
    body = body ?? materialBody;
  }
  if (net === null && body === null && gross !== null) {
    if (packagingWeight === null) issue('missing_packaging_weight', '只有毛重时，需要包材合计估重，包含纸箱、保护材料及其他包材。');
    if (extrasWeight === null) issue('missing_extras_weight', '只有毛重时，需要非组装附带件重量；必需组装配件仍包含在净重中。');
    if (extrasWeight !== null && packagingWeight !== null) {
      net = gross - packagingWeight - extrasWeight; netEstimated = true; netOrigin = 'gross';
      if (net <= 0) {issue('invalid_estimated_net', '毛重扣除包材和非组装附带件后的组装净重不为正，请核对。'); net = null;}
      if (!weightEstimates.packagingBasis) issue('missing_weight_basis', '包材估重必须说明依据。');
      assumptions.push(`组装净重为估算：毛重${gross}kg－包材${packagingWeight}kg－非组装附带件${extrasWeight}kg；必需组装配件不在此步扣除。`);
    }
  }
  if (accessoryWeight === null && net !== null && body !== null) {
    accessoryWeight = net - body;
    assumptions.push('组装配件合计重量由组装净重减明确主料本体重量得到；没有虚构逐项分重。');
  }
  if (accessoryWeight === null) issue('missing_accessory_weight', '拆分主料需要必需组装配件重量；可自动合理估重并注明依据，不能默认零。');
  if (accessoryWeight !== null && accessoryWeight < 0) issue('negative_accessory_weight', '主料重量超过组装净重，无法得到合理配件重量。');
  if (net === null && body !== null && accessoryWeight !== null) {net = body + accessoryWeight; netOrigin = netWeightBasis === 'body' ? 'body' : 'material'; assumptions.push('组装净重由明确主料本体重量加必需组装配件重量得到。');}
  if (net !== null && accessoryWeight !== null) {
    const calculatedBody = net - accessoryWeight;
    if (body !== null && Math.abs(body - calculatedBody) > 0.01) issue('weight_split', '主料重量加组装配件重量与组装净重不一致。');
    body = body ?? calculatedBody;
    if (body < 0) issue('negative_body_weight', '组装配件重量超过组装净重，主料重量为负。');
  }
  if (net === null) issue('missing_net_weight', '缺少可用的组装净重。');
  if (body === null) issue('missing_body_weight', '缺少可用的主料本体重量。');
  if (net !== null && gross !== null && gross + 0.001 < net) issue('gross_below_net', '毛重小于组装净重，请核对重量口径。');
  if (net !== null && gross !== null && packagingWeight !== null && extrasWeight !== null && Math.abs(gross - net - packagingWeight - extrasWeight) > 0.01) issue('gross_weight_balance', '毛重与组装净重、包材和非组装附带件重量之和不一致。');
  const woodPieces = (p.material === 'mixed' && wood === null && metal === null ? (input.woodPieces ?? []) : []).map((piece, i) => {
    const factor = {cm: 1, mm: 0.1, m: 100}[piece.unit];
    if (!factor || !finite(piece.length) || piece.length <= 0 || !finite(piece.width) || piece.width <= 0) {issue('wood_dimensions', `木件${i + 1}尺寸无效。`); return null;}
    const rawThickness = present(piece.thickness) ? value(piece.thickness, `木件${i + 1}厚度`, {positive: true}) : null;
    const thickness = present(piece.thickness) ? rawThickness === null ? null : rawThickness * factor : 1.8;
    const density = value(piece.densityKgM3, `木件${i + 1}密度`, {defaultValue: 650, positive: true});
    const count = value(piece.quantity, `木件${i + 1}数量`, {defaultValue: 1, positive: true});
    if (!present(piece.thickness)) assumptions.push(`木件${i + 1}厚度暂按18mm。`);
    if (!present(piece.densityKgM3)) assumptions.push(`木件${i + 1}密度暂按650kg/m³。`);
    return {length: piece.length * factor, width: piece.width * factor, thickness, density, quantity: count, weight: thickness !== null && density !== null && count !== null ? piece.length * factor * piece.width * factor * thickness / 1e6 * density * count : null, notes: piece.notes ?? ''};
  });
  if (body !== null) {
    if (p.material === 'metal') {wood = wood ?? 0; metal = metal ?? body;}
    else if (p.material === 'wood') {metal = metal ?? 0; wood = wood ?? body;}
    else if (p.material === 'mixed') {
      if (wood === null && woodPieces.length && woodPieces.every(x => x && x.weight !== null)) {wood = woodPieces.reduce((s, x) => s + x.weight, 0); assumptions.push('木件按图片尺寸和体积估重；金属重量由扣除组装配件后的主料本体重量减木重得到。');}
      if (wood === null && metal !== null) wood = body - metal;
      if (metal === null && wood !== null) metal = body - wood;
      if (wood === null || metal === null) issue('missing_material_split', '铁木混合产品需要木件尺寸或铁木分重。');
    }
    if (metal !== null && wood !== null && (metal < 0 || wood < 0 || Math.abs(metal + wood - body) > 0.01)) issue('weight_split', '铁木重量之和与主料本体重量不一致，或木重超过主料重量。');
  }
  if (processing.needsCoating && metal === 0) issue('no_metal_coating', '产品没有金属重量，但标记为需要金属喷涂，请核对。');
  const sum = items => items.some(x => x.cost === null) ? null : items.reduce((s, x) => s + x.cost, 0);
  const costs = {
    main: body !== null && metal !== null && wood !== null && body >= 0 && metal >= 0 && wood >= 0 ? metal * rates.metal + wood * rates.wood : null,
    accessories: sum(accessories),
    processing: metal !== null && metal >= 0 ? metal * PROCESSING_RATE_PER_KG : null,
    coating: processing.needsCoating === false ? 0 : processing.needsCoating === true && metal !== null ? metal * rates.coating : null,
    protection: sum(protection),
    carton: cartonDimensions && unitsPerCarton !== null ? cartonPrice({...cartonDimensions, unit: 'cm'}, rates.carton) / unitsPerCarton : null,
    fixedPackaging: FIXED_PACKAGING.reduce((s, x) => s + x.quantity * x.unitPrice, 0),
  };
  const direct = Object.values(costs).some(x => !finite(x)) ? null : Object.values(costs).reduce((s, x) => s + x, 0);
  let totals = null;
  if (direct !== null && !issues.some(x => x.code === 'invalid_profit_parameters' || x.code === 'invalid_rate')) {try {totals = pricing(direct, rates.netMargin, rates.managementToProfit, rates.tax);} catch (e) {issue('profit_calculation', e.message);}}
  // blockingIssues 只列出 blocking 级问题；severity 是问题分类（重量/尺寸/包装/输入）。
  // 只有缺价（missing_price）允许草稿导出；旧版 --allow-draft 的 P0 在这里被收敛。
  const blockingIssues = issues
    .filter(x => x.severity === 'blocking')
    .map(x => ({code: x.code, message: x.message, severity: issueCategory(x.code), draftAllowed: x.code === 'missing_price'}));
  const ready = blockingIssues.length === 0;
  const draftOnly = blockingIssues.length > 0 && blockingIssues.every(x => x.draftAllowed);
  return {version: VERSION, ready, draftOnly, product: {...p, date, dimensions: productDimensions, cartonDimensions}, order: {quantity, unitsPerCarton}, processing, rates, accessories, protection, woodPieces, epsCoverage, costs, directCost: direct, totals: ready ? totals : null, weights: {gross, net, body, metal, wood, accessories: accessoryWeight, extras: extrasWeight, packaging: packagingWeight, netEstimated, netOrigin, netWeightBasis: 'assembled'}, weightEstimates, assumptions: [...new Set(assumptions)], issues, blockingIssues};
}
