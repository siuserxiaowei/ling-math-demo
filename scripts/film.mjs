#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {MODEL,DEFAULT_CONFIG,LingError,loadConfig,generate,redactSecret} from './ling_client.mjs';
import {generatePlan,validatePlan} from './ling_plan.mjs';
import {writeTeachingGuide} from './teaching_guide.mjs';
import {synthesize,DEFAULT_TTS_MODEL,DEFAULT_VOICE} from './ming_speech.mjs';
import {narrationCues,normalizeCaption} from './verify_film.mjs';
import {loadPlaywright,browserExecutableStatus,runCommand,inspectAudio,resolvePython} from './runtime.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const readJSON=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const safe=(value,secret)=>redactSecret(value,secret).replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi,'[REDACTED]').slice(0,5000);
const relative=(directory,file)=>path.relative(directory,file).split(path.sep).join('/');
function sourceClaims(value){const claims={};for(const key of ['provider','model','requiredModel','requestModel','responseModel','transportMode','source','visualSource','modelGenerated','simulated','htmlSha256','sha256','baseAuthorModel','basePlanSha256','hostEdited']){if(['string','boolean','number'].includes(typeof value?.[key]))claims[key]=typeof value[key]==='string'?safe(value[key]).slice(0,240):value[key];}return claims;}

export function parseArgs(argv){
  const options={tts:'auto',maxRounds:1,timeout:300,maxTokens:12000,fps:30};
  const flags=new Set(['prompt','prompt-file','out-dir','plan','narration','html','reference-html','tts','audio-index','voice','config','playwright-module','max-rounds','timeout','max-tokens','fps']);
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];if(arg==='--help'||arg==='-h'){options.help=true;continue;}if(arg==='--test-localhost'){options.allowTestLocalhost=true;continue;}
    if(!arg.startsWith('--')||!flags.has(arg.slice(2)))throw new LingError('INVALID_ARGUMENT','未知参数，请使用--help查看。');
    const value=argv[++i];if(!value||value.startsWith('--'))throw new LingError('INVALID_ARGUMENT','参数缺少值。');options[arg.slice(2)]=value;
  }
  if(options.help)return options;
  if(Boolean(options.prompt)===Boolean(options['prompt-file'])||!options['out-dir'])throw new LingError('INVALID_ARGUMENT','须指定--out-dir，并使用--prompt或--prompt-file之一。');
  options.maxRounds=Number(options['max-rounds']??options.maxRounds);options.timeout=Number(options.timeout);options.maxTokens=Number(options['max-tokens']??options.maxTokens);options.fps=Number(options.fps);
  if(![0,1].includes(options.maxRounds))throw new LingError('INVALID_ARGUMENT','max-rounds只允许0或1。');
  if(!Number.isFinite(options.timeout)||options.timeout<=0||options.timeout>3600)throw new LingError('INVALID_ARGUMENT','timeout须为0至3600秒。');
  if(!Number.isInteger(options.maxTokens)||options.maxTokens<256||options.maxTokens>131072)throw new LingError('INVALID_ARGUMENT','max-tokens须为256至131072整数。');
  if(!Number.isInteger(options.fps)||options.fps<1||options.fps>60)throw new LingError('INVALID_ARGUMENT','fps须为1至60整数，默认30。');
  if(!['auto','macos','ming','import'].includes(options.tts))throw new LingError('INVALID_ARGUMENT','tts只允许auto、macos、ming或import。');
  if(options['audio-index']&&options.tts!=='import')throw new LingError('INVALID_ARGUMENT','audio-index须搭配--tts import。');
  if(options.narration&&options['audio-index'])throw new LingError('INVALID_ARGUMENT','narration与audio-index不能同时使用。');
  if(options.tts==='import'&&!options['audio-index']&&!options.narration)throw new LingError('INVALID_ARGUMENT','tts import需要audio-index或narration。');
  if(options.html&&(!options.plan||!options.narration))throw new LingError('INVALID_ARGUMENT','html零API复用模式须同时提供plan和narration。');
  options.outDir=path.resolve(options['out-dir']);return options;
}

export function chooseTTS(mode){
  return mode==='auto'?'ming':mode;
}

async function emptyDirectory(directory){
  const absolute=path.resolve(directory);
  if([path.parse(absolute).root,path.resolve(os.homedir()),path.resolve(process.cwd())].includes(absolute))throw new LingError('UNSAFE_OUTPUT','请选择专用的新输出目录。');
  try{const info=await fs.lstat(absolute);if(!info.isDirectory()||info.isSymbolicLink()||(await fs.readdir(absolute)).length)throw new LingError('OUTPUT_EXISTS','输出目录须为空的普通目录，不覆盖旧产物。');}
  catch(error){if(error.code==='ENOENT')await fs.mkdir(absolute,{recursive:true});else throw error;}
  await fs.writeFile(path.join(absolute,'film.json'),'{}\n',{flag:'wx',mode:0o600});return absolute;
}

