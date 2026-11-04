import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Browser operations belong to the host's supported browser/computer tools.
// This module plans searches and validates observed prices. It does not fetch pages.
export const is1688 = url => {try {const u=new URL(url);return u.protocol==='https:'&&(u.hostname==='1688.com'||u.hostname.endsWith('.1688.com'));}catch{return false;}};
export const isOffer = url => {try {const u=new URL(url);return u.protocol==='https:'&&u.hostname==='detail.1688.com'&&/^\/offer\/\d+\.html$/.test(u.pathname);}catch{return false;}};
const nonempty=x=>typeof x==='string'&&x.trim().length>0;
const number=x=>typeof x==='number'&&Number.isFinite(x);
const validDate=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&!Number.isNaN(Date.parse(x))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;

export function classifyFailure({channel,message='',pageText='',pageUrl=''}={}) {
  // A generic fetch error or debugger failure is never evidence about site auth.
  if(channel==='web')return 'web_tool_error';
  if(/debugger unattached|tab not found|timed out|timeout|无法.*确认.*网址|could not determine.*URL|extension.*(disconnected|stopped)/i.test(message))return 'browser_connection_error';
  if(!is1688(pageUrl))return 'browser_url_unverified';
  if(/验证码|滑块验证|安全验证|访问验证/.test(pageText))return 'verification_required';
  if(/请先登录|登录后查看价格|扫码登录|密码登录/.test(pageText))return 'login_required';
  if(/没有找到相关|暂无相关商品/.test(pageText))return 'no_match';
  return 'unresolved';
}

export function planLookups(input) {
 const groups=[['accessories',input.accessories??[]],['packaging.protection',input.packaging?.protection??[]]];
 const order=input.order?.quantity??500, tasks=[];
 for(const [group,items] of groups)for(const [i,item] of items.entries()){
  if(item.sourceType==='user'||item.sourceType==='template')continue;
  if(item.templateKey&&item.sourceType!=='pending'&&item.unitPrice==null)continue;
  if(item.sourceType==='web'&&number(item.unitPrice)&&item.unitPrice>=0)continue;
  if(item.sourceType==='estimate'&&item.estimateApproved===true&&number(item.unitPrice)&&item.unitPrice>=0)continue;
  const keywords=[item.name,item.material,item.spec].filter(nonempty).join(' ');
  tasks.push({itemPath:`${group}[${i}]`,name:item.name,spec:item.spec??'',method:item.lookupMethod??'keyword',keywords,image:item.lookupImage??null,productQuantity:order,usagePerProduct:item.quantity??null,unit:item.pricing??'piece',quantityBeforeUnitConversion:number(item.quantity)?item.quantity*order:null,entry:'https://www.1688.com/',steps:['read_browser_workflow','connect_local_browser','search_via_visible_ui','open_offer','select_spec','read_regular_price_unit_and_tier','validate_and_apply'],status:'not_started'});
 }
 return {version:1,tasks,notes:'数量为按用量×订单量计算的初值；体积/面积/长度包材须先按尺寸换算，原报价为包/副/箱时再换算。此计划不是搜索证据。'};
}

export function validatePriceEvidence(e,demand) {
 const issues=[];const require=(ok,msg)=>{if(!ok)issues.push(msg);};
 require(e&&typeof e==='object','缺少浏览器价格证据');if(!e||typeof e!=='object')return issues;
 require(isOffer(e.url),'必须使用实际打开的1688商品详情链接');
 for(const k of ['supplier','title','selectedSpec','quoteUnit','targetUnit','observedText'])require(nonempty(e[k]),`缺少${k}`);
 require(validDate(e.queriedAt),'查询日期无效');
 require(['visible_dom','screenshot'].includes(e.evidenceKind),'须来自已显示的网页或截图');
 require(['keyword','image'].includes(e.searchMethod),'须记录关键词或图片查找方式');
 require(e.searchMethod!=='keyword'||nonempty(e.keywords),'文字搜索缺少实际关键词');
 require(e.searchMethod!=='image'||nonempty(e.inputImage),'图片搜索缺少实际使用图片的说明/路径');
 require(e.specMatched===true,'所选规格尚未核对匹配');
 require(e.currency==='CNY','本核价器只接受已确认人民币报价');
 require(e.priceKind==='regular','不得采用起始价、样品价、首单价或优惠券价');
 require(number(e.originalPrice)&&e.originalPrice>=0,'原始单价无效');
 require(number(e.targetUnitsPerQuoteUnit)&&e.targetUnitsPerQuoteUnit>0,'报价单位换算系数无效');
 require(number(demand)&&demand>0,'须提供按目标计价单位换算的采购总需求');
 for(const k of ['minOrderQty','tierMinQty','tierMaxQty'])if(e[k]!=null)require(number(e[k])&&e[k]>=0,`${k}无效`);
 require(e.tierMaxQty==null||e.tierMinQty==null||e.tierMaxQty>=e.tierMinQty,'价格档位上下限颠倒');
 if(number(demand)&&number(e.targetUnitsPerQuoteUnit)&&e.targetUnitsPerQuoteUnit>0){
  const q=demand/e.targetUnitsPerQuoteUnit;
  if(e.minOrderQty!=null)require(q+1e-9>=e.minOrderQty,'采购量低于起订量');
  if(e.tierMinQty!=null)require(q+1e-9>=e.tierMinQty,'采购量低于价格档位');
  if(e.tierMaxQty!=null)require(q-1e-9<=e.tierMaxQty,'采购量超过价格档位');
 }
 return issues;
}

