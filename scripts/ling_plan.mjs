#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {MODEL, DEFAULT_CONFIG, LingError, loadConfig, buildRequest, requestCompletion, redactSecret} from './ling_client.mjs';

export const PLAN_PROMPT = `你是服务家长和老师的小学初中知识可视化教学编导。根据用户一句话里的年级、知识点、孩子卡点和使用场景，制定能帮助孩子理解“为什么”的原创讲解计划。用户未说明时，按知识点推定合适年级并在grade中注明推定；mode默认parent，明确课堂/备课需求用teacher。先明确一个可检验的学习目标、一个具体误区、所需前置知识，再选择适龄的具体情境与连续图形操作，不硬塞无关故事。数学必须正确，单位、成立条件与近似说清楚；动画是解释载体，不是效果已经得到证明的声明。
整体长度随用户需求决定；未指定时通常按60至120秒、8至14段规划文稿，仍须3至24段。短题可更短、复杂算理可更长，不能编造实际时长。正文先呈现孩子遇到的问题，用同一对象逐步变化解释关键关系，再用一道与主例不同的题检验能否迁移。检验题必须有相邻的提问段与答案解释段：提问段只问问题、展示所需条件，不提前说或画答案；该段旁白结束后留3至15秒真正静音思考，再到下一段揭示答案和理由。questionSegmentId与answerSegmentId必须引用这两个相邻段；pauseSeconds只表示所需思考静音，实际时间轴由配音样本测量决定。
每段字幕text是画面上一句短句；spokenText是自然中文配音，所有分数、公式、运算符、希腊字母和单位都写成完整正确中文读法，例如四分之三、除以、乘以、圆周率。禁止在spokenText放1/2、÷、×、π等数学记号或朗读内部scene/id/example标签。普通独立数字可用，有歧义时改中文。每段通常10至45字，只讲当前可见变化；字幕最多约两行短句，长解释主动拆段。visual写清具体画什么、数量/比例如何变化，避免每句变一张无关PPT。不同视图中的数量不可重复加总。
同一参照量中的数值差异不能误称单位改变；真正单位换算须明确解释。结尾回收当前目标，不突然追加无关算例或未经解释的新算法。teaching中的adultTips给家长/老师2至4条可操作使用建议，引用可见动作或小节名称，勿用s08等程序段号，不放入孩子画面。check记录实际检验题、真实答案与解释，成人提示和学生答案段必须一致；不得临时编另一套题或声称已验证孩子学会、提分。结构校验不证明答案或教学效果，宿主仍需复核。
只输出一个严格JSON对象，不加Markdown或解释。schemaVersion保持1，顶层仅schemaVersion,title,topic,audience,teaching,segments。以下仅示意字段与引用，真实内容按用户任务原创，不照抄占位文字：
{"schemaVersion":1,"title":"标题","topic":"知识点","audience":"年级与受众","teaching":{"mode":"parent","grade":"年级","learningGoal":"孩子完成视频后可解释或完成的具体任务","misconception":"本次纠正的具体误区","prerequisites":["需要先会的知识"],"check":{"questionSegmentId":"s02","answerSegmentId":"s03","question":"与主例不同的具体检验题","expectedAnswer":"该题的真实答案","explanation":"答案理由","pauseSeconds":4},"adultTips":["何时暂停并听孩子解释","如何用检验题判断需要重看哪一步"]},"segments":[{"id":"s01","text":"主例短字幕","spokenText":"解释主例中的关键变化。","visual":{"scene":"自定义场景id","stage":"讲解","description":"具体可见的操作与数学关系"}},{"id":"s02","text":"检验题短字幕","spokenText":"提出具体新题，请孩子先想一想。","visual":{"scene":"自定义场景id","stage":"检验提问","description":"只展示题目与条件，保留答案空白"}},{"id":"s03","text":"答案解释短字幕","spokenText":"揭示检验题的正确答案与理由。","visual":{"scene":"自定义场景id","stage":"答案解释","description":"思考停顿后才出现答案图形"}}]}。
id唯一，依序s01、s02。segments每段仅id,text,spokenText,visual；visual.scene和stage按知识点自由设计，visual可增加有助于绘图的数字、公式与对象数据；确有两个示例时可加visual.example为A或B。不要添加duration/start/end等未经测量的时间字段。`;