async function execute(executable,args,{timeout=90000,allowFailure=false}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});let stdout='',stderr='',timedOut=false,settled=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),1500).unref();},timeout);
    child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-2000000);});child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-32000);});
    const finish=(code,error)=>{if(settled)return;settled=true;clearTimeout(timer);const result={code:timedOut?124:code,stdout,stderr};if(error||(!allowFailure&&result.code!==0))reject(new LingError(timedOut?'SUBPROCESS_TIMEOUT':'SUBPROCESS_FAILED',safe(error?.message||stderr||'本地子任务未完成。')));else resolve(result);};
    child.once('error',error=>finish(1,error));child.once('close',code=>finish(code));
  });
}
const script=(name,args,options)=>execute(process.execPath,[path.join(ROOT,'scripts',name),...args],options);

export function planProvenance(receipt,bytes){
  const verified=Boolean(receipt?.ok&&receipt.requestPerformed&&receipt.requestModel===MODEL&&receipt.responseModel===MODEL&&receipt.planSha256===digest(bytes));
  if(!verified)return{authorship:'imported-unverified',modelAuthored:false,transportMode:'imported',sha256:digest(bytes)};
  return{authorship:receipt.transportMode==='official'?'Ling-3.2-flash':receipt.transportMode==='test'?'simulated':'api-unverified',modelAuthored:receipt.transportMode==='official',transportMode:receipt.transportMode,sha256:digest(bytes)};
}

async function obtainPlan(options,directory,manifest,save,api){
  if(options.plan){
    const source=path.resolve(options.plan),bytes=await fs.readFile(source),plan=validatePlan(JSON.parse(bytes.toString('utf8')));
    const supplied=await readJSON(path.join(path.dirname(source),'receipt.json')).catch(()=>null),provenance=planProvenance(supplied,bytes),target=path.join(directory,'plan'),derivationFile=path.join(path.dirname(source),'provenance.json'),derivation=await readJSON(derivationFile).catch(()=>null);
    if(derivation){provenance.providedDerivation={sha256:digest(await fs.readFile(derivationFile)),claims:sourceClaims(derivation),independentlyAuthenticated:false};}
    await fs.mkdir(target);await fs.writeFile(path.join(target,'plan.json'),bytes,{flag:'wx'});
    await fs.writeFile(path.join(target,'provenance.json'),JSON.stringify(provenance,null,2)+'\n',{flag:'wx'});
    manifest.plan={...provenance,file:'plan/plan.json',source:'provided-plan'};await save();return{plan,file:path.join(target,'plan.json'),bytes};
  }
  const instruction=await fs.readFile(path.join(ROOT,'assets/ling-film-plan.txt'),'utf8');let prompt=instruction+'\n\n用户需求：\n'+options.prompt,prior;
  for(let round=1;round<=2;round++){
    const folder=path.join(directory,`plan-round-0${round}`);
    try{
      const result=await generatePlan({prompt,outDir:folder,...api,maxTokens:Math.min(options.maxTokens,12000)}),bytes=await fs.readFile(result.plan),plan=validatePlan(JSON.parse(bytes.toString('utf8')));
      if(options.misconception && plan.teaching?.misconception!==options.misconception)throw new LingError('INVALID_PLAN','teaching.misconception须逐字采用作业识别得到的误区。');
      manifest.planRounds.push({directory:relative(directory,folder),receipt:relative(directory,result.receipt),ok:true,transportMode:result.transportMode});
      manifest.plan={...planProvenance(result,bytes),file:relative(directory,result.plan),source:'generated-plan'};await save();return{plan,file:result.plan,bytes};
    }catch(error){
      const receipt=await readJSON(path.join(folder,'receipt.json')).catch(()=>null);manifest.planRounds.push({directory:relative(directory,folder),receipt:relative(directory,path.join(folder,'receipt.json')),ok:false,errorCode:error.code||'PLAN_FAILED',transportMode:receipt?.transportMode||null});await save();
      if(round!==1||!['INVALID_SPOKEN_TEXT','INVALID_PLAN_JSON','INVALID_PLAN'].includes(error.code))throw error;
      prior=await fs.readFile(path.join(folder,'response.md'),'utf8').catch(()=> '');
      prompt=instruction+'\n\n用户需求：\n'+options.prompt+'\n\n上次计划校验失败：'+error.code+'。只修复真实问题，spokenText必须是完整中文读法，teaching须包含教学目标、误区、相邻问答段引用和真实静音要求。不得声称已播放或验证。请重新输出完整JSON。\n\n上次正文：\n'+prior;
    }
  }
}

