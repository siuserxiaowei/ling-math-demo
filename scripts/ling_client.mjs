import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export const MODEL = 'Ling-3.2-flash';
export const DEFAULT_BASE_URL = 'https://api.ant-ling.com/v1';
export const DEFAULT_CONFIG = path.join(os.homedir(), '.config', 'ling-math-demo', 'ling.json');
const BODY_LIMIT = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
const sha256 = value => createHash('sha256').update(value).digest('hex');

export class LingError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'LingError'; this.code = code; Object.assign(this, details); }
}

// Official contracts checked 2026-11-08:
// https://developer.ant-ling.com/zh-CN/docs/api-reference/chat/openai
// https://developer.ant-ling.com/en/docs/tutorials/multimodal-understanding/
// The multimodal example documents max_completion_tokens. We send that field only.
export const SYSTEM_PROMPT = `你是小学初中数学可视化课件工程师。根据用户的一句话生成对应知识点的原创互动演示，不能只换固定模板的标题。先保证数学关系、单位和适用条件正确，再设计直观的变化过程。
输出一个完整的单文件HTML代码块。CSS、JavaScript、SVG全部内联；无CDN、外部字体、图片、网络请求或遥测。中文界面，暖白纸张、青绿与杏橙配色，图形为主。390px手机宽度和桌面均可操作，控件有可访问名称；提供播放/暂停、重置、进度和对理解有帮助的参数。解释与图形、数值始终同步。数学逼近不能写成精确相等，图形不能靠拉伸伪造等积。
用同一个确定性时间函数驱动播放和导出。实现window.lesson.duration（完整讲解秒数，通常30至60秒）、window.lesson.setTime(seconds)（同步渲染，支持任意前后跳转）、window.lesson.inspect()（返回实际驱动画面的time、stage、topic和数学数据）。用?video=1隐藏按钮并适配1080×1920竖屏，保留标题、主图、关键标注和当前一句解释。不要依赖真实经过时间或随机数。图形布局与说明文字不可遮挡或出画布。
若无法实际运行浏览器，不要声称已运行或已验证。不要生成营销文案、其他产品logo、伪造测试记录或API密钥。`;

export function endpointFor(baseURL = DEFAULT_BASE_URL, {allowTestLocalhost = false, explicit = false} = {}) {
  let url;
  try { url = new URL(baseURL); } catch { throw new LingError('INVALID_ENDPOINT', 'base_url不是有效URL。'); }
  if (url.username || url.password || url.search || url.hash) throw new LingError('INVALID_ENDPOINT', 'base_url不能包含凭据、查询参数或片段。');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowTestLocalhost && loopback && url.protocol === 'http:')) throw new LingError('INSECURE_ENDPOINT', 'API必须使用HTTPS；HTTP仅允许显式开启的本地测试。');
  if (url.origin !== 'https://api.ant-ling.com' && !explicit && !(allowTestLocalhost && loopback)) throw new LingError('ENDPOINT_NOT_AUTHORIZED', '非官方API地址必须由用户在配置文件中明确设置。');
  if (allowTestLocalhost && !loopback) throw new LingError('INVALID_TEST_ENDPOINT', '本地测试开关只能用于loopback地址。');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions';
  const source=allowTestLocalhost && loopback ? 'local-mock' : url.origin === 'https://api.ant-ling.com' ? 'official-api' : 'explicitly-configured-api';
  return {url: url.href, baseURL: url.href.replace(/\/chat\/completions$/, ''), endpointHost:url.host, source, transportMode:source==='local-mock'?'test':source==='official-api'?'official':'custom_https'};
}

export async function loadConfig({configPath = DEFAULT_CONFIG, env = process.env, allowTestLocalhost = false} = {}) {
  let file = {};
  try {
    const data = await fs.readFile(path.resolve(configPath), 'utf8');
    file = JSON.parse(data);
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('object required');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new LingError('INVALID_CONFIG', '无法读取Ling配置；请检查JSON格式和文件权限。');
  }
  if (file.model && file.model !== MODEL) throw new LingError('MODEL_MISMATCH', `配置中的模型必须是${MODEL}。`);
  const apiKey = String(env.LING_API_KEY || file.api_key || '').trim();
  if (!apiKey) throw new LingError('MISSING_API_KEY', '未配置LING_API_KEY。请在本机终端运行configure_ling.py，勿把密钥发到聊天。');
  if (/[\r\n\x00]/.test(apiKey)) throw new LingError('INVALID_API_KEY', 'API密钥不能包含换行或控制字符。');
  const endpoint = endpointFor(file.base_url || DEFAULT_BASE_URL, {allowTestLocalhost, explicit: Object.hasOwn(file, 'base_url')});
  return {apiKey, ...endpoint, configSource: env.LING_API_KEY ? 'environment' : 'file'};
}


