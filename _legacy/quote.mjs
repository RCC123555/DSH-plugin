import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { calculate, VERSION, PROCESSING_RATE_PER_KG } from './calculate.mjs';
import { createWorkDir, recordRun, cleanupWorkDir, previewSlices, checkFormulaValues } from './runtime.mjs';
const run=promisify(execFile),here=path.dirname(fileURLToPath(import.meta.url));
const BOTTOM='报价底稿',FRONT='报价BOM';
const formulaString=s=>`"${String(s??'').replace(/"/g,'""')}"`;
const safeText=s=>String(s??'').startsWith('=')?"'"+s:String(s??'');
const validNumber=v=>typeof v==='number'&&Number.isFinite(v);
const excelDate=s=>(Date.parse(s+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000;
const fmtDimensions=d=>d?`${d.length}×${d.width}×${d.height} cm`:'';
const sourceName=x=>({user:'用户提供',web:'联网参考',template:'原表参考',estimate:'暂估',pending:'待核价'}[x.sourceType]??x.sourceType);
const unitName=x=>({piece:x.unit??'个',volume:'m³',area:'m²',length:'m'}[x.pricing]??'个');
export function imageDimensions(bytes) {
  if(bytes.length>=24&&bytes[0]===0x89&&bytes.toString('ascii',1,4)==='PNG')return [bytes.readUInt32BE(16),bytes.readUInt32BE(20),'image/png'];
  if(bytes.length>=4&&bytes[0]===0xff&&bytes[1]===0xd8){
    let i=2;
    while(i+4<=bytes.length){
      if(bytes[i++]!==0xff)continue;
      while(bytes[i]===0xff)i++;
      const marker=bytes[i++];
      if(marker===0xd9||marker===0xda)break;
      if(marker===0x01||(marker>=0xd0&&marker<=0xd8))continue;
      if(i+2>bytes.length)break;
      const len=bytes.readUInt16BE(i);
      if(len<2||i+len>bytes.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&len>=8)return [bytes.readUInt16BE(i+5),bytes.readUInt16BE(i+3),'image/jpeg'];
      i+=len;
    }
  }
  if(bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'){
    const type=bytes.toString('ascii',12,16);
    if(type==='VP8X')return [bytes.readUIntLE(24,3)+1,bytes.readUIntLE(27,3)+1,'image/webp'];
    if(type==='VP8L'&&bytes[20]===0x2f){const n=bytes.readUInt32LE(21);return [(n&0x3fff)+1,((n>>>14)&0x3fff)+1,'image/webp'];}
    if(type==='VP8 '&&bytes[23]===0x9d&&bytes[24]===1&&bytes[25]===0x2a)return [bytes.readUInt16LE(26)&0x3fff,bytes.readUInt16LE(28)&0x3fff,'image/webp'];
  }
  throw new Error('无法读取图片尺寸；请使用完整的PNG、JPEG或WebP参考图片。');
}

export function layoutFor(count) {
  const extra=Math.max(2,count)-2;
  const row=n=>n+(n>=16?extra:0)+(n>=37?1:0);
  return {extra,row,accessoryStart:14,accessoryEnd:15+extra,accessorySubtotal:row(16),protection:row(29),carton:row(31),cost:row(34),management:row(35),profit:row(36),beforeTax:37+extra,tax:row(37),afterTax:row(38),footer:row(39)};
}
async function spreadsheetApi(nodeModules) {
  if(nodeModules){const req=createRequire(path.join(path.resolve(nodeModules),'..','hardware-quote-runtime.cjs'));return import(pathToFileURL(req.resolve('@oai/artifact-tool')).href);}
  try{return await import('@oai/artifact-tool');}
  catch{throw new Error('缺少表格运行库。请通过load_workspace_dependencies找到Node.js、node_modules及Python，再传入--node-modules和--python；不要将依赖打包上传。');}
}
export async function resolveOutputDir(outputDir,profilePath=path.join(process.cwd(),'.hardware-quote-device.json')) {
  if(outputDir)return path.resolve(outputDir);
  try {const profile=JSON.parse(await fs.readFile(profilePath,'utf8'));if(profile.outputDir)return path.resolve(profile.outputDir);}
  catch(e){if(e.code!=='ENOENT')throw e;}
  return path.resolve(process.cwd(),'报价单');
}
async function reserveOutput(directory,product,draft) {
  await fs.mkdir(directory,{recursive:true});
  const label=String(product.sku||product.name||'产品').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,80);
  for(let version=1;version<10000;version++){
    const filename=`${product.date}_${label}${draft?'_待核价':''}_报价_v${String(version).padStart(2,'0')}.xlsx`,target=path.join(directory,filename);
    try{const handle=await fs.open(target,'wx');await handle.close();return target;}catch(e){if(e.code!=='EEXIST')throw e;}
  }
  throw new Error('报价文件版本数量过多，请检查输出目录。');
}

export async function buildQuote(input,options={}) {
  const result=calculate(input),layout=layoutFor(result.accessories.length),hyperlinks=[];
  if(!result.ready&&!options.allowDraft)throw new Error('报价尚未完整：\n'+result.issues.filter(x=>x.severity==='blocking').map(x=>x.message).join('\n'));
  if(!/^\d{4}-\d{2}-\d{2}$/.test(result.product.date)||Number.isNaN(excelDate(result.product.date)))throw new Error('不能使用无效日期导出报价。');
  const workDir=await createWorkDir(options.workDir);
  const expanded=options.preparedTemplate?path.resolve(options.preparedTemplate):path.join(workDir,'expanded-template.xlsx');
  const template=options.template??path.join(here,'..','assets','对外报价BOM表.xlsx');
  if(!options.preparedTemplate){
    try{await run(options.python??'python',[path.join(here,'prepare_template.py'),template,expanded,'--accessories',String(result.accessories.length)],{maxBuffer:1024*1024});}
    catch(e){if(e.code==='EPERM')throw new Error('当前环境禁止Node子进程。先单独运行prepare_template.py生成扩展模板，再通过--prepared-template传入。');throw e;}
  }
  const {FileBlob,SpreadsheetFile}=await spreadsheetApi(options.nodeModules);
  const wb=await SpreadsheetFile.importXlsx(await FileBlob.load(expanded));
  if(!options.preparedTemplate&&!options.diagnostics)await fs.unlink(expanded);
  const front=wb.worksheets.getItem(FRONT),bottom=wb.worksheets.add(BOTTOM);
  if(front.getRange(`D${layout.cost}`).values[0][0]!=='成本合计')throw new Error('扩展模板的配件行数与输入不一致，请重新运行prepare_template.py。');
  const explanations=[...result.assumptions,...[result.weightEstimates.accessoriesBasis,result.weightEstimates.extrasBasis,result.weightEstimates.packagingBasis,input.packaging?.notes,input.processing?.notes].filter(Boolean),...(result.epsCoverage.required?[`上下EPS整片覆盖核对：每片至少${result.epsCoverage.minimumLengthCm}×${result.epsCoverage.minimumWidthCm}cm，每箱符合完整覆盖的片材${result.epsCoverage.fullPanelsPerCarton}片；局部垫条或小垫块不计入上下整片数量。`]:[]),...result.issues.map(x=>`${x.severity==='blocking'?'待补':'提醒'}：${x.message}`)];
  const averageExtra=[...result.accessories,...result.protection].reduce((n,x)=>n+(x.priceEvidence?.method==='arithmetic_mean'?2+x.priceEvidence.samples.reduce((a,s)=>a+2+Math.ceil(String(s.observedText).length/180),0)+(x.priceEvidence.excluded??[]).length:0),0);
  const bottomLastRow=55+averageExtra+result.protection.length+result.woodPieces.filter(Boolean).length+6*result.accessories.length+4*result.protection.length+explanations.length;
  const set=(sheet,cell,v)=>{if(validNumber(v))sheet.getRange(cell).values=[[v]];else if(v===null||v===undefined)sheet.getRange(cell).formulas=[['=NA()']];else sheet.getRange(cell).values=[[safeText(v)]];};
  const price=(sheet,cell,v)=>{if(validNumber(v))set(sheet,cell,v);else sheet.getRange(cell).clear({applyTo:'contents'});};
  const form=(sheet,cell,f)=>sheet.getRange(cell).formulas=[[f]];
  const text=(sheet,cell,v)=>sheet.getRange(cell).values=[[safeText(v)]];
  const pct=(cell)=>bottom.getRange(cell).setNumberFormat('0.0%');
  const money=(sheet,cell)=>sheet.getRange(cell).setNumberFormat('0.00');
  const band=(r,title)=>{bottom.mergeCells(`A${r}:I${r}`);text(bottom,`A${r}`,title);bottom.getRange(`A${r}:I${r}`).format={fill:'#e8eef2',font:{name:'Microsoft YaHei',size:10,bold:true,color:'#164e63'},rowHeight:25,verticalAlignment:'center'};};
  const header=(r,values)=>{bottom.getRange(`A${r}:I${r}`).values=[values];bottom.getRange(`A${r}:I${r}`).format={fill:'#164e63',font:{name:'Microsoft YaHei',size:10,bold:true,color:'#ffffff'},rowHeight:31,wrapText:true,verticalAlignment:'center',horizontalAlignment:'center'};};
  const note=(r,message)=>{bottom.mergeCells(`A${r}:I${r}`);text(bottom,`A${r}`,message);bottom.getRange(`A${r}:I${r}`).format.wrapText=true;bottom.getRange(`A${r}:I${r}`).format.rowHeight=Math.max(27,Math.min(90,Math.ceil(String(message).length/85)*18+12));const url=String(message).match(/https?:\/\/[^\s\u3000-\u9fff，。；）]+/)?.[0];if(url)hyperlinks.push({sheet:BOTTOM,ref:`A${r}`,target:url,display:String(message)});};

  // The second sheet owns editable shared parameters and packaging builds.
  bottom.showGridLines=false;
  bottom.getRange(`A1:I${bottomLastRow}`).format={font:{name:'Microsoft YaHei',size:10},verticalAlignment:'center',rowHeight:24};
  for(const [col,width] of Object.entries({A:24,B:24,C:10,D:13,E:13,F:16,G:14,H:22,I:21}))bottom.getRange(`${col}1:${col}23`).format.columnWidth=width;
  text(bottom,'A1','报价底稿');bottom.getRange('A1').format.font={name:'Microsoft YaHei',size:15,bold:true,color:'#164e63'};bottom.getRange('A1:I1').format.rowHeight=33;
  bottom.mergeCells('A2:I2');text(bottom,'A2',`${result.product.name}  ${result.product.sku??''}  报价日期：${result.product.date}  规则版本：${VERSION}`);
  bottom.mergeCells('A3:I3');text(bottom,'A3',result.ready?(result.assumptions.length||result.issues.length?'含估算或提醒，请检查下方依据。':'已按输入核算，参考价格见下方。'):'待核价：'+result.issues.filter(x=>x.severity==='blocking').map(x=>x.message).join('；'));
  bottom.getRange('A3:I3').format.wrapText=true;bottom.getRange('A3:I3').format.rowHeight=result.ready?27:Math.min(160,35+result.issues.length*18);bottom.getRange('A3:I3').format.font={name:'Microsoft YaHei',size:10,color:result.ready?'#475569':'#b91c1c'};
  bottom.getRange('A4:D4').values=[['核算参数','值','单位','依据']];bottom.getRange('A4:D4').format={fill:'#164e63',font:{name:'Microsoft YaHei',size:10,color:'#ffffff',bold:true},rowHeight:28};
  const parameters=[
    ['铁单价',result.rates.metal,'元/kg','用户约定'],['木单价',result.rates.wood,'元/kg','用户约定'],['喷涂单价',result.rates.coating,'元/kg','用户约定'],['纸箱平方单价',result.rates.carton,'元/m²','用户约定'],
    ['税金参数',result.rates.tax,'比例','沿用原表'],['含税净利率目标',result.rates.netMargin,'比例','利润÷含税报价'],['管理费/利润',result.rates.managementToProfit,'比例','按利润金额比例'],
    ['采购产品数量',result.order.quantity,'件','本次采购口径'],['每箱产品数',result.order.unitsPerCarton,'件/箱','本次装箱口径'],
    ['外箱长',result.product.cartonDimensions?.length,'cm','用户提供'],['外箱宽',result.product.cartonDimensions?.width,'cm','用户提供'],['外箱高',result.product.cartonDimensions?.height,'cm','用户提供'],
    ['组装净重',result.weights.net,'kg','用户确认，含轮子等必需配件'],['主料木材重量',result.weights.wood,'kg',result.product.material==='metal'?'纯金属，木重为0':result.woodPieces.length?'按实际木件体积估算':'分重/材质分配'],['主料金属重量',result.weights.metal,'kg','主料本体重量减木重'],
    ['毛重',result.weights.gross,'kg','整件＋包材＋非组装附带件'],['组装配件重量',result.weights.accessories,'kg','拆分主料时扣除，净重保留'],['包材重量',result.weights.packaging,'kg','仅从毛重扣除'],['开料、焊接人工单价',PROCESSING_RATE_PER_KG,'元/kg','本体金属重量×3元/kg（加工成本）'],
    ['主料本体重量',result.weights.body,'kg','组装净重减必需配件'],['非组装附带件重量',result.weights.extras,'kg','不计净重，随货成本仍计入']
  ];
  for(let i=0;i<parameters.length;i++){const r=5+i;for(let c=0;c<4;c++){const letter=String.fromCharCode(65+c);const v=parameters[i][c];if(c===1&&v===undefined)set(bottom,`${letter}${r}`,null);else if(c===1&&v===null){if([20,21,22].includes(r)&&result.weights.netOrigin!=='gross')text(bottom,`${letter}${r}`,'');else set(bottom,`${letter}${r}`,null);}else set(bottom,`${letter}${r}`,v);}bottom.getRange(`B${r}`).format.fill='#fff5cc';}
  for(const r of [9,10,11])pct(`B${r}`);
  bottom.getRange('B14:B22').setNumberFormat('0.000');bottom.getRange('B24:B25').setNumberFormat('0.000');bottom.getRange('B5:B8').setNumberFormat('0.00');money(bottom,'B23');
  bottom.mergeCells('F4:I4');text(bottom,'F4','重量口径与报价');bottom.getRange('F4:I4').format={fill:'#164e63',font:{name:'Microsoft YaHei',size:10,color:'#ffffff',bold:true}};
  for(const [r,s] of [[5,'净重＝组装整件，含全部必需配件。'],[6,'毛重＝整件＋包材＋非组装附带件。'],[7,'主料重量＝组装净重－组装配件重量。'],[8,'开料、焊接人工＝本体金属重量×3元/kg（加工成本）'],[13,'参考单价按下方采购需求匹配档位。'],[14,'改变数量后，核对价格档位和重量。']]){bottom.mergeCells(`F${r}:I${r}`);text(bottom,`F${r}`,s);bottom.getRange(`F${r}:I${r}`).format.wrapText=true;bottom.getRange(`F${r}:I${r}`).format.rowHeight=30;}
  for(const [r,label,ref] of [[9,'未税报价',`G${layout.beforeTax}`],[10,'含税报价',`G${layout.afterTax}`],[11,'实际含税净利率',`L${layout.afterTax}`]]){bottom.mergeCells(`F${r}:G${r}`);text(bottom,`F${r}`,label);bottom.mergeCells(`H${r}:I${r}`);form(bottom,`H${r}`,`='${FRONT}'!${ref}`);bottom.getRange(`H${r}:I${r}`).setNumberFormat(r===11?'0.0%':'0.00');}

  band(28,'保护材料用量（每件产品）：顶部/底部各一整片EPS，局部垫块额外列明');
  header(29,['名称','材质 / 单价单位','数量','长 cm','宽 cm','厚 cm','单价','费用 元','来源记录']);
  const protectionRows=[];
  let cursor=30;
  for(const [i,item] of result.protection.entries()){
    const r=cursor++;protectionRows.push(r);
    text(bottom,`A${r}`,item.name);text(bottom,`B${r}`,`${item.spec??item.material??''} / 元/${unitName(item)}`);set(bottom,`C${r}`,item.quantity);
    for(const [col,key] of [['D','length'],['E','width'],['F','height']]){if(item.dimensions)set(bottom,`${col}${r}`,item.dimensions[key]);else text(bottom,`${col}${r}`,'');}
    price(bottom,`G${r}`,item.unitPrice);
    const usage=item.pricing==='volume'?`C${r}*D${r}*E${r}*F${r}/1000000`:item.pricing==='area'?`C${r}*D${r}*E${r}/10000`:item.pricing==='length'?`C${r}*D${r}/100`:`C${r}`;
    form(bottom,`H${r}`,`=IF(ISNUMBER(G${r}),${usage}*G${r},NA())`);text(bottom,`I${r}`,`包材${i+1}`);
    bottom.getRange(`A${r}:I${r}`).format.rowHeight=32;bottom.getRange(`A${r}:B${r}`).format.wrapText=true;bottom.getRange(`G${r}:H${r}`).setNumberFormat('0.00');
  }
  const protectionTotal=cursor++;text(bottom,`G${protectionTotal}`,'保护材料合计');form(bottom,`H${protectionTotal}`,protectionRows.length?`=SUM(H${protectionRows[0]}:H${protectionRows.at(-1)})`:'=0');money(bottom,`H${protectionTotal}`);
  if(result.epsCoverage.required){
    const clearance=result.epsCoverage.clearanceCm;
    const eligible=result.protection.flatMap((item,i)=>item.material==='EPS'&&item.dimensions?[protectionRows[i]]:[]);
    const terms=eligible.map(r=>`IF(AND(MAX(D${r}:E${r})>=MAX($B$14:$B$16)-${clearance},MIN(D${r}:E${r})>=SUM($B$14:$B$16)-MAX($B$14:$B$16)-MIN($B$14:$B$16)-${clearance}),C${r}*$B$13,0)`);
    bottom.mergeCells('F16:G16');text(bottom,'F16','每箱完整EPS片数');bottom.mergeCells('H16:I16');form(bottom,'H16','='+ (terms.join('+')||'0'));
    bottom.mergeCells('F17:I18');form(bottom,'F17',`=IF(H16>=2,"上下整片EPS覆盖通过（至少2片/箱）","EPS整片覆盖不足，阻止确定报价")`);bottom.getRange('F17:I18').format.wrapText=true;
  }
  const cartonSection=cursor+1;band(cartonSection,'纸箱：全搭侧封箱');const areaRow=cartonSection+1,cartonCostRow=cartonSection+2;
  bottom.mergeCells(`A${areaRow}:F${areaRow}`);text(bottom,`A${areaRow}`,'展开面积 m²＝(长＋2×高＋2)×(2×宽＋3×高＋2)÷10000');form(bottom,`H${areaRow}`,'=(B14+2*B16+2)*(2*B15+3*B16+2)/10000');bottom.getRange(`H${areaRow}`).setNumberFormat('0.0000');
  bottom.mergeCells(`A${cartonCostRow}:F${cartonCostRow}`);text(bottom,`A${cartonCostRow}`,'每件产品纸箱费用＝展开面积×平方单价÷每箱产品数');form(bottom,`H${cartonCostRow}`,`=H${areaRow}*B8/B13`);money(bottom,`H${cartonCostRow}`);
  cursor=cartonCostRow+2;
  const woodRows=[];
  if(result.woodPieces.length){band(cursor++,'木件体积估重：明确分重优先；缺少参数暂按18mm、650kg/m³');header(cursor++,['木件','长 cm','宽 cm','厚 cm','数量','密度 kg/m³','重量 kg','说明','']);
    for(const [i,piece] of result.woodPieces.entries())if(piece){const r=cursor++;woodRows.push(r);text(bottom,`A${r}`,`木件${i+1}`);for(const [col,key] of [['B','length'],['C','width'],['D','thickness'],['E','quantity'],['F','density']])set(bottom,`${col}${r}`,piece[key]);form(bottom,`G${r}`,`=B${r}*C${r}*D${r}*E${r}*F${r}/1000000`);bottom.getRange(`G${r}`).setNumberFormat('0.000');bottom.mergeCells(`H${r}:I${r}`);text(bottom,`H${r}`,piece.notes);bottom.getRange(`H${r}:I${r}`).format.wrapText=true;bottom.getRange(`A${r}:I${r}`).format.rowHeight=35;}}
  if(result.weights.netOrigin==='gross')form(bottom,'B17','=B20-B22-B25');
  else if(result.weights.netOrigin==='material')form(bottom,'B17','=B18+B19+B21');
  else if(result.weights.netOrigin==='body')form(bottom,'B17','=B24+B21');
  if(result.weights.netOrigin==='body')set(bottom,'B24',input.product.netWeightKg);
  else if(result.weights.netOrigin==='material')form(bottom,'B24','=B18+B19');
  else form(bottom,'B24','=B17-B21');
  if(input.product?.material==='metal'){if(!validNumber(input.product?.metalWeightKg))form(bottom,'B19','=B24');}
  else if(input.product?.material==='wood'){if(!validNumber(input.product?.woodWeightKg))form(bottom,'B18','=B24');}
  else if(input.product?.material==='mixed'){
    if(woodRows.length)form(bottom,'B18',`=SUM(G${woodRows[0]}:G${woodRows.at(-1)})`);
    if(!validNumber(input.product?.metalWeightKg))form(bottom,'B19','=B24-B18');
    else if(!validNumber(input.product?.woodWeightKg)&&!woodRows.length)form(bottom,'B18','=B24-B19');
  }

  cursor+=1;band(cursor++,'配件重量拆分：组装必需件计入净重，非组装附带件不计净重');
  header(cursor++,['名称','规格','每件用量','单件重 kg','净重口径','合计重 kg','重量来源','依据','说明']);
  const weightRows=[];
  for(const [index,item] of result.accessories.entries()){
    const r=cursor++;weightRows.push({row:r,item});
    text(bottom,`A${r}`,item.name);text(bottom,`B${r}`,item.spec??'');form(bottom,`C${r}`,`='${FRONT}'!D${14+index}`);
    if(validNumber(item.weightKgPerUnit)){set(bottom,`D${r}`,item.weightKgPerUnit);form(bottom,`F${r}`,`=C${r}*D${r}`);}else{text(bottom,`D${r}`,'未逐项分重');text(bottom,`F${r}`,'采用合计依据');}
    text(bottom,`E${r}`,item.includedInNetWeight?'组装必需件':'非组装附带件');text(bottom,`G${r}`,{user:'用户提供',web:'联网参考',estimate:'合理估重'}[item.weightSourceType]??'合计分重');text(bottom,`H${r}`,`重量${index+1}`);text(bottom,`I${r}`,item.includedInNetWeight?'从净重拆出主料':'净重不含，采购成本计入');
    bottom.getRange(`A${r}:I${r}`).format.wrapText=true;bottom.getRange(`A${r}:I${r}`).format.rowHeight=42;bottom.getRange(`D${r}:F${r}`).setNumberFormat('0.000000');
    note(cursor++,`重量${index+1}：${item.weightBasis||'详见配件合计重量依据。'}`);
  }
  for(const [cell,include] of [['B21',true],['B25',false]]){
    const members=weightRows.filter(x=>x.item.includedInNetWeight===include);
    if(members.every(x=>validNumber(x.item.weightKgPerUnit)))form(bottom,cell,members.length?`=SUM(${members.map(x=>`F${x.row}`).join(',')})`:'=0');
  }
  if(result.accessories.some(x=>!validNumber(x.weightKgPerUnit)))note(cursor++,'部分配件采用合计分重；改变其BOM用量后必须重新核实合计重量，不能沿用原分重。');

  cursor+=1;band(cursor++,'单价来源与采购档位：链接对应具体物料；未公开的起订量标记为“未公布”');header(cursor++,['物料','规格','每件用量','采购需求','起订量','价格档位','参考单价','来源','链接']);
  const sources=[];
  const sourceRecords=[...result.accessories.map((item,index)=>({item,index,kind:'accessory'})),...result.protection.map((item,index)=>({item,index,kind:'protection'}))];
  for(const rec of sourceRecords){
    const {item,index,kind}=rec,r=cursor,recordId=`${kind==='accessory'?'配件':'包材'}${index+1}`;sources.push({...rec,row:r,recordId});
    text(bottom,`A${r}`,item.name);text(bottom,`B${r}`,item.spec??'');
    if(kind==='accessory')form(bottom,`C${r}`,`='${FRONT}'!D${14+index}`);
    else {const pr=protectionRows[index];const usage=item.pricing==='volume'?`C${pr}*D${pr}*E${pr}*F${pr}/1000000`:item.pricing==='area'?`C${pr}*D${pr}*E${pr}/10000`:item.pricing==='length'?`C${pr}*D${pr}/100`:`C${pr}`;form(bottom,`C${r}`,`=${usage}`);}
    form(bottom,`D${r}`,`=C${r}*$B$12`);
    if(validNumber(item.minOrderQty))set(bottom,`E${r}`,item.minOrderQty);else text(bottom,`E${r}`,'未公布');
    text(bottom,`F${r}`,`${item.priceTierMinQty??'未公布'}～${item.priceTierMaxQty??'不限'}`);price(bottom,`G${r}`,item.unitPrice);text(bottom,`H${r}`,`${sourceName(item)}：${item.sourceLabel}`);
    if(item.url){text(bottom,`I${r}`,'打开参考链接');hyperlinks.push({sheet:BOTTOM,ref:`I${r}`,target:item.url,display:'打开参考链接'});bottom.getRange(`I${r}`).format.font={name:'Microsoft YaHei',size:10,color:'#1565c0'};}else text(bottom,`I${r}`,item.sourceType==='pending'?'待补价格':'无外部链接');
    bottom.getRange(`A${r}:I${r}`).format.wrapText=true;bottom.getRange(`A${r}:I${r}`).format.rowHeight=49;bottom.getRange(`C${r}:E${r}`).setNumberFormat(item.pricing==='volume'?'0.000000':item.pricing==='area'||item.pricing==='length'?'0.0000':'0');money(bottom,`G${r}`);
    const average=item.priceEvidence?.method==='arithmetic_mean'?item.priceEvidence:null;
    const notes=average?`记录 ${recordId}；${average.comparisonKey}；${average.priceBasis}；${average.sampleCount}条有效报价算术平均；范围${average.min}—${average.max}元/${average.targetUnit}。各样本及采购档位见下方，数量改变导致任一档位失效时须重新查价。`:`记录 ${recordId}；计价单位：元/${unitName(item)}；原始报价单位：${item.quoteUnit??unitName(item)}；查询日期：${item.queriedAt??'原表/用户输入'}。${item.notes??''}`;
    const mismatch=[];if(validNumber(item.minOrderQty))mismatch.push(`D${r}<E${r}`);if(validNumber(item.priceTierMinQty))mismatch.push(`D${r}<${item.priceTierMinQty}`);if(validNumber(item.priceTierMaxQty))mismatch.push(`D${r}>${item.priceTierMaxQty}`);
    note(r+1,notes);
    if(mismatch.length)form(bottom,`A${r+1}`,`=IF(OR(${mismatch.join(',')}),${formulaString('采购需求不匹配所选档位，请重新核价。 '+notes)},${formulaString(notes)})`);
    if(item.url)note(r+2,item.url);else note(r+2,item.sourceType==='template'?`模板来源：${item.sourceLabel}`:item.sourceType==='user'?'此单价由用户提供；不是联网市场价格。':item.sourceType==='pending'?'未取得有效单价，留空待核；查找情况见上一行。':'请补充参考依据。');
    cursor+=4;
    if(average){
      header(cursor++,['供应商','实际规格','原始单价','原报价单位','目标单位数','换算单价','查询日期','MOQ及档位','链接']);
      const sampleRows=[];
      for(const sample of average.samples){
        const sr=cursor++;sampleRows.push(sr);
        text(bottom,`A${sr}`,sample.supplier);text(bottom,`B${sr}`,sample.selectedSpec);set(bottom,`C${sr}`,sample.originalPrice);text(bottom,`D${sr}`,`元/${sample.quoteUnit}`);set(bottom,`E${sr}`,sample.targetUnitsPerQuoteUnit);
        const conditions=[`E${sr}>0`,...[['minOrderQty','>='],['tierMinQty','>='],['tierMaxQty','<=']].filter(([k])=>validNumber(sample[k])).map(([k,op])=>`D${r}/E${sr}${op}${sample[k]}`)];
        form(bottom,`F${sr}`,`=IF(AND(${conditions.join(',')}),C${sr}/E${sr},NA())`);text(bottom,`G${sr}`,sample.queriedAt);text(bottom,`H${sr}`,`MOQ ${sample.minOrderQty??'未公布'}；档位${sample.tierMinQty??'未公布'}—${sample.tierMaxQty??'未公布'} ${sample.quoteUnit}`);text(bottom,`I${sr}`,'查看此样本');hyperlinks.push({sheet:BOTTOM,ref:`I${sr}`,target:sample.url,display:'查看此样本'});
        bottom.getRange(`A${sr}:I${sr}`).format.wrapText=true;bottom.getRange(`A${sr}:I${sr}`).format.rowHeight=76;bottom.getRange(`C${sr}`).setNumberFormat('0.000000');bottom.getRange(`E${sr}`).setNumberFormat('0.######');bottom.getRange(`F${sr}`).setNumberFormat('0.000000');bottom.getRange(`I${sr}`).format.font={name:'Microsoft YaHei',size:10,color:'#1565c0'};
        const observation=`${sample.evidenceKind} / ${sample.searchMethod}；${sample.searchMethod==='image'?sample.inputImage:sample.keywords}；币种${sample.currency}；${sample.priceKind}；${sample.observedText}`;
        for(let start=0;start<observation.length;start+=180)note(cursor++,observation.slice(start,start+180));
        note(cursor++,sample.url);
      }
      if(validNumber(item.unitPrice)){form(bottom,`G${r}`,`=IF(COUNT(${sampleRows.map(sr=>`F${sr}`).join(',')})=${sampleRows.length},AVERAGE(${sampleRows.map(sr=>`F${sr}`).join(',')}),NA())`);bottom.getRange(`G${r}`).setNumberFormat('0.000000');}
      for(const excluded of average.excluded??[])note(cursor++,`排除：${excluded.sample?.supplier??''}；${excluded.sample?.url??''}；${excluded.reasons.join('；')}`);
      cursor++;
    }
  }
  band(cursor++,'估算、重量与包装说明');
  note(cursor++,'净重为组装完整产品，含全部必需配件；非组装赠品、备用件及包材不计净重。主料重量为净重减已单独计价的组装配件重量。仅毛重时先扣包材和非组装附带件，再拆分主料。');
  for(const message of explanations)note(cursor++,message);
  note(cursor++,'价格为本次采购条件下的参考。BOM用量或采购批量改变后，应核对价格档位；固定包装项沿用原表，不重复计入保护材料。');
  bottom.getRange(`A5:A25`).format.horizontalAlignment='left';bottom.getRange('B5:B25').format.horizontalAlignment='right';
  bottom.freezePanes.freezeRows(4);
  for(const source of sources.filter(s=>s.kind==='protection'))form(bottom,`G${protectionRows[source.index]}`,`=IF(ISNUMBER(G${source.row}),G${source.row},"")`);

  // Write only inputs and affected formulas on the original styled BOM.
  text(front,'A1',result.ready?'成本核算报价单':'成本核算报价单（待核价）');
  text(front,'B2',result.product.supplier??'');text(front,'B3',result.product.developmentId??'');text(front,'B4',result.product.name);text(front,'G4',result.product.sku??'');
  set(front,'F2',excelDate(result.product.date));front.getRange('F2:I2').setNumberFormat('yyyy-mm-dd');
  if(result.weights.gross!==null)set(front,'B5',result.weights.gross);else text(front,'B5','未提供');
  form(front,'B6',`='${BOTTOM}'!B17`);front.getRange('B5:D6').setNumberFormat('0.000');
  front.getRange('A5:I6').format.rowHeight=42;
  text(front,'G5',fmtDimensions(result.product.cartonDimensions));text(front,'G6',fmtDimensions(result.product.dimensions));
  form(front,'E8',`='${BOTTOM}'!B19`);form(front,'E9',`='${BOTTOM}'!B18`);form(front,'G8',`='${BOTTOM}'!B5`);form(front,'G9',`='${BOTTOM}'!B6`);form(front,'H8','=E8*G8');form(front,'H9','=E9*G9');
  front.getRange('E8:E11').setNumberFormat('0.000');front.getRange('G8:H11').setNumberFormat('0.00');text(front,'I8','净重扣组装配件后主料');
  const accessorySources=sources.filter(s=>s.kind==='accessory');
  for(let i=0;i<Math.max(2,result.accessories.length);i++){
    const r=14+i,item=result.accessories[i],source=accessorySources[i];
    if(item){text(front,`B${r}`,item.name);text(front,`C${r}`,item.spec??'');set(front,`D${r}`,item.quantity);text(front,`F${r}`,item.unit??'PCS');form(front,`G${r}`,`=IF(ISNUMBER('${BOTTOM}'!G${source.row}),'${BOTTOM}'!G${source.row},"")`);form(front,`H${r}`,`=IF(ISNUMBER(G${r}),D${r}*G${r},NA())`);text(front,`I${r}`,`${source.recordId}底稿`);hyperlinks.push({sheet:FRONT,ref:`I${r}`,location:`'${BOTTOM}'!A${source.row}`,display:`${source.recordId}底稿`});}
    else {for(const c of ['B','C','D','E','F','G','I'])text(front,`${c}${r}`,'');form(front,`H${r}`,'=0');}
    front.getRange(`B${r}:C${r}`).format.wrapText=true;front.getRange(`I${r}`).format.font={name:'Microsoft YaHei',size:10,color:'#1565c0'};front.getRange(`G${r}:H${r}`).setNumberFormat('0.00');
    const displayLength=s=>[...String(s??'')].reduce((n,c)=>n+(c.charCodeAt(0)>255?1:0.55),0);
    front.getRange(`A${r}:I${r}`).format.rowHeight=Math.max(32,Math.min(60,Math.ceil(Math.max(displayLength(item?.name),displayLength(item?.spec))/8)*16+8));
  }
  form(front,`H${layout.accessorySubtotal}`,`=SUM(H14:H${layout.accessoryEnd})`);
  const pr=layout.row(18),co=layout.row(23);
  form(front,`D${pr}`,'=E8');text(front,`F${pr}`,'kg');form(front,`G${pr}`,`='${BOTTOM}'!B23`);form(front,`H${pr}`,`=D${pr}*G${pr}`);front.getRange(`D${pr}`).setNumberFormat('0.000');text(front,`I${pr}`,'加工成本3元/kg');for(let r=pr+1;r<pr+5;r++){text(front,`D${r}`,'');text(front,`F${r}`,'');}
  if(result.processing.needsCoating===true)form(front,`D${co}`,'=E8');else if(result.processing.needsCoating===false)set(front,`D${co}`,0);else set(front,`D${co}`,null);
  form(front,`G${co}`,`='${BOTTOM}'!B7`);form(front,`H${co}`,`=D${co}*G${co}`);text(front,`I${co}`,'仅本体金属');
  set(front,`D${layout.protection}`,1);form(front,`G${layout.protection}`,`=IF(ISNUMBER('${BOTTOM}'!H${protectionTotal}),'${BOTTOM}'!H${protectionTotal},"")`);form(front,`H${layout.protection}`,`=IF(ISNUMBER(G${layout.protection}),D${layout.protection}*G${layout.protection},NA())`);text(front,`I${layout.protection}`,'包材用量底稿');hyperlinks.push({sheet:FRONT,ref:`I${layout.protection}`,location:`'${BOTTOM}'!A28`,display:'包材用量底稿'});
  form(front,`D${layout.carton}`,`=1/'${BOTTOM}'!B13`);text(front,`F${layout.carton}`,'箱');form(front,`G${layout.carton}`,`='${BOTTOM}'!H${areaRow}*'${BOTTOM}'!B8`);form(front,`H${layout.carton}`,`=D${layout.carton}*G${layout.carton}`);text(front,`I${layout.carton}`,'全搭侧封箱');hyperlinks.push({sheet:FRONT,ref:`I${layout.carton}`,location:`'${BOTTOM}'!A${cartonSection}`,display:'全搭侧封箱'});
  form(front,`G${layout.cost}`,`=H12+H${layout.accessorySubtotal}+H${layout.row(24)}+H${layout.row(33)}`);
  text(front,`D${layout.beforeTax}`,'未税报价');form(front,`G${layout.beforeTax}`,`=SUM(G${layout.cost}:G${layout.profit})`);
  text(front,`D${layout.tax}`,'税金');text(front,`D${layout.afterTax}`,'含税报价');
  if(result.ready){form(front,`G${layout.profit}`,`=G${layout.cost}*'${BOTTOM}'!B10*(1+'${BOTTOM}'!B9)/(1-'${BOTTOM}'!B10*(1+'${BOTTOM}'!B11)*(1+'${BOTTOM}'!B9))`);form(front,`G${layout.management}`,`=G${layout.profit}*'${BOTTOM}'!B11`);}
  else {form(front,`G${layout.profit}`,'=NA()');form(front,`G${layout.management}`,'=NA()');}
  form(front,`G${layout.tax}`,`=G${layout.beforeTax}*'${BOTTOM}'!B9`);form(front,`G${layout.afterTax}`,result.epsCoverage.required?`=IF('${BOTTOM}'!H16>=2,SUM(G${layout.beforeTax},G${layout.tax}),NA())`:`=SUM(G${layout.beforeTax},G${layout.tax})`);form(front,`L${layout.afterTax}`,`=G${layout.profit}/G${layout.afterTax}`);front.getRange(`L${layout.afterTax}`).setNumberFormat('0.0%');
  front.getRange(`G${layout.cost}:I${layout.afterTax}`).setNumberFormat('0.00');front.getRange(`D${layout.beforeTax}:I${layout.beforeTax}`).format.rowHeight=24;
  text(front,`B${layout.footer}`,input.operator??'自动核价');set(front,`E${layout.footer}`,excelDate(result.product.date));front.getRange(`E${layout.footer}:I${layout.footer}`).setNumberFormat('yyyy-mm-dd');

  if(result.product.images?.length){
    const imagePath=path.resolve(result.product.images[0]),bytes=await fs.readFile(imagePath);
    const [w,h,mime]=imageDimensions(bytes),boxW=220,boxH=137,scale=Math.min(boxW/w,boxH/h);
    front.images.add({dataUrl:`data:${mime};base64,${bytes.toString('base64')}`,anchor:{from:{row:layout.cost-1,col:1,rowOffsetPx:4,colOffsetPx:4},extent:{widthPx:Math.round(w*scale),heightPx:Math.round(h*scale)}}});
  }
  wb.recalculate();
  const inspection=await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!|#NULL!|#SPILL!|#CALC!'+(result.ready?'|#N/A':''),options:{useRegex:true,maxResults:100},maxChars:6000});
  // Match output contains notices on an empty result; inspect actual cell error values too.
  checkFormulaValues([{sheet:front,lastRow:layout.footer,lastColumn:'L'},{sheet:bottom,lastRow:Math.max(cursor,bottomLastRow),lastColumn:'I'}],!result.ready);
  if(result.ready){
    const actual=front.getRange(`G${layout.afterTax}`).values[0][0],margin=front.getRange(`L${layout.afterTax}`).values[0][0];
    if(!validNumber(actual)||Math.abs(actual-result.totals.afterTax)>1e-6||!validNumber(margin)||Math.abs(margin-result.rates.netMargin)>1e-9)throw new Error('Excel与独立核算结果不一致。');
  }
  const previewDir=path.resolve(options.previewDir??path.join(workDir,'previews'));await fs.mkdir(previewDir,{recursive:true});
  const previewFiles=[];
  for(const {sheetName,range,filename} of [...previewSlices(FRONT,layout.footer),...previewSlices(BOTTOM,cursor)]){
    const preview=await wb.render({sheetName,range,scale:1.35,format:'png'}),file=path.join(previewDir,filename);
    await fs.writeFile(file,new Uint8Array(await preview.arrayBuffer()));previewFiles.push(file);
  }
  const outputDir=await resolveOutputDir(options.outputDir,options.profilePath),output=await reserveOutput(outputDir,result.product,!result.ready);
  try{await (await SpreadsheetFile.exportXlsx(wb)).save(output);}catch(e){await fs.unlink(output);throw e;}
  // SDK sidecar is diagnostic output, not a deliverable; inspection is returned below.
  try{await fs.unlink(output+'.inspect.ndjson');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(options.diagnostics)await fs.writeFile(path.join(workDir,'calculation.json'),JSON.stringify(result,null,2)+'\n');
  const metadata=path.join(workDir,'native-metadata.json');await fs.writeFile(metadata,JSON.stringify({frontLastRow:layout.footer,bottomLastRow:cursor,bottomPageBreakRows:[28,sources[0]?.row-2].filter(Number.isFinite),hyperlinks},null,2)+'\n');
  let finalized=false;
  try{await run(options.python??'python',[path.join(here,'finalize_xlsx.py'),output,metadata],{maxBuffer:1024*1024});finalized=true;}
  catch(e){if(e.code!=='EPERM')throw e;}
  await recordRun(workDir,output,finalized);
  return {output,previewDir,previewFiles,workDir,ready:result.ready,totals:result.totals,issues:result.issues,layout,finalized,nativeMetadata:metadata,nativeFinalizeCommand:finalized?null:[options.python??'<Python>',path.join(here,'finalize_xlsx.py'),output,metadata],cleanupCommand:finalized?[process.execPath,fileURLToPath(import.meta.url),'--cleanup',workDir]:null,inspection:inspection.ndjson,...(options.returnWorkbook===false?{}:{workbook:wb})};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2);
    if(args[0]==='--cleanup'){
      if(args.length!==2)throw new Error('用法：node quote.mjs --cleanup <本轮workDir>；须先完成预览及最终Excel复核。');
      console.log(JSON.stringify(await cleanupWorkDir(args[1])));
    }else{
      const options={returnWorkbook:false};let inputPath=null,configure=false;
      const names={'--output-dir':'outputDir','--node-modules':'nodeModules','--python':'python','--preview-dir':'previewDir','--work-dir':'workDir','--profile':'profilePath','--template':'template','--prepared-template':'preparedTemplate'};
      for(let i=0;i<args.length;i++){const a=args[i];if(a==='--allow-draft')options.allowDraft=true;else if(a==='--diagnostics')options.diagnostics=true;else if(a==='--configure')configure=true;else if(names[a]){if(!args[i+1])throw new Error(`${a}缺少值。`);options[names[a]]=args[++i];}else if(a.startsWith('--'))throw new Error(`未知参数：${a}`);else if(!inputPath)inputPath=a;else throw new Error('只能提供一个产品输入JSON。');}
      if(configure){if(!options.outputDir)throw new Error('配置保存目录需要--output-dir。');const profile=options.profilePath??path.join(process.cwd(),'.hardware-quote-device.json');await fs.writeFile(profile,JSON.stringify({version:1,outputDir:path.resolve(options.outputDir)},null,2)+'\n');console.log(JSON.stringify({profile,outputDir:path.resolve(options.outputDir)}));}
      else if(!inputPath)throw new Error('用法：node quote.mjs input.json --python <Python> --node-modules <运行库目录> [--output-dir <报价单目录>] [--allow-draft] [--diagnostics]');
      else {const input=JSON.parse(await fs.readFile(inputPath,'utf8'));if(input.product?.images)input.product.images=input.product.images.map(p=>path.resolve(path.dirname(inputPath),p));console.log(JSON.stringify(await buildQuote(input,options),null,2));}
    }
  }catch(e){console.error(e.stack??e.message);process.exitCode=1;}
}