function localAsset(base,value,label){
  if(typeof value!=='string'||!value||path.isAbsolute(value))throw new LingError('INVALID_NARRATION',`${label}须为清单旁的相对路径。`);
  const resolved=path.resolve(base,value),rel=path.relative(base,resolved);
  if(rel.startsWith('..'+path.sep)||rel==='..'||path.isAbsolute(rel))throw new LingError('INVALID_NARRATION',`${label}不能越出音频目录。`);return resolved;
}

export function checkNarrationPlan(narration,plan,planBytes){
  narrationCues(narration);
  if(narration.sourcePlan?.sha256!==digest(planBytes))throw new LingError('NARRATION_PLAN_MISMATCH','narration.sourcePlan.sha256与实际plan文件不符，不能复用音轨。');
  if(narration.segments.length!==plan.segments.length)throw new LingError('NARRATION_PLAN_MISMATCH','旁白分段与计划数量不一致。');
  for(let i=0;i<plan.segments.length;i++){
    const a=plan.segments[i],b=narration.segments[i];
    if(a.id!==b.id||a.text!==b.text||a.spokenText!==b.spokenText||JSON.stringify(a.visual)!==JSON.stringify(b.visual))throw new LingError('NARRATION_PLAN_MISMATCH','旁白中的字幕、中文读音或画面计划已变动。');
    if(!Array.isArray(b.lines)||b.lines.length<1||b.lines.length>2||normalizeCaption(b.lines.join(''))!==normalizeCaption(a.text))throw new LingError('INVALID_NARRATION','旁白字幕分行与计划文本不符。');
  }
  if(Boolean(plan.teaching)!==Boolean(narration.teaching))throw new LingError('NARRATION_PLAN_MISMATCH','计划与配音的教学结构不一致。');
  if(plan.teaching){
    if(JSON.stringify(narration.teaching)!==JSON.stringify(plan.teaching))throw new LingError('NARRATION_PLAN_MISMATCH','教学目标或检验题与配音清单不符，不能复用。');
    const check=plan.teaching.check,q=narration.segments.find(s=>s.id===check.questionSegmentId),a=narration.segments.find(s=>s.id===check.answerSegmentId);
    if(!q||!a||a.voiceStart-q.voiceEnd<check.pauseSeconds-.0001||Math.abs(q.end-a.voiceStart)>.0001)throw new LingError('INVALID_NARRATION','检验题未保留完整思考时间，或答案开始时点与问题画面区间不符。');
    const pause=narration.thinkingPauses?.[0];
    if(!Array.isArray(narration.thinkingPauses)||narration.thinkingPauses.length!==1||!pause||typeof pause!=='object'||![pause.start,pause.end,pause.duration].every(Number.isFinite)||pause.questionSegmentId!==q.id||pause.answerSegmentId!==a.id||Math.abs(pause.start-q.voiceEnd)>.0001||Math.abs(pause.end-a.voiceStart)>.0001||Math.abs(pause.duration-(a.voiceStart-q.voiceEnd))>.0001||pause.requestedSeconds!==check.pauseSeconds)throw new LingError('INVALID_NARRATION','思考停顿清单与实测问答时间不符。');
  }
  return narration;
}

export function checkSubtitles(text,narration){
  const blocks=text.replace(/^\uFEFF/,'').replace(/\r/g,'').trim().split(/\n\s*\n/);
  if(blocks.length!==narration.segments.length)throw new LingError('INVALID_NARRATION','SRT段数与实测音轨不符。');
  const seconds=value=>{const match=/^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(value);if(!match)throw new LingError('INVALID_NARRATION','SRT时间格式无效。');return Number(match[1])*3600+Number(match[2])*60+Number(match[3])+Number(match[4])/1000;};
  for(let i=0;i<blocks.length;i++){const lines=blocks[i].split('\n'),timing=(lines[1]||'').split(/\s+-->\s+/),segment=narration.segments[i];if(Number(lines[0])!==i+1||timing.length!==2||Math.abs(seconds(timing[0])-segment.voiceStart)>.0011||Math.abs(seconds(timing[1])-segment.end)>.0011||normalizeCaption(lines.slice(2).join(''))!==normalizeCaption(segment.text))throw new LingError('INVALID_NARRATION','SRT文字或时间与实测音轨不符。');}
  return true;
}

