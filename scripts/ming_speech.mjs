#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {DEFAULT_CONFIG,LingError,loadConfig,readSSE,redactSecret} from './ling_client.mjs';

// Live official page rechecked 2026-11-08 (updated 2026-11-05); cached search
// results still show the older Ming-3.0-tts identifier. Never silently switch.
// https://developer.ant-ling.com/zh-CN/docs/api-reference/audio/tts/
// Voice list linked by that page: inclusionAI/Ming-3.0-tts, instruction_en.md.
export const DEFAULT_TTS_MODEL='Ming-3.0-tts-0.5B';
// UK_Charlotte is the official API example and a live verified voice. Other
// documented voice ids remain explicit choices; do not silently switch voices.
export const DEFAULT_VOICE='UK_Charlotte';
export const PCM_SAMPLE_RATE=44100;
export const SPEECH_URL='https://api.ant-ling.com/v1/audio/speech';
const MAX_AUDIO_BYTES=64*1024*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
function identifier(value,secret){return typeof value==='string'&&!(secret&&value.includes(secret))&&/^[A-Za-z0-9._:\/-]{1,240}$/.test(value)?value:null;}
function usage(value){const out={};for(const key of ['prompt_tokens','completion_tokens','total_tokens'])if(Number.isFinite(value?.[key])&&value[key]>=0)out[key]=value[key];return Object.keys(out).length?out:null;}
function safeDetail(value,secret){return redactSecret(String(value),secret).replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]').replace(/data:[^,\s]+;base64,[A-Za-z0-9+/=]+/gi,'[REDACTED_AUDIO]').slice(0,500);}
function mp3Frame(bytes,offset){
  if(offset+4>bytes.length||bytes[offset]!==255||(bytes[offset+1]&224)!==224)return null;
  const h=bytes.readUInt32BE(offset),version=(h>>>19)&3,layer=(h>>>17)&3,bitrateIndex=(h>>>12)&15,sampleIndex=(h>>>10)&3,padding=(h>>>9)&1;
  if(version===1||layer===0||bitrateIndex===0||bitrateIndex===15||sampleIndex===3||(h&3)===2)return null;
  const high=version===3;
  const rates=high?{3:[32,64,96,128,160,192,224,256,288,320,352,384,416,448],2:[32,48,56,64,80,96,112,128,160,192,224,256,320,384],1:[32,40,48,56,64,80,96,112,128,160,192,224,256,320]}:{3:[32,48,56,64,80,96,112,128,144,160,176,192,224,256],2:[8,16,24,32,40,48,56,64,80,96,112,128,144,160],1:[8,16,24,32,40,48,56,64,80,96,112,128,144,160]};
  const sampleRate=[44100,48000,32000][sampleIndex]/(high?1:version===2?2:4),bitrate=rates[layer][bitrateIndex-1]*1000;
  const length=layer===3?(Math.floor(12*bitrate/sampleRate)+padding)*4:Math.floor((layer===1&&!high?72:144)*bitrate/sampleRate)+padding;
  if(offset+length>bytes.length)return null;
  return{version,layer,sampleRate,length};
}
function hasMP3Frames(bytes){
  let offset=0;
  if(bytes.toString('ascii',0,3)==='ID3'){
    if(bytes.length<10||![2,3,4].includes(bytes[3])||bytes[4]===255||[6,7,8,9].some(i=>bytes[i]&128))return false;
    const reserved=bytes[3]===2?63:bytes[3]===3?31:15;if(bytes[5]&reserved)return false;
    const size=(bytes[6]<<21)|(bytes[7]<<14)|(bytes[8]<<7)|bytes[9];
    offset=10+size+(bytes[3]===4&&(bytes[5]&16)?10:0);
  }
  const first=mp3Frame(bytes,offset);if(!first)return false;
  const second=mp3Frame(bytes,offset+first.length);
  return Boolean(second&&second.version===first.version&&second.layer===first.layer&&second.sampleRate===first.sampleRate);
}
function completeSSE(text){
  if(!/\r?\n\r?\n$/.test(text))return false;
  let packets=0;
  for(const block of text.split(/\r?\n\r?\n/)){
    if(!block.trim())continue;const data=[];
    for(const line of block.split(/\r?\n/)){
      if(line.startsWith(':'))continue;
      const match=/^(data|event|id|retry): ?(.*)$/.exec(line);if(!match)return false;
      if(match[1]==='data')data.push(match[2]);
    }
    if(!data.length)continue;
    let packet;try{packet=JSON.parse(data.join('\n'));}catch{return false;}
    if(!packet||typeof packet!=='object'||!['speech.audio.delta','speech.audio.done','error'].includes(packet.type))return false;
    packets++;
  }
  return packets>0;
}
export function classifyResponse(bytes){
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE')return'RIFF';
  // Raw signed PCM naturally starts with FF FF / FF FB for some negative
  // samples. A two-byte sync word (or an ID3 prefix) cannot identify MP3.
  if(hasMP3Frames(bytes))return'MP3';
  if(bytes.length<=65536){
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return'unknown';}
    try{const value=JSON.parse(text);if(value&&typeof value==='object')return'JSON';}catch{}
    if(completeSSE(text))return'SSE';
  }
  return'unknown';
}
function providerError(bytes,secret){
  if(bytes.length>65536)return null;
  try{const packet=JSON.parse(bytes.toString('utf8')),info=packet?.error??packet;if(!info||typeof info!=='object')return null;const error={};if(['string','number'].includes(typeof info.code))error.code=safeDetail(info.code,secret);if(typeof info.message==='string')error.message=safeDetail(info.message,secret);return Object.keys(error).length?error:null;}catch{return null;}
}

