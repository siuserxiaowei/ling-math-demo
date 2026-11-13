#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {generate,LingError,DEFAULT_CONFIG,checkConfiguration} from './ling_client.mjs';

const HELP=`真实调用 Ling-3.2-flash 生成离线互动HTML（不使用固定模板）。

node scripts/ling_generate.mjs --prompt '讲清楚圆的面积' --out-dir output/new-lesson
node scripts/ling_generate.mjs --prompt-file brief.txt --image diagram.png --out-dir output/new-lesson

Options:
  --prompt TEXT           一句话需求（与--prompt-file二选一）
  --prompt-file FILE      UTF-8需求文件
  --out-dir DIRECTORY    新建或空目录；不覆盖旧产物
  --image FILE           PNG/JPEG，可重复，最多4张
  --config FILE          本机密钥配置（默认 ${DEFAULT_CONFIG.replaceAll('\\','/').replace(/^.*?\/\.config\//,'~/.config/')}）
  --thinking MODE        disabled（默认快速预览）或enabled
  --max-tokens N         max_completion_tokens（默认12000）
  --timeout SECONDS      整体请求超时（默认300秒）
  --check-config         仅检查本机配置，不发网络请求，不输出密钥
  --test-localhost       显式允许配置中的HTTP loopback，仅供本地mock测试
  --help                 显示帮助，不读取密钥，不请求网络

密钥只从LING_API_KEY或本机配置读取。请勿把密钥放入命令行或聊天。
输出 lesson.html / response.md / receipt.json。保存最终正文，不保存思考内容。
`;

export function parseArgs(argv){const out={images:[],thinking:'disabled',maxTokens:12000,timeout:300};const flags=new Set(['prompt','prompt-file','out-dir','image','config','thinking','max-tokens','timeout']);for(let i=0;i<argv.length;i++){const arg=argv[i];if(arg==='--help'||arg==='-h'){out.help=true;continue;}if(arg==='--test-localhost'){out.allowTestLocalhost=true;continue;}if(arg==='--check-config'){out.checkConfig=true;continue;}if(!arg.startsWith('--')||!flags.has(arg.slice(2)))throw new LingError('INVALID_ARGUMENT','存在未知参数，请使用--help查看支持的参数。');const key=arg.slice(2),value=argv[++i];if(!value||value.startsWith('--'))throw new LingError('INVALID_ARGUMENT',`参数${arg}缺少值。`);if(key==='image')out.images.push(path.resolve(value));else out[key]=value;}if(out.help||out.checkConfig)return out;if(Boolean(out.prompt)===Boolean(out['prompt-file'])||!out['out-dir'])throw new LingError('INVALID_ARGUMENT','必须指定--out-dir，并在--prompt和--prompt-file中选择一个。');if(out.images.length>4)throw new LingError('TOO_MANY_IMAGES','最多4张图片。');if(!['enabled','disabled'].includes(out.thinking))throw new LingError('INVALID_THINKING','thinking必须为enabled或disabled。');out.maxTokens=Number(out['max-tokens']??out.maxTokens);out.timeout=Number(out.timeout);out.outDir=path.resolve(out['out-dir']);return out;}

export async function main(argv=process.argv.slice(2)){const options=parseArgs(argv);if(options.help){console.log(HELP);return;}if(options.checkConfig){console.log(JSON.stringify(await checkConfiguration({configPath:options.config,allowTestLocalhost:options.allowTestLocalhost}),null,2));return;}if(options['prompt-file'])options.prompt=await fs.readFile(path.resolve(options['prompt-file']),'utf8').catch(()=>{throw new LingError('INVALID_PROMPT_FILE','无法读取指定的UTF-8需求文件。');});const result=await generate({prompt:options.prompt,images:options.images,outDir:options.outDir,thinking:options.thinking,maxTokens:options.maxTokens,timeout:options.timeout,config:options.config,allowTestLocalhost:options.allowTestLocalhost});console.log(JSON.stringify({ok:true,model:result.responseModel,source:result.source,transportMode:result.transportMode,endpointHost:result.endpointHost,html:result.html,response:result.response,receipt:result.receipt,usage:result.usage},null,2));}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){main().catch(error=>{console.error(JSON.stringify({ok:false,code:error instanceof LingError?error.code:'LOCAL_ERROR',message:error instanceof LingError?error.message:'本地运行失败。',receipt:error.receipt||null},null,2));process.exitCode=1;});}
