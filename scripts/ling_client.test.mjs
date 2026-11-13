import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {generate,extractHTML,readSSE,buildRequest,endpointFor,checkConfiguration,MODEL} from './ling_client.mjs';
import {parseArgs} from './ling_generate.mjs';

const FAKE_KEY='unit-test-key-never-a-real-credential';
const HTML='<!doctype html><html lang="zh-CN"><body><h1>分数除法</h1><script>window.lesson={duration:10,setTime(t){},inspect(){return{time:0}}}</script></body></html>';
const fixture=async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'ling-client-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;};
const chunk=(content,extra={})=>({id:'test-request-01',model:MODEL,choices:[{index:0,delta:{content},...extra}]});
function responseFrom(content=HTML,{finish='stop',model=MODEL,reasoning='private-reasoning-must-not-be-persisted',step=7}={}){
  const packets=[{...chunk(''),model,choices:[{index:0,delta:{reasoning_content:reasoning}}]},...Array.from(content).map(c=>({...chunk(c),model})),{...chunk('',{finish_reason:finish}),model,usage:{prompt_tokens:11,completion_tokens:22,total_tokens:33}}];
  const bytes=Buffer.from(packets.map(p=>'data: '+JSON.stringify(p)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n');
  return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=step)controller.enqueue(bytes.subarray(i,i+step));controller.close();}}),{headers:{'content-type':'text/event-stream','x-request-id':'header-request'}});
}
const run=async(root,fetchImpl,extra={})=>generate({prompt:'讲清楚三分之四除以二分之一',outDir:path.join(root,'out'),env:{LING_API_KEY:FAKE_KEY},config:path.join(root,'missing.json'),fetchImpl,...extra});
async function artifacts(root){let out='';for(const name of await fs.readdir(path.join(root,'out')))out+=await fs.readFile(path.join(root,'out',name),'utf8');return out;}

test('SSE decoder preserves split UTF-8, CRLF, multiline data and final unseparated event',async()=>{
  const bytes=Buffer.from(':heartbeat\r\nevent: completion\r\ndata: {"hello":\r\ndata: "世界"}\r\n\r\ndata: [DONE]');
  const body=new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}});
  const events=[];for await(const item of readSSE(body))events.push(item);
  assert.equal(events.length,2);assert.equal(events[0].event,'completion');assert.deepEqual(JSON.parse(events[0].data),{hello:'世界'});assert.equal(events[1].data,'[DONE]');
});

test('CLI accepts repeated images and check-config without prompt or output',()=>{
  const args=parseArgs(['--prompt','一句话','--out-dir','new','--image','a.png','--image','b.jpg']);assert.equal(args.images.length,2);assert.equal(args.maxTokens,12000);assert.equal(args.thinking,'disabled');
  assert.equal(parseArgs(['--check-config']).checkConfig,true);
  assert.throws(()=>parseArgs([FAKE_KEY]),e=>!e.message.includes(FAKE_KEY));
  assert.throws(()=>parseArgs(['--prompt','a','--prompt-file','b','--out-dir','x']),e=>e.code==='INVALID_ARGUMENT');
  assert.throws(()=>parseArgs(['--prompt','a','--out-dir','x',...Array.from({length:5},()=>['--image','a.png']).flat()]),e=>e.code==='TOO_MANY_IMAGES');
});

test('config inspection is offline and reports missing API key without a secret',async t=>{
  const root=await fixture(t);const missing=await checkConfiguration({configPath:path.join(root,'absent.json'),env:{}});
  assert.equal(missing.configured,false);assert.equal(missing.networkRequested,false);assert.deepEqual(missing.missing,['api_key']);
  const good=await checkConfiguration({configPath:path.join(root,'absent.json'),env:{LING_API_KEY:FAKE_KEY}});
  assert.equal(good.configured,true);assert.equal(good.model,MODEL);assert.ok(!JSON.stringify(good).includes(FAKE_KEY));
});

test('endpoint defaults to official HTTPS and custom hosts need explicit configuration',()=>{
  assert.equal(endpointFor().url,'https://api.ant-ling.com/v1/chat/completions');
  assert.throws(()=>endpointFor('https://unexpected.example/v1'),e=>e.code==='ENDPOINT_NOT_AUTHORIZED');
  assert.throws(()=>endpointFor('http://unexpected.example/v1',{explicit:true}),e=>e.code==='INSECURE_ENDPOINT');
  assert.throws(()=>endpointFor('https://user:secret@example.test/v1',{explicit:true}),e=>e.code==='INVALID_ENDPOINT');
  assert.throws(()=>endpointFor('http://127.0.0.1:1234/v1'),e=>e.code==='INSECURE_ENDPOINT');
  assert.equal(endpointFor('http://127.0.0.1:1234/v1',{allowTestLocalhost:true}).source,'local-mock');
});

