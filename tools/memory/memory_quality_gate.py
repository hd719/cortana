#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, re, subprocess
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any

DB_BIN='/opt/homebrew/opt/postgresql@17/bin'; DB='cortana'
ACTION={'must','should','need','todo','remember','prefer','rule','plan','schedule','review','fix','send','build'}
LONG={'always','never','preference','policy','rule','habit','routine','goal','weekly','monthly','career','health','finance'}
SHORT={'today','tomorrow','asap','immediately','now','temporary','one-time'}
NEG={' not ',' never ',' no ',' don\'t ',' do not ',' avoid ',' stop '}

@dataclass
class Candidate:
    text:str; source_type:str='manual'; source_ref:str|None=None; timestamp:str|None=None

def run_psql(sql:str)->str:
    env=os.environ.copy(); env['PATH']=f"{DB_BIN}:{env.get('PATH','')}"
    p=subprocess.run(['psql',DB,'-q','-X','-v','ON_ERROR_STOP=1','-t','-A','-c',sql],capture_output=True,text=True,env=env)
    if p.returncode!=0: raise RuntimeError(p.stderr.strip() or 'psql failed')
    return p.stdout.strip()

def fetch_json(sql:str)->list[dict[str,Any]]:
    raw=run_psql(f"SELECT COALESCE(json_agg(t),'[]'::json)::text FROM ({sql}) t;")
    return json.loads(raw) if raw else []

def toks(t:str)->set[str]: return set(re.findall(r"[A-Za-z][A-Za-z0-9_'-]{2,}",t.lower()))

def sim(a:str,b:str)->float:
    if not a or not b: return 0.0
    seq=SequenceMatcher(None,a.lower(),b.lower()).ratio(); ta,tb=toks(a),toks(b)
    jac=(len(ta&tb)/len(ta|tb)) if (ta or tb) else 0.0
    return max(seq,jac)

def corpus(limit:int)->list[dict[str,Any]]:
    sql=f"""
    WITH e AS (SELECT 'episodic' tier,id::text id,COALESCE(happened_at::text,NOW()::text) ts,TRIM(COALESCE(summary,'')||' '||COALESCE(details,'')) body FROM cortana_memory_episodic WHERE active=TRUE ORDER BY happened_at DESC NULLS LAST LIMIT {limit}),
         s AS (SELECT 'semantic' tier,id::text id,COALESCE(last_seen_at::text,first_seen_at::text,NOW()::text) ts,TRIM(COALESCE(subject,'')||' '||COALESCE(predicate,'')||' '||COALESCE(object_value,'')) body FROM cortana_memory_semantic WHERE active=TRUE ORDER BY last_seen_at DESC NULLS LAST LIMIT {limit}),
         p AS (SELECT 'procedural' tier,id::text id,COALESCE(updated_at::text,created_at::text,NOW()::text) ts,TRIM(COALESCE(workflow_name,'')||' '||COALESCE(trigger_context,'')||' '||COALESCE(expected_outcome,'')) body FROM cortana_memory_procedural WHERE deprecated=FALSE ORDER BY updated_at DESC NULLS LAST LIMIT {limit})
    SELECT * FROM (SELECT * FROM e UNION ALL SELECT * FROM s UNION ALL SELECT * FROM p) x WHERE COALESCE(body,'')<>'' ORDER BY ts DESC LIMIT {limit*2}
    """
    try:
        return fetch_json(sql)
    except Exception:
        return []

def score_actionability(text:str)->float:
    t=f" {text.lower()} "; hits=sum(1 for w in ACTION if (w in toks(t) or f" {w} " in t))
    has_verb=bool(re.search(r"\b(do|build|send|review|fix|create|schedule|call|ship|track|improve)\b",t))
    has_time=bool(re.search(r"\b(today|tomorrow|week|month|by\s+\w+day|\d{1,2}:\d{2})\b",t))
    return round(min(1.0,0.25+0.12*hits+(0.15 if has_verb else 0)+(0.15 if has_time else 0)),3)

