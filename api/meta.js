// api/meta.js — Vercel Serverless Function (CommonJS)
// Proxies the Metabase enterprise CSV to avoid CORS issues in the browser

const https = require('https');

const METABASE_CSV_URL = 'https://metabase.spyne.ai/public/question/84265073-fe7b-4ee1-81d7-5eb37a7e9b2f.csv';

function fetchCSV() {
  return new Promise((resolve, reject) => {
    const req = https.get(METABASE_CSV_URL, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SpyneDashboard/1.0)',
        'Accept': 'text/csv,text/plain,*/*',
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        https.get(res.headers.location, { timeout: 15000 }, (res2) => {
          let data = '';
          res2.on('data', chunk => { data += chunk; });
          res2.on('end', () => resolve(data));
        }).on('error', reject);
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseLine(line) {
  const cols = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inQ)                    { inQ = true; }
    else if (c === '"' && inQ && line[i+1] === '"') { cur += '"'; i++; }
    else if (c === '"' && inQ)                { inQ = false; }
    else if (c === ',' && !inQ)               { cols.push(cur); cur = ''; }
    else                                       { cur += c; }
  }
  cols.push(cur);
  return cols;
}

function parseCSV(text) {
  const map = {};
  const lines = text.trim().split('\n');
  if (lines.length < 2) return map;

  const headers = parseLine(lines[0]);
  const idx = {
    name:    headers.findIndex(h => /enterprise name/i.test(h)),
    seg:     headers.findIndex(h => /customer segment/i.test(h)),
    csPoc:   headers.findIndex(h => /cs poc/i.test(h)),
    obPoc:   headers.findIndex(h => /ob poc/i.test(h)),
    liveArr: headers.findIndex(h => /live arr/i.test(h)),
  };

  console.log('[meta] CSV headers:', headers.slice(0, 8));
  console.log('[meta] Column indices:', idx);

  lines.slice(1).forEach(line => {
    if (!line.trim()) return;
    const cols = parseLine(line);
    const name = (cols[idx.name] || '').trim();
    if (!name) return;
    const seg    = (cols[idx.seg]    || '').trim();
    const csPoc  = (cols[idx.csPoc]  || '').trim();
    const obPoc  = (cols[idx.obPoc]  || '').trim();
    const liveArr= (cols[idx.liveArr]|| '').trim();
    if (!map[name]) {
      map[name] = { segment: seg, csPoc, obPoc, liveArr };
    } else {
      if (!map[name].segment && seg)    map[name].segment = seg;
      if (!map[name].csPoc   && csPoc)  map[name].csPoc   = csPoc;
      if (!map[name].obPoc   && obPoc)  map[name].obPoc   = obPoc;
      if (!map[name].liveArr && liveArr)map[name].liveArr = liveArr;
    }
  });
  return map;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300'); // cache 1hr

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  try {
    const csvText = await fetchCSV();
    const enterpriseMeta = parseCSV(csvText);
    const count = Object.keys(enterpriseMeta).length;
    console.log('[meta] Parsed', count, 'enterprises');
    res.status(200).json({ enterpriseMeta, count, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[meta] error:', err.message);
    res.status(500).json({ error: err.message, enterpriseMeta: {} });
  }
};