const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function requireText(value, name, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max) throw new LingError('INVALID_PLAN', `计划中的${name}须为非空文本且不超过${max}字符。`);
}

export function validateSpokenText(text) {
  // Ordinary numerals (including decimals) are fine. Fractions and mathematical
  // notation need explicit readings; punctuation and ordinary hyphens stay valid.
  if (/\d\s*[/／]\s*\d|[÷×πΠ√∑∫∞≈≠≤≥=^%％+＋*＊²³⁰¹⁴⁵⁶⁷⁸⁹₀-₉½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|\d\s*[-−－]\s*\d/u.test(text)) throw new LingError('INVALID_SPOKEN_TEXT','spokenText含有可能读错的分数或数学记号，请改为完整中文读法。');
  return text;
}

export function validateTeaching(teaching, segments) {
  if (!plain(teaching) || Object.keys(teaching).some(key => !['mode','grade','learningGoal','misconception','prerequisites','check','adultTips'].includes(key))) throw new LingError('INVALID_PLAN','teaching字段与教学契约不符。');
  if (!['parent','teacher'].includes(teaching.mode)) throw new LingError('INVALID_PLAN','teaching.mode须为parent或teacher。');
  for (const field of ['grade','learningGoal','misconception']) requireText(teaching[field],`teaching.${field}`,600);
  if (!Array.isArray(teaching.prerequisites) || teaching.prerequisites.length > 6) throw new LingError('INVALID_PLAN','teaching.prerequisites须为0至6条前置知识。');
  for (const value of teaching.prerequisites) requireText(value,'teaching.prerequisites',300);
  if (!Array.isArray(teaching.adultTips) || teaching.adultTips.length < 2 || teaching.adultTips.length > 4) throw new LingError('INVALID_PLAN','teaching.adultTips须为2至4条使用建议。');
  for (const value of teaching.adultTips) requireText(value,'teaching.adultTips',600);
  const check=teaching.check;
  if (!plain(check) || Object.keys(check).some(key => !['questionSegmentId','answerSegmentId','question','expectedAnswer','explanation','pauseSeconds'].includes(key))) throw new LingError('INVALID_PLAN','teaching.check字段与教学契约不符。');
  for (const field of ['questionSegmentId','answerSegmentId','question','expectedAnswer','explanation']) requireText(check[field],`teaching.check.${field}`,1200);
  if (!Number.isFinite(check.pauseSeconds) || check.pauseSeconds < 3 || check.pauseSeconds > 15) throw new LingError('INVALID_PLAN','检验题思考静音须为3至15秒。');
  const question=segments.findIndex(segment=>segment.id===check.questionSegmentId),answer=segments.findIndex(segment=>segment.id===check.answerSegmentId);
  if (question < 0 || answer !== question+1) throw new LingError('INVALID_PLAN','检验题必须引用实际存在、提问在前且答案紧随其后的两个相邻分镜。');
  return teaching;
}

export function validatePlan(plan,{requireTeaching=false}={}) {
  if (!plain(plan) || plan.schemaVersion !== 1) throw new LingError('INVALID_PLAN', '计划schemaVersion必须为1。');
  if (Object.keys(plan).some(key => !['schemaVersion','title','topic','audience','teaching','segments'].includes(key))) throw new LingError('INVALID_PLAN','计划包含未定义的顶层字段。');
  for (const field of ['title','topic','audience']) requireText(plan[field],field,200);
  if (!Array.isArray(plan.segments) || plan.segments.length < 3 || plan.segments.length > 24) throw new LingError('INVALID_PLAN','计划须包含3至24个分镜。');
  const ids = new Set();
  for (const segment of plan.segments) {
    if (!plain(segment) || Object.keys(segment).some(key => !['id','text','spokenText','visual'].includes(key))) throw new LingError('INVALID_PLAN','分镜字段与契约不符。');
    if (typeof segment.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(segment.id) || ids.has(segment.id)) throw new LingError('INVALID_PLAN','分镜id须安全且唯一。');
    ids.add(segment.id); requireText(segment.text,'text',300); requireText(segment.spokenText,'spokenText');validateSpokenText(segment.spokenText);
    if (!plain(segment.visual)) throw new LingError('INVALID_PLAN','每个分镜须有visual对象。');
    for (const field of ['scene','stage','description']) requireText(segment.visual[field],`visual.${field}`);
    if (segment.visual.example !== undefined && !['A','B'].includes(segment.visual.example)) throw new LingError('INVALID_PLAN','visual.example提供时须为A或B。');
    if (Buffer.byteLength(JSON.stringify(segment.visual)) > 65536) throw new LingError('INVALID_PLAN','单个分镜的visual数据过大。');
  }
  if (plan.teaching !== undefined) validateTeaching(plan.teaching,plan.segments);
  else if (requireTeaching) throw new LingError('INVALID_PLAN','新生成计划须包含适龄目标、误区、思考停顿与检验题teaching字段；历史导入可明确使用兼容模式。');
  return plan;
}

export function parsePlan(content,{requireTeaching=false}={}) {
  let text = content.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  let plan;
  try { plan = JSON.parse(text); } catch { throw new LingError('INVALID_PLAN_JSON','模型最终回复不是一个完整JSON计划；原始正文已保留。'); }
  return validatePlan(plan,{requireTeaching});
}

async function reserveDirectory(outDir) {
  const directory = path.resolve(outDir);
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new LingError('OUTPUT_NOT_DIRECTORY','输出必须是普通目录。');
    if ((await fs.readdir(directory)).length) throw new LingError('OUTPUT_EXISTS','输出目录非空，拒绝覆盖。');
  } catch (error) { if (error.code === 'ENOENT') await fs.mkdir(directory,{recursive:true}); else throw error; }
  await fs.writeFile(path.join(directory,'receipt.json'),'{}\n',{flag:'wx',mode:0o600});
  return directory;
}