// OpenAI-compatible raw PCM is signed little-endian 16-bit mono. The Ant
// documentation defaults to 44100 Hz when sample_rate is omitted. We preserve
// every received sample and add only a WAV container, never empty/fake audio.
export function pcmToWav(pcm,sampleRate=PCM_SAMPLE_RATE){
  if(!Buffer.isBuffer(pcm)||!pcm.length)throw new LingError('EMPTY_AUDIO','没有可封装的PCM音频数据。');
  if(pcm.length%2!==0)throw new LingError('TRUNCATED_PCM','PCM采样数据未按16位对齐。');
  if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>48000)throw new LingError('INVALID_SAMPLE_RATE','PCM采样率必须为8000至48000的整数。');
  const bytes=Buffer.alloc(44+pcm.length);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(sampleRate,24);bytes.writeUInt32LE(sampleRate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(pcm.length,40);pcm.copy(bytes,44);return bytes;
}

export function inspectWav(bytes){
  if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw new LingError('INVALID_WAV','TTS没有返回有效WAV音频。');
  const end=bytes.readUInt32LE(4)+8;
  if(end>bytes.length||end<44)throw new LingError('TRUNCATED_WAV','WAV长度不完整。');
  let format, dataBytes=0, offset=12;
  while(offset+8<=end){
    const tag=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8;
    if(start+size>end)throw new LingError('TRUNCATED_WAV','WAV数据块不完整。');
    if(tag==='fmt '){if(size<16)throw new LingError('INVALID_WAV','WAV格式块无效。');format={encoding:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),sampleRate:bytes.readUInt32LE(start+4),byteRate:bytes.readUInt32LE(start+8),blockAlign:bytes.readUInt16LE(start+12),bitsPerSample:bytes.readUInt16LE(start+14)};}
    if(tag==='data')dataBytes+=size;
    offset=start+size+(size%2);
  }
  if(!format||!format.channels||!format.sampleRate||!format.byteRate||!format.blockAlign||!dataBytes)throw new LingError('EMPTY_AUDIO','WAV缺少格式或有效声音数据。');
  if([1,3].includes(format.encoding)&&dataBytes%format.blockAlign!==0)throw new LingError('TRUNCATED_WAV','WAV采样数据未对齐。');
  return {...format,dataBytes,durationSeconds:[1,3].includes(format.encoding)?dataBytes/format.byteRate:null};
}