export function checkThinkingSilence(narration,bytes){
  if(!narration.teaching)return[];
  const invalid=()=>new LingError('INVALID_NARRATION','思考区间必须在实际16位PCM WAV中为静音，不能只修改时间或hash。');
  if(!Buffer.isBuffer(bytes)||bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw invalid();
  const end=bytes.readUInt32LE(4)+8;if(end>bytes.length)throw invalid();
  let format,data;const chunks=[];
  for(let pos=12;pos+8<=end;){
    const tag=bytes.toString('ascii',pos,pos+4),size=bytes.readUInt32LE(pos+4),start=pos+8;if(start+size>end)throw invalid();
    if(tag==='fmt '){if(size<16)throw invalid();format={encoding:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),sampleRate:bytes.readUInt32LE(start+4),blockAlign:bytes.readUInt16LE(start+12),bits:bytes.readUInt16LE(start+14)};}
    if(tag==='data')chunks.push(bytes.subarray(start,start+size));
    pos=start+size+(size%2);
  }
  if(!format||format.encoding!==1||format.bits!==16||format.channels<1||format.channels>2||format.blockAlign!==format.channels*2||format.sampleRate!==narration.sampleRate||!chunks.length)throw invalid();
  data=Buffer.concat(chunks);if(data.length%format.blockAlign)throw invalid();
  if(!Array.isArray(narration.thinkingPauses)||narration.thinkingPauses.length!==1)throw invalid();
  return narration.thinkingPauses.map(pause=>{
    if(!pause||typeof pause!=='object'||![pause.start,pause.end].every(Number.isFinite))throw invalid();
    const first=Math.round(pause.start*format.sampleRate),last=Math.round(pause.end*format.sampleRate);
    if(first<0||last<=first||last*format.blockAlign>data.length)throw invalid();
    let maxAmplitude=0;for(let pos=first*format.blockAlign;pos<last*format.blockAlign;pos+=2)maxAmplitude=Math.max(maxAmplitude,Math.abs(data.readInt16LE(pos)));
    if(maxAmplitude!==0)throw invalid();
    return{questionSegmentId:pause.questionSegmentId,answerSegmentId:pause.answerSegmentId,start:pause.start,end:pause.end,sampleFrames:last-first,sampleRate:format.sampleRate,maxAmplitude,allSamplesZero:true};
  });
}

async function validateNarrationFiles(file,planInfo){
  const narration=checkNarrationPlan(await readJSON(file),planInfo.plan,planInfo.bytes),base=path.dirname(file),audio=localAsset(base,narration.audio,'audio');
  const bytes=await fs.readFile(audio);if(narration.sha256!==digest(bytes))throw new LingError('INVALID_NARRATION','整轨音频hash与清单不符。');
  const thinkingSilence=checkThinkingSilence(narration,bytes);
  const measured=await inspectAudio(audio);if(Math.abs(measured.duration-narration.duration)>1/44100+.00001)throw new LingError('INVALID_NARRATION','音轨实测时长与清单不符，拒绝截音或拉伸。');
  await runCommand('ffmpeg',['-v','error','-i',audio,'-f','null','-'],{timeout:120000});
  const files=new Map([[narration.audio,audio],[narration.subtitles,localAsset(base,narration.subtitles,'subtitles')],[narration.captions,localAsset(base,narration.captions,'captions')]]);
  for(const segment of narration.segments){const source=localAsset(base,segment.audio,'segment.audio'),content=await fs.readFile(source);if(segment.sha256&&digest(content)!==segment.sha256)throw new LingError('INVALID_NARRATION','分段音频hash与清单不符。');files.set(segment.audio,source);}
  const captions=await readJSON(files.get(narration.captions));if(!Array.isArray(captions.cues)||captions.cues.length!==narration.segments.length)throw new LingError('INVALID_NARRATION','captions.json与分段清单不符。');
  for(let i=0;i<captions.cues.length;i++){const c=captions.cues[i],s=narration.segments[i];if(c.id!==s.id||c.text!==s.text||Math.abs(c.start-s.voiceStart)>.00001||Math.abs(c.end-s.end)>.00001)throw new LingError('INVALID_NARRATION','字幕时间或文本与音轨清单不符。');}
  checkSubtitles(await fs.readFile(files.get(narration.subtitles),'utf8'),narration);return{narration,files,audio,thinkingSilence};
}

