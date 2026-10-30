#!/usr/bin/env node
// node src/cli/reports.mjs --store DIR list | show ID | candidates | promote ID
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
const a = process.argv.slice(2);
const dir = a[a.indexOf('--store') + 1];
const cmd = a.filter((x, i) => i !== a.indexOf('--store') && i !== a.indexOf('--store') + 1);
const ls = (sub) => { const d = path.join(dir, sub); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')) : []; };
const read = (sub, id) => JSON.parse(fs.readFileSync(path.join(dir, sub, `${id}.json`), 'utf8'));
if (cmd[0] === 'list') for (const f of ls('reports')) { const r = read('reports', f.replace('.json', ''));
  console.log(`${r.report_id}  ${r.source}  declared=${r.declared_status}  ${r.project_name ?? '(unregistered)'}  "${r.task_title}"  ${r.body.length} chars`); }
else if (cmd[0] === 'candidates') for (const f of ls('candidates')) { const c = read('candidates', f.replace('.json', ''));
  console.log(`${c.candidate_id}  reason=${c.reason}  promoted=${c.promoted}  ${c.project_name ?? '(unregistered)'}  ${c.body.length} chars`); }
else if (cmd[0] === 'show') process.stdout.write(read('reports', cmd[1]).body + '\n');
else if (cmd[0] === 'promote') console.log(JSON.stringify(new Store(dir).promote(cmd[1]), null, 2));
else console.error('usage: reports.mjs --store DIR list|candidates|show ID|promote ID');
