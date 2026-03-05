#!/usr/bin/env npx tsx
import { spawnSync } from "child_process";
function q(sql:string):string{const r=spawnSync("psql",["cortana","-t","-A","-c",sql],{encoding:"utf8",env:withPostgresPath(process.env)});return r.status===0?(r.stdout||"").trim():""}
async function main(){
 const currentRun=q("SELECT run_id FROM cortana_sitrep ORDER BY timestamp DESC LIMIT 1;");
 const prevRun=q("SELECT run_id FROM (SELECT DISTINCT run_id, MAX(timestamp) OVER (PARTITION BY run_id) ts FROM cortana_sitrep WHERE run_id != (SELECT run_id FROM cortana_sitrep ORDER BY timestamp DESC LIMIT 1)) t ORDER BY ts DESC LIMIT 1;");
 const currentRaw=q("SELECT json_object_agg(domain||'.'||key,value) FROM cortana_sitrep_latest;");
 const previousRaw=prevRun?q(`SELECT json_object_agg(domain||'.'||key,value) FROM cortana_sitrep WHERE run_id='${prevRun.replace(/'/g,"''")}';`):"{}";
 const recentRaw=q("SELECT json_agg(x) FROM (SELECT title,priority,timestamp FROM cortana_insights ORDER BY timestamp DESC LIMIT 15) x;");
 const allow=["calendar.","health.","finance.","tasks.","email.","weather.","system."];
 let cur:any={},prev:any={},recent:any=[]; try{cur=JSON.parse(currentRaw||"{}")}catch{} try{prev=JSON.parse(previousRaw||"{}")}catch{} try{recent=JSON.parse(recentRaw||"[]")}catch{}
 cur=Object.fromEntries(Object.entries(cur).filter(([k])=>allow.some(a=>k.startsWith(a))).slice(0,40));
 prev=Object.fromEntries(Object.entries(prev).filter(([k])=>allow.some(a=>k.startsWith(a))).slice(0,40));
 console.log(JSON.stringify({current_run_id:currentRun,previous_run_id:prevRun,current:cur,previous:prev,recent_insights:(Array.isArray(recent)?recent:[]).slice(0,10)}));
}
main();