async function obtainNarration(options,directory,planInfo,manifest,save){
  const target=path.join(directory,'narration');
  if(options.narration){
    const source=path.resolve(options.narration),validated=await validateNarrationFiles(source,planInfo);await fs.mkdir(target);
    for(const [name,file]of validated.files){const destination=localAsset(target,name,'复制路径');await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(file,destination,fs.constants.COPYFILE_EXCL);}
    await fs.copyFile(source,path.join(target,'narration.json'),fs.constants.COPYFILE_EXCL);
    manifest.narrationSource={kind:'reused-measured-manifest',sourceManifestSha256:digest(await fs.readFile(source)),providerClaim:validated.narration.provider,identityVerification:'imported-manifest; not independently voice-identified'};
  }else{
    const backend=chooseTTS(options.tts);let indexFile;
    if(backend==='ming'){
      const folder=path.join(directory,'speech');await fs.mkdir(folder);const segments=[];manifest.ttsAttempts=[];
      for(const item of planInfo.plan.segments){
        const output=path.join(folder,item.id+'.wav');
        try{const result=await synthesize({text:item.spokenText,output,config:options.config,voice:options.voice||DEFAULT_VOICE,timeout:options.timeout,env:options.env});segments.push({id:item.id,audio:path.basename(output),provider:'Ming',model:result.requestModel,voice:result.voice,transportMode:result.transportMode,source:result.source,receipt:path.basename(result.receipt)});manifest.ttsAttempts.push({id:item.id,ok:true,receipt:relative(directory,result.receipt)});await save();}
        catch(error){manifest.ttsAttempts.push({id:item.id,ok:false,receipt:error.receipt?relative(directory,error.receipt):null,errorCode:error.code});await save();throw error;}
      }
      indexFile=path.join(folder,'audio-index.json');await fs.writeFile(indexFile,JSON.stringify({schemaVersion:1,provider:'Ming',model:DEFAULT_TTS_MODEL,voice:options.voice||DEFAULT_VOICE,segments},null,2)+'\n',{flag:'wx'});
    }else if(backend==='import'){
      if(!options['audio-index'])throw new LingError('INVALID_ARGUMENT','导入配音须提供audio-index。');
      const source=path.resolve(options['audio-index']),index=await readJSON(source),folder=path.join(directory,'speech-import');
      if(index.schemaVersion!==1||!Array.isArray(index.segments))throw new LingError('INVALID_AUDIO_INDEX','audio-index格式无效。');
      const lookup=new Map(index.segments.map(item=>[item.id,item]));if(lookup.size!==index.segments.length)throw new LingError('INVALID_AUDIO_INDEX','audio-index包含重复id。');
      await fs.mkdir(folder);const segments=[];
      for(const item of planInfo.plan.segments){const entry=lookup.get(item.id);if(typeof entry?.audio!=='string')throw new LingError('INVALID_AUDIO_INDEX','audio-index缺少所需分段。');const audio=path.resolve(path.dirname(source),entry.audio);if(path.extname(audio).toLowerCase()!=='.wav')throw new LingError('INVALID_AUDIO_INDEX','导入分段须为WAV。');const destination=path.join(folder,item.id+'.wav');await fs.copyFile(audio,destination,fs.constants.COPYFILE_EXCL);segments.push({id:item.id,audio:path.basename(destination),provider:'imported-unverified',source:'user-provided-audio-index'});}
      indexFile=path.join(folder,'audio-index.json');await fs.writeFile(indexFile,JSON.stringify({schemaVersion:1,provider:'imported-unverified',segments},null,2)+'\n',{flag:'wx'});
      manifest.narrationSource={kind:'imported-unverified',sourceIndexSha256:digest(await fs.readFile(source))};
    }
    const python=options.pythonRuntime||await resolvePython();
    await execute(python.command,[...python.args,path.join(ROOT,'scripts/prepare_narration.py'),planInfo.file,'--out-dir',target,'--backend',backend==='macos'?'macos':'audio',...(backend==='macos'?['--voice',options.voice||'Tingting']:['--audio-index',indexFile])],{timeout:Math.max(180000,planInfo.plan.segments.length*60000)});
  }
  const file=path.join(target,'narration.json'),validated=await validateNarrationFiles(file,planInfo);
  manifest.narration={file:relative(directory,file),audio:relative(directory,validated.audio),subtitles:relative(directory,localAsset(target,validated.narration.subtitles,'subtitles')),provider:validated.narration.provider,model:validated.narration.model||null,voice:validated.narration.voice||null,duration:validated.narration.duration,sha256:validated.narration.sha256};manifest.thinkingPauseVerification=validated.thinkingSilence;await save();return{file,...validated};
}

export function narrationProjection(plan,narration){return{title:plan.title,topic:plan.topic,audience:plan.audience,duration:narration.duration,...(plan.teaching?{teaching:plan.teaching,thinkingPauses:narration.thinkingPauses||[]}:{}),segments:narration.segments.map(({id,text,spokenText,lines,visual,start,end,voiceStart,voiceEnd})=>({id,text,spokenText,lines,visual,start,end,voiceStart,voiceEnd}))};}

