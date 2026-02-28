#!/usr/bin/env npx tsx
import { execSync } from 'node:child_process';

const run = (cmd: string) => execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });

function list(sort = 'cpu', limit = 25) {
  const out = run(`ps -Ao pid,pcpu,pmem,user,comm,args -r | head -n ${Number(limit) + 1}`);
  console.log(`Processes (sorted by ${sort})\n${out}`);
}

function top(type = 'cpu', limit = 10) { list(type, limit); }

function info(pid: number) {
  console.log(run(`ps -p ${pid} -o pid,ppid,user,stat,%cpu,%mem,lstart,command`));
  try { console.log(run(`lsof -p ${pid} | head -n 40`)); } catch {}
}

function find(name: string) { console.log(run(`ps -Ao pid,pcpu,pmem,comm,args | grep -i ${JSON.stringify(name)} | grep -v grep || true`)); }
function ports(port?: number, listening = false) { console.log(run(`lsof -nP -i${port ? ` :${port}` : ''} ${listening ? '| grep LISTEN' : ''} || true`)); }
function killProc(pid?: number, name?: string, force = false) {
  if (pid) run(`kill ${force ? '-9' : ''} ${pid}`);
  if (name) run(`pkill ${force ? '-9' : ''} -f ${JSON.stringify(name)}`);
}
function summary() {
  console.log(run('uptime'));
  console.log(run('vm_stat | head -n 20'));
  console.log(run('df -h /'));
}
async function watch(interval = 2) { while (true) { console.clear(); summary(); await new Promise((r) => setTimeout(r, interval * 1000)); } }

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'list-procs': list(args[1] ?? 'cpu', Number(args[3] ?? 25)); break;
    case 'top': top(args[1] ?? 'cpu', Number(args[3] ?? 10)); break;
    case 'info': info(Number(args[0])); break;
    case 'find': find(args[0] ?? ''); break;
    case 'ports': ports(args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : undefined, args.includes('--listening')); break;
    case 'kill': killProc(args[0] && !args[0].startsWith('-') ? Number(args[0]) : undefined, args.includes('--name') ? args[args.indexOf('--name') + 1] : undefined, args.includes('--force')); break;
    case 'summary': summary(); break;
    case 'watch': await watch(Number(args.includes('--interval') ? args[args.indexOf('--interval') + 1] : 2)); break;
    default: console.log('Usage: process-watch.ts {list-procs|top|info <pid>|find <name>|ports [--port N] [--listening]|kill <pid>|summary|watch}');
  }
}
main().catch((e) => { console.error(String(e)); process.exit(1); });