async function reserveOutputs({output,outDir}){
  if(Boolean(output)===Boolean(outDir))throw new LingError('INVALID_ARGUMENT','须在output与outDir中选择一个。');
  let audio,receipt;
  if(outDir){
    const directory=path.resolve(outDir);
    try{const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new LingError('OUTPUT_NOT_DIRECTORY','输出必须是普通目录。');if((await fs.readdir(directory)).length)throw new LingError('OUTPUT_EXISTS','输出目录非空，拒绝覆盖。');}
    catch(error){if(error.code==='ENOENT')await fs.mkdir(directory,{recursive:true});else throw error;}
    audio=path.join(directory,'speech.wav');receipt=path.join(directory,'receipt.json');
  }else{
    audio=path.resolve(output);if(path.extname(audio).toLowerCase()!=='.wav')throw new LingError('INVALID_ARGUMENT','output文件须以.wav结尾。');
    receipt=audio.slice(0,-4)+'.receipt.json';await fs.mkdir(path.dirname(audio),{recursive:true});
  }
  const rawAudio=audio.slice(0,-4)+'.response.bin';
  for(const file of [audio,receipt,rawAudio]){try{await fs.lstat(file);throw new LingError('OUTPUT_EXISTS','音频或receipt已存在，拒绝覆盖。');}catch(error){if(error.code!=='ENOENT')throw error;}}
  await fs.writeFile(receipt,'{}\n',{flag:'wx',mode:0o600});return{audio,receipt,rawAudio};
}