export function selectFeedbackScreenshots(report){
  const screenshots=(report.screenshots||[]).filter(name=>typeof name==='string');
  const thinking=report.samples?.find(s=>s.reasons?.some(r=>r.endsWith(':thinking-midpoint')))?.screenshot;
  const answerId=report.thinkingPauses?.[0]?.answerSegmentId;
  const answer=report.samples?.find(s=>s.expectedSegmentId===answerId&&s.reasons?.some(r=>r.endsWith(':voice-midpoint')))?.screenshot;
  const questionId=report.thinkingPauses?.[0]?.questionSegmentId;
  const questionTime=report.samples?.find(s=>s.expectedSegmentId===questionId)?.time??Infinity;
  const mainSamples=(report.samples||[]).filter(s=>s.time<questionTime&&s.reasons?.some(r=>r.endsWith(':voice-midpoint')));
  const main=mainSamples[Math.floor(mainSamples.length/3)]?.screenshot||screenshots[0];
  const preferred=thinking?[main,thinking,answer,screenshots.at(-1)]:[screenshots[0],screenshots[Math.floor(screenshots.length/3)],screenshots[Math.floor(screenshots.length*2/3)],screenshots.at(-1)];
  return [...new Set(preferred.filter(name=>screenshots.includes(name)))].slice(0,4);
}

async function verifyRound(html,narration,outDir,options){
  const result=await script('verify_film.mjs',['--html',html,'--narration',narration,'--out-dir',outDir,...(options['playwright-module']?['--playwright-module',options['playwright-module']]:[])],{timeout:100000,allowFailure:true});
  return readJSON(path.join(outDir,'verify-film.json')).catch(()=>({ok:false,issues:[{kind:'verification_process_failed',blocking:true,message:safe(result.stderr||'未生成检查报告。')}],screenshots:[]}));
}

async function preflight(options){
  const [,,pythonRuntime]=await Promise.all([runCommand('ffmpeg',['-version']),runCommand('ffprobe',['-version']),resolvePython()]);
  const runtime=await loadPlaywright(options['playwright-module']),browser=await browserExecutableStatus(runtime.chromium);
  if(!browser.available)throw new LingError('MISSING_RUNTIME','缺少Playwright Chromium，请先配置运行环境。');
  if(!options.narration){const backend=chooseTTS(options.tts);if(backend==='macos'){if(process.platform!=='darwin')throw new LingError('MISSING_RUNTIME','macos配音仅适用于macOS。');await runCommand('say',['-v','?']);}}
  return{playwrightModule:runtime.moduleEntry,chromiumAvailable:true,ffmpeg:true,ffprobe:true,python:true,pythonRuntime};
}