def score_shelf(text:str)->float:
    t=text.lower(); long=sum(1 for w in LONG if w in t); short=sum(1 for w in SHORT if w in t)
    if long==0 and short==0: return 0.55
    return round(max(0,min(1,0.5+0.1*long-0.12*short)),3)

def contradiction(new:str,old:str)->tuple[bool,str]:
    ov=toks(new)&toks(old)
    if len(ov)<3: return False,'low overlap'
    nneg=any(w in f" {new.lower()} " for w in NEG); oneg=any(w in f" {old.lower()} " for w in NEG)
    if nneg!=oneg: return True,'polarity flip with shared anchors'
    return False,'none'

def evaluate(c:Candidate,limit:int=300)->dict[str,Any]:
    mem=corpus(limit); scored=[]
    for r in mem:
        s=sim(c.text,str(r.get('body') or ''))
        if s>=0.35: scored.append((s,r))
    scored.sort(key=lambda x:x[0],reverse=True); top=scored[:8]
    rec=len([1 for s,_ in scored if s>=0.72]); novelty=round(max(0,1-(top[0][0] if top else 0)),3)
    recurrence=round(max(0,1-min(rec,8)/8),3); action=score_actionability(c.text); shelf=score_shelf(c.text)
    weighted=round(novelty*0.35+action*0.25+recurrence*0.2+shelf*0.2,3)
    verdict='promote' if (weighted>=0.68 and novelty>=0.4) else ('hold' if weighted>=0.45 else 'archive')
    supers=[]; now=c.timestamp or datetime.now(timezone.utc).isoformat()
    for s,r in top:
        ok,why=contradiction(c.text,str(r.get('body') or ''))
        if ok: supers.append({'tier':r.get('tier'),'id':r.get('id'),'similarity':round(s,3),'demote_recommended':True,'reason':why,'new_memory_timestamp':now})
    reasons=[]
    if novelty<0.35: reasons.append('low novelty')
    if action<0.35: reasons.append('low actionability')
    if shelf<0.35: reasons.append('short shelf-life')
    return {
      'verdict':verdict,
      'scores':{'novelty':novelty,'actionability':action,'recurrence':recurrence,'shelf_life':shelf,'weighted':weighted},
      'recurrence_count':rec,
      'matched_examples':[{'tier':r.get('tier'),'id':r.get('id'),'similarity':round(s,3),'text_preview':str(r.get('body') or '')[:180]} for s,r in top],
      'supersession_flags':supers,
      'reasons':reasons,
    }

def log_event(c:Candidate,res:dict[str,Any]):
    payload=json.dumps({'memory_text':c.text[:500],'source_type':c.source_type,'source_ref':c.source_ref,'result':res}).replace("'","''")
    msg=(f"Evaluated memory candidate: {res['verdict']}").replace("'","''")
    run_psql(f"INSERT INTO cortana_events (event_type,source,severity,message,metadata) VALUES ('memory_quality_gate','memory_quality_gate.py','info','{msg}','{payload}'::jsonb);")

def main()->int:
    ap=argparse.ArgumentParser(description='Score memory quality and return consolidation verdict')
    ap.add_argument('--text'); ap.add_argument('--text-file'); ap.add_argument('--source-type',default='manual')
    ap.add_argument('--source-ref'); ap.add_argument('--timestamp'); ap.add_argument('--corpus-limit',type=int,default=300)
    ap.add_argument('--log-event',action='store_true'); ap.add_argument('--dry-run',action='store_true')
    a=ap.parse_args(); text=a.text or ''
    if a.text_file: text=open(a.text_file,'r',encoding='utf-8').read().strip()
    if not text: raise SystemExit('Provide --text or --text-file')
    c=Candidate(text=text,source_type=a.source_type,source_ref=a.source_ref,timestamp=a.timestamp)
    res=evaluate(c,a.corpus_limit)
    if a.log_event and not a.dry_run: log_event(c,res)
    print(json.dumps(res,indent=2)); return 0

if __name__=='__main__': raise SystemExit(main())
