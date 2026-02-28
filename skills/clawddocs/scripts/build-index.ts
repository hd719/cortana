#!/usr/bin/env npx tsx
async function main(){const [cmd,...rest]=process.argv.slice(2);if(cmd==='fetch')console.log('Downloading all docs...');else if(cmd==='build')console.log('Building search index...');else if(cmd==='search')console.log(`Semantic search for: ${rest.join(' ')}`);else console.log('Usage: build-index.ts {fetch|build|search <query>}');}
main();
