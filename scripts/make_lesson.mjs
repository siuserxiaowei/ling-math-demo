#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),opts={};
for(let i=0;i<args.length;i++){const key=args[i];if(key==='--help'){console.log('node scripts/make_lesson.mjs --topic circle-area|fraction-division --out lesson.html [--narration narration.json] [--duration seconds] [--force]');process.exit(0);}if(key==='--force'){opts.force=true;continue;}if(!['--topic','--out','--narration','--duration'].includes(key)||!args[i+1]||args[i+1].startsWith('--'))throw new Error(`未知参数或缺少值：${key}`);opts[key.slice(2)]=args[++i];}
if(!['circle-area','fraction-division'].includes(opts.topic)||!opts.out)throw new Error('必须指定 --topic circle-area|fraction-division 和 --out');
const config={topic:opts.topic,duration:opts.topic==='circle-area'?54:32,provenance:'原创、可复现的教学基准样例；由本次Skill开发创建，未归为Ling模型的实测输出。'};
if(opts.narration){const raw=JSON.parse(await fs.readFile(path.resolve(opts.narration),'utf8'));if(!Array.isArray(raw.segments)||raw.segments.length!==6||opts.topic!=='circle-area')throw new Error('此样例的定时旁白需要6段圆面积讲解；其他主题须调整画面时间函数');let previous=-Infinity;config.segments=raw.segments.map(s=>{if(!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.start<previous||s.end<=s.start||typeof s.text!=='string')throw new Error('旁白时间轴必须有序、非重叠且包含文字');previous=s.end;return{start:s.start,end:s.end,text:s.text};});config.duration=Math.ceil(previous+.5);}
if(opts.duration){const d=Number(opts.duration);if(!Number.isFinite(d)||d<=0||d>600||d<(config.segments?.at(-1)?.end??0))throw new Error('duration须为0至600秒且不能截断旁白');config.duration=d;}
const target=path.resolve(opts.out);await fs.mkdir(path.dirname(target),{recursive:true});const source=await fs.readFile(path.join(root,'assets/lesson.html'),'utf8');
const payload=JSON.stringify(config).replaceAll('<','\\u003c');
const html=source.replace('__LESSON_CONFIG__',payload);await fs.writeFile(target,html,{flag:opts.force?'w':'wx'});
console.log(JSON.stringify({html:target,topic:config.topic,duration:config.duration,provenance:config.provenance}));