/** A separate Ming TTS request. Ling remains the video/lesson author. */
export async function synthesize({text,output,outDir,config:configPath=DEFAULT_CONFIG,voice=DEFAULT_VOICE,model=DEFAULT_TTS_MODEL,speed=1,timeout=300,fetchImpl=globalThis.fetch,env=process.env}={}){
  if(typeof text!=='string'||!text.trim()||Array.from(text).length>2048)throw new LingError('INVALID_TEXT','每次配音须为1至2048字符的非空文本。');
  if(typeof model!=='string'||!/^Ming-[A-Za-z0-9._-]{1,100}$/.test(model))throw new LingError('INVALID_MODEL','须明确使用Ming TTS模型标识。');
  if(typeof voice!=='string'||!voice.trim()||Array.from(voice).length>120||/[\r\n\x00]/.test(voice))throw new LingError('INVALID_VOICE','voice须为有效系统音色标识。');
  if(!Number.isFinite(speed)||speed<0.25||speed>4)throw new LingError('INVALID_SPEED','speed须为0.25至4。');
  if(!Number.isFinite(timeout)||timeout<=0||timeout>3600)throw new LingError('INVALID_TIMEOUT','timeout须为0至3600秒。');
  const files=await reserveOutputs({output,outDir});
  const receipt={schemaVersion:1,task:'speech',provider:'Ming',status:'starting',ok:false,requestModel:null,responseModel:null,modelVerified:false,voice:null,speed,responseFormat:'pcm',storedFormat:'wav',streamFormat:'sse',requestedSampleRate:null,pcmInterpretation:{encoding:'pcm_s16le',channels:1,bitsPerSample:16,sampleRate:PCM_SAMPLE_RATE,sampleRateSource:'official-api documented default; sample_rate omitted'},endpointHost:'api.ant-ling.com',requestPerformed:false,attempts:0,source:'unverified',startedAt:new Date().toISOString(),textSha256:hash(text),textCharacters:Array.from(text).length,usage:null};
  let config,timer,audioBytes=0;
  const saveReceipt=async()=>{receipt.finishedAt=new Date().toISOString();receipt.elapsedSeconds=(Date.parse(receipt.finishedAt)-Date.parse(receipt.startedAt))/1000;const temporary=files.receipt+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temporary,files.receipt);}finally{await fs.unlink(temporary).catch(()=>{});}};
  try{
    config=await loadConfig({configPath,env});
    receipt.voice=redactSecret(voice,config.apiKey);receipt.requestModel=redactSecret(model,config.apiKey);
    if(config.transportMode!=='official')throw new LingError('TTS_KEY_SCOPE','Ling配置并非官方API，不能把其令牌发送给Ant语音端点。请使用官方私有配置。');
    Object.assign(receipt,{configSource:config.configSource,source:fetchImpl===globalThis.fetch?'official-ming-api':'test-injected-fetch',transportMode:fetchImpl===globalThis.fetch?'official':'test',voice:redactSecret(voice,config.apiKey),requestModel:redactSecret(model,config.apiKey)});
    const controller=new AbortController();timer=setTimeout(()=>controller.abort(),timeout*1000);
    let bytes;
    for(let attempt=0;attempt<2;attempt++){
      receipt.attempts++;receipt.requestPerformed=true;
      try{
        const response=await fetchImpl(SPEECH_URL,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json',Accept:'text/event-stream, audio/pcm, audio/wav'},body:JSON.stringify({model,input:text,voice,response_format:'pcm',stream_format:'sse',...(speed===1?{}:{speed})}),signal:controller.signal});
        receipt.httpStatus=response.status;receipt.mime=safeDetail(response.headers.get('content-type')||'',config.apiKey);receipt.responseBytes=null;receipt.responseClassification='unknown';
        if(!response.ok){const status=response.status;await response.body?.cancel().catch(()=>{});if([502,503,504].includes(status)&&attempt===0&&!controller.signal.aborted)continue;throw new LingError(status===401||status===403?'AUTH_FAILED':status===429?'RATE_LIMITED':'HTTP_ERROR',`Ming语音请求失败（HTTP ${status}），已停止。`);}
        receipt.requestId=identifier(response.headers.get('x-request-id'),config.apiKey);
        const chunks=[],append=chunk=>{audioBytes+=chunk.length;if(audioBytes>MAX_AUDIO_BYTES)throw new LingError('AUDIO_TOO_LARGE','语音响应超过64MiB，已停止。');chunks.push(chunk);};
        const contentType=response.headers.get('content-type')||'';
        if(contentType.includes('text/event-stream')){
          receipt.responseBytes=0;receipt.responseClassification='SSE';receipt.sse={eventCount:0,audioDeltaCount:0,completed:false};
          const observedBody=async function*(){if(response.body)for await(const chunk of response.body){receipt.responseBytes+=chunk.length;yield chunk;}};
          let done=false;
          for await(const event of readSSE(observedBody())){
            receipt.sse.eventCount++;
            if(event.event==='error')throw new LingError('TTS_PROVIDER_ERROR','Ming语音流返回错误。');
            let packet;try{packet=JSON.parse(event.data);}catch{throw new LingError('INVALID_TTS_STREAM','Ming语音流不是有效JSON。');}
            if(packet.error||packet.type==='error')throw new LingError('TTS_PROVIDER_ERROR','Ming语音流返回错误。');
            if(packet.model){if(packet.model!==model)throw new LingError('MODEL_MISMATCH','Ming响应模型与请求不一致。');receipt.responseModel=model;receipt.modelVerified=true;}
            if(packet.type==='speech.audio.delta'){
              receipt.sse.audioDeltaCount++;
              if(typeof packet.audio!=='string'||!packet.audio.length||packet.audio.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(packet.audio))throw new LingError('INVALID_TTS_STREAM','语音片段不是有效Base64。');
              append(Buffer.from(packet.audio,'base64'));
            }else if(packet.type==='speech.audio.done'){receipt.usage=usage(packet.usage);done=true;receipt.sse.completed=true;break;}
          }
          if(!done)throw new LingError('INCOMPLETE_AUDIO','Ming语音流缺少完成事件。');
        }else{
          if(!/^audio\/(?:wav|x-wav|wave|pcm)(?:;|$)/i.test(contentType))throw new LingError('INVALID_TTS_FORMAT','Ming响应不是PCM或WAV音频；未保存错误正文。');
          if(!response.body)throw new LingError('EMPTY_AUDIO','Ming没有返回音频。');
          receipt.responseBytes=0;for await(const chunk of response.body){receipt.responseBytes+=chunk.length;append(Buffer.from(chunk));}
        }
        bytes=Buffer.concat(chunks);
        if(!contentType.includes('text/event-stream'))receipt.responseClassification=classifyResponse(bytes);
        if(!bytes.length)throw new LingError('EMPTY_AUDIO',`Ming返回HTTP ${response.status}，但音频响应为0字节。`);
        if(receipt.responseClassification==='JSON'){const detail=providerError(bytes,config.apiKey);if(detail){receipt.providerError=detail;throw new LingError('TTS_PROVIDER_ERROR','Ming返回JSON错误，脱敏code/message已记录在receipt。');}}
        break;
      }catch(error){if(error instanceof LingError)throw error;if(controller.signal.aborted)throw new LingError('TIMEOUT','Ming语音生成超时。');if(attempt===0&&audioBytes===0)continue;throw new LingError('NETWORK_ERROR','Ming语音连接失败，未保存不完整音频。');}
    }
    receipt.rawAudioBytes=bytes.length;receipt.rawAudioSha256=hash(bytes);
    // Retain completed audio payloads before format detection, so a local
    // parser failure can be diagnosed without another paid API request.
    if(config.apiKey&&bytes.includes(Buffer.from(config.apiKey)))throw new LingError('UNSAFE_AUDIO_PAYLOAD','响应含凭据文本，未保存原始数据。');
    await fs.writeFile(files.rawAudio,bytes,{flag:'wx',mode:0o600});receipt.rawAudioFile=path.basename(files.rawAudio);
    const classification=classifyResponse(bytes);
    if(classification!=='RIFF'){
      if(['MP3','JSON','SSE'].includes(classification))throw new LingError('INVALID_TTS_FORMAT','收到的字节不是请求的PCM音频。');
      bytes=pcmToWav(bytes);receipt.containerConversion='received PCM -> WAV (no audio resynthesis)';
    }else receipt.containerConversion='none (provider returned WAV)';
    const audio=inspectWav(bytes);await fs.writeFile(files.audio,bytes,{flag:'wx'});
    Object.assign(receipt,{ok:true,status:'completed',audioSha256:hash(bytes),audioBytes:bytes.length,audioMetadata:audio,durationSeconds:audio.durationSeconds});
    await saveReceipt();return{audio:files.audio,receipt:files.receipt,...receipt};
  }catch(error){
    receipt.ok=false;receipt.status='failed';receipt.error={code:error instanceof LingError?error.code:'LOCAL_ERROR',message:error instanceof LingError?redactSecret(error.message,config?.apiKey):'本地音频处理失败。'};
    await saveReceipt();throw new LingError(receipt.error.code,receipt.error.message,{receipt:files.receipt});
  }finally{if(timer)clearTimeout(timer);}
}

