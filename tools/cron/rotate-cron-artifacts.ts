#!/usr/bin/env npx tsx
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import db from "../lib/db.js";
const { withPostgresPath } = db;

const DB=process.env.CORTANA_DB||"cortana"; const SOURCE="rotate-cron-artifacts.sh";
const RUN_DIR=process.env.OPENCLAW_CRON_RUN_DIR||path.join(process.env.HOME||"",".openclaw/cron/runs");
const ROTATE=500*1024, WARN=1024*1024, RET=7, KEEP=3;

function psql(sql:string){spawnSync("psql",[DB,"-c",sql],{stdio:"ignore",env:withPostgresPath(process.env)});}
function esc(s:string){return s.replace(/'/g,"''");}
function log(sev:string,msg:string,meta="{}"){psql(`INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('cron_artifact_rotation', '${SOURCE}', '${sev}', '${esc(msg)}', '${esc(meta)}'::jsonb);`);}

async function main(){
  if(!fs.existsSync(RUN_DIR)){log("info","cron runs directory missing; skipping artifact rotation",JSON.stringify({run_dir:RUN_DIR}));process.exit(0);} 
  let rotated=0,pruned=0,deleted=0,warn=0;
  for(const file of fs.readdirSync(RUN_DIR).filter(f=>f.endsWith('.jsonl')).map(f=>path.join(RUN_DIR,f))){
    const size=(()=>{try{return fs.statSync(file).size;}catch{return 0;}})();
    if(size<=ROTATE) continue;
    const ts=spawnSync("date",["+%Y%m%d%H%M%S"],{encoding:"utf8"}).stdout.trim();
    const archive=`${file}.${ts}.gz`;
    const gz=spawnSync("sh",["-lc",`gzip -c ${JSON.stringify(file)} > ${JSON.stringify(archive)}`]);
    if(gz.status===0){fs.writeFileSync(file,"");rotated++;log("info","Rotated cron artifact",JSON.stringify({file,archive,bytes_before:size}));}
    else {log("error","Failed to rotate cron artifact",JSON.stringify({file})); try{fs.unlinkSync(archive);}catch{}}
    const vers=fs.readdirSync(RUN_DIR).filter(f=>f.startsWith(path.basename(file)+".")&&f.endsWith('.gz')).sort().reverse();
    vers.forEach((v,i)=>{if(i>=KEEP){try{fs.unlinkSync(path.join(RUN_DIR,v));pruned++;log("info","Pruned extra rotated artifact",JSON.stringify({archive:path.join(RUN_DIR,v),keep_versions:KEEP}));}catch{}}});
  }
  const now=Date.now();
  for(const f of fs.readdirSync(RUN_DIR).filter(f=>f.endsWith('.jsonl.gz')||/\.jsonl\..*\.gz$/.test(f))){
    const p=path.join(RUN_DIR,f);try{const m=fs.statSync(p).mtime.getTime(); if(now-m>RET*86400000){fs.unlinkSync(p);deleted++;log("info","Deleted expired compressed cron artifact",JSON.stringify({archive:p,retention_days:RET}));}}catch{}
  }
  for(const file of fs.readdirSync(RUN_DIR).filter(f=>f.endsWith('.jsonl')).map(f=>path.join(RUN_DIR,f))){
    const size=(()=>{try{return fs.statSync(file).size;}catch{return 0;}})(); if(size>WARN){warn++;log("warning","Oversized cron artifact detected",JSON.stringify({file,bytes:size,warn_threshold:WARN}));}
  }
  log("info","Cron artifact rotation run complete",JSON.stringify({run_dir:RUN_DIR,rotated,pruned_versions:pruned,deleted_old:deleted,oversized_active:warn}));
  console.log(`rotation complete: rotated=${rotated} pruned=${pruned} deleted_old=${deleted} oversized_active=${warn}`);
}
main();
