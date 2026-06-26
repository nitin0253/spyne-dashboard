// api/meta.js — Vercel Serverless Function (CommonJS)
// Proxies the Metabase enterprise CSV — 30min in-memory cache

const https = require('https');

const METABASE_CSV_URL = 'https://metabase.spyne.ai/public/question/84265073-fe7b-4ee1-81d7-5eb37a7e9b2f.csv';
const CACHE_TTL_MS = 30 * 60 * 1000;

let _cache = null;
let _cacheTime = 0;
let _inflight = null;

function fetchCSV() {
  return new Promise((resolve, reject) => {
    function doGet(url, redirects) {
      if (redirects > 3) return reject(new Error('too many redirects'));
      const req = https.get(url, {
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/csv,*/*' }
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return doGet(res.headers.location, redirects + 1);
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    }
    doGet(METABASE_CSV_URL, 0);
  });
}

function parseLine(line) {
  const cols = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inQ)                         { inQ = true; }
    else if (c === '"' && inQ && line[i+1] === '"') { cur += '"'; i++; }
    else if (c === '"' && inQ)                     { inQ = false; }
    else if (c === ',' && !inQ)                    { cols.push(cur); cur = ''; }
    else                                            { cur += c; }
  }
  cols.push(cur);
  return cols;
}

function parseCSV(text) {
  const map = {};
  const lines = text.trim().split('\n');
  if (lines.length < 2) return map;

  const headers = parseLine(lines[0]);
  console.log('[meta] headers:', headers.slice(0, 10));

  const idx = {
    name:          headers.findIndex(h => /enterprise name/i.test(h)),
    seg:           headers.findIndex(h => /customer segment/i.test(h)),
    csPoc:         headers.findIndex(h => /cs poc/i.test(h)),
    obPoc:         headers.findIndex(h => /ob poc/i.test(h)),
    liveArr:       headers.findIndex(h => /live arr/i.test(h)),
    contractedArr: headers.findIndex(h => /contracted arr/i.test(h)),
    stage:         headers.findIndex(h => /^stage$/i.test(h.trim())),
  };
  console.log('[meta] idx:', idx);

  lines.slice(1).forEach(line => {
    if (!line.trim()) return;
    const cols = parseLine(line);
    const name = (cols[idx.name] || '').trim();
    if (!name) return;

    const segment      = (cols[idx.seg]           || '').trim();
    const csPoc        = (cols[idx.csPoc]          || '').trim();
    const obPoc        = (cols[idx.obPoc]          || '').trim();
    const liveArr      = (cols[idx.liveArr]        || '').trim();
    const stage        = (cols[idx.stage]          || '').trim();
    const contractedRaw= (cols[idx.contractedArr]  || '').trim();
    const contractedVal= parseFloat(contractedRaw.replace(/[^0-9.]/g, '')) || 0;
    const isActive     = /live|onboarding/i.test(stage);

    if (!map[name]) {
      map[name] = {
        segment, csPoc, obPoc, liveArr,
        contractedArr:  isActive ? contractedVal : 0,
        rooftopCount:   1,
        activeRooftops: isActive ? 1 : 0,
      };
    } else {
      if (!map[name].segment && segment) map[name].segment = segment;
      if (!map[name].csPoc   && csPoc)   map[name].csPoc   = csPoc;
      if (!map[name].obPoc   && obPoc)   map[name].obPoc   = obPoc;
      if (!map[name].liveArr && liveArr) map[name].liveArr = liveArr;
      if (isActive) {
        map[name].contractedArr  = (map[name].contractedArr  || 0) + contractedVal;
        map[name].activeRooftops = (map[name].activeRooftops || 0) + 1;
      }
      map[name].rooftopCount = (map[name].rooftopCount || 0) + 1;
    }
  });

  Object.values(map).forEach(e => {
    e.poc = (e.csPoc && e.csPoc !== '') ? e.csPoc : (e.obPoc || '');
  });
  return map;
}

async function getWithCache() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL_MS) {
    console.log('[meta] cache hit, age:', Math.round((now - _cacheTime) / 1000) + 's');
    return _cache;
  }
  if (_inflight) return _inflight;
  console.log('[meta] fetching Metabase CSV…');
  _inflight = fetchCSV()
    .then(csvText => {
      const enterpriseMeta = parseCSV(csvText);
      const count = Object.keys(enterpriseMeta).length;
      console.log('[meta] parsed', count, 'enterprises');
      _cache = { enterpriseMeta, count, fetchedAt: new Date().toISOString() };
      _cacheTime = Date.now();
      _inflight = null;
      return _cache;
    })
    .catch(err => {
      console.error('[meta] fetch failed:', err.message);
      _inflight = null;
      if (_cache) return _cache;
      return { enterpriseMeta: {}, count: 0, fetchedAt: new Date().toISOString(), error: err.message };
    });
  return _inflight;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=900');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });
  try {
    const result = await getWithCache();
    res.status(200).json(result);
  } catch (err) {
    console.error('[meta] handler error:', err.message);
    res.status(500).json({ error: err.message, enterpriseMeta: {} });
  }
};
