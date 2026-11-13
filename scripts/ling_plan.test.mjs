import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generatePlan,parsePlan,validatePlan,validateSpokenText,parseArgs,PLAN_PROMPT} from './ling_plan.mjs';
import {MODEL} from './ling_client.mjs';
const KEY='unit-test-only-credential';
const plan=()=>({schemaVersion:1,title:'小数为什么能化分数',topic:'小数与分数',audience:'五年级',segments:Array.from({length:3},(_,i)=>({id:`s0${i+1}`,text:'把一整个分成十份',spokenText:'把一整个分成十份，每一份是十分之一。',visual:{scene:'decimal_grid',stage:['divide','highlight','compare'][i],description:'十格长方形高亮一格',numerator:1,denominator:10}}))});
const teaching=()=>({mode:'parent',grade:'五年级',learningGoal:'能把小数表示为等分单位的数量',misconception:'把零点一看成一整个',prerequisites:['知道平均分的含义'],check:{questionSegmentId:'s02',answerSegmentId:'s03',question:'零点四占十格中的几格？',expectedAnswer:'四格',explanation:'每格是十分之一，零点四是四个十分之一。',pauseSeconds:4},adultTips:['在提问结束后等孩子先说理由。','若把零点四涂成整条，回看单位格。']});
const lesson=()=>({...plan(),teaching:teaching()});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ling-plan-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const response=(content=JSON.stringify(lesson()),model=MODEL,finish='stop')=>new Response('data: '+JSON.stringify({id:'plan-test',model,choices:[{index:0,delta:{content,reasoning_content:'never-save-reasoning'},finish_reason:finish}],usage:{total_tokens:7}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const run=(root,fetchImpl,extra={})=>generatePlan({prompt:'小数为什么能写成分数',outDir:path.join(root,'out'),config:path.join(root,'missing.json'),env:{LING_API_KEY:KEY},fetchImpl,...extra});
test('plan schema accepts original scenes and validates unique ids and segment bounds',()=>{assert.equal(validatePlan(plan()).segments[0].visual.scene,'decimal_grid');for(const mutate of [p=>p.segments.pop(),p=>p.segments[1].id=p.segments[0].id,p=>p.segments[0].spokenText='',p=>p.segments[0].visual.description='']){const p=plan();mutate(p);assert.throws(()=>validatePlan(p),e=>e.code==='INVALID_PLAN');}});
test('spoken text rejects ambiguous math notation while allowing ordinary numerals',()=>{for(const text of ['把1/2涂上颜色','计算3÷2','把四分之三×二','用π计算面积','三的平方写作3²','算一算3-2','把50%涂满'])assert.throws(()=>validateSpokenText(text),e=>e.code==='INVALID_SPOKEN_TEXT');for(const text of ['先拿出3个苹果，再平均分成2份。','面积是1.5平方厘米。','四分之三除以二分之一。','这是A-B两组的日常称呼。'])assert.equal(validateSpokenText(text),text);const p=plan();p.segments[1].spokenText='取1/2';assert.throws(()=>validatePlan(p),e=>e.code==='INVALID_SPOKEN_TEXT');assert.ok(PLAN_PROMPT.includes('整体长度随用户需求决定'));});
test('parser accepts a single strict JSON document or JSON fence and rejects prose/truncation',()=>{assert.deepEqual(parsePlan('```json\n'+JSON.stringify(plan())+'\n```'),plan());for(const text of ['a '+JSON.stringify(plan()),'{"schemaVersion":1','[]'])assert.throws(()=>parsePlan(text));});
test('CLI contract accepts prompt-file, limits and explicit mock switch',()=>{const parsed=parseArgs(['--prompt-file','brief.txt','--out-dir','new','--max-tokens','9000','--timeout','60','--test-localhost']);assert.equal(parsed.maxTokens,9000);assert.equal(parsed.timeout,60);assert.equal(parsed.allowTestLocalhost,true);assert.throws(()=>parseArgs([KEY]),e=>!e.message.includes(KEY));});
test('generation replaces only system contract and writes validated JSON with test provenance',async t=>{const root=await fixture(t);let observed;const result=await run(root,async(url,options)=>{observed={url,options};return response();});assert.equal(result.ok,true);assert.equal(result.transportMode,'test');assert.equal(result.source,'test-injected-fetch');const body=JSON.parse(observed.options.body);assert.equal(body.model,MODEL);assert.equal(body.thinking.type,'disabled');assert.ok(body.messages[0].content.includes('spokenText'));assert.equal(body.messages[1].content[0].text,'小数为什么能写成分数');assert.deepEqual(JSON.parse(await fs.readFile(result.plan)),lesson());const files=await Promise.all(['plan.json','response.md','receipt.json'].map(name=>fs.readFile(path.join(root,'out',name),'utf8')));assert.ok(!files.join('').includes(KEY));assert.ok(!files.join('').includes('never-save-reasoning'));});
test('missing key and nonempty output never make a request or overwrite prior work',async t=>{const root=await fixture(t);let calls=0;await assert.rejects(run(root,async()=>{calls++;return response();},{env:{}}),e=>e.code==='MISSING_API_KEY');assert.equal(calls,0);assert.equal(JSON.parse(await fs.readFile(path.join(root,'out/receipt.json'))).requestPerformed,false);await assert.rejects(run(root,async()=>response()),e=>e.code==='OUTPUT_EXISTS');});
test('401 and 429 stop once, keeping only safe failure receipts',async t=>{for(const status of [401,429]){const root=await fixture(t);let calls=0;await assert.rejects(run(root,async()=>{calls++;return new Response(KEY,{status});}),e=>e.code===(status===401?'AUTH_FAILED':'RATE_LIMITED'));assert.equal(calls,1);assert.ok(!(await fs.readFile(path.join(root,'out/receipt.json'),'utf8')).includes(KEY));}});
test('invalid plan, wrong model and truncated output never become successful plans',async t=>{for(const [content,model,finish,code] of [['{}',MODEL,'stop','INVALID_PLAN'],[JSON.stringify(plan()),'different-model','stop','MODEL_MISMATCH'],[JSON.stringify(plan()),MODEL,'length','TRUNCATED']]){const root=await fixture(t);await assert.rejects(run(root,async()=>response(content,model,finish)),e=>e.code===code);await assert.rejects(fs.access(path.join(root,'out/plan.json')));assert.equal(JSON.parse(await fs.readFile(path.join(root,'out/receipt.json'))).ok,false);}});

test('structured teaching validates mode, references, adjacent answer and bounded thinking pause',()=>{
  assert.equal(validatePlan(lesson(),{requireTeaching:true}).teaching.check.pauseSeconds,4);
  for(const mutate of [p=>p.teaching.mode='student',p=>p.teaching.check.questionSegmentId='missing',p=>p.teaching.check.answerSegmentId='s01',p=>p.teaching.check.questionSegmentId='s03',p=>p.teaching.check.answerSegmentId='s02',p=>p.teaching.check.pauseSeconds=2.99,p=>p.teaching.check.pauseSeconds=15.01,p=>p.teaching.check.pauseSeconds=NaN,p=>p.teaching.adultTips=['一条不足'],p=>p.teaching.prerequisites=[''],p=>p.teaching.extra='unexpected',p=>p.teaching.check.duration=4]){
    const value=lesson();mutate(value);assert.throws(()=>validatePlan(value),e=>e.code==='INVALID_PLAN');
  }
  const nonadjacent=lesson();nonadjacent.teaching.check.questionSegmentId='s01';assert.throws(()=>validatePlan(nonadjacent));
});
test('legacy imports remain explicit and new generation requires teaching by default',async t=>{
  assert.deepEqual(validatePlan(plan()),plan());
  assert.throws(()=>parsePlan(JSON.stringify(plan()),{requireTeaching:true}),e=>e.code==='INVALID_PLAN');
  const root=await fixture(t);await assert.rejects(run(root,async()=>response(JSON.stringify(plan()))),e=>e.code==='INVALID_PLAN');
  await assert.rejects(fs.access(path.join(root,'out/plan.json')));
  const other=await fixture(t);const result=await run(other,async()=>response(JSON.stringify(plan())),{requireTeaching:false});
  assert.equal(result.teachingStatus,'legacy');
  const current=await fixture(t);const complete=await run(current,async()=>response());assert.equal(complete.teachingStatus,'structured');
});
