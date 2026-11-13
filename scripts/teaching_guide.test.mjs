import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {renderTeachingGuide,writeTeachingGuide} from './teaching_guide.mjs';

const plan=()=>({schemaVersion:1,title:'小数乘法',topic:'小数乘法算理',audience:'五年级',teaching:{mode:'parent',grade:'小学五年级',learningGoal:'能用一百格解释小数乘法',misconception:'把零点三乘零点二算成零点六',prerequisites:['理解零点一表示十分之一'],check:{questionSegmentId:'s02',answerSegmentId:'s03',question:'零点四乘零点二是多少？用几格表示？',expectedAnswer:'零点零八，八格',explanation:'四列与两行的交集是八格，占一百格的百分之八。',pauseSeconds:5},adultTips:['先让孩子指出单位正方形。','若回答零点八，回到一百格图观察交集。']},segments:['s01','s02','s03'].map((id,index)=>({id,text:['先看主例','换个数试试','交集是八格'][index],spokenText:['先看零点三乘零点二。','零点四乘零点二是多少？','答案是零点零八。'][index],visual:{scene:'grid',stage:String(index),description:'同一个单位正方形中的交集'}}))});

test('adult guide uses the exact planned check and answer for the selected role',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'teaching-guide-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const p=plan(),result=await writeTeachingGuide({plan:p,outDir:path.join(root,'film'),sourcePlanSha256:'a'.repeat(64)});
  const text=await fs.readFile(result.file,'utf8');
  assert.equal(result.status,'structured');assert.equal(result.mode,'parent');
  for(const value of [p.teaching.learningGoal,p.teaching.misconception,p.teaching.check.question,p.teaching.check.expectedAnswer,p.teaching.check.explanation,...p.teaching.adultTips])assert.ok(text.includes(value));
  assert.ok(text.includes('至少5秒'));assert.ok(text.includes('家庭辅导提示'));assert.ok(text.includes('学生实际学习效果尚未验证'));
  p.teaching.mode='teacher';assert.ok(renderTeachingGuide(p).includes('课堂使用提示'));
});

test('guide rejects broken teaching references before creating any output',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'teaching-guide-invalid-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const p=plan();p.teaching.check.answerSegmentId='missing';const outDir=path.join(root,'invalid');
  await assert.rejects(writeTeachingGuide({plan:p,outDir}),e=>e.code==='INVALID_PLAN');
  await assert.rejects(fs.access(outDir));
});

test('legacy material stays legacy rather than inventing a question or learning result',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'teaching-guide-legacy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const p=plan();delete p.teaching;const result=await writeTeachingGuide({plan:p,outDir:root});
  assert.equal(result.status,'legacy');assert.equal(result.mode,null);const text=await fs.readFile(result.file,'utf8');
  assert.ok(text.includes('没有记录年级目标'));assert.ok(!text.includes('零点四乘零点二'));assert.ok(!text.includes('至少5秒'));
});

test('adult document escapes generated markup and refuses existing files',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'teaching-guide-safe-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const p=plan();p.teaching.adultTips[0]='<script>alert(1)</script>\n# another heading';
  const result=await writeTeachingGuide({plan:p,outDir:root});const text=await fs.readFile(result.file,'utf8');
  assert.ok(!text.includes('<script>'));assert.ok(text.includes('&lt;script&gt;'));assert.ok(!text.includes('\n# another heading'));
  await assert.rejects(writeTeachingGuide({plan:p,outDir:root}),e=>e.code==='OUTPUT_EXISTS');
  assert.equal(await fs.readFile(result.file,'utf8'),text);
});
