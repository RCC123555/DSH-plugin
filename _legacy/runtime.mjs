import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const RECORD='.hardware-quote-run.json';
const normalized=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
const inside=(parent,child)=>{const rel=path.relative(parent,child);return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));};

// lstat each ancestor instead of realpath, which is unavailable in some Windows sandboxes.
async function checkedPath(target) {
  const resolved=path.resolve(target),ancestors=[];let current=resolved;
  for(;;){
    const info=await fs.lstat(current,{bigint:true});
    if(info.isSymbolicLink())throw new Error('只能清理无目录链接的本轮临时路径。');
    ancestors.push(info);const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
  return {resolved,info:ancestors[0],ancestors};
}

// Every run owns a fresh child directory, even under a caller-supplied work root.
export async function createWorkDir(parent=os.tmpdir()) {
  const root=path.resolve(parent);await fs.mkdir(root,{recursive:true});
  return fs.mkdtemp(path.join(root,'hardware-quote-'));
}

export async function recordRun(workDir,output,finalized) {
  const record={kind:'hardware-quote-run',version:1,workDir:path.resolve(workDir),output:path.resolve(output),finalized};
  await fs.writeFile(path.join(workDir,RECORD),JSON.stringify(record)+'\n');
}

// Called only after the agent has reviewed all previews and the saved workbook.
export async function cleanupWorkDir(directory) {
  const {resolved:real,info}=await checkedPath(directory);
  if(!info.isDirectory()||info.ino===0n||!/^hardware-quote-[A-Za-z0-9_-]{6,}$/.test(path.basename(real)))throw new Error('只能清理本脚本创建的独立报价临时目录。');
  const marker=path.join(real,RECORD),markerInfo=await fs.lstat(marker);
  if(!markerInfo.isFile()||markerInfo.isSymbolicLink()||markerInfo.size>65536)throw new Error('报价临时目录的归属记录无效。');
  const record=JSON.parse(await fs.readFile(marker,'utf8'));
  if(record.kind!=='hardware-quote-run'||record.version!==1||typeof record.workDir!=='string'||normalized(record.workDir)!==normalized(real)||record.finalized!==true||typeof record.output!=='string')throw new Error('归属记录不匹配或原生导出尚未完成，保留临时文件供恢复。');
  const {resolved:output,info:outputInfo,ancestors}=await checkedPath(record.output);
  if(!outputInfo.isFile()||inside(real,output)||ancestors.some(parent=>parent.dev===info.dev&&parent.ino===info.ino))throw new Error('最终报价必须存在且位于临时目录之外。');
  // Only this verified run directory is removed. External previews and inputs stay outside it.
  await fs.rm(real,{recursive:true,force:false});
  return {removed:real,output};
}

export function previewSlices(sheetName,lastRow,maxRows=96) {
  if(!Number.isSafeInteger(lastRow)||lastRow<1||!Number.isSafeInteger(maxRows)||maxRows<1)throw new Error('预览行数必须为正整数。');
  const count=Math.ceil(lastRow/maxRows),slices=[];
  for(let start=1,index=1;start<=lastRow;start+=maxRows,index++)slices.push({sheetName,range:`A${start}:I${Math.min(lastRow,start+maxRows-1)}`,filename:`${sheetName}${count>1?'_'+String(index).padStart(2,'0'):''}.png`});
  return slices;
}

// Read a bounded block at a time; do not materialize a second full formula matrix.
export function checkFormulaValues(sheets,allowPending) {
  for(const {sheet,lastRow,lastColumn} of sheets)for(let start=1;start<=lastRow;start+=64){
    const values=sheet.getRange(`A${start}:${lastColumn}${Math.min(lastRow,start+63)}`).values;
    for(let r=0;r<values.length;r++)for(let c=0;c<values[r].length;c++){
      const v=values[r][c];if(typeof v!=='string')continue;
      if(/^#(?:REF!|DIV\/0!|VALUE!|NAME\?|NUM!|NULL!|SPILL!|CALC!|N\/A)$/.test(v)&&!(v==='#N/A'&&allowPending))throw new Error(`导出前发现公式错误：${sheet.name} ${v}`);
      if(/not implemented|unsupported function/i.test(v)&&sheet.getRangeByIndexes(start+r-1,c,1,1).formulas[0][0])throw new Error(`不支持的公式：${sheet.name} ${v}`);
    }
  }
}
