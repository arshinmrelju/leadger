import fs from 'node:fs';
const files = ['ledger.html','dashboard.html','transactions.html','admin.html','js/ledger.js','js/admin.js','js/auth.js','js/app.js','js/shell.js'];
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    const hasWord = l.includes('"transactions"') || l.includes("'transactions'");
    const isDayHead = l.includes('dayHeads') || l.includes('collectionGroup') || l.includes('/transactions');
    if (hasWord && !isDayHead) {
      console.log(`${f}:${i+1}  ${l.trim()}`);
    }
  });
}
console.log('--- scan done ---');