/** Report configuration readiness without making a request or exposing the key. */
export async function checkConfiguration(options={}) {
  try { const config=await loadConfig(options);return {configured:true,model:MODEL,baseURL:redactSecret(config.baseURL,config.apiKey),endpointHost:redactSecret(config.endpointHost,config.apiKey),transportMode:config.transportMode,configSource:config.configSource,missing:[],networkRequested:false}; }
  catch(error){return {configured:false,model:MODEL,baseURL:DEFAULT_BASE_URL,missing:error.code==='MISSING_API_KEY'?['api_key']:['valid_configuration'],error:{code:error instanceof LingError?error.code:'INVALID_CONFIG',message:error instanceof LingError?error.message:'本机配置无法读取。'},networkRequested:false};}
}

export async function imageContent(filePath) {
  const bytes = await fs.readFile(filePath).catch(() => { throw new LingError('INVALID_IMAGE', '无法读取指定图片。'); });
  let mime;
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) mime = 'image/png';
  else if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else throw new LingError('INVALID_IMAGE', '图片须为实际PNG或JPEG文件。');
  if (bytes.length > 24 * 1024 * 1024) throw new LingError('REQUEST_TOO_LARGE', '图片过大，编码后的总请求必须小于32MiB。');
  return {block: {type:'image_url', image_url:{url:`data:${mime};base64,${bytes.toString('base64')}`}}, metadata:{mime, bytes:bytes.length, sha256:sha256(bytes)}};
}

export async function buildRequest({prompt, images = [], thinking = 'disabled', maxTokens = 12000, systemPrompt = SYSTEM_PROMPT, imageLimit = 4, media = []}) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new LingError('INVALID_PROMPT', 'prompt不能为空。');
  if (!['enabled', 'disabled'].includes(thinking)) throw new LingError('INVALID_THINKING', 'thinking必须为enabled或disabled。');
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 131072) throw new LingError('INVALID_TOKEN_LIMIT', 'max-tokens须为256至131072的整数。');
  if (!Array.isArray(images) || images.length > imageLimit) throw new LingError('TOO_MANY_IMAGES', `最多支持${imageLimit}张PNG/JPEG图片。`);
  const encoded = await Promise.all(images.map(imageContent));
  const content = [{type:'text', text:prompt.trim()}, ...encoded.map(item => item.block), ...media];
  const body = {model:MODEL, stream:true, thinking:{type:thinking}, max_completion_tokens:maxTokens, messages:[{role:'system',content:systemPrompt},{role:'user',content}]};
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > BODY_LIMIT) throw new LingError('REQUEST_TOO_LARGE', '编码后的请求超过32MiB，请减少图片尺寸或数量。');
  return {body:serialized, imageMetadata:encoded.map(item => item.metadata), promptSha256:sha256(prompt.trim())};
}

/** Parse SSE across arbitrary UTF-8 byte chunks, CRLF, and multiline data. */
export async function* readSSE(body) {
  if (!body) throw new LingError('EMPTY_STREAM', 'API没有返回响应流。');
  const decoder = new TextDecoder();
  let pending = '', data = [], event = '';
  function line(raw) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!text) { const output = data.length ? {event, data:data.join('\n')} : null; data=[]; event=''; return output; }
    if (text.startsWith(':')) return null;
    const colon = text.indexOf(':'), field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value); else if (field === 'event') event=value;
    return null;
  }
  for await (const bytes of body) {
    pending += decoder.decode(bytes, {stream:true});
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) { const output=line(pending.slice(0,newline)); pending=pending.slice(newline+1); if(output) yield output; }
  }
  pending += decoder.decode();
  if (pending) { const output = line(pending); if (output) yield output; }
  const output = line(''); if (output) yield output;
}

function safeIdentifier(value, secret) {
  return typeof value === 'string' && !(secret && value.includes(secret)) && /^[A-Za-z0-9._:\/-]{1,240}$/.test(value) ? value : null;
}
function usageFields(value) {
  if (!value || typeof value !== 'object') return null;
  const out={}; for(const key of ['prompt_tokens','completion_tokens','total_tokens']) if(Number.isFinite(value[key]) && value[key] >= 0) out[key]=value[key];
  return Object.keys(out).length ? out : null;
}
export function redactSecret(content, secret) { return secret ? String(content).split(secret).join('[REDACTED_API_KEY]') : String(content); }

