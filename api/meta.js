// api/meta.js — Vercel Serverless Function (CommonJS)
// Fetches and caches the Live Accounts Google Sheet CSV
// Replaces Metabase entirely.

const https = require('https');

const LIVE_ACCOUNTS_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTS0ExA81qlU0Z2lRs9OobIbmQmLiCX4OGlTJ7Hi-Y4I4X1ovP4q_SG6cSyVtWJG_LYqwOJtNqGEdnC/pub?output=csv';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min in-memory cache

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
    doGet(LIVE_ACCOUNTS_CSV, 0);
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
    id:      headers.findIndex(h => /enterprise id/i.test(h)),
    name:    headers.findIndex(h => /enterprise name/i.test(h)),
    stage:   headers.findIndex(h => /^stage$/i.test(h.trim())),
    liveArr: headers.findIndex(h => /live arr/i.test(h)),
    csPoc:   headers.findIndex(h => /csm name_new/i.test(h) || /cs name/i.test(h)),
    seg:     headers.findIndex(h => /customer segment/i.test(h)),
    rag:     headers.findIndex(h => /overall rag/i.test(h)),
  };
  console.log('[meta] idx:', idx);

  lines.slice(1).forEach(line => {
    if (!line.trim()) return;
    const cols    = parseLine(line);
    const rawName = (cols[idx.name] || '').trim();
    if (!rawName) return;

    const stage       = (cols[idx.stage]   || '').trim();
    const liveArrRaw  = (cols[idx.liveArr] || '').trim();
    const liveArrVal  = parseFloat(liveArrRaw.replace(/[^0-9.]/g, '')) || 0;
    const csPoc       = (cols[idx.csPoc]   || '').trim();
    const seg         = (cols[idx.seg]     || '').trim();
    const rag         = (cols[idx.rag]     || '').trim();
    const entId       = (cols[idx.id]      || '').trim();

    if (!map[rawName]) {
      map[rawName] = {
        originalName:   rawName,
        enterpriseId:   entId,
        segment:        seg,
        csPoc:          csPoc,
        obPoc:          '',
        stage:          stage,
        rag:            rag,
        liveArr:        String(liveArrVal),
        contractedArr:  liveArrVal,   // Live ARR = yearly ARR for this account
        rooftopCount:   1,
        activeRooftops: /live|onboarding/i.test(stage) ? 1 : 0,
      };
    } else {
      if (!map[rawName].segment  && seg)   map[rawName].segment  = seg;
      if (!map[rawName].csPoc    && csPoc) map[rawName].csPoc    = csPoc;
      if (!map[rawName].stage    && stage) map[rawName].stage    = stage;
      if (!map[rawName].rag      && rag)   map[rawName].rag      = rag;
      if (!map[rawName].enterpriseId && entId) map[rawName].enterpriseId = entId;
      map[rawName].contractedArr  = (map[rawName].contractedArr  || 0) + liveArrVal;
      map[rawName].liveArr        = String(map[rawName].contractedArr);
      map[rawName].rooftopCount   = (map[rawName].rooftopCount   || 0) + 1;
      if (/live|onboarding/i.test(stage)) map[rawName].activeRooftops = (map[rawName].activeRooftops || 0) + 1;
    }
  });

  // Build result keyed by original name (for display) 
  // AND add normalized-key duplicates for fuzzy matching
  const result = {};
  Object.values(map).forEach(e => {
    e.poc = e.csPoc || '';
    result[e.originalName] = e;
    // Also store under normalized key (lowercase+trim) for matching
    const normKey = e.originalName.toLowerCase().trim();
    if (normKey !== e.originalName) result[normKey] = e;
  });
  return result;
}

async function getWithCache() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL_MS) {
    console.log('[meta] cache hit, age:', Math.round((now - _cacheTime) / 1000) + 's');
    return _cache;
  }
  if (_inflight) {
    console.log('[meta] waiting for in-flight fetch');
    return _inflight;
  }
  console.log('[meta] fetching Live Accounts sheet from:', LIVE_ACCOUNTS_CSV.slice(0,80));
  _inflight = fetchCSV()
    .then(csvText => {
      console.log('[meta] CSV received, length:', csvText.length, 'first 200:', csvText.slice(0,200));
      const enterpriseMeta = parseCSV(csvText);
      const count = Object.keys(enterpriseMeta).length;
      console.log('[meta] parsed', count, 'enterprises, sample keys:', Object.keys(enterpriseMeta).slice(0,3));
      _cache = { enterpriseMeta, count, fetchedAt: new Date().toISOString() };
      _cacheTime = Date.now();
      _inflight = null;
      return _cache;
    })
    .catch(err => {
      console.error('[meta] fetch failed:', err.message);
      _inflight = null;
      if (_cache) { console.log('[meta] returning stale cache'); return _cache; }
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

  // ?raw=1 returns first 500 chars of CSV for debugging
  if (req.url && req.url.includes('raw=1')) {
    try {
      const csv = await fetchCSV();
      return res.status(200).json({ length: csv.length, preview: csv.slice(0, 500) });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    // Force fresh fetch if cache is empty
    if (!_cache) {
      console.log('[meta] cold start, fetching immediately...');
    }
    const result = await getWithCache();
    res.status(200).json(result);
  } catch (err) {
    console.error('[meta] handler error:', err.message);
    res.status(500).json({ error: err.message, enterpriseMeta: {} });
  }
};
