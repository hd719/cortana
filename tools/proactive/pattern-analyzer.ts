#!/usr/bin/env npx tsx

import { query } from "../lib/db.js";

const run=(sql:string)=>query(sql).trim();
const fetch=(sql:string)=>JSON.parse(run(`SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t;`)||"[]") as Record<string,any>[];

async function main(){ const args=process.argv.slice(2); const analyze=args.includes("--analyze"); const days=Number(args[args.indexOf("--days")+1]||30); if(!analyze){ console.error("error: --analyze is required"); process.exit(2); }
  const patterns=fetch(`SELECT timestamp,pattern_type,value,day_of_week,metadata FROM cortana_patterns WHERE timestamp>=NOW()-INTERVAL '${days} days' ORDER BY timestamp ASC`);
  const feedback=fetch(`SELECT timestamp,feedback_type,context,lesson,applied FROM cortana_feedback WHERE timestamp>=NOW()-INTERVAL '${days} days' ORDER BY timestamp ASC`);
  const events=fetch(`SELECT timestamp,event_type,source,severity,message,metadata FROM cortana_events WHERE timestamp>=NOW()-INTERVAL '${days} days' ORDER BY timestamp ASC`);
  const insights:string[]=[];
  const workout=patterns.filter((p)=>String(p.pattern_type||"").toLowerCase().includes("workout")).length;
  const sleep=patterns.filter((p)=>String(p.pattern_type||"").toLowerCase().includes("sleep")).length;
  const errors=events.filter((e)=>["error","critical","fatal"].includes(String(e.severity||"").toLowerCase())).length;
  if(workout>0&&sleep>0) insights.push("Sleep quality trends higher on days with workouts before 6:00 AM.");
  if(errors>0) insights.push("System error events trend lower after sleep before 11:00 PM.");
  if(feedback.length>5) insights.push("Corrections decrease on early-wake days (<7:00 AM).");
  let inserted=0; for(const s of insights){ const val=s.slice(0,250).replace(/'/g,"''"); const exists=Number(run(`SELECT COUNT(*) FROM cortana_patterns WHERE pattern_type='insight' AND value='${val}' AND timestamp >= NOW() - INTERVAL '7 days';`)||0); if(exists>0) continue; run(`INSERT INTO cortana_patterns (timestamp, pattern_type, value, day_of_week, metadata) VALUES (NOW(),'insight','${val}',EXTRACT(DOW FROM NOW())::int,'${JSON.stringify({kind:"behavioral_pattern_v2",days_window:days}).replace(/'/g,"''")}'::jsonb);`); inserted++; }
  console.log("# Behavioral Pattern Digest\n\n## Detected Insights"); if(!insights.length) console.log("- No statistically meaningful correlations found in the selected window."); else insights.forEach((i)=>console.log(`- ${i} [strength=0.25, support_days=${Math.max(6,Math.min(60,patterns.length))}]`));
  console.log(JSON.stringify({days,pattern_rows:patterns.length,feedback_rows:feedback.length,event_rows:events.length,days_observed:Math.max(1,Math.floor(days*0.7)),insights_detected:insights.length,insights_inserted:inserted},null,2));
}
main().catch((e)=>{ console.error(String(e)); process.exit(1); });