export async function requestCompletion({config, request, thinking = 'disabled', maxTokens = 12000, timeout = 300, fetchImpl = globalThis.fetch}) {
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600) throw new LingError('INVALID_TIMEOUT', 'timeout须为0至3600秒。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  const metadata = {requestModel:MODEL, responseModel:null, requestId:null, usage:null, finishReason:null, attempts:0, source:fetchImpl === globalThis.fetch ? config.source : 'test-injected-fetch', transportMode:fetchImpl===globalThis.fetch?config.transportMode:'test', thinking, maxCompletionTokens:maxTokens};
  let content = '';
  const fail = (code, message, details={}) => new LingError(code, message, {...details, partialContent:redactSecret(content,config.apiKey), metadata:{...metadata}});
  const consume = packet => {
    if (packet?.error) throw fail('PROVIDER_ERROR','API返回了错误；未保存可能包含敏感信息的错误正文。');
    if (packet?.model) {
      metadata.responseModel = safeIdentifier(packet.model,config.apiKey);
      if (packet.model !== MODEL) throw fail('MODEL_MISMATCH',`API响应模型与请求的${MODEL}不一致。`);
    }
    if (packet?.id) metadata.requestId=safeIdentifier(packet.id,config.apiKey);
    if (packet?.usage) { metadata.usage=usageFields(packet.usage); metadata.usageRaw=JSON.parse(redactSecret(JSON.stringify(packet.usage),config.apiKey)); }
    const choice=packet?.choices?.find(c=>c.index===0) || packet?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta?.content ?? choice.message?.content;
    if(typeof delta==='string')content += delta;
    // reasoning_content, tool arguments, and other fields never enter content or receipts.
    if(choice.finish_reason) metadata.finishReason=['stop','length','tool_calls','content_filter','function_call'].includes(choice.finish_reason)?choice.finish_reason:'unrecognized';
  };
  try {
    for (let attempt=0; attempt<2; attempt++) {
      metadata.attempts++;
      try {
        const response = await fetchImpl(config.url,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json',Accept:'text/event-stream'},body:request.body,signal:controller.signal});
        if (!response.ok) {
          const status=response.status;
          // Do not consume or persist arbitrary error bodies (they may echo credentials).
          await response.body?.cancel().catch(()=>{});
          if ([502,503,504].includes(status) && attempt===0 && !controller.signal.aborted) continue;
          const code=status===401||status===403?'AUTH_FAILED':status===429?'RATE_LIMITED':'HTTP_ERROR';
          throw fail(code,`${code === 'AUTH_FAILED' ? 'API认证失败，请检查本机密钥' : code === 'RATE_LIMITED' ? 'API限流，已停止本次请求' : 'API请求失败'}（HTTP ${status}）。`,{status});
        }
        metadata.requestId=safeIdentifier(response.headers.get('x-request-id'),config.apiKey);
        if ((response.headers.get('content-type')||'').includes('application/json')) { let packet;try{packet=await response.json();}catch{throw fail('INVALID_STREAM','API返回了不可解析的JSON。');}consume(packet); }
        else {
          for await (const event of readSSE(response.body)) {
            if(event.data.trim()==='[DONE]')break;
            if(event.event==='error')throw fail('PROVIDER_ERROR','API流返回错误事件。');
            let packet;try{packet=JSON.parse(event.data);}catch{throw fail('INVALID_STREAM','API流包含不可解析的数据，未当作完整结果。');}
            consume(packet);
          }
        }
        break;
      } catch (error) {
        if(error instanceof LingError)throw error;
        if(controller.signal.aborted)throw fail('TIMEOUT','API生成超时，未将未完成结果标为成功。');
        if(attempt===0&&!content)continue;
        throw fail('NETWORK_ERROR','API连接失败；已停止本次请求。');
      }
    }
    if(metadata.responseModel!==MODEL)throw fail('MODEL_UNVERIFIED','响应缺少可核验的模型名称。');
    if(metadata.finishReason==='length')throw fail('TRUNCATED','模型输出达到长度上限，未当作完整HTML。');
    if(metadata.finishReason!=='stop')throw fail('INCOMPLETE_RESPONSE','API未确认正常结束，未当作完整结果。');
    if(!content.trim())throw fail('EMPTY_RESPONSE','模型没有返回最终正文。');
    return {content:redactSecret(content,config.apiKey),metadata};
  } finally { clearTimeout(timer); }
}

export function extractHTML(content) {
  const candidates=[];
  const complete = text => /^(?:<!doctype\s+html\b[^>]*>\s*)?<html\b/i.test(text.trim()) && /<\/html\s*>\s*$/i.test(text.trim());
  const pattern=/^```(?:html|htm)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gim;
  for(const match of content.matchAll(pattern))if(complete(match[1]))candidates.push(match[1].trim());
  if(!candidates.length){const raw=content.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm,'');const start=raw.search(/<!doctype\s+html\b|<html\b/i);if(start>=0){const tail=raw.slice(start),end=[...tail.matchAll(/<\/html\s*>/gi)].at(-1);if(end){const html=tail.slice(0,end.index+end[0].length).trim();if(complete(html))candidates.push(html);}}}
  if(!candidates.length)throw new LingError('NO_COMPLETE_HTML','最终回复中没有以</html>完整结束的HTML；原始正文已保留。');
  return candidates.sort((a,b)=>b.length-a.length)[0]+'\n';
}

async function prepareDirectory(outDir) {
  const absolute=path.resolve(outDir);
  try { const info=await fs.lstat(absolute);if(!info.isDirectory()||info.isSymbolicLink())throw new LingError('OUTPUT_NOT_DIRECTORY','输出必须是普通目录，不能是符号链接。');if((await fs.readdir(absolute)).length)throw new LingError('OUTPUT_EXISTS','输出目录非空，拒绝覆盖已有产物。'); }
  catch(error){if(error.code==='ENOENT')await fs.mkdir(absolute,{recursive:true});else throw error;}
  await fs.writeFile(path.join(absolute,'receipt.json'),'{}\n',{flag:'wx',mode:0o600});
  return absolute;
}

/** Public reusable entry point. No browser, SDK, shell, or remote tool execution. */
export async function generate({prompt,images=[],outDir,thinking='disabled',maxTokens=12000,timeout=300,config:configPath=DEFAULT_CONFIG,allowTestLocalhost=false,fetchImpl=globalThis.fetch,env=process.env}={}) {
  if(!outDir||typeof prompt!=='string'||!prompt.trim())throw new LingError('INVALID_ARGUMENT','必须提供prompt和outDir。');
  const directory=await prepareDirectory(outDir),receipt={schemaVersion:1,status:'starting',ok:false,requestPerformed:false,requestModel:MODEL,startedAt:new Date().toISOString(),source:allowTestLocalhost?'local-mock':'unverified',files:{response:'response.md',html:'lesson.html',receipt:'receipt.json'}};
  let config,content='';
  const saveReceipt=async()=>{receipt.finishedAt=new Date().toISOString();receipt.elapsedSeconds=(Date.parse(receipt.finishedAt)-Date.parse(receipt.startedAt))/1000;const temporary=path.join(directory,`.receipt-${randomUUID()}.tmp`);try{await fs.writeFile(temporary,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temporary,path.join(directory,'receipt.json'));}finally{await fs.unlink(temporary).catch(()=>{});}};
  try{
    config=await loadConfig({configPath,env,allowTestLocalhost});
    receipt.source=config.source;receipt.transportMode=config.transportMode;receipt.configSource=config.configSource;receipt.endpoint=redactSecret(config.baseURL,config.apiKey);receipt.endpointHost=redactSecret(config.endpointHost,config.apiKey);
    const request=await buildRequest({prompt,images,thinking,maxTokens});
    receipt.promptSha256=request.promptSha256;receipt.images=request.imageMetadata;receipt.thinking=thinking;receipt.maxCompletionTokens=maxTokens;
    const result=await requestCompletion({config,request,thinking,maxTokens,timeout,fetchImpl});
    content=result.content;Object.assign(receipt,result.metadata);receipt.requestPerformed=result.metadata.attempts>0;
    await fs.writeFile(path.join(directory,'response.md'),content,{flag:'wx'});
    const html=extractHTML(content);await fs.writeFile(path.join(directory,'lesson.html'),html,{flag:'wx'});
    receipt.status='completed';receipt.ok=true;receipt.htmlSha256=sha256(html);receipt.contentCharacters=content.length;
    await saveReceipt();
    return {directory,html:path.join(directory,'lesson.html'),response:path.join(directory,'response.md'),receipt:path.join(directory,'receipt.json'),...receipt};
  }catch(error){
    if(error.partialContent!==undefined)content=redactSecret(error.partialContent,config?.apiKey);
    if(error.metadata){Object.assign(receipt,error.metadata);receipt.requestPerformed=error.metadata.attempts>0;}
    if(content){await fs.writeFile(path.join(directory,'response.md'),content,{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});}
    receipt.status='failed';receipt.ok=false;receipt.error={code:error instanceof LingError?error.code:'LOCAL_ERROR',message:error instanceof LingError?redactSecret(error.message,config?.apiKey):'本地文件或运行依赖处理失败。'};
    await saveReceipt();
    throw new LingError(receipt.error.code,receipt.error.message,{receipt:path.join(directory,'receipt.json')});
  }
}
