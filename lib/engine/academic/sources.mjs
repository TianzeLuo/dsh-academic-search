import { SourceError } from './http.mjs';
import { parseArxiv, parseOpenAlex, parseSemantic, parseCrossref, identifier, baseArxiv, array } from './model.mjs';

const OA_FIELDS='id,title,doi,authorships,publication_date,updated_date,type,abstract_inverted_index,primary_location,best_oa_location,cited_by_count,topics';
const S2_FIELDS='title,authors,externalIds,abstract,year,publicationDate,venue,openAccessPdf,url,citationCount';
export function headersFor(source,env=process.env) {
  if(source==='openalex' && env.OPENALEX_API_KEY) return {Authorization:`Bearer ${env.OPENALEX_API_KEY}`};
  if(source==='semanticscholar' && env.SEMANTIC_SCHOLAR_API_KEY) return {'x-api-key':env.SEMANTIC_SCHOLAR_API_KEY};
  return {};
}
function json(response) {try{return JSON.parse(response.body);}catch{throw new SourceError('invalid_response','Provider returned invalid JSON');}}
function parsed(parser,value) {try{return parser(value);}catch(error){throw new SourceError('invalid_response',error.message);}}
export function arxivQuery(query) {
  if(/\b(?:ti|au|abs|cat|all|submittedDate):/.test(query)) return query;
  const tokens=query.match(/"[^"\n]+"|[\p{L}\p{N}]+(?:[-.][\p{L}\p{N}]+)*/gu) ?? [];
  if(!tokens.length) throw new Error('arXiv query has no searchable terms');
  return tokens.map(token=>`all:"${token.replace(/^"|"$/g,'')}"`).join(' AND ');
}
function endpoint(base,params) {const url=new URL(base);for(const [key,value] of Object.entries(params)) if(value!==undefined) url.searchParams.set(key,String(value));return url.href;}
export class Sources {
  constructor(http,{env=process.env}={}) {this.http=http;this.env=env;}
  async get(source,url,options={}) {return this.http.request(source,url,{headers:headersFor(source,this.env),...options});}
  async search(source,query,{per_source=10,date_from,date_to,mode='keyword',query_plan}={}) {
    let url;
    const originalQuery=query;
    if(query_plan && mode!=='semantic') query=query_plan.required.map(term=>'"'+term.replaceAll('"','')+'"').join(' ');
    let executedQuery=query;
    if(source==='arxiv') {
      let text=arxivQuery(query);
      if(date_from || date_to) text+=` AND submittedDate:[${(date_from ?? '1991-01-01').replaceAll('-','')}0000 TO ${(date_to ?? '9999-12-31').replaceAll('-','')}2359]`;
      executedQuery=text;
      url=endpoint('https://export.arxiv.org/api/query',{search_query:text,start:0,max_results:per_source,sortBy:'relevance',sortOrder:'descending'});
    } else if(source==='openalex') {
      const filters=[];if(date_from)filters.push(`from_publication_date:${date_from}`);if(date_to)filters.push(`to_publication_date:${date_to}`);
      url=endpoint('https://api.openalex.org/works',{[mode==='semantic'?'search.semantic':'search']:query,per_page:per_source,select:OA_FIELDS,...(filters.length?{filter:filters.join(',')}:{})});
    } else if(source==='semanticscholar') {
      url=endpoint('https://api.semanticscholar.org/graph/v1/paper/search',{query,limit:per_source,fields:S2_FIELDS,...(date_from || date_to?{publicationDateOrYear:`${date_from ?? ''}:${date_to ?? ''}`}:{})});
    } else if(source==='crossref') {
      const filters=[];if(date_from)filters.push(`from-pub-date:${date_from}`);if(date_to)filters.push(`until-pub-date:${date_to}`);
      url=endpoint('https://api.crossref.org/works',{'query.bibliographic':query,rows:per_source,...(filters.length?{filter:filters.join(',')}:{})});
    } else throw new Error(`Unknown source ${source}`);
    try {
    const response=await this.get(source,url);
    let papers,total;
    if(source==='arxiv') {try{({papers,total}=parseArxiv(response.body));}catch(error){throw new SourceError('invalid_response',error.message);}}
    else {
      const data=json(response);
      const items=source==='openalex'?data.results:source==='semanticscholar'?data.data:data.message?.items;
      if(!Array.isArray(items)) throw new SourceError('invalid_response',`${source}: expected results array`);
      const parse=source==='openalex'?parseOpenAlex:source==='semanticscholar'?parseSemantic:parseCrossref;
      try{papers=items.map(parse);}catch(error){throw new SourceError('invalid_response',error.message);}
      total=source==='openalex'?data.meta?.count:source==='semanticscholar'?data.total:data.message?.['total-results'];
    }
    return {source,query:originalQuery,executed_query:executedQuery,optional_terms:query_plan?.optional ?? [],papers,total:total ?? null,status:papers.length?'ok':'ok_zero_results',
      ...(papers.length===0?{query_suggestion:'Try one shorter required concept in a new explicitly budgeted call; no automatic retry was sent'}:{}),
      truncated:total==null?null:total>papers.length,url:response.url,cached:response.cached,fetched_at:response.fetched_at,elapsed_ms:response.elapsed_ms};
    } catch(error) {
      if (!(error instanceof SourceError)) throw error;
      throw new SourceError(error.status,error.message,{...error.details,url,executed_query:executedQuery,optional_terms:query_plan?.optional ?? []});
    }
  }
  async resolve(value) {
    const id=identifier(value);
    if(id.type==='arxiv') {
      const response=await this.get('arxiv',endpoint('https://export.arxiv.org/api/query',{id_list:id.value,max_results:1}));
      const result=parsed(parseArxiv,response.body);
      const p=result.papers.find(p=>p.ids.arxiv===baseArxiv(id.value));
      if(!p || (/v\d+$/.test(id.value) && p.ids.arxiv_version!==id.value)) throw new SourceError('not_found','Requested arXiv identity/version not returned');
      return {paper:p,fetched_at:response.fetched_at,cached:response.cached};
    }
    if(id.type==='openalex' || id.type==='doi') {
      const response=await this.get('openalex',`https://api.openalex.org/works/${encodeURIComponent(id.type==='doi'?'https://doi.org/'+id.value:id.value)}?select=${OA_FIELDS}`);
      const p=parsed(parseOpenAlex,json(response));
      if(id.type==='doi' && p.ids.doi!==id.value || id.type==='openalex' && p.ids.openalex!==id.value) throw new SourceError('invalid_response','Resolved identity does not match request');
      return {paper:p,fetched_at:response.fetched_at,cached:response.cached};
    }
    const response=await this.get('semanticscholar',`https://api.semanticscholar.org/graph/v1/paper/${id.value}?fields=${S2_FIELDS}`);
    const p=parsed(parseSemantic,json(response));
    if(p.ids.semanticscholar!==id.value) throw new SourceError('invalid_response','Resolved identity does not match request');
    return {paper:p,fetched_at:response.fetched_at,cached:response.cached};
  }
  async expand(value,{direction='references',limit=10}={}) {
    const id=identifier(value);
    // OpenAlex edges require its own ID or a DOI; arXiv graph retrieval uses S2.
    if(id.type==='openalex' || id.type==='doi') {
      let work=id.value;
      if(id.type==='doi') work=(await this.resolve(value)).paper.ids.openalex;
      if(direction==='citations') {
        const response=await this.get('openalex',endpoint('https://api.openalex.org/works',{filter:`cites:${work}`,per_page:limit,select:OA_FIELDS}));
        const data=json(response);
        if(!Array.isArray(data.results)) throw new SourceError('invalid_response','Missing citation results');
        return {source:'openalex',papers:data.results.map(p=>parsed(parseOpenAlex,p)),total:data.meta?.count ?? null,truncated:(data.meta?.count ?? 0)>limit,fetched_at:response.fetched_at};
      }
      const response=await this.get('openalex',`https://api.openalex.org/works/${work}?select=id,referenced_works`);
      const seed=json(response);
      if(seed.id!=='https://openalex.org/'+work)throw new SourceError('invalid_response','Reference seed identity does not match request');
      const refs=seed.referenced_works;
      if(!Array.isArray(refs)) throw new SourceError('invalid_response','Missing referenced works');
      const ids=refs.slice(0,limit).map(ref=>{
        let resolved;try{resolved=identifier(ref);}catch{throw new SourceError('invalid_response','Invalid referenced work identity');}
        if(resolved.type!=='openalex')throw new SourceError('invalid_response','Expected OpenAlex reference identity');
        return resolved.value;
      });
      if(!ids.length) return {source:'openalex',papers:[],total:0,truncated:false,fetched_at:response.fetched_at};
      const batch=await this.get('openalex',endpoint('https://api.openalex.org/works',{filter:'openalex:'+ids.join('|'),per_page:limit,select:OA_FIELDS}));
      const data=json(batch);
      if(!Array.isArray(data.results)) throw new SourceError('invalid_response','Missing reference results');
      if(data.results.some(p=>!ids.includes(p?.id?.replace('https://openalex.org/',''))))throw new SourceError('invalid_response','Reference hydration returned an unrequested work');
      return {source:'openalex',papers:data.results.map(p=>parsed(parseOpenAlex,p)),total:refs.length,truncated:refs.length>limit,
        missing_ids:ids.filter(id=>!data.results.some(p=>p.id==='https://openalex.org/'+id)),fetched_at:batch.fetched_at};
    }
    const s2id=id.type==='arxiv'?'ARXIV:'+baseArxiv(id.value):id.value;
    const response=await this.get('semanticscholar',endpoint(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2id)}/${direction}`,{limit,fields:S2_FIELDS}));
    const data=json(response);
    if(!Array.isArray(data.data)) throw new SourceError('invalid_response','Missing graph edges');
    return {source:'semanticscholar',papers:data.data.map(edge=>parsed(parseSemantic,direction==='references'?edge?.citedPaper:edge?.citingPaper)),total:null,truncated:data.next!=null,fetched_at:response.fetched_at};
  }
}
