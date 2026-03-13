#!/usr/bin/env npx tsx
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { getScriptDir, resolveRepoPath } from "../lib/paths.js";

function usage(){console.log(`Usage:\n  run-deliberation.sh <session-uuid>\n\nWhat it does:\n  1) Fetches the council session context\n  2) Spawns Oracle agent to analyze + cast vote\n  3) Spawns Researcher agent to analyze + cast vote\n  4) Runs council-tally.sh to finalize decision`)}
const die=(m:string):never=>{console.log(JSON.stringify({ok:false,error:m}));process.exit(1)};

function run(cmd:string,args:string[]){return spawnSync(cmd,args,{encoding:"utf8"});}

async function main():Promise<void>{
  const a=process.argv.slice(2); if(a[0]==="-h"||a[0]==="--help"){usage();process.exit(0);} if(a.length!==1){usage();process.exit(1);} const sid=a[0];
  if(!/^[0-9a-fA-F-]{36}$/.test(sid)) die("Session id must be a UUID");
  if(run("sh",["-lc","command -v openclaw >/dev/null 2>&1"]).status!==0) die("openclaw CLI not found in PATH");
  const dir=getScriptDir(import.meta.url);
  const council=path.join(dir,"council.ts"); const tally=path.join(dir,"council-tally.ts");
  const s=run("tsx",[council,"status","--session",sid]); if(s.status!==0) die("Unable to load session");
  const sessionJson=(s.stdout||"").trim(); const obj=JSON.parse(sessionJson); const sess=obj.session||{};
  const build=(role:string)=>JSON.stringify({role,instruction:"You are participating in a Council deliberation. Analyze the prompt and cast exactly one vote using the council CLI in this workspace.",required_steps:["Read session context.","Choose one of: approve, reject, abstain.",`Run: ${resolveRepoPath("tools","council","council.sh")} vote --session ${sid} --voter ${role} --vote <approve|reject|abstain> --confidence <0-1> --reasoning '<brief rationale>' --model '<model>'`,"Return a concise summary with vote + confidence."],session:{id:sess.id,title:sess.title,type:sess.type,initiator:sess.initiator,participants:sess.participants,context:sess.context??{}}});
  const runAgent=(role:string)=>run("openclaw",["agent","--agent",role,"--session-id",`council-${sid}-${role}`,"--message",build(role),"--timeout","900","--json"]);
  const o=runAgent("oracle"); if(o.status!==0) die("Oracle agent run failed");
  const orLog=`/tmp/council-${sid}-oracle.json`; fs.writeFileSync(orLog,o.stdout||"");
  const r=runAgent("researcher"); if(r.status!==0) die("Researcher agent run failed");
  const reLog=`/tmp/council-${sid}-researcher.json`; fs.writeFileSync(reLog,r.stdout||"");
  const t=run("tsx",[tally,"--session",sid]); if(t.status!==0) die("Failed to tally council decision");
  console.log(JSON.stringify({ok:true,action:"run_deliberation",session_id:sid,oracle_log:orLog,researcher_log:reLog,tally:JSON.parse((t.stdout||"").trim())}));
}
main();