const HELP=`Ming普通话配音（独立TTS，非Ling语音能力）。\nnode scripts/ming_speech.mjs --text-file s01.txt --output audio/s01.wav\n或 --out-dir 新建或空目录，输出speech.wav和receipt.json。\n参数：--config FILE；--voice '${DEFAULT_VOICE}'；--model ${DEFAULT_TTS_MODEL}；--speed 1；--timeout 300。显式output的receipt为同basename.receipt.json。\n复用官方Ling私有配置中的key，仅请求官方Ant语音端点，显式SSE返回PCM并无损封装WAV；不自动换模型、端点或配音服务。费用和权限以API控制台为准。`;
export function parseArgs(argv){
  const options={voice:DEFAULT_VOICE,model:DEFAULT_TTS_MODEL,speed:1,timeout:300},flags=new Set(['text-file','output','out-dir','config','voice','model','speed','timeout']);
  for(let i=0;i<argv.length;i++){const arg=argv[i];if(arg==='--help'||arg==='-h'){options.help=true;continue;}if(!arg.startsWith('--')||!flags.has(arg.slice(2)))throw new LingError('INVALID_ARGUMENT','未知参数，请使用--help查看。');const value=argv[++i];if(!value||value.startsWith('--'))throw new LingError('INVALID_ARGUMENT','参数缺少值。');options[arg.slice(2)]=value;}
  if(options.help)return options;if(!options['text-file']||Boolean(options.output)===Boolean(options['out-dir']))throw new LingError('INVALID_ARGUMENT','须指定--text-file及--output或--out-dir之一。');
  options.speed=Number(options.speed);options.timeout=Number(options.timeout);options.outDir=options['out-dir'];return options;
}
export async function main(argv=process.argv.slice(2)){const options=parseArgs(argv);if(options.help){console.log(HELP);return;}options.text=await fs.readFile(path.resolve(options['text-file']),'utf8').catch(()=>{throw new LingError('INVALID_TEXT_FILE','无法读取UTF-8旁白文件。');});const result=await synthesize(options);console.log(JSON.stringify({ok:true,provider:result.provider,model:result.requestModel,voice:result.voice,audio:result.audio,receipt:result.receipt,durationSeconds:result.durationSeconds,transportMode:result.transportMode,source:result.source},null,2));}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({ok:false,code:error instanceof LingError?error.code:'LOCAL_ERROR',message:error instanceof LingError?error.message:'本地运行失败。',receipt:error.receipt||null},null,2));process.exitCode=1;});
