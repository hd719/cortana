#!/usr/bin/env npx tsx
async function main(){const k=process.argv[2];if(!k){console.log('Usage: search.ts <keyword>');process.exit(1);}console.log(`Searching docs for: ${k}`);}main();