test('request uses only max_completion_tokens and actual PNG/JPEG MIME',async t=>{
  const root=await fixture(t),png=path.join(root,'p.png'),jpg=path.join(root,'j.jpg');
  await fs.writeFile(png,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cX3cAAAAASUVORK5CYII=','base64'));
  await fs.writeFile(jpg,Buffer.from([255,216,255,224,0,16,74,70,73,70]));
  const request=await buildRequest({prompt:'image test',images:[png,jpg],maxTokens:12000});const body=JSON.parse(request.body);
  assert.equal(body.model,MODEL);assert.equal(body.stream,true);assert.equal(body.thinking.type,'disabled');assert.equal(body.max_completion_tokens,12000);assert.equal(body.max_tokens,undefined);
  assert.match(body.messages[1].content[1].image_url.url,/^data:image\/png;base64,/);assert.match(body.messages[1].content[2].image_url.url,/^data:image\/jpeg;base64,/);
  assert.equal(request.imageMetadata[0].mime,'image/png');assert.ok(!JSON.stringify(request.imageMetadata).includes('base64'));
  const bad=path.join(root,'fake.png');await fs.writeFile(bad,'not a picture');await assert.rejects(buildRequest({prompt:'a',images:[bad]}),e=>e.code==='INVALID_IMAGE');
  await assert.rejects(buildRequest({prompt:'a',images:[png,png,png,png,png]}),e=>e.code==='TOO_MANY_IMAGES');
});

test('the encoded total request must be below 32 MiB',async t=>{
  const root=await fixture(t),image=path.join(root,'large.png'),bytes=Buffer.alloc(7*1024*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);await fs.writeFile(image,bytes);
  await assert.rejects(buildRequest({prompt:'a',images:[image,image,image,image]}),e=>e.code==='REQUEST_TOO_LARGE');
});

test('largest complete HTML block is chosen and incomplete HTML is rejected',()=>{
  const small='<html><body>small</body></html>';
  assert.equal(extractHTML('```html\n'+small+'\n```\n```html\n'+HTML+'\n```'),HTML+'\n');
  assert.equal(extractHTML(HTML),HTML+'\n');
  assert.throws(()=>extractHTML('```html\n<html><body>unfinished\n```'),e=>e.code==='NO_COMPLETE_HTML');
  assert.throws(()=>extractHTML('```js\nconst sample="<html>example</html>";\n```'),e=>e.code==='NO_COMPLETE_HTML');
});

test('successful generation persists final content and receipt without reasoning or credentials',async t=>{
  const root=await fixture(t);let observed;
  const result=await run(root,async(url,options)=>{observed={url,options};return responseFrom('```html\n'+HTML+'\n```');});
  assert.equal(result.ok,true);assert.equal(result.responseModel,MODEL);assert.equal(result.source,'test-injected-fetch');assert.equal(result.requestPerformed,true);
  assert.equal(result.transportMode,'test');assert.equal(result.endpointHost,'api.ant-ling.com');
  assert.equal(observed.url,'https://api.ant-ling.com/v1/chat/completions');assert.equal(observed.options.headers.Authorization,'Bearer '+FAKE_KEY);
  assert.equal(observed.options.redirect,'error');
  assert.equal(await fs.readFile(result.html,'utf8'),HTML+'\n');
  const data=await artifacts(root);assert.ok(!data.includes(FAKE_KEY));assert.ok(!data.includes('private-reasoning'));assert.equal(result.finishReason,'stop');assert.equal(result.usage.total_tokens,33);assert.deepEqual(result.usageRaw,{prompt_tokens:11,completion_tokens:22,total_tokens:33});
});

test('401, 403 and 429 stop immediately and do not persist untrusted error bodies',async t=>{
  for(const status of [401,403,429]){const root=await fixture(t);let calls=0;
    await assert.rejects(run(root,async()=>{calls++;return new Response(FAKE_KEY,{status});}),e=>e.code===(status===429?'RATE_LIMITED':'AUTH_FAILED'));
    assert.equal(calls,1);const receipt=JSON.parse(await fs.readFile(path.join(root,'out/receipt.json')));assert.equal(receipt.ok,false);assert.equal(receipt.attempts,1);assert.ok(!(await artifacts(root)).includes(FAKE_KEY));
    await assert.rejects(fs.access(path.join(root,'out/lesson.html')));
  }
});

test('one transient gateway failure can retry, but only once',async t=>{
  const root=await fixture(t);let calls=0;const result=await run(root,async()=>++calls===1?new Response('temporary',{status:503}):responseFrom());assert.equal(calls,2);assert.equal(result.attempts,2);
  const another=await fixture(t);calls=0;await assert.rejects(run(another,async()=>{calls++;return new Response('temporary',{status:503});}),e=>e.code==='HTTP_ERROR');assert.equal(calls,2);
});

test('a stream failure after content is never retried and partial final text is retained',async t=>{
  const root=await fixture(t);let calls=0;const packet=Buffer.from('data: '+JSON.stringify(chunk('<html>partial'))+'\n\n');
  await assert.rejects(run(root,async()=>{calls++;return new Response(new ReadableStream({pull(c){if(this.sent)c.error(new Error(FAKE_KEY));else{this.sent=true;c.enqueue(packet);}}}),{headers:{'content-type':'text/event-stream'}});}),e=>e.code==='NETWORK_ERROR');
  assert.equal(calls,1);assert.equal(await fs.readFile(path.join(root,'out/response.md'),'utf8'),'<html>partial');assert.ok(!(await artifacts(root)).includes(FAKE_KEY));
});

test('wrong response model, length truncation and missing HTML cannot produce a success lesson',async t=>{
  const scenarios=[{content:HTML,options:{model:'Ling-3.1-flash'},code:'MODEL_MISMATCH'},{content:HTML,options:{finish:'length'},code:'TRUNCATED'},{content:'just text',options:{},code:'NO_COMPLETE_HTML'}];
  for(const s of scenarios){const root=await fixture(t);await assert.rejects(run(root,async()=>responseFrom(s.content,s.options)),e=>e.code===s.code);const receipt=JSON.parse(await fs.readFile(path.join(root,'out/receipt.json')));assert.equal(receipt.ok,false);assert.equal(receipt.error.code,s.code);await assert.rejects(fs.access(path.join(root,'out/lesson.html')));if(s.code!=='MODEL_MISMATCH')assert.ok((await fs.readFile(path.join(root,'out/response.md'),'utf8')).length);}
});

test('unexpected secret echo is redacted even in otherwise successful final content',async t=>{
  const root=await fixture(t);const result=await run(root,async()=>responseFrom(HTML.replace('分数除法',FAKE_KEY)));assert.equal(result.ok,true);assert.ok(!(await artifacts(root)).includes(FAKE_KEY));assert.match(await fs.readFile(result.response,'utf8'),/REDACTED_API_KEY/);
});

test('untrusted provider metadata cannot smuggle an echoed key into the receipt',async t=>{
  const root=await fixture(t);
  await assert.rejects(run(root,async()=>new Response(JSON.stringify({model:MODEL,id:'request-'+FAKE_KEY,choices:[{message:{content:HTML},finish_reason:FAKE_KEY}]}),{headers:{'content-type':'application/json'}})),e=>e.code==='INCOMPLETE_RESPONSE');
  assert.ok(!(await artifacts(root)).includes(FAKE_KEY));
  const receipt=JSON.parse(await fs.readFile(path.join(root,'out/receipt.json')));assert.equal(receipt.requestId,null);assert.equal(receipt.finishReason,'unrecognized');
});

test('existing outputs are protected and missing credentials create only an explicit failure receipt',async t=>{
  const root=await fixture(t);await fs.mkdir(path.join(root,'out'));await fs.writeFile(path.join(root,'out/lesson.html'),'mine');await assert.rejects(run(root,async()=>responseFrom()),e=>e.code==='OUTPUT_EXISTS');assert.equal(await fs.readFile(path.join(root,'out/lesson.html'),'utf8'),'mine');
  const second=await fixture(t);let called=false;await assert.rejects(run(second,async()=>{called=true;return responseFrom();},{env:{}}),e=>e.code==='MISSING_API_KEY');assert.equal(called,false);const receipt=JSON.parse(await fs.readFile(path.join(second,'out/receipt.json')));assert.equal(receipt.requestPerformed,false);assert.equal(receipt.status,'failed');
});

test('timeout is bounded and does not silently retry an aborted request',async t=>{
  const root=await fixture(t);let calls=0;
  await assert.rejects(run(root,async(_url,{signal})=>{calls++;return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true});});},{timeout:.02}),e=>e.code==='TIMEOUT');assert.equal(calls,1);
});

test('real HTTP loopback smoke is explicitly labelled local-mock',async t=>{
  const root=await fixture(t);let body='',authorization;
  const server=http.createServer(async(req,res)=>{authorization=req.headers.authorization;for await(const data of req)body+=data;res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify(chunk(HTML))+'\n\n');res.end('data: '+JSON.stringify(chunk('',{finish_reason:'stop'}))+'\n\ndata: [DONE]\n\n');});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const cfg=path.join(root,'ling.json');await fs.writeFile(cfg,JSON.stringify({api_key:FAKE_KEY,base_url:`http://127.0.0.1:${server.address().port}/v1`,model:MODEL}));
  const result=await generate({prompt:'本地mock测试',outDir:path.join(root,'out'),config:cfg,env:{},allowTestLocalhost:true});
  assert.equal(result.source,'local-mock');assert.equal(result.transportMode,'test');assert.equal(result.responseModel,MODEL);assert.equal(authorization,'Bearer '+FAKE_KEY);assert.equal(JSON.parse(body).messages[1].content[0].text,'本地mock测试');assert.ok(!(await artifacts(root)).includes(FAKE_KEY));
});
