import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { sha } from './model.mjs';
import { absolutePath, assertWrite, assertRead, existsSync, readFileSync, writeFileSync, mkdirSync, PathBoundaryError } from '../lib/guarded-fs.mjs';

export class SourceError extends Error {
  constructor(status,message,details={}) {super(message);this.status=status;this.details=details;}
}
const HOSTS = new Set(['export.arxiv.org','arxiv.org','api.openalex.org','api.semanticscholar.org','api.crossref.org']);
export function allowedUrl(value) {
  const url=new URL(value);
  if (url.protocol!=='https:' || !HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port!=='443')) throw new SourceError('boundary_rejected','URL is outside the supported academic services');
  return url;
}
export class HttpClient {
  constructor({dataRoot,fetchImpl=fetch,timeoutMs=15000,cacheTtlMs=86400000,intervals={arxiv:3100,openalex:1100,semanticscholar:1100,crossref:1100},clock=()=>Date.now()}={}) {
    this.root=absolutePath(dataRoot);this.fetch=fetchImpl;this.timeout=timeoutMs;this.ttl=cacheTtlMs;this.intervals=intervals;this.clock=clock;
    this.queues=new Map();this.last=new Map();this.cooldowns=new Map();
  }
  async boundedBody(response,maxBytes) {
    if (Number(response.headers.get('content-length'))>maxBytes) throw new SourceError('too_large','Response exceeds byte budget');
    const chunks=[];let length=0;
    for await (const chunk of response.body ?? []) {length+=chunk.byteLength;if(length>maxBytes) {await response.body.cancel?.().catch(()=>{});throw new SourceError('too_large','Response exceeds byte budget');}chunks.push(Buffer.from(chunk));}
    return Buffer.concat(chunks);
  }
  async request(source,urlValue,{headers={},maxBytes=8000000,binary=false,cache=true}={}) {
    const url=allowedUrl(urlValue).href;
    const key=sha(source+'|'+url+'|'+sha(JSON.stringify(headers)));
    const cacheDir=absolutePath(path.join(this.root,'http-cache'));
    const cacheFile=absolutePath(path.join(cacheDir,key+'.json'));
    if (cache && !binary && this.ttl>0 && existsSync(cacheFile)) {
      const cached=JSON.parse(readFileSync(cacheFile,'utf8'));
      if (this.clock()-cached.saved_at<this.ttl) return {...cached.response,cached:true};
    }
    const previous=this.queues.get(source) ?? Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=> {
      const cooldownDir=absolutePath(path.join(this.root,'source-state'));
      const cooldownFile=absolutePath(path.join(cooldownDir,sha(source)+'.json'));
      if(existsSync(cooldownFile)) {
        const stored=JSON.parse(readFileSync(cooldownFile,'utf8'));
        if(Number.isFinite(stored.cooldown_until))this.cooldowns.set(source,Math.max(this.cooldowns.get(source) ?? 0,stored.cooldown_until));
      }
      if ((this.cooldowns.get(source) ?? 0)>this.clock()) throw new SourceError('rate_limited','Source is cooling down after HTTP 429');
      const delay=(this.last.get(source) ?? 0)+(this.intervals[source] ?? 1100)-this.clock();
      if (delay>0) await sleep(delay);
      const started=this.clock(); this.last.set(source,started);
      const signal=AbortSignal.timeout(this.timeout);
      try {
        let requestUrl=url,response;
        for(let hop=0;hop<4;hop++) {
          response=await this.fetch(requestUrl,{headers:{'User-Agent':'codex-academic-search/0.1 (bounded personal literature retrieval)',...headers},signal,redirect:'manual'});
          if (![301,302,303,307,308].includes(response.status)) break;
          const location=response.headers.get('location');
          if(!location) throw new SourceError('invalid_response','Redirect without a location');
          const next=allowedUrl(new URL(location,requestUrl).href);
          if(next.hostname!==new URL(requestUrl).hostname && Object.keys(headers).length) throw new SourceError('boundary_rejected','Authenticated cross-host redirect rejected');
          requestUrl=next.href;
          await response.body?.cancel(); response=undefined;
        }
        if(!response) throw new SourceError('invalid_response','Too many redirects');
        if(!response.ok) {
          await response.body?.cancel();
          const status=response.status===429?'rate_limited':[401,403].includes(response.status)?'access_denied':response.status===404?'not_found':'http_error';
          if(response.status===429) {
            const retry=response.headers.get('retry-after');
            const seconds=retry && /^\d+$/.test(retry)?Number(retry):retry?Math.max(0,(Date.parse(retry)-this.clock())/1000):60;
            const cooldown=this.clock()+Math.min(3600,Math.max(60,Number.isFinite(seconds)?seconds:60))*1000;
            this.cooldowns.set(source,cooldown);
            mkdirSync(cooldownDir,{recursive:true});writeFileSync(cooldownFile,JSON.stringify({source,cooldown_until:cooldown}),'utf8');
          }
          throw new SourceError(status,`${source}: HTTP ${response.status}`,{http_status:response.status,retry_after:response.headers.get('retry-after')});
        }
        const body=await this.boundedBody(response,maxBytes);
        const result={body:binary?body:body.toString('utf8'),content_type:response.headers.get('content-type'),url:requestUrl,
          fetched_at:new Date().toISOString(),elapsed_ms:this.clock()-started,cached:false};
        if(cache && !binary && this.ttl>0) {mkdirSync(cacheDir,{recursive:true});writeFileSync(cacheFile,JSON.stringify({saved_at:this.clock(),response:result}),'utf8');}
        return result;
      } catch(error) {
        if(error instanceof SourceError || error instanceof PathBoundaryError) throw error;
        if(['EACCES','EPERM','EROFS','ENOSPC','EIO'].includes(error.code)) throw error;
        const timeout=['TimeoutError','AbortError'].includes(error.name);
        throw new SourceError(timeout?'timeout':'network_error',timeout?`${source}: request timed out`:`${source}: network request failed`,{code:error.cause?.code ?? error.code ?? null});
      }
    });
    this.queues.set(source,task);return task;
  }
  writeArtifact(folder,value,extension='json') {
    const directory=assertWrite(absolutePath(path.join(this.root,folder)));mkdirSync(directory,{recursive:true});
    const file=assertWrite(absolutePath(path.join(directory,`${Date.now()}-${randomUUID()}.${extension}`)));
    writeFileSync(file,typeof value==='string' || Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});return file;
  }
  readArtifact(file) {return JSON.parse(readFileSync(assertRead(absolutePath(file)),'utf8'));}
}