export async function generatePlan({prompt,outDir,config:configPath=DEFAULT_CONFIG,timeout=300,maxTokens=6000,allowTestLocalhost=false,fetchImpl=globalThis.fetch,env=process.env,requireTeaching=true}={}) {
  if (typeof prompt !== 'string' || !prompt.trim() || !outDir) throw new LingError('INVALID_ARGUMENT','必须提供prompt和outDir。');
  const directory = await reserveDirectory(outDir);
  const receipt = {schemaVersion:1,task:'video-plan',status:'starting',ok:false,requestPerformed:false,requestModel:MODEL,source:'unverified',startedAt:new Date().toISOString(),files:{plan:'plan.json',response:'response.md',receipt:'receipt.json'}};
  let config, content='';
  const saveReceipt = async () => {
    receipt.finishedAt = new Date().toISOString(); receipt.elapsedSeconds=(Date.parse(receipt.finishedAt)-Date.parse(receipt.startedAt))/1000;
    const temporary=path.join(directory,`.receipt-${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600}); await fs.rename(temporary,path.join(directory,'receipt.json')); }
    finally { await fs.unlink(temporary).catch(()=>{}); }
  };
  try {
    config=await loadConfig({configPath,env,allowTestLocalhost});
    Object.assign(receipt,{source:config.source,transportMode:config.transportMode,endpointHost:redactSecret(config.endpointHost,config.apiKey),configSource:config.configSource});
    const request=await buildRequest({prompt,thinking:'disabled',maxTokens});
    const body=JSON.parse(request.body); body.messages[0].content=PLAN_PROMPT; request.body=JSON.stringify(body);
    receipt.promptSha256=request.promptSha256;
    const result=await requestCompletion({config,request,thinking:'disabled',maxTokens,timeout,fetchImpl});
    content=result.content; Object.assign(receipt,result.metadata); receipt.requestPerformed=result.metadata.attempts>0;
    await fs.writeFile(path.join(directory,'response.md'),content,{flag:'wx'});
    const plan=parsePlan(content,{requireTeaching}), serialized=JSON.stringify(plan,null,2)+'\n';
    await fs.writeFile(path.join(directory,'plan.json'),serialized,{flag:'wx'});
    Object.assign(receipt,{ok:true,status:'completed',planSha256:hash(serialized),segmentCount:plan.segments.length,teachingStatus:plan.teaching?'structured':'legacy'});
    await saveReceipt();
    return {directory,plan:path.join(directory,'plan.json'),response:path.join(directory,'response.md'),receipt:path.join(directory,'receipt.json'),...receipt};
  } catch (error) {
    if (error.partialContent!==undefined) content=redactSecret(error.partialContent,config?.apiKey);
    if (error.metadata) { Object.assign(receipt,error.metadata); receipt.requestPerformed=error.metadata.attempts>0; }
    await fs.writeFile(path.join(directory,'response.md'),content,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    receipt.status='failed'; receipt.ok=false; receipt.error={code:error instanceof LingError?error.code:'LOCAL_ERROR',message:error.code==='TRUNCATED'?'计划输出达到长度上限，未当作完整计划。':error instanceof LingError?redactSecret(error.message,config?.apiKey):'本地计划文件处理失败。'};
    await saveReceipt(); throw new LingError(receipt.error.code,receipt.error.message,{receipt:path.join(directory,'receipt.json')});
  }
}

const HELP=`Ling-3.2-flash 视频分镜与旁白计划（输出严格JSON）。\nnode scripts/ling_plan.mjs --prompt '给五年级讲分数除法' --out-dir output/new-plan\n参数：--prompt/--prompt-file 二选一；--out-dir 新建或空目录；--config FILE；--timeout SECONDS（300）；--max-tokens N（6000）；--test-localhost 仅显式loopback测试。\n密钥从LING_API_KEY或私有配置读取，不接受明文key参数。新生成必须有teaching教学结构；历史导入由宿主兼容处理。输出plan.json / response.md / receipt.json。`;
export function parseArgs(argv) {
  const options={timeout:300,maxTokens:6000},flags=new Set(['prompt','prompt-file','out-dir','config','timeout','max-tokens']);
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i]; if(arg==='--help'||arg==='-h'){options.help=true;continue;} if(arg==='--test-localhost'){options.allowTestLocalhost=true;continue;}
    if(!arg.startsWith('--')||!flags.has(arg.slice(2)))throw new LingError('INVALID_ARGUMENT','未知参数，请使用--help查看。');
    const value=argv[++i]; if(!value||value.startsWith('--'))throw new LingError('INVALID_ARGUMENT','参数缺少值。'); options[arg.slice(2)]=value;
  }
  if(options.help)return options;
  if(Boolean(options.prompt)===Boolean(options['prompt-file'])||!options['out-dir'])throw new LingError('INVALID_ARGUMENT','须提供--out-dir及一个prompt来源。');
  options.timeout=Number(options.timeout);options.maxTokens=Number(options['max-tokens']??options.maxTokens);options.outDir=path.resolve(options['out-dir']);return options;
}
export async function main(argv=process.argv.slice(2)) {
  const options=parseArgs(argv);if(options.help){console.log(HELP);return;}
  if(options['prompt-file'])options.prompt=await fs.readFile(path.resolve(options['prompt-file']),'utf8').catch(()=>{throw new LingError('INVALID_PROMPT_FILE','无法读取UTF-8需求文件。');});
  const result=await generatePlan(options);console.log(JSON.stringify({ok:true,model:result.responseModel,source:result.source,transportMode:result.transportMode,plan:result.plan,response:result.response,receipt:result.receipt},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({ok:false,code:error instanceof LingError?error.code:'LOCAL_ERROR',message:error instanceof LingError?error.message:'本地运行失败。',receipt:error.receipt||null},null,2));process.exitCode=1;});
