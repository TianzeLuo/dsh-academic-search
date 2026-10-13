import path from 'node:path';
import { SOURCES, fuse, identifier, sha, titleKey } from './model.mjs';
import { HttpClient, SourceError } from './http.mjs';
import { Sources } from './sources.mjs';
import { PORT_ROOT, absolutePath, setWriteRoots, readFileSync, underRoot } from '../lib/guarded-fs.mjs';

export const VERSION='0.2.0';
export class InputError extends Error {}
const string=(max=800)=>({type:'string',minLength:1,maxLength:max});
const integer=(min,max)=>({type:'integer',minimum:min,maximum:max});
const enumeration=values=>({type:'string',enum:values});
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const list=(items,min,max)=>({type:'array',items,minItems:min,maxItems:max,uniqueItems:true});
export const TOOL_DEFS=[
  {name:'academic_search',description:'Bounded academic discovery. Default summary omits abstracts, authors and raw source records; full evidence and all candidates remain in run_path. Use academic_read for local pagination. query_plan explicitly separates required concepts from optional terms. No model API is called.',inputSchema:schema({queries:list(string(800),1,6),sources:list(enumeration(SOURCES),1,4),per_source:integer(1,30),limit:integer(1,100),mode:enumeration(['keyword','semantic']),date_from:string(10),date_to:string(10),abstract_chars:integer(0,5000),detail:enumeration(['summary','full']),ranking:enumeration(['legacy','relevance','rrf']),query_plan:schema({required:list(string(100),1,8),optional:list(string(100),0,8)},['required'])},['queries'])},
  {name:'academic_resolve',description:'Resolve a supported scholarly identifier to authoritative metadata. Accept arXiv ID/URL, DOI, OpenAlex W ID or S2 ID. No arbitrary URLs.',inputSchema:schema({identifier:string(500)},['identifier'])},
  {name:'academic_expand',description:'Fetch one bounded citation/reference hop. OpenAlex ID/DOI uses OpenAlex; arXiv/S2 ID uses Semantic Scholar. Returns truncation and source errors; does not recursively expand.',inputSchema:schema({identifier:string(500),direction:enumeration(['references','citations']),limit:integer(1,30),abstract_chars:integer(0,5000)},['identifier'])},
  {name:'academic_fetch',description:'Download a selected arXiv PDF only. Pin version, verify PDF signature and SHA, and return a provenance manifest handoff for paper_import. expected_title rejects metadata mismatch before downloading.',inputSchema:schema({identifier:string(500),expected_title:string(500)},['identifier'])},
  {name:'academic_read',description:'Read a saved search run locally by run_id with stable pagination and summary/full detail. No network requests; all recalled candidates are available, including those beyond the original display limit.',inputSchema:schema({run_id:{type:'string',pattern:'^[0-9a-f-]{36}$'},offset:integer(0,10000),limit:integer(1,100),detail:enumeration(['summary','full']),abstract_chars:integer(0,5000)},['run_id'])},
  {name:'academic_export',description:'Export one saved search run as a reading table, JSON and BibTeX. run_id comes from academic_search. Output is confined to configured data root.',inputSchema:schema({run_id:{type:'string',pattern:'^[0-9a-f-]{36}$'}},['run_id'])},
];
export function validate(s,value,label='arguments') {
  const type=Array.isArray(value)?'array':value===null?'null':typeof value;
  if(s.type==='integer'?!Number.isSafeInteger(value):s.type!==type) throw new InputError(`${label}: expected ${s.type}`);
  if(s.enum && !s.enum.includes(value)) throw new InputError(`${label}: unsupported value`);
  if(s.type==='string' && ((s.minLength && value.trim().length<s.minLength) || value.length>(s.maxLength ?? Infinity) || s.pattern && !new RegExp(s.pattern).test(value))) throw new InputError(`${label}: invalid string`);
  if(s.type==='integer' && (value<s.minimum || value>s.maximum)) throw new InputError(`${label}: outside ${s.minimum}..${s.maximum}`);
  if(s.type==='array') {if(value.length<s.minItems || value.length>s.maxItems || s.uniqueItems && new Set(value.map(v=>JSON.stringify(v))).size!==value.length) throw new InputError(`${label}: invalid list length or duplicate items`);value.forEach((v,i)=>validate(s.items,v,`${label}[${i}]`));}
  if(s.type==='object') {for(const key of s.required ?? []) if(!Object.hasOwn(value,key))throw new InputError(`${label}: missing ${key}`);for(const [key,v] of Object.entries(value)){if(!s.properties[key])throw new InputError(`${label}: unknown ${key}`);validate(s.properties[key],v,`${label}.${key}`);}}
}
function dates(args) {
  for(const key of ['date_from','date_to']) if(args[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(args[key]) || !Number.isFinite(Date.parse(args[key])) || new Date(args[key]).toISOString().slice(0,10)!==args[key])) throw new InputError(`${key}: invalid calendar date`);
  if(args.date_from && args.date_to && args.date_from>args.date_to)throw new InputError('date_from is after date_to');
}
function compact(p,chars=1000) {
  const {source_records,...rest}=p;
  return {...rest,abstract:p.abstract?.slice(0,chars) ?? null,abstract_truncated:(p.abstract?.length ?? 0)>chars,
    source_records:source_records?.map(({record,...provenance})=>({...provenance,ids:record.ids,url:record.url,published_at:record.published_at}))};
}
function presented(p,args) {
  if(args.detail==='full' || args.abstract_chars!==undefined) return compact(p,args.abstract_chars ?? 1000);
  return {work_id:p.work_id,title:p.title,ids:p.ids,url:p.url,published_at:p.published_at ?? p.year ?? null,
    sources:[...new Set(p.source_records.map(r=>r.source))],score:p.score,relevance:p.relevance,missing_fields:p.missing_fields};
}
function escapeMd(value) {return String(value ?? '').replace(/[\r\n]+/g,' ').replaceAll('|','\\|');}
function bibValue(value) {return String(value ?? '').replace(/[{}\\]/g,' ').replace(/\s+/g,' ').trim();}
export class AcademicService {
  constructor(options={}) {
    this.root=absolutePath(options.dataRoot ?? path.join(PORT_ROOT,'data','academic'));
    setWriteRoots([this.root]);
    this.http=options.http ?? new HttpClient({...options,dataRoot:this.root});
    this.sources=options.sources ?? new Sources(this.http,options);
  }
  list(){return TOOL_DEFS.map(t=>({...t,annotations:{readOnlyHint:t.name==='academic_read',destructiveHint:false,idempotentHint:!['academic_search','academic_fetch','academic_export'].includes(t.name),openWorldHint:!['academic_export','academic_read'].includes(t.name)}}));}
  async search(args) {
    dates(args);
    if(args.query_plan && args.queries.length!==1)throw new InputError('query_plan requires exactly one query');
    const sources=args.sources ?? ['arxiv','openalex','semanticscholar'];
    if(args.mode==='semantic' && (sources.length!==1 || sources[0]!=='openalex')) throw new InputError('semantic mode requires sources: [openalex]');
    const started=Date.now();
    const results=await Promise.all(sources.map(async source=> {
      const sourceResults=[];
      for(const query of args.queries) {
        try{sourceResults.push(await this.sources.search(source,query,args));}
        catch(error){if(!(error instanceof SourceError))throw error;sourceResults.push({source,query,status:error.status,error:error.message,...error.details,papers:[],total:null,truncated:null,fetched_at:new Date().toISOString()});}
      }
      return sourceResults;
    }));
    const flat=results.flat();
    // Persist every bounded candidate; limit affects presentation only.
    const fused=fuse(flat,args.queries,Infinity,{ranking:args.ranking ?? (args.query_plan ? 'relevance' : 'legacy'),queryPlan:args.query_plan});
    const failures=flat.filter(r=>!['ok','ok_zero_results'].includes(r.status));
    const status=failures.length===flat.length?'failed':failures.length?'partial':'ok';
    const saved={version:VERSION,created_at:new Date().toISOString(),status,arguments:args,...fused,source_results:flat,elapsed_ms:Date.now()-started,
      scope:'bounded candidate retrieval; not exhaustive literature coverage; title/abstract relevance only'};
    const runPath=this.http.writeArtifact('runs',saved);
    const runId=path.basename(runPath,'.json').slice(path.basename(runPath,'.json').indexOf('-')+1);
    const limit=args.limit ?? 20;
    return {...saved,papers:saved.papers.slice(0,limit).map(p=>presented(p,args)),returned:Math.min(limit,saved.papers.length),
      truncated:saved.papers.length>limit,truncation_reason:saved.papers.length>limit?'display_limit':null,
      next_offset:saved.papers.length>limit?limit:null,
      source_results:flat.map(({papers,...state})=>({...state,returned:papers.length})),run_id:runId,run_path:runPath};
  }
  async fetch(args) {
    let id;try{id=identifier(args.identifier);}catch(error){throw new InputError(error.message);}
    if(id.type!=='arxiv')throw new InputError('academic_fetch currently accepts arXiv only');
    const resolved=await this.sources.resolve(args.identifier);
    if(args.expected_title && titleKey(args.expected_title)!==titleKey(resolved.paper.title))throw new InputError('expected_title does not match resolved metadata; PDF was not downloaded');
    const pinned=resolved.paper.ids.arxiv_version;
    if(!/v\d+$/.test(pinned))throw new SourceError('invalid_response','arXiv exact version is missing');
    const response=await this.sources.get('arxiv',`https://arxiv.org/pdf/${pinned}`,{maxBytes:50000000,binary:true,cache:false});
    if(!response.body.subarray(0,5).equals(Buffer.from('%PDF-')))throw new SourceError('invalid_response','Download is not a PDF');
    const hash=sha(response.body);
    const file=this.http.writeArtifact('papers',response.body,'pdf');
    const manifest={paper:resolved.paper,arxiv_version:pinned,sha256:hash,bytes:response.body.length,source:file,url:response.url,fetched_at:response.fetched_at,
      identity_validation:'authoritative arXiv version URL and PDF signature; reader should verify title on import'};
    const manifestPath=this.http.writeArtifact('papers',manifest);
    return {...manifest,manifest_path:manifestPath,reader_next:{tool:'paper_import',arguments:{source:file,provenance_manifest:manifestPath,expected_title:args.expected_title ?? resolved.paper.title}}};
  }
  async loadRun(runId) {
    // Resolve a run ID only inside this service's immutable run directory.
    const {readdirSync}=await import('../lib/guarded-fs.mjs');
    const dir=underRoot(absolutePath(path.join(this.root,'runs')),this.root);
    const names=readdirSync(dir).filter(name=>name.endsWith('-'+runId+'.json'));
    if(names.length!==1)throw new InputError('Unknown or ambiguous run_id');
    const runPath=underRoot(absolutePath(path.join(dir,names[0])),this.root);
    return {run:JSON.parse(readFileSync(runPath,'utf8')),runPath};
  }
  async read(args) {
    const {run,runPath}=await this.loadRun(args.run_id);
    const offset=args.offset ?? 0,limit=args.limit ?? 20;
    const papers=run.papers.slice(offset,offset+limit).map(p=>presented(p,args));
    return {run_id:args.run_id,run_path:runPath,status:run.status,unique_candidates:run.unique_candidates,
      saved_candidates:run.papers.length,offset,returned:papers.length,papers,
      truncated:offset+papers.length<run.papers.length,next_offset:offset+papers.length<run.papers.length?offset+papers.length:null};
  }
  async export(args) {
    const {run}=await this.loadRun(args.run_id);
    const table=['# 学术检索候选表','',`检索日期：${run.created_at}；状态：${run.status}。`, '', '相关性依据为标题和摘要，正文尚待 reader 核对。','',
      '| 顺序 | 论文 | 日期 | 来源 | 匹配词 | 缺失字段 |','|---|---|---|---|---|---|',
      ...run.papers.map((p,i)=>`| ${i+1} | ${escapeMd(p.title)}${p.url?' — '+escapeMd(p.url):''} | ${escapeMd(p.published_at || p.year)} | ${[...new Set(p.source_records.map(r=>r.source))].join(', ')} | ${escapeMd(p.relevance.matched_terms.join(', '))} | ${p.missing_fields.join(', ')} |`)];
    const bib=run.papers.map(p=>`@misc{paper_${p.work_id},\n  title = {${bibValue(p.title)}},\n  author = {${p.authors.map(bibValue).join(' and ')}},\n  ${p.published_at || p.year?`year = {${bibValue(p.published_at?.slice(0,4) ?? p.year)}},\n  `:''}${p.ids.doi?`doi = {${bibValue(p.ids.doi)}},\n  `:''}${p.ids.arxiv?`eprint = {${bibValue(p.ids.arxiv)}},\n  archivePrefix = {arXiv},\n  `:''}url = {${bibValue(p.url)}}\n}`).join('\n\n');
    return {run_id:args.run_id,markdown:this.http.writeArtifact('exports',table.join('\n')+'\n','md'),json:this.http.writeArtifact('exports',run),bibtex:this.http.writeArtifact('exports',bib+'\n','bib')};
  }
  async call(name,args) {
    const def=TOOL_DEFS.find(t=>t.name===name);if(!def)throw new InputError(`Unknown tool: ${name}`);validate(def.inputSchema,args);
    try {
      let data;
      if(name==='academic_search')data=await this.search(args);
      else if(name==='academic_resolve'){try{identifier(args.identifier);}catch(error){throw new InputError(error.message);}data=await this.sources.resolve(args.identifier);}
      else if(name==='academic_expand'){try{identifier(args.identifier);}catch(error){throw new InputError(error.message);}data=await this.sources.expand(args.identifier,args);data={...data,seed:args.identifier,direction:args.direction ?? 'references',papers:data.papers.map(p=>compact(p,args.abstract_chars ?? 1000)),status:data.papers.length?'ok':'ok_zero_results'};}
      else if(name==='academic_fetch')data=await this.fetch(args);
      else if(name==='academic_read')data=await this.read(args);
      else data=await this.export(args);
      return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,...(data.status==='failed'?{isError:true}:{})};
    } catch(error) {
      if(error instanceof InputError)throw error;
      if(!(error instanceof SourceError))throw error;
      const data={status:error.status,error:error.message,...error.details};
      return {isError:true,content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
    }
  }
}
