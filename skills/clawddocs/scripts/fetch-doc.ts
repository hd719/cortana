#!/usr/bin/env npx tsx
async function main(){const p=process.argv[2];if(!p){console.log('Usage: fetch-doc.ts <path>');process.exit(1);}console.log(`Fetching: https://docs.clawd.bot/${p}`);}main();
