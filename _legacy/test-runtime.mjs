import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createWorkDir,recordRun,cleanupWorkDir,previewSlices,checkFormulaValues} from './runtime.mjs';
const root=await fs.mkdtemp(path.join(process.cwd(),'hardware-runtime-test-'));
let passed=0,skipped=0;
async function test(name,fn){if(await fn()===false){skipped++;console.log('SKIP '+name+'（当前环境不允许创建目录链接）');}else{passed++;console.log('PASS '+name);}}
const exists=async p=>{try{await fs.stat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const output=path.join(root,'final.xlsx');await fs.writeFile(output,'fixture');
try{
  await test('每轮独立目录，清理只移除已完成轮次',async()=>{
    const a=await createWorkDir(root),b=await createWorkDir(root),user=path.join(root,'user.txt');await fs.writeFile(user,'preserve');
    assert.notEqual(a,b);await recordRun(a,output,true);await cleanupWorkDir(a);
    assert.equal(await exists(a),false);assert.equal(await exists(b),true);assert.equal(await fs.readFile(user,'utf8'),'preserve');assert.equal(await exists(output),true);
  });
  await test('未完成原生导出或无归属记录时保留临时文件',async()=>{
    const run=await createWorkDir(root);await assert.rejects(cleanupWorkDir(run));assert(await exists(run));
    await recordRun(run,output,false);await assert.rejects(cleanupWorkDir(run),/尚未完成/);assert(await exists(run));
  });
  await test('拒绝归属路径不符和任意用户目录',async()=>{
    const a=await createWorkDir(root),b=await createWorkDir(root);await recordRun(a,output,true);
    await fs.copyFile(path.join(a,'.hardware-quote-run.json'),path.join(b,'.hardware-quote-run.json'));
    await assert.rejects(cleanupWorkDir(b),/归属记录不匹配/);await assert.rejects(cleanupWorkDir(root),/只能清理/);assert(await exists(a));assert(await exists(b));
  });
  await test('最终文件在临时目录内或已丢失时拒绝清理',async()=>{
    const run=await createWorkDir(root),inside=path.join(run,'final.xlsx');await fs.writeFile(inside,'fixture');await recordRun(run,inside,true);
    await assert.rejects(cleanupWorkDir(run),/临时目录之外/);assert(await exists(inside));
    const outside=path.join(root,'missing.xlsx');await fs.writeFile(outside,'fixture');await recordRun(run,outside,true);await fs.unlink(outside);await assert.rejects(cleanupWorkDir(run));assert(await exists(run));
  });
  await test('拒绝目录别名，内部链接不删除外部目标',async()=>{
    const run=await createWorkDir(root),external=path.join(root,'external');await fs.mkdir(external);await fs.writeFile(path.join(external,'keep.txt'),'preserve');await recordRun(run,output,true);
    const alias=path.join(root,'hardware-quote-alias12');try{await fs.symlink(run,alias,process.platform==='win32'?'junction':'dir');}catch(e){if(e.code==='EPERM'||e.code==='EACCES')return false;throw e;}await assert.rejects(cleanupWorkDir(alias),/只能清理/);await fs.unlink(alias);
    await fs.symlink(external,path.join(run,'linked-preview'),process.platform==='win32'?'junction':'dir');await cleanupWorkDir(run);assert.equal(await fs.readFile(path.join(external,'keep.txt'),'utf8'),'preserve');
  });
  await test('预览分片连续完整且普通文件名兼容',()=>{
    assert.deepEqual(previewSlices('报价BOM',41),[{sheetName:'报价BOM',range:'A1:I41',filename:'报价BOM.png'}]);
    assert.deepEqual(previewSlices('报价底稿',193).map(s=>s.range),['A1:I96','A97:I192','A193:I193']);
    assert.deepEqual(previewSlices('报价底稿',193).map(s=>s.filename),['报价底稿_01.png','报价底稿_02.png','报价底稿_03.png']);assert.throws(()=>previewSlices('x',0));
  });
  await test('分块检查覆盖最后一行，不将待核价标记当有效值',()=>{
    const calls=[];let formulas=0;
    const sheet={name:'fixture',getRange(address){calls.push(address);return {values:address==='A129:I130'?[['#N/A']]:[['valid']]};},getRangeByIndexes(){formulas++;return {formulas:[['=UNKNOWN()']]};}};
    checkFormulaValues([{sheet,lastRow:130,lastColumn:'I'}],true);assert.deepEqual(calls,['A1:I64','A65:I128','A129:I130']);assert.equal(formulas,0);
    assert.throws(()=>checkFormulaValues([{sheet,lastRow:130,lastColumn:'I'}],false),/公式错误/);
    sheet.getRange=()=>({values:[['unsupported function']]});assert.throws(()=>checkFormulaValues([{sheet,lastRow:1,lastColumn:'I'}],false),/不支持的公式/);assert.equal(formulas,1);
  });
}finally{
  // root is the exact fresh mkdtemp path created by this test, never a caller path.
  await fs.rm(root,{recursive:true,force:true});
}
console.log(`${passed}个运行与清理用例通过，${skipped}个环境限制跳过。`);
