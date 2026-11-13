#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runCommand,resolvePython} from './runtime.mjs';
import {inspect,reviewLoop} from './multimodal.mjs';
import {runFilm} from './film.mjs';
import {LingError} from './ling_client.mjs';
const scripts=path.dirname(fileURLToPath(import.meta.url));
export async function main(argv=process.argv.slice(2)){
  const args={};for(let i=0;i<argv.length;i++){const key=argv[i];if(key==='--dry-run'){args.dryRun=true;continue;}if(!['--ref-video','--video','--photo','--prompt','--out-dir','--max-rounds','--playwright-module','--mode'].includes(key)||!argv[i+1])throw Error('未知参数或缺值');args[key.slice(2)]=argv[++i];}
  if(args['ref-video']&&args.video)throw Error('ref-video和video不能同时使用');
  args.video=args['ref-video']||args.video;
  const mode=args.mode||'all';if(!['all','structure','homework'].includes(mode))throw Error('mode须为all/structure/homework');
  const maxRounds=Number(args['max-rounds']??2);if(!Number.isInteger(maxRounds)||maxRounds<0||maxRounds>2)throw Error('max-rounds须为0至2（最多3轮审核）');
  const out=path.resolve(args['out-dir']||`outputs/mm-${new Date().toISOString().slice(0,10)}${args.dryRun?'-dry-run':''}`);
  await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'run.json'),JSON.stringify({status:'starting',dryRun:!!args.dryRun,mode}),{flag:'wx'});
  const fixtures=path.join(out,'fixtures');await fs.mkdir(fixtures);
  const python=await resolvePython();await runCommand(python.command,[...python.args,path.join(scripts,'prepare_mm_demo.py'),fixtures]);
  const photo=path.resolve(args.photo||path.join(fixtures,'homework.png'));
  const synthetic=path.join(fixtures,'structure.mp4');
  if(!args.video)await runCommand('ffmpeg',['-v','error','-loop','1','-i',photo,'-t','9','-vf',"scale=640:-2,drawbox=x=40:y=120:w=180:h=180:color=orange@0.6:t=fill:enable='between(t,3,6)',drawbox=x=280:y=120:w=180:h=180:color=green@0.6:t=fill:enable='gte(t,6)'",'-r','15','-c:v','libx264','-pix_fmt','yuv420p',synthetic],{timeout:60000});
  const prompt=args.prompt||'给五年级解释0.3乘0.2，用百格图，最后留一道迁移题';
  const common={dryRun:!!args.dryRun,prompt};const analysis={};
  if(mode!=='homework'){const refVideo=path.resolve(args.video||synthetic);try{analysis.structure=await inspect({...common,kind:'structure',file:refVideo,outDir:path.join(out,'structure')});}catch(error){
    // Fallback (2026-11-12): server returned 500 "torchvision.io has no attribute read_video" for every video_url; send ≤30 s as 1 fps PNG frames (documented image input) instead. Never on 401/403/429.
    if(args.dryRun||!(error instanceof LingError)||!['PROVIDER_ERROR','HTTP_ERROR'].includes(error.code))throw error;
    const dir=path.join(out,'structure-frames','frames');await fs.mkdir(dir,{recursive:true});
    await runCommand('ffmpeg',['-v','error','-i',refVideo,'-t','30','-vf','fps=1,scale=640:-2',path.join(dir,'f-%02d.png')],{timeout:120000});
    const files=(await fs.readdir(dir)).filter(f=>f.endsWith('.png')).sort().slice(0,30);
    const frames=files.map((f,i)=>({file:path.join(dir,f),time:i+0.5}));
    analysis.structure=await inspect({...common,kind:'structure',file:refVideo,frames,prompt:prompt+'\n帧时间戳（秒）：'+frames.map(x=>x.time).join(','),outDir:path.join(out,'structure-frames')});
    analysis.structureInput={mode:'frames-fallback',reason:`video_url失败：${error.code}`,frames:frames.length,fps:1};}}
  if(analysis.structure)await fs.writeFile(path.join(out,'structure.json'),JSON.stringify(analysis.structure,null,2),{flag:'wx'});
  if(mode!=='structure')analysis.homework=await inspect({...common,kind:'homework',file:photo,outDir:path.join(out,'homework')});
  if(analysis.homework?.uncertain)throw Error('Ling无法确认作业内容，请补充清晰照片或题意。');
  let review;
  if(args.dryRun){
    const narration={duration:9,segments:[{id:'synthetic',voiceStart:0,voiceEnd:9,end:9,spokenText:'dry-run占位旁白，仅验证请求配对，不是模型输出或真实配音'}]};
    review=await reviewLoop({video:args.video||synthetic,narration,outDir:path.join(out,'review'),maxRounds,dryRun:true});
  }else{
    const enriched=prompt+(analysis.homework?'\nteaching.misconception必须逐字设置为：'+analysis.homework.misconception:'')+'\n仅采用结构节奏，画面文案配音全部原创；作业识别结果必须用于教学计划teaching误区字段。\n'+JSON.stringify(analysis);
    const film=await runFilm({prompt:enriched,misconception:analysis.homework?.misconception,outDir:path.join(out,'film'),maxRounds:1,'playwright-module':args['playwright-module']});
    const manifest=JSON.parse(await fs.readFile(film.manifest,'utf8'));
    const narration=JSON.parse(await fs.readFile(path.join(film.directory,manifest.narration.file),'utf8'));
    review=await reviewLoop({video:film.video,html:path.join(film.directory,'film.html'),audio:path.join(film.directory,manifest.narration.audio),narration,outDir:path.join(out,'review'),maxRounds,render:async({html,video,audio,duration})=>runCommand(process.execPath,[path.join(scripts,'render_video.mjs'),'--html',html,'--output',video,'--audio',audio,'--duration',String(duration),...(args['playwright-module']?['--playwright-module',args['playwright-module']]:[])],{timeout:3600000})});
  }
  const result={dryRun:!!args.dryRun,status:review.status,analysis,review,unverified:args.dryRun?['真实Ling识别、Ming配音、修订重渲染均未调用']:['未抽样画面、真实音轨语义和教学效果仍需人工复核']};
  await fs.writeFile(path.join(out,'run.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  if(review.status==='revision-limit')process.exitCode=2;
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error instanceof LingError?`${error.code}: ${error.message}`:'多模态任务失败；检查参数、本地素材、配置及已保存记录。未输出密钥或请求正文。');process.exitCode=1;});
