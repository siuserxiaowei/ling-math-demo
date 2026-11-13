#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const argv=process.argv.slice(2);let directory,port=0;
for(let i=0;i<argv.length;i++){if(argv[i]==='--dir')directory=argv[++i];else if(argv[i]==='--port')port=Number(argv[++i]);else if(argv[i]==='--help'){console.log('node scripts/serve_lesson.mjs --dir <demo-output> [--port 0]');process.exit(0);}else throw new Error('未知参数');}
if(!directory||!Number.isInteger(port)||port<0||port>65535)throw new Error('需要有效的--dir与--port');
const root=await fs.realpath(directory);if(!(await fs.stat(path.join(root,'lesson.html'))).isFile())throw new Error('目录缺少lesson.html');
const server=http.createServer(async(req,res)=>{try{const route=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);const relative=route==='/'?'lesson.html':route.replace(/^\/+/, '');const file=path.resolve(root,relative);if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}const real=await fs.realpath(file);if(!real.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}const type={'.html':'text/html; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.mp4':'video/mp4','.json':'application/json; charset=utf-8'}[path.extname(real)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(await fs.readFile(real));}catch{res.writeHead(404);res.end('Not found');}});
server.listen(port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}/`));
process.on('SIGINT',()=>server.close());process.on('SIGTERM',()=>server.close());
