import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {LingError} from './ling_client.mjs';
import {validatePlan} from './ling_plan.mjs';

// Model text is document content, never markup or executable instructions.
const md=value=>String(value).replace(/\\/g,'\\\\').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([`*_[\]#|])/g,'\\$1').replace(/[\r\n]+/g,' ').trim();

export function renderTeachingGuide(plan){
  validatePlan(plan);
  if(!plan.teaching){
    return '# '+md(plan.title)+' · 历史素材使用说明\n\n'+
      '这份历史计划没有记录年级目标、具体误区或检验题。现有视频可以作为概念演示素材；本说明未补写题目、答案或思考停顿。\n\n'+
      '如需生成完整的家庭辅导或课堂使用提示，请先为该计划补齐教学结构并复核内容，再重新制作对应音轨和视频。\n\n'+
      '学生实际学习效果尚未验证。\n';
  }
  const t=plan.teaching,c=t.check;
  const kind=t.mode==='teacher'?'课堂使用提示':'家庭辅导提示';
  const lines=[
    '# '+md(plan.title)+' · '+kind,
    '',
    '适用年级：'+md(t.grade),
    '',
    '学习目标：'+md(t.learningGoal),
    '',
    '这次重点纠正：'+md(t.misconception),
    '',
    '## 开始前',
    '',
    t.prerequisites.length?'先确认孩子理解：'+t.prerequisites.map(md).join('；')+'。':'计划未列额外前置知识；可先请孩子说说对这个知识点的理解。',
    '',
    '## 让孩子先想一想',
    '',
    md(c.question),
    '',
    '提问旁白结束后，视频计划预留至少'+c.pauseSeconds+'秒静音思考。可按孩子情况继续暂停，先听解释，再播放答案。',
    '',
    '## 检验题答案与理由',
    '',
    '答案：'+md(c.expectedAnswer),
    '',
    '理由：'+md(c.explanation),
    '',
    '## 使用建议',
    '',
    ...t.adultTips.map(tip=>'- '+md(tip)),
    '',
    '本提示依据当前讲解计划生成，成人提示不进入孩子的视频画面。数学与题意仍需随视频复核；学生实际学习效果尚未验证。',
    ''
  ];
  return lines.join('\n');
}

export async function writeTeachingGuide({plan,outDir,sourcePlanSha256}={}){
  const content=renderTeachingGuide(plan);
  if(typeof outDir!=='string'||!outDir.trim())throw new LingError('INVALID_ARGUMENT','使用提示需要明确输出目录。');
  if(sourcePlanSha256!==undefined&&!/^[a-f0-9]{64}$/i.test(sourcePlanSha256))throw new LingError('INVALID_ARGUMENT','来源计划指纹须为SHA256。');
  const directory=path.resolve(outDir);
  if([path.parse(directory).root,path.resolve(os.homedir())].includes(directory))throw new LingError('UNSAFE_OUTPUT','使用提示应写入专用作品目录。');
  const existing=await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(existing&&(!existing.isDirectory()||existing.isSymbolicLink()))throw new LingError('OUTPUT_NOT_DIRECTORY','使用提示输出必须是普通目录。');
  await fs.mkdir(directory,{recursive:true});
  const file=path.join(directory,'teaching-guide.md');
  try{await fs.writeFile(file,content,{flag:'wx'});}
  catch(error){if(error.code==='EEXIST')throw new LingError('OUTPUT_EXISTS','已有使用提示，拒绝覆盖。');throw error;}
  return {file,status:plan.teaching?'structured':'legacy',mode:plan.teaching?.mode??null,...(sourcePlanSha256?{sourcePlanSha256}:{})};
}
