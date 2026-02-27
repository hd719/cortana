#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, subprocess
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

DB_BIN='/opt/homebrew/opt/postgresql@17/bin'; DB='cortana'
ACTED={'accepted','completed','in_progress','acted'}
DISMISSED={'dismissed','cancelled','rejected','ignored'}

@dataclass
class Outcome:
    signal_id:int; signal_type:str; confidence:float; bucket:str; task_created:bool; outcome:str

def run_psql(sql:str)->str:
    env=os.environ.copy(); env['PATH']=f"{DB_BIN}:{env.get('PATH','')}"
    p=subprocess.run(['psql',DB,'-q','-X','-v','ON_ERROR_STOP=1','-t','-A','-c',sql],capture_output=True,text=True,env=env)
    if p.returncode!=0: raise RuntimeError(p.stderr.strip() or 'psql failed')
    return p.stdout.strip()

def fetch_json(sql:str)->list[dict[str,Any]]:
    raw=run_psql(f"SELECT COALESCE(json_agg(t),'[]'::json)::text FROM ({sql}) t;")
    return json.loads(raw) if raw else []

def exists(name:str)->bool:
    return (run_psql(f"SELECT to_regclass('{name.replace("'","''")}') IS NOT NULL;") or '').strip().lower()=='t'

def has_col(table:str,col:str)->bool:
    q=("SELECT EXISTS (SELECT 1 FROM information_schema.columns "
       f"WHERE table_schema='public' AND table_name='{table.replace("'","''")}' "
       f"AND column_name='{col.replace("'","''")}');")
    return (run_psql(q) or '').strip().lower()=='t'

def bucket(c:float)->str:
    if c<0.50: return '0.00-0.49'
    if c<0.65: return '0.50-0.64'
    if c<0.80: return '0.65-0.79'
    return '0.80-1.00'

def load_signals(days:int)->list[dict[str,Any]]:
    rows=[]
    if exists('cortana_proactive_signals'):
        ts_col='created_at' if has_col('cortana_proactive_signals','created_at') else ('timestamp' if has_col('cortana_proactive_signals','timestamp') else None)
        where=(f"WHERE {ts_col}>=NOW()-INTERVAL '{int(days)} days'" if ts_col else '')
        rows+=fetch_json(f"SELECT id signal_id,COALESCE(signal_type,'unknown') signal_type,COALESCE(confidence,0)::float8 confidence,metadata FROM cortana_proactive_signals {where} ORDER BY id DESC")
    if len(rows)<10:
        rows+=fetch_json(f"SELECT id signal_id,COALESCE(metadata->>'signal_type',metadata->>'type','unknown') signal_type,COALESCE(NULLIF(metadata->>'confidence','')::float8,0.0) confidence,metadata FROM cortana_events WHERE timestamp>=NOW()-INTERVAL '{int(days)} days' AND (source ILIKE 'proactive%' OR event_type ILIKE 'proactive%') ORDER BY id DESC")
    dedup={}
    for r in rows:
        sid=int(r.get('signal_id') or 0)
        if sid>0 and sid not in dedup: dedup[sid]=r
    return list(dedup.values())

def load_suggestion(days:int)->dict[int,dict[str,Any]]:
    if not exists('cortana_proactive_suggestions'): return {}
    ts_col='created_at' if has_col('cortana_proactive_suggestions','created_at') else ('timestamp' if has_col('cortana_proactive_suggestions','timestamp') else None)
    where=(f"WHERE {ts_col}>=NOW()-INTERVAL '{int(days)} days'" if ts_col else '')
    rows=fetch_json(f"SELECT id,status,metadata FROM cortana_proactive_suggestions {where} ORDER BY id DESC")
    out={}
    for r in rows:
        md=r.get('metadata') if isinstance(r.get('metadata'),dict) else {}
        sid=int(md.get('signal_id') or -1)
        if sid>0 and sid not in out: out[sid]=r
    return out

def load_tasks(days:int)->tuple[set[int],dict[int,str]]:
    if not exists('cortana_tasks'): return set(),{}
    ts_col='created_at' if has_col('cortana_tasks','created_at') else ('timestamp' if has_col('cortana_tasks','timestamp') else None)
    where=(f"{ts_col}>=NOW()-INTERVAL '{int(days)} days' AND " if ts_col else '')
    rows=fetch_json(f"SELECT status,metadata FROM cortana_tasks WHERE {where} source='proactive-detector'")
    created=set(); outcomes={}
    for r in rows:
        md=r.get('metadata') if isinstance(r.get('metadata'),dict) else {}
        sid=int(md.get('signal_id') or -1)
        if sid<=0: continue
        created.add(sid); st=str(r.get('status') or '').lower()
        if st == 'completed': outcomes[sid]='acted'
        elif st in {'cancelled','dismissed','rejected'}: outcomes[sid]='dismissed'
        elif sid not in outcomes: outcomes[sid]='ready'
    return created,outcomes

def build(days:int)->list[Outcome]:
    sigs=load_signals(days); smap=load_suggestion(days); tcreated,tout=load_tasks(days)
    out=[]
    for s in sigs:
        sid=int(s.get('signal_id') or 0)
        if sid<=0: continue
        conf=float(s.get('confidence') or 0.0); state=tout.get(sid,'unknown')
        sg=smap.get(sid)
        if sg and state in {'unknown','ready'}:
            ss=str(sg.get('status') or '').lower()
            if ss in ACTED: state='acted'
            elif ss in DISMISSED: state='dismissed'
            elif ss: state='ready'
        out.append(Outcome(sid,str(s.get('signal_type') or 'unknown'),conf,bucket(conf),sid in tcreated,state))
    return out

def summarize(items:list[Outcome],target:float,min_support:int)->dict[str,Any]:
    by=defaultdict(list)
    for o in items: by[(o.signal_type,o.bucket)].append(o)
    metrics=[]
    for (stype,b),rows in sorted(by.items()):
        acted=sum(1 for r in rows if r.outcome=='acted'); dismissed=sum(1 for r in rows if r.outcome=='dismissed')
        pending=sum(1 for r in rows if r.outcome not in {'acted','dismissed'}); denom=acted+dismissed
        prec=(acted/denom) if denom else None
        metrics.append({'signal_type':stype,'confidence_bucket':b,'support':len(rows),'acted':acted,'dismissed':dismissed,'pending_or_unknown':pending,'task_created':sum(1 for r in rows if r.task_created),'precision':round(prec,3) if prec is not None else None})
    low={'0.00-0.49':0.0,'0.50-0.64':0.5,'0.65-0.79':0.65,'0.80-1.00':0.8}
    by_type=defaultdict(list)
    for m in metrics: by_type[m['signal_type']].append(m)
    rec=[]
    for stype,rows in by_type.items():
        rows=sorted(rows,key=lambda r:low[r['confidence_bucket']],reverse=True); chosen=None
        for r in rows:
            if r['support']>=min_support and r['precision'] is not None and r['precision']>=target:
                chosen=r; break
        rec.append({'signal_type':stype,'recommended_min_confidence':(low[chosen['confidence_bucket']] if chosen else 0.8),'reason':(f"precision {chosen['precision']:.2f} support {chosen['support']} in {chosen['confidence_bucket']}" if chosen else 'insufficient high-precision evidence; tighten to 0.80')})
    oa=sum(1 for i in items if i.outcome=='acted'); od=sum(1 for i in items if i.outcome=='dismissed'); d=oa+od
    return {'generated_at':datetime.now(timezone.utc).isoformat(),'signals_analyzed':len(items),'outcomes_with_decision':d,'overall_precision':round(oa/d,3) if d else None,'metrics':metrics,'recommendations':rec}

def write_event(summary:dict[str,Any],dry:bool):
    if dry: return
    sev='warning' if (summary.get('overall_precision') is not None and summary['overall_precision']<0.45) else 'info'
    payload=json.dumps(summary).replace("'","''")
    run_psql(f"INSERT INTO cortana_events (event_type,source,severity,message,metadata) VALUES ('proactive_calibration','evaluate_accuracy.py','{sev}','Proactive calibration complete','{payload}'::jsonb);")

def main()->int:
    ap=argparse.ArgumentParser(description='Evaluate proactive detector precision and suggest threshold tuning')
    ap.add_argument('--days',type=int,default=30); ap.add_argument('--target-precision',type=float,default=0.60)
    ap.add_argument('--min-support',type=int,default=3); ap.add_argument('--dry-run',action='store_true')
    a=ap.parse_args(); items=build(a.days); summary=summarize(items,a.target_precision,a.min_support)
    write_event(summary,a.dry_run); print(json.dumps(summary,indent=2)); return 0

if __name__=='__main__': raise SystemExit(main())