export async function runFilm(options){
  options={tts:'auto',maxRounds:1,timeout:300,maxTokens:12000,fps:30,...options};
  if(typeof options.prompt!=='string'||!options.prompt.trim())throw new LingError('INVALID_PROMPT','教学需求不能为空。');
  if(options.html&&(!options.plan||!options.narration))throw new LingError('INVALID_ARGUMENT','html零API复用模式须同时提供plan和narration。');
  const directory=await emptyDirectory(options.outDir),manifest={schemaVersion:1,task:'narrated-visual-film',requiredModel:MODEL,status:'running',modelGenerated:false,simulated:false,planRounds:[],rounds:[],maxFeedbackRounds:options.maxRounds,feedbackStatus:options.maxRounds?'pending':'skipped',mathStatus:'pending_host_review',listeningStatus:'pending_host_review',startedAt:new Date().toISOString(),promptSha256:digest(options.prompt)};
  let secret;
  const save=async()=>{const tmp=path.join(directory,'.film-'+randomUUID()+'.tmp');try{await fs.writeFile(tmp,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(tmp,path.join(directory,'film.json'));}finally{await fs.unlink(tmp).catch(()=>{});}};
  await save();
  try{
    if(!options.html){const config=await loadConfig({configPath:options.config||DEFAULT_CONFIG,allowTestLocalhost:options.allowTestLocalhost,env:options.env||process.env});secret=config.apiKey;manifest.transportMode=config.transportMode;manifest.simulated=config.transportMode==='test';}
    else{manifest.transportMode='imported';manifest.visualSource='imported/host-composition';manifest.feedbackStatus='skipped-imported-html';}
    manifest.runtime=await preflight(options);options.pythonRuntime=manifest.runtime.pythonRuntime;await save();
    const api={config:options.config,timeout:options.timeout,allowTestLocalhost:options.allowTestLocalhost,env:options.env||process.env};
    console.error(options.plan?'正在核对并复用现有分镜计划…':'正在生成 Ling 分镜与中文旁白计划…');const planInfo=await obtainPlan(options,directory,manifest,save,api);
    const teachingGuide=await writeTeachingGuide({plan:planInfo.plan,outDir:directory,sourcePlanSha256:digest(planInfo.bytes)});
    manifest.teaching={status:teachingGuide.status,mode:teachingGuide.mode,guide:relative(directory,teachingGuide.file),reviewStatus:planInfo.plan.teaching?'pending_host_review':'legacy_plan_without_teaching_check'};await save();
    console.error(options.narration?'正在核对并复制实测旁白时间轴…':'正在准备并实测逐段配音时间轴…');const narration=await obtainNarration(options,directory,planInfo,manifest,save);
    let selected;
    if(options.html){
      const source=path.resolve(options.html),folder=path.join(directory,'round-import');await fs.mkdir(folder);const html=path.join(folder,'lesson.html');await fs.copyFile(source,html,fs.constants.COPYFILE_EXCL);
      const sourceBytes=await fs.readFile(source),provenanceFile=path.join(path.dirname(source),'provenance.json'),provenance=await readJSON(provenanceFile).catch(()=>null);
      manifest.visualSource='imported/host-composition';manifest.importedVisual={sha256:digest(sourceBytes),authorship:'provided-html; no new model request',...(provenance?{adjacentProvenanceSha256:digest(await fs.readFile(provenanceFile)),sourceClaims:sourceClaims(provenance)}:{})};
      const report=await verifyRound(html,narration.file,path.join(folder,'check'),options);manifest.rounds.push({directory:'round-import',source:'imported/host-composition',requestPerformed:false,ok:Boolean(report.ok),report:'round-import/check/verify-film.json'});selected={html,folder,report,result:{transportMode:'imported',requestPerformed:false,source:'imported/host-composition',responseModel:null}};await save();
    }else{
    const instruction=await fs.readFile(path.join(ROOT,'assets/ling-film-generation.txt'),'utf8'),projection=narrationProjection(planInfo.plan,narration.narration);
    let request=instruction+'\n\n用户需求：\n'+options.prompt+'\n\n实测时间轴（不得改动字幕、中文旁白、分段或音频时长）：\n'+JSON.stringify(projection,null,2);
    if(options['reference-html'])request+='\n\n供借鉴且可修改的现有HTML（仍须严格遵循上方实测时间轴）：\n```html\n'+await fs.readFile(path.resolve(options['reference-html']),'utf8')+'\n```';
    const requestFile=path.join(directory,'generation-request.txt');await fs.writeFile(requestFile,request,{flag:'wx'});
    for(let round=1;round<=1+options.maxRounds;round++){
      const folder=path.join(directory,`round-0${round}`),record={directory:relative(directory,folder),receipt:relative(directory,path.join(folder,'receipt.json')),ok:false};manifest.rounds.push(record);
      let result;
      try{console.error(round===1?'正在调用 Ling 生成可视化短片画面…':'正在把真实截图与检查报告反馈给 Ling…');result=await generate({prompt:request,outDir:folder,images:round===1?[]:selected?.feedbackImages||[],...api,maxTokens:options.maxTokens});}
      catch(error){record.generationFailed=true;record.errorCode=error.code||'GENERATION_FAILED';manifest.feedbackStatus=round===2?'generation_failed':manifest.feedbackStatus;await save();if(round===2&&selected?.report.ok){manifest.warnings=(manifest.warnings||[]).concat('截图反馈生成失败，保留已通过技术检查的首版，失败回执已保留。');break;}throw error;}
      record.transportMode=result.transportMode;record.source=result.source;record.responseModel=result.responseModel;record.requestPerformed=result.requestPerformed;
      manifest.visualSource=result.transportMode==='official'?'Ling-3.2-flash':result.transportMode==='test'?'simulated':'api-unverified';
      const report=await verifyRound(result.html,narration.file,path.join(folder,'check'),options);record.report=relative(directory,path.join(folder,'check/verify-film.json'));record.ok=Boolean(report.ok);await save();
      const feedbackImages=selectFeedbackScreenshots(report).map(name=>path.join(folder,'check',name));
      const candidate={html:result.html,folder,report,result,feedbackImages};
      if(round===1||report.ok)selected=candidate;
      if(round===2){manifest.feedbackStatus=report.ok?'passed':'verification_failed';if(!report.ok&&selected.report.ok)manifest.warnings=(manifest.warnings||[]).concat('反馈修订版未通过，保留已通过技术检查的首版。');}
      if(round===1&&options.maxRounds){request=instruction+'\n\n原需求：\n'+options.prompt+'\n\n不可更改的实测字幕与旁白时间轴：\n'+JSON.stringify(projection,null,2)+'\n\n以下是上一轮真实浏览器检查报告与对应截图；技术通过不代表数学或听审通过。请检查画面、字幕、数学关系和真实问题，保留正确部分。只输出完整HTML，不声称自己运行了工具。\n'+JSON.stringify(report,null,2)+'\n\n上一轮HTML：\n```html\n'+await fs.readFile(result.html,'utf8')+'\n```';manifest.feedbackInputs={screenshots:feedbackImages.map(file=>relative(directory,file)),report:record.report};}
    }
    }
    if(!selected?.report.ok)throw new LingError('FILM_VERIFICATION_FAILED','所有画面版本均未通过字幕、时间轴或安全区检查，未渲染视频。');
    const finalHTML=path.join(directory,'film.html');await fs.copyFile(selected.html,finalHTML,fs.constants.COPYFILE_EXCL);
    manifest.selectedRound=relative(directory,selected.folder);manifest.modelGenerated=selected.result.transportMode==='official'&&selected.result.requestPerformed&&selected.result.responseModel===MODEL;manifest.simulated=selected.result.transportMode==='test';manifest.transportMode=selected.result.transportMode;manifest.html='film.html';manifest.htmlSha256=digest(await fs.readFile(finalHTML));manifest.technicalCheckPassed=true;await save();
    console.error('正在渲染带旁白与字幕的 MP4…');const video=path.join(directory,'final.mp4'),poster=path.join(directory,'poster.png');
    const rendered=await script('render_video.mjs',['--html',finalHTML,'--output',video,'--poster',poster,'--audio',narration.audio,'--duration',String(narration.narration.duration),'--fps',String(options.fps),...(options['playwright-module']?['--playwright-module',options['playwright-module']]:[])],{timeout:Math.max(900000,narration.narration.duration*30000)});
    manifest.render=JSON.parse(rendered.stdout.trim());
    const {stdout}=await runCommand('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height','-of','json',video]),media=JSON.parse(stdout),v=media.streams?.find(stream=>stream.codec_type==='video'),a=media.streams?.find(stream=>stream.codec_type==='audio'),duration=Number(media.format?.duration);
    if(v?.width!==1080||v?.height!==1920||!a||!Number.isFinite(duration)||duration+.001<narration.narration.duration||duration-narration.narration.duration>1/options.fps+.1)throw new LingError('INVALID_VIDEO','MP4尺寸、音轨或完整旁白时长未通过核对。');
    await runCommand('ffmpeg',['-v','error','-i',video,'-f','null','-'],{timeout:Math.max(120000,duration*3000)});
    manifest.video='final.mp4';manifest.poster='poster.png';manifest.subtitles=manifest.narration.subtitles;manifest.mediaVerification={width:v.width,height:v.height,videoCodec:v.codec_name,audioCodec:a.codec_name,duration,completeDecodePassed:true};manifest.status='rendered_review_pending';manifest.finishedAt=new Date().toISOString();await save();
    return{directory,video,subtitles:path.join(directory,manifest.subtitles),poster,teachingGuide:teachingGuide.file,manifest:path.join(directory,'film.json'),status:manifest.status,modelGenerated:manifest.modelGenerated,simulated:manifest.simulated,ttsProvider:manifest.narration.provider,mathStatus:manifest.mathStatus,listeningStatus:manifest.listeningStatus};
  }catch(error){manifest.status='failed';manifest.error={code:error instanceof LingError?error.code:'LOCAL_ERROR',message:safe(error.message||'任务未完成。',secret)};manifest.finishedAt=new Date().toISOString();await save();throw new LingError(manifest.error.code,manifest.error.message,{manifest:path.join(directory,'film.json')});}
}

