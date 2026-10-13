import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from '../vendor/node_modules/fast-xml-parser/src/fxp.js';

export const SOURCES = ['arxiv', 'openalex', 'semanticscholar', 'crossref'];
export const sha = value => createHash('sha256').update(value).digest('hex');
export const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
export const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
export const titleKey = value => clean(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function doiId(value) {
  const text = clean(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').toLowerCase();
  return /^10\.\d{4,9}\/\S+$/i.test(text) ? text : null;
}
export function arxivId(value) {
  const text = clean(value).replace(/^arxiv:/i, '').replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '').replace(/\.pdf$/, '');
  return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/.test(text) ? text : null;
}
export const baseArxiv = value => arxivId(value)?.replace(/v\d+$/, '') ?? null;
export const arxivFromDoi = value => /^10\.48550\/arxiv\./i.test(value ?? '') ? baseArxiv(value.slice('10.48550/arxiv.'.length)) : null;
export function identifier(value) {
  const arxiv = arxivId(value);
  if (arxiv) return { type: 'arxiv', value: arxiv };
  const doi = doiId(value);
  if (doi) return { type: 'doi', value: doi };
  const openalex = clean(value).replace(/^https?:\/\/openalex\.org\//, '').replace(/^openalex:/i, '');
  if (/^W\d+$/.test(openalex)) return { type: 'openalex', value: openalex };
  const semantic = clean(value).replace(/^https?:\/\/www\.semanticscholar\.org\/paper\/(?:[^/]+\/)?/, '').replace(/^s2:/i, '');
  if (/^[a-f0-9]{40}$/.test(semantic)) return { type: 'semanticscholar', value: semantic };
  throw new Error('Use an arXiv ID/URL, DOI, OpenAlex W ID or Semantic Scholar paper ID');
}
function paper(source, values) {
  const title = clean(values.title);
  if (!title) throw new Error(`${source}: missing paper title`);
  return { title, authors: [], abstract: null, published_at: null, updated_at: null, venue: null,
    publication_status: 'unknown', ids: {}, url: null, pdf_url: null, citation_count: null, categories: [],
    ...values, title, source };
}
export function abstractFromIndex(index) {
  if (!index || typeof index !== 'object') return null;
  const words = [];
  for (const [word, positions] of Object.entries(index)) for (const pos of array(positions)) {
    if (Number.isInteger(pos) && pos >= 0 && pos < 30000) words.push([pos,word]);
  }
  return words.sort((a,b)=>a[0]-b[0]).map(x=>x[1]).join(' ') || null;
}
export function parseArxiv(text) {
  if (!/<feed[\s>]/.test(text) || /<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new Error('arxiv: response is not a valid Atom feed');
  const parser = new XMLParser({ignoreAttributes:false, removeNSPrefix:true, parseTagValue:false, processEntities:true});
  const feed = parser.parse(text).feed;
  if (feed === undefined || feed === null) throw new Error('arxiv: missing feed');
  const papers = array(feed.entry).map(entry => {
    const id = arxivId(entry.id);
    if (!id) throw new Error(`arxiv: invalid entry identity`);
    return paper('arxiv', { title:entry.title, authors:array(entry.author).map(a=>clean(a.name)), abstract:clean(entry.summary) || null,
      published_at:entry.published ?? null, updated_at:entry.updated ?? null, publication_status:'preprint',
      ids:{arxiv:baseArxiv(id),arxiv_version:id,...(doiId(entry.doi)?{doi:doiId(entry.doi)}:{})},
      url:`https://arxiv.org/abs/${id}`, pdf_url:`https://arxiv.org/pdf/${id}`,
      venue:clean(entry['journal_ref']) || null, categories:array(entry.category).map(c=>c['@_term']).filter(Boolean) });
  });
  return {papers,total:Number(feed.totalResults ?? papers.length)};
}
export function parseOpenAlex(data) {
  if (!/^https:\/\/openalex\.org\/W\d+$/.test(data?.id ?? '')) throw new Error('openalex: invalid work identity');
  return paper('openalex', {title:data.title, authors:array(data.authorships).map(a=>a.author?.display_name).filter(Boolean),
    abstract:abstractFromIndex(data.abstract_inverted_index), published_at:data.publication_date ?? null,
    updated_at:data.updated_date ?? null, venue:data.primary_location?.source?.display_name ?? null,
    publication_status:data.type === 'preprint' ? 'preprint' : 'unknown',
    ids:{openalex:clean(data.id).replace('https://openalex.org/',''), ...(doiId(data.doi)?{doi:doiId(data.doi)}:{}),...(arxivFromDoi(doiId(data.doi))?{arxiv:arxivFromDoi(doiId(data.doi))}:{})},
    url:data.primary_location?.landing_page_url || data.id,
    pdf_url:data.best_oa_location?.pdf_url || data.primary_location?.pdf_url || null,
    citation_count:data.cited_by_count ?? null, categories:array(data.topics).slice(0,6).map(t=>t.display_name).filter(Boolean)});
}
export function parseSemantic(data) {
  if (!/^[a-f0-9]{40}$/.test(data?.paperId ?? '')) throw new Error('semanticscholar: invalid paper identity');
  const ids = {semanticscholar:data.paperId};
  if (doiId(data.externalIds?.DOI)) ids.doi=doiId(data.externalIds.DOI);
  if (baseArxiv(data.externalIds?.ArXiv)) ids.arxiv=baseArxiv(data.externalIds.ArXiv);
  return paper('semanticscholar',{title:data.title, authors:array(data.authors).map(a=>a.name).filter(Boolean),abstract:data.abstract ?? null,
    published_at:data.publicationDate ?? null, year:data.year ?? null, venue:data.venue || null, ids,
    url:data.url || `https://www.semanticscholar.org/paper/${data.paperId}`,pdf_url:data.openAccessPdf?.url ?? null,citation_count:data.citationCount ?? null});
}
export function parseCrossref(data) {
  const parts=(data.published ?? data.issued)?.['date-parts']?.[0];
  const published=parts?.length >= 3 ? parts.slice(0,3).map((v,i)=>i?String(v).padStart(2,'0'):String(v)).join('-') : null;
  return paper('crossref',{title:array(data.title)[0],authors:array(data.author).map(a=>clean([a.given,a.family].filter(Boolean).join(' '))),
    abstract:data.abstract ? clean(data.abstract.replace(/<[^>]*>/g,' ')) : null,published_at:published,year:parts?.[0] ?? null,
    ids:doiId(data.DOI)?{doi:doiId(data.DOI)}:{},venue:array(data['container-title'])[0] ?? null,url:data.URL ?? null,
    pdf_url:null,citation_count:data['is-referenced-by-count'] ?? null});
}
// Explicit source IDs only: source-local IDs are never matched across namespaces.
function aliases(p) { return Object.entries(p.ids).filter(([key,value])=>value && key !== 'arxiv_version').map(([key,value])=>`${key}:${value}`); }
function conflict(a,b) { return ['doi','arxiv'].some(key=>a[key] && b[key] && a[key]!==b[key]); }
export function fuse(results, queryTexts, limit = 20, {queryPlan,ranking=queryPlan ? 'relevance' : 'legacy'} = {}) {
  const groups=[];
  for (const result of results) {
    result.papers.forEach((p,index)=> {
      const matches=groups.filter(g=>!conflict(g.ids,p.ids) && aliases(p).some(id=>g.aliases.has(id)));
      let group=matches[0];
      // Exact normalized title + exact ordered authors is a fallback only; conflicts remain separate.
      if (!group && p.authors.length) group=groups.find(g=>!conflict(g.ids,p.ids) && titleKey(g.title)===titleKey(p.title) && titleKey(g.authors.join('|'))===titleKey(p.authors.join('|')));
      if (!group) { group={...p,ids:{...p.ids},aliases:new Set(aliases(p)),source_records:[],score:0};groups.push(group); }
      for(const other of matches.slice(1)) {
        if(conflict(group.ids,other.ids))continue;
        Object.assign(group.ids,other.ids);other.aliases.forEach(id=>group.aliases.add(id));
        group.source_records.push(...other.source_records);
        if(!group.abstract && other.abstract)group.abstract=other.abstract;
        if(!group.pdf_url && other.pdf_url)group.pdf_url=other.pdf_url;
        groups.splice(groups.indexOf(other),1);
      }
      aliases(p).forEach(id=>group.aliases.add(id)); Object.assign(group.ids,p.ids);
      if (!group.abstract && p.abstract) group.abstract=p.abstract;
      if (!group.pdf_url && p.pdf_url) group.pdf_url=p.pdf_url;
      group.source_records.push({source:result.source,query:result.query,rank:index+1,fetched_at:result.fetched_at,record:p});
    });
  }
  const ranked=groups.map(g=> {
    const ranks=new Map();
    for(const record of g.source_records) {const key=record.source+'|'+record.query;ranks.set(key,Math.min(ranks.get(key) ?? Infinity,record.rank));}
    g.score=[...ranks.values()].reduce((score,rank)=>score+1/(60+rank),0);
    const evidenceText=titleKey(g.title+' '+(g.abstract ?? ''));
    const tokens=[...new Set(queryTexts.flatMap(q=>titleKey(q).split(' ')).filter(t=>t.length>2 && !['the','and','for','with','from','what','which','are','does'].includes(t)))];
    const overlap=tokens.filter(t=>evidenceText.split(' ').includes(t));
    const required=queryPlan?.required ?? [];
    const missingRequired=required.filter(term=>!titleKey(term).split(' ').every(t=>evidenceText.split(' ').includes(t)));
    const phraseMatches=queryTexts.filter(q=>evidenceText.includes(titleKey(q)));
    // A transparent lexical heuristic, not a semantic relevance judgement.
    // Evaluate each query separately: independent query variants are alternatives.
    const coverage=Math.max(0,...queryTexts.map(q=>{
      const terms=[...new Set(titleKey(q).split(' ').filter(t=>tokens.includes(t)))];
      return terms.filter(t=>evidenceText.split(' ').includes(t)).length/Math.max(1,terms.length);
    }));
    const requiredCoverage=required.length?(required.length-missingRequired.length)/required.length:coverage;
    const optionalMatches=(queryPlan?.optional ?? []).filter(term=>evidenceText.includes(titleKey(term)));
    const exact=queryTexts.some(q=>titleKey(q)===titleKey(g.title));
    const identity=aliases(g).sort().join('|') || titleKey(g.title)+'|'+g.authors.join('|');
    const {aliases:ignored,...out}=g;
    const score=ranking==='rrf'?g.score:ranking==='legacy'?g.score*(1+0.25*overlap.length/Math.max(1,tokens.length))+(exact?1:0):requiredCoverage+0.1*coverage+0.05*Math.min(1,phraseMatches.length)+0.01*optionalMatches.length+0.1*g.score+(exact?1:0);
    return {...out,work_id:sha(identity).slice(0,20),rrf_score:Number(g.score.toFixed(8)),score:Number(score.toFixed(8)),
      relevance:{basis:g.abstract?'title_and_abstract':'title_only',matched_terms:overlap,missing_terms:tokens.filter(t=>!overlap.includes(t)),missing_required:missingRequired,optional_matches:optionalMatches,coverage,exact_title:exact,
        reasons:[...(missingRequired.length?['required_concepts_missing']:[]),...(!overlap.length?['no_query_term_match']:[]),...(!g.abstract?['abstract_unavailable']:[])],
        method:ranking==='rrf'?'rrf60':ranking==='legacy'?'rrf60_with_bounded_term_overlap; no full-text relevance judgement':'lexical_concept_coverage_then_rrf60; no semantic or full-text judgement'},
      missing_fields:['abstract','published_at','venue','pdf_url'].filter(key=>!g[key])};
  }).sort((a,b)=>b.score-a.score || a.work_id.localeCompare(b.work_id));
  return {papers:ranked.slice(0,limit),unique_candidates:ranked.length,truncated:ranked.length>limit};
}
