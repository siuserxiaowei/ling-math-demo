#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { narrationCues, normalizeCaption } from './verify_film.mjs';

const SELF = fileURLToPath(import.meta.url);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function scriptJSON(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function validateMap(narration, map) {
  narrationCues(narration);
  if (map?.schemaVersion !== 1 || !Array.isArray(map.segments)) throw new Error('map must have schemaVersion:1 and a segments array.');
  if (map.segments.length !== narration.segments.length) throw new Error('map must contain exactly one entry for every narration segment.');
  const allowed = new Set(narration.segments.map((segment) => segment.id)), seen = new Set();
  for (const entry of map.segments) {
    if (typeof entry.id !== 'string' || !allowed.has(entry.id) || seen.has(entry.id)) throw new Error('Map segment ids must uniquely match narration.segments.');
    seen.add(entry.id);
    if (![entry.sourceTimeStart, entry.sourceTimeEnd].every(Number.isFinite) || entry.sourceTimeStart < 0 || entry.sourceTimeEnd < entry.sourceTimeStart) throw new Error(`Invalid source-time range for segment ${entry.id}.`);
    if (typeof entry.showFormula !== 'boolean') throw new Error(`Segment ${entry.id} needs a boolean showFormula.`);
    if (!Array.isArray(entry.actions)) throw new Error(`Segment ${entry.id} needs an actions array.`);
    for (const action of entry.actions) {
      if (action?.type !== 'click' || typeof action.selector !== 'string' || !action.selector.trim() || action.selector.length > 512 || Object.keys(action).some((key) => !['type', 'selector'].includes(key))) throw new Error(`Segment ${entry.id} only supports declared {type:'click',selector:'...'} actions.`);
    }
  }
  return narration.segments.map((segment) => ({ narration: segment, map: map.segments.find((entry) => entry.id === segment.id) }));
}

function captionLines(segment) {
  const lines = Array.isArray(segment.lines) ? segment.lines : (() => {
    const characters = [...segment.text], result = [];
    while (characters.length) result.push(characters.splice(0, 16).join(''));
    return result;
  })();
  if (!lines.length || lines.length > 2 || lines.some((line) => typeof line !== 'string' || !line.trim()) || normalizeCaption(lines.join('')) !== normalizeCaption(segment.text)) throw new Error(`Segment ${segment.id} needs one or two prepared caption lines matching text.`);
  return lines;
}

export function buildFilmHtml(payload) {
  const encoded = scriptJSON(payload);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; frame-src 'self' about:; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'">
<meta name="host-composition" content="true"><title>SVG讲解成片 · 宿主时间轴合成</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fffaf2;color:#3b332a;font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
#film{position:relative;width:1080px;height:1920px;background:#fffaf2;overflow:hidden}
#film-header{position:absolute;left:80px;right:80px;top:54px}
#film-title{margin:0;font-size:64px;line-height:1.15;font-weight:700;letter-spacing:-1px;color:#173e3c}
#film-question{margin-top:18px;font-size:40px;line-height:1.25;color:#746d61}
#film-scene{position:absolute;left:80px;top:300px;width:920px;height:920px;display:flex;align-items:center;justify-content:center}
#film-scene>svg{display:block;width:100%;height:100%;overflow:hidden}
#film-formula{position:absolute;left:80px;top:1274px;width:920px;min-height:100px;text-align:center;font-size:64px;line-height:1.25;font-weight:700;color:#0b6e66;white-space:normal}
#film-caption{position:absolute;left:80px;right:80px;bottom:140px;min-height:152px;padding:16px 0;box-sizing:border-box;font-size:56px;line-height:1.36;text-align:center;color:#173e3c;font-weight:500;white-space:normal}
#film-source{display:none!important;width:0;height:0;border:0}
</style></head><body><main id="film" aria-label="知识讲解视频画面"><header id="film-header"><h1 id="film-title"></h1><div id="film-question"></div></header><div id="film-scene"></div><div id="film-formula" hidden></div><div id="film-caption" data-segment-id="" aria-live="off"></div></main>
<iframe id="film-source" title="原始SVG课件运行环境" aria-hidden="true" tabindex="-1" sandbox="allow-scripts allow-same-origin"></iframe>
<script id="film-payload" type="application/json">${encoded}</script>
<script>
(()=>{'use strict';
const payload=JSON.parse(document.getElementById('film-payload').textContent),frame=document.getElementById('film-source');
const scene=document.getElementById('film-scene'),caption=document.getElementById('film-caption'),formula=document.getElementById('film-formula');
const title=document.getElementById('film-title'),question=document.getElementById('film-question');let sourceWindow,sourceDocument,state={time:0,segmentId:null,cueSegmentId:null,sourceTime:0,showFormula:false};
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const presentStyle=['fill','fill-opacity','stroke','stroke-width','stroke-opacity','opacity','font-family','font-size','font-weight','font-style','letter-spacing','text-anchor','dominant-baseline','paint-order','visibility','display'];
function cloneOriginalSvg(){
 const original=sourceDocument.querySelector('#main-svg');if(!original||original.namespaceURI!=='http://www.w3.org/2000/svg')throw new Error('Source must expose its actual SVG as #main-svg.');
 const clone=original.cloneNode(true),originals=[original,...original.querySelectorAll('*')],clones=[clone,...clone.querySelectorAll('*')];
 originals.forEach((element,index)=>{const computed=sourceWindow.getComputedStyle(element);for(const property of presentStyle){const value=computed.getPropertyValue(property);if(value)clones[index].style.setProperty(property,value);}});
 clone.setAttribute('width','100%');clone.setAttribute('height','100%');clone.setAttribute('preserveAspectRatio','xMidYMid meet');clone.style.width='100%';clone.style.height='100%';
 scene.replaceChildren(clone);
}
function setTime(seconds){
 if(!sourceWindow)throw new Error('Original SVG lesson has not finished loading.');
 const time=clamp(Number(seconds)||0,0,payload.duration);let entry=payload.timeline[0];
 for(const candidate of payload.timeline)if(time>=candidate.start)entry=candidate;
 for(const action of entry.actions){const matches=sourceDocument.querySelectorAll(action.selector);if(matches.length!==1||typeof matches[0].click!=='function')throw new Error('Declared source click must select exactly one clickable element: '+action.selector);matches[0].click();}
 const progress=clamp((time-entry.start)/(entry.end-entry.start),0,1),sourceTime=entry.sourceTimeStart+(entry.sourceTimeEnd-entry.sourceTimeStart)*progress;
 const returned=sourceWindow.lesson.setTime(sourceTime);if(returned&&typeof returned.then==='function')throw new Error('Original source setTime must be synchronous.');
 cloneOriginalSvg();
 title.textContent=payload.titleOverride||sourceDocument.querySelector('h1')?.textContent?.trim()||'知识讲解';
 question.textContent=(sourceDocument.querySelector('#subtitle')||sourceDocument.querySelector('.sub'))?.textContent?.trim()||'';
 formula.hidden=!entry.showFormula;formula.textContent=entry.showFormula?sourceDocument.querySelector('#formula-line')?.textContent?.trim()||'':'';
 if(entry.showFormula&&!formula.textContent)throw new Error('The mapped formula segment has no original #formula-line text.');
 const cue=payload.timeline.find(candidate=>time>=candidate.voiceStart&&time<candidate.end);
 caption.replaceChildren();caption.dataset.segmentId=cue?cue.id:'';caption.style.visibility=cue?'visible':'hidden';
 if(cue)cue.lines.forEach((line,index)=>{if(index)caption.append(document.createElement('br'));caption.append(document.createTextNode(line));});
 state={time,segmentId:entry.id,cueSegmentId:cue?cue.id:null,sourceTime,showFormula:entry.showFormula};
}
frame.addEventListener('load',()=>{
 try{
  const win=frame.contentWindow,doc=frame.contentDocument;if(!win?.lesson)return;
  if(typeof win.lesson.setTime!=='function'||!Number.isFinite(win.lesson.duration)||win.lesson.duration<=0)throw new Error('The original lesson needs a synchronous setTime and positive duration.');
  for(const entry of payload.timeline){if(entry.sourceTimeStart>win.lesson.duration||entry.sourceTimeEnd>win.lesson.duration)throw new Error('Mapped source time exceeds the original lesson duration for segment '+entry.id);for(const action of entry.actions){const elements=doc.querySelectorAll(action.selector);if(elements.length!==1||typeof elements[0].click!=='function')throw new Error('Invalid declared source click selector: '+action.selector);}}
  sourceWindow=win;sourceDocument=doc;
  window.lesson={duration:payload.duration,setTime,inspect(){let original=null;if(typeof sourceWindow.lesson.inspect==='function')original=sourceWindow.lesson.inspect();return {hostComposition:true,mathStatus:'not_assessed',...state,source:original};}};
  setTime(0);window.dispatchEvent(new Event('lesson-ready'));
 }catch(error){document.documentElement.dataset.filmCompositionError=String(error.message);throw error;}
});
frame.srcdoc=payload.sourceHtml;
})();
</script></body></html>\n`;
}

export async function composeFilm(options) {
  const sourcePath = resolve(options['source-html']), narrationPath = resolve(options.narration), mapPath = resolve(options.map), outputPath = resolve(options.output);
  const provenancePath = resolve(dirname(outputPath), 'provenance.json');
  if (outputPath === provenancePath) throw new Error('The HTML output must have a different name from provenance.json.');
  if ([sourcePath, narrationPath, mapPath].includes(outputPath) || [sourcePath, narrationPath, mapPath].includes(provenancePath)) throw new Error('Output must not replace an input.');
  for (const target of [outputPath, provenancePath]) if (await stat(target).then(() => true).catch((error) => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Refusing to overwrite an existing composition or provenance file.');
  const [sourceBytes, narrationBytes, mapBytes] = await Promise.all([readFile(sourcePath), readFile(narrationPath), readFile(mapPath)]);
  const sourceHtml = sourceBytes.toString('utf8');
  if (!Buffer.from(sourceHtml, 'utf8').equals(sourceBytes)) throw new Error('The source HTML must be valid UTF-8 so it can be preserved verbatim.');
  const narration = JSON.parse(narrationBytes.toString('utf8')), map = JSON.parse(mapBytes.toString('utf8'));
  const entries = validateMap(narration, map);
  async function binding(field) {
    if (!narration[field]) return null;
    if (typeof narration[field] !== 'string' || isAbsolute(narration[field])) throw new Error(`narration.${field} must be a relative file in the narration directory.`);
    const directory = await realpath(dirname(narrationPath)), file = await realpath(resolve(dirname(narrationPath), narration[field]));
    if (!file.startsWith(directory + sep)) throw new Error(`narration.${field} must remain inside its narration directory.`);
    const bytes = await readFile(file); return { file: basename(file), sha256: hash(bytes), bytes };
  }
  const audioBinding = await binding('audio'), captionsBinding = await binding('captions');
  if (audioBinding && narration.sha256 && narration.sha256 !== audioBinding.sha256) throw new Error('The narration audio hash differs from its measured manifest.');
  let captionsById;
  if (captionsBinding) {
    const captions = JSON.parse(captionsBinding.bytes.toString('utf8'));
    if (captions.schemaVersion !== 1 || !Array.isArray(captions.cues) || captions.cues.length !== entries.length) throw new Error('The prepared captions must match the narration segment set.');
    captionsById = new Map(captions.cues.map((cue) => [cue.segmentId ?? cue.id, cue]));
    if (captionsById.size !== entries.length) throw new Error('Prepared caption segment ids must be unique.');
  }
  const timeline = entries.map(({ narration: segment, map: entry }) => {
    const cue = captionsById?.get(segment.id);
    if (captionsById && (!cue || normalizeCaption(cue.text) !== normalizeCaption(segment.text) || Math.abs(cue.start - segment.voiceStart) > 0.000001 || Math.abs(cue.end - segment.end) > 0.000001)) throw new Error(`Prepared caption ${segment.id} is not bound to the measured narration text and timing.`);
    return { id: segment.id, start: segment.start, end: segment.end, voiceStart: segment.voiceStart, voiceEnd: segment.voiceEnd, text: segment.text, lines: captionLines({ ...segment, lines: cue?.lines ?? segment.lines }), sourceTimeStart: entry.sourceTimeStart, sourceTimeEnd: entry.sourceTimeEnd, actions: entry.actions, showFormula: entry.showFormula };
  });
  const sourceModel = options['source-model'] ?? map.sourceModel ?? null;
  if (sourceModel !== null && (typeof sourceModel !== 'string' || !sourceModel.trim())) throw new Error('source-model must be a non-empty caller declaration.');
  const provenance = { schemaVersion: 1, hostComposition: true, mathStatus: 'not_assessed', createdAt: new Date().toISOString(), sourceHtml: basename(sourcePath), sourceHtmlSha256: hash(sourceBytes), sourceHtmlBytes: sourceBytes.length, narration: basename(narrationPath), narrationSha256: hash(narrationBytes), map: basename(mapPath), mapSha256: hash(mapBytes), duration: narration.duration,
    sourceModel, sourceModelAttribution: sourceModel ? 'Caller-declared attribution; not independently authenticated by this adapter.' : 'No model attribution declared.',
    audioSha256: audioBinding?.sha256 ?? null, captionsSha256: captionsBinding?.sha256 ?? null, bindings: { audio: audioBinding ? { file: audioBinding.file, sha256: audioBinding.sha256 } : null, captions: captionsBinding ? { file: captionsBinding.file, sha256: captionsBinding.sha256 } : null },
    attribution: { originalLesson: 'The supplied source HTML and its SVG drawing logic are retained verbatim; original authorship/model attribution remains with that source.', hostComposition: 'This wrapper is host timeline composition. It is not a newly generated Ling HTML.', adaptation: 'Measured narration timing, declared click actions, original SVG cloning, video layout and captions; no replacement mathematical figures.' },
    scope: 'Adapter for compatible synchronous SVG lessons exposing #main-svg, lesson.setTime, and optional #formula-line. It is not a universal HTML/Canvas generator.', sourceTimeValidation: 'Non-negative ordered ranges checked at composition; upper bounds checked against the actual original lesson.duration on iframe load.' };
  const html = buildFilmHtml({ sourceHtml, duration: narration.duration, titleOverride: options.title || '', timeline, provenance });
  await mkdir(dirname(outputPath), { recursive: true });
  const created = [];
  try { await writeFile(provenancePath, JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' }); created.push(provenancePath); await writeFile(outputPath, html, { flag: 'wx' }); created.push(outputPath); }
  catch (error) { for (const file of created) await rm(file, { force: true }); throw error; }
  return { output: outputPath, provenance: provenancePath, hostComposition: true, sourceHtmlSha256: provenance.sourceHtmlSha256, duration: narration.duration, segments: timeline.length };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return { help: true };
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !['source-html', 'narration', 'map', 'output', 'title', 'source-model'].includes(key)) throw new Error(`Unknown argument: ${argv[i]}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = argv[++i];
  }
  if (!options['source-html'] || !options.narration || !options.map || !options.output) throw new Error('--source-html, --narration, --map and --output are required.');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  try { const options = parseArgs(process.argv.slice(2)); if (options.help) process.stdout.write('node compose_film.mjs --source-html lesson.html --narration narration.json --map map.json --output video.html [--title TEXT]\nPreserves a compatible original SVG lesson verbatim and composes a measured host timeline; no model API is called.\n'); else process.stdout.write(JSON.stringify(await composeFilm(options), null, 2) + '\n'); }
  catch (error) { process.stderr.write(`Composition failed: ${error.message}\n`); process.exitCode = 1; }
}