const HELP=`一句话生成有旁白、字幕的知识可视化MP4，主创Ling-3.2-flash。\nnode scripts/film.mjs --prompt '给五年级讲清楚分数除法' --out-dir output/new-film\n可选：--prompt-file FILE；--plan plan.json；--narration narration.json；--reference-html FILE；--tts auto|macos|ming|import；--audio-index FILE；--voice NAME；--config FILE；--playwright-module PATH；--max-rounds 0|1（默认1）；--timeout 300；--max-tokens 12000；--fps 30。\n--html FILE搭配--plan和--narration为零API复用模式，只核验和渲染，标imported/host-composition及modelGenerated:false。\n默认auto在所有系统使用百灵官方Ming TTS；显式macos才使用本机say/Tingting，import使用导入音频。失败不静默更换配音服务。--narration须与plan字节hash和内容一致。\n--test-localhost仅用于显式loopback mock，输出始终标simulated。数学正确性与听审留待宿主复核。`;
export async function main(argv=process.argv.slice(2)){const options=parseArgs(argv);if(options.help){console.log(HELP);return;}if(options['prompt-file'])options.prompt=await fs.readFile(path.resolve(options['prompt-file']),'utf8').catch(()=>{throw new LingError('INVALID_PROMPT_FILE','无法读取UTF-8需求文件。');});const result=await runFilm(options);console.log(JSON.stringify(result,null,2));return result;}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({ok:false,code:error instanceof LingError?error.code:'LOCAL_ERROR',message:error instanceof LingError?error.message:'本地任务失败。',manifest:error.manifest||null},null,2));process.exitCode=1;});