export function priceFromEvidence(e,demand) {
 if(e?.method==='arithmetic_mean')return priceFromAverage(e,demand);
 const issues=validatePriceEvidence(e,demand);if(issues.length)throw new Error(issues.join('；'));
 const factor=e.targetUnitsPerQuoteUnit;
 const notes=`1688本机浏览器${e.searchMethod==='image'?'以图搜款':'关键词搜索'}；商品：${e.title}；已选规格：${e.selectedSpec}；原价${e.originalPrice}元/${e.quoteUnit}，1${e.quoteUnit}=${factor}${e.targetUnit}；采购需求${demand}${e.targetUnit}。MOQ及档位未提供者为页面未公布，不代表零或无限制。观察记录：${e.observedText}`;
 return {sourceType:'web',provider:`${e.supplier} / 1688`,url:e.url,queriedAt:e.queriedAt,quoteUnit:`元/${e.quoteUnit}`,unitPrice:e.originalPrice/factor,...(e.minOrderQty!=null?{minOrderQty:e.minOrderQty*factor}:{}),...(e.tierMinQty!=null?{priceTierMinQty:e.tierMinQty*factor}:{}),...(e.tierMaxQty!=null?{priceTierMaxQty:e.tierMaxQty*factor}:{}),notes,priceEvidence:e};
}

// The host verifies physical equivalence on the visible SKU rows. Keep that
// explicit decision, every original quote, and every rejection in the workpaper.
export function averagePriceEvidence(samples,demand,{comparisonKey,targetUnit,priceBasis}={}) {
 if(![comparisonKey,targetUnit,priceBasis].every(nonempty))throw new Error('均价须明确对比规格、目标单位和税运口径');
 if(!Array.isArray(samples))throw new Error('报价样本必须为数组');
 const accepted=[],excluded=[],seen=new Set();
 for(const sample of samples){
  const reasons=validatePriceEvidence(sample,demand);
  if(sample?.comparisonKey!==comparisonKey)reasons.push('非同规格商品');
  if(sample?.targetUnit!==targetUnit)reasons.push('目标计价单位不同');
  if(sample?.priceBasis!==priceBasis)reasons.push('税运报价口径不同');
  const key=isOffer(sample?.url)?new URL(sample.url).pathname+'|'+String(sample.selectedSpec).trim():'';
  if(seen.has(key))reasons.push('重复商品及规格');
  if(reasons.length){excluded.push({sample,reasons});continue;}
  seen.add(key);accepted.push(sample);
 }
 if(!accepted.length)throw new Error('没有可用于均价的同规格有效报价');
 const prices=accepted.map(e=>e.originalPrice/e.targetUnitsPerQuoteUnit);
 const mean=prices.reduce((s,p)=>s+p,0)/prices.length;
 return {method:'arithmetic_mean',comparisonKey,targetUnit,priceBasis,demand,samples:accepted,excluded,sampleCount:prices.length,mean,min:Math.min(...prices),max:Math.max(...prices)};
}

export function priceFromAverage(e,demand) {
 const a=averagePriceEvidence(e.samples,demand,e);
 // Revalidation must fail if any formerly included sample is no longer valid.
 if(a.excluded.length||a.sampleCount!==e.sampleCount||!number(e.mean)||Math.abs(a.mean-e.mean)>1e-9)throw new Error('均价证据无效或采购量改变后样本不再适用，须重新查价');
 const first=a.samples[0];
 return {sourceType:'web',provider:`1688 ${a.sampleCount}条同规格${a.sampleCount===1?'单一样本':'算术均价'}`,url:first.url,queriedAt:first.queriedAt,quoteUnit:`元/${a.targetUnit}`,unitPrice:a.mean,priceEvidence:e,notes:`${a.comparisonKey}；${a.priceBasis}；样本${a.sampleCount}条，范围${a.min}—${a.max}元/${a.targetUnit}，算术平均${a.mean}元/${a.targetUnit}。`+a.samples.map((s,i)=>`\n${i+1}. ${s.supplier}；${s.selectedSpec}；${s.originalPrice}元/${s.quoteUnit}÷${s.targetUnitsPerQuoteUnit}=${s.originalPrice/s.targetUnitsPerQuoteUnit}元/${s.targetUnit}；MOQ ${s.minOrderQty??'未公布'}，档位${s.tierMinQty??'未公布'}—${s.tierMaxQty??'未公布'}${s.quoteUnit}；${s.queriedAt}；${s.url}；${s.observedText}`).join('')+`\n排除${(e.excluded??[]).length}条：`+(e.excluded??[]).map(x=>`${x.sample?.url??''} ${x.reasons.join('、')}`).join('；')};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const fs=await import('node:fs/promises');
 try {
  const [mode,file,demand]=process.argv.slice(2);
  if(!file||!['plan','validate','average'].includes(mode))throw new Error('用法：node 1688-lookup.mjs plan input.json | validate evidence.json <目标单位采购量> | average batch.json <目标单位采购量>');
  const data=JSON.parse(await fs.readFile(file,'utf8'));
  console.log(JSON.stringify(mode==='plan'?planLookups(data):mode==='average'?priceFromAverage(averagePriceEvidence(data.samples,Number(demand),data),Number(demand)):priceFromEvidence(data,Number(demand)),null,2));
 }catch(e){console.error(e.message);process.exitCode=1;}
}

