// api/data.js — Vercel Serverless Function (CommonJS)
// maxDuration bumped to 60s (Pro plan) — set in vercel.json too for safety

const { google } = require('googleapis');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Vercel function config — extend timeout ───────────────────────────────────
module.exports.config = { maxDuration: 60 };

const METABASE_CSV_URL = 'https://metabase.spyne.ai/public/question/84265073-fe7b-4ee1-81d7-5eb37a7e9b2f.csv';

// ── AI Accuracy data (per enterprise per month) ───────────────────────────────
const AI_ACCURACY_CSV_PATH = path.join(__dirname, '..', 'data', 'ai_accuracy.csv');

let _aiAccuracyIndex = null;
let _aiAccuracyByEnt = null;

function loadAiAccuracy() {
  if (_aiAccuracyIndex) return { byKey: _aiAccuracyIndex, byEnt: _aiAccuracyByEnt };
  const byKey = {};
  const byEnt = {};
  try {
    const raw = fs.readFileSync(AI_ACCURACY_CSV_PATH, 'utf8');
    const lines = raw.trim().split('\n');
    if (lines.length < 2) return { byKey, byEnt };
    const headers = parseLine(lines[0]).map(h => h.trim().toLowerCase());
    const iMonth       = headers.indexOf('month');
    const iEntId       = headers.indexOf('enterprise_id');
    const iTotalImages = headers.indexOf('total images');
    const iQcedImages  = headers.indexOf('qced_images');
    const iIncorrect   = headers.indexOf('incorrect_images');
    const iTrueAcc     = headers.indexOf('true_accuracy');
    const iToolAcc     = headers.indexOf('post_qc_tool_accuracy');
    if (iMonth < 0 || iEntId < 0 || iTrueAcc < 0) {
      console.error('[ai_accuracy] required columns missing');
      return { byKey, byEnt };
    }
    lines.slice(1).forEach(line => {
      if (!line.trim()) return;
      const cols = parseLine(line);
      const month = (cols[iMonth] || '').trim();
      const entId = (cols[iEntId] || '').trim().toLowerCase();
      if (!month || !entId) return;
      const parsePct = (s) => { const n = parseFloat(String(s || '').replace(/[^\d.]/g, '')); return isFinite(n) ? +n.toFixed(2) : 0; };
      const parseNum = (s) => { const n = parseFloat(String(s || '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
      const entry = {
        month,
        trueAccuracy:       parsePct(cols[iTrueAcc]),
        postQcToolAccuracy: iToolAcc     >= 0 ? parsePct(cols[iToolAcc])     : 0,
        totalImages:        iTotalImages >= 0 ? parseNum(cols[iTotalImages]) : 0,
        qcedImages:         iQcedImages  >= 0 ? parseNum(cols[iQcedImages])  : 0,
        incorrectImages:    iIncorrect   >= 0 ? parseNum(cols[iIncorrect])   : 0,
      };
      byKey[entId + '|' + month] = entry;
      if (!byEnt[entId]) byEnt[entId] = [];
      byEnt[entId].push(entry);
    });
  } catch (e) {
    console.error('[ai_accuracy] load failed:', e.message);
  }
  _aiAccuracyIndex = byKey;
  _aiAccuracyByEnt = byEnt;
  return { byKey, byEnt };
}

// ── Fetch & parse Metabase enterprise CSV ─────────────────────────────────────
function fetchMetabaseCSV() {
  return new Promise((resolve) => {
    const req = https.get(METABASE_CSV_URL, {
      timeout: 4000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/csv,*/*' }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, { timeout: 4000 }, (res2) => {
          let raw = '';
          res2.on('data', chunk => { raw += chunk; });
          res2.on('end', () => { try { resolve(parseEnterpriseMeta(raw)); } catch(e) { resolve({}); } });
        }).on('error', () => resolve({}));
        return;
      }
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => { try { resolve(parseEnterpriseMeta(raw)); } catch(e) { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); console.error('[metabase] timeout'); resolve({}); });
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

// Strip control characters from a cell value (newlines, tabs, null bytes, etc.)
// These cause JSON.stringify to produce malformed JSON
function cleanCell(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '')
           .replace(/\n/g, ' ')
           .replace(/\r/g, '')
           .trim();
}

function parseEnterpriseMeta(csvText) {
  const map = {};
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return map;

  const headers = parseLine(lines[0]);
  const idx = {
    entId:         headers.findIndex(h => /enterprise\s*id/i.test(h)),
    name:          headers.findIndex(h => /enterprise name/i.test(h)),
    seg:           headers.findIndex(h => /customer segment/i.test(h)),
    csPoc:         headers.findIndex(h => /cs poc/i.test(h)),
    obPoc:         headers.findIndex(h => /ob poc/i.test(h)),
    liveArr:       headers.findIndex(h => /live arr/i.test(h)),
    contractedArr: headers.findIndex(h => /contracted arr/i.test(h)),
    stage:         headers.findIndex(h => /^stage$/i.test(h.trim())),
  };
  lines.slice(1).forEach(line => {
    if (!line.trim()) return;
    const cols = parseLine(line);
    const name = (cols[idx.name] || '').trim();
    if (!name) return;

    const segment      = (cols[idx.seg]           || '').trim();
    const entId        = (cols[idx.entId]         || '').trim();
    const csPoc        = (cols[idx.csPoc]          || '').trim();
    const obPoc        = (cols[idx.obPoc]          || '').trim();
    const liveArr      = (cols[idx.liveArr]        || '').trim();
    const stage        = (cols[idx.stage]          || '').trim();
    const contractedRaw= (cols[idx.contractedArr]  || '').trim();
    const contractedVal= parseFloat(contractedRaw.replace(/[^0-9.]/g, '')) || 0;
    const isActive     = /live|onboarding/i.test(stage);

    if (!map[name]) {
      map[name] = { entId, segment, csPoc, obPoc, liveArr, contractedArr: isActive ? contractedVal : 0, rooftopCount: 1, activeRooftops: isActive ? 1 : 0 };
    } else {
      if (!map[name].entId   && entId)   map[name].entId   = entId;
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
  Object.values(map).forEach(e => { e.poc = (e.csPoc && e.csPoc !== '') ? e.csPoc : (e.obPoc || ''); });
  return map;
}

function buildMetaIndex(metaMap) {
  const index = {};
  Object.entries(metaMap).forEach(([name, val]) => {
    index[name.toLowerCase().trim()] = { originalKey: name, ...val };
  });
  Object.entries(metaMap).forEach(([name, val]) => {
    if (val.entId) {
      const idKey = 'id:' + val.entId.toLowerCase().trim();
      if (!index[idKey]) index[idKey] = { originalKey: name, ...val };
    }
  });
  return index;
}

function lookupMeta(metaIndex, outputName, enterpriseId) {
  if (!metaIndex) return null;
  if (enterpriseId) {
    const byId = metaIndex['id:' + enterpriseId.toLowerCase().trim()];
    if (byId) return byId;
  }
  if (!outputName) return null;
  return metaIndex[outputName.toLowerCase().trim()] || null;
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  ADD A NEW MONTH — edit ONLY this array, nothing else needed    ║
// ╚══════════════════════════════════════════════════════════════════╝
const SHEETS = [
  { month: 'Jan-26', key: 'jan26', id: '1VI-9hxnFIynsTOl3aCdIiR-RRAfRssISOWnZdddCz4Q', frozen: true },
  { month: 'Feb-26', key: 'feb26', id: '1K2SMR34s0O21BKGpCX-EsUPgOdiAkiuUW8yDyyvFzQU', frozen: true },
  { month: 'Mar-26', key: 'mar26', id: '1_2xlqYzD15vhZ4qfsH-3kGHj8LXljpdUjdgFIfS5-Iw', frozen: true },
  { month: 'Apr-26', key: 'apr26', id: '1cKEaxHNOqU2vpnCsnHbf1PfQdVnReg3MsGIgqgE1UhE', frozen: true },
  { month: 'May-26', key: 'may26', id: '1_3d_XJmSbBziSCicauYEiP1J5N4RRW6pGco49uWuh84', frozen: true },
  { month: 'Jun-26', key: 'jun26', id: '1bNs5JvqzZ0HifsSy4fcu0-z-s11NRY8kTH9t9yLeKGA' },
  { month: 'Jul-26', key: 'jul26', id: '1i3KqktELNb-ykpZeHaMh3wk3FBBV-eHNAw6736oaXbI', hasEntId: true },
  // { month: 'Aug-26', key: 'aug26', id: 'PASTE_SHEET_ID_HERE', hasEntId: true },
];

const ALWAYS_EXCLUDE = new Set([
  'ranbir.manoranjan@spyne.ai', 'ankit.choudhary@spyne.ai', 'ddroppova810@gmail.com',
  'nitin.kumar@spyne.ai', 'vinod.singh+1@cariotauto.com', 'kishor@spyne.ai',
  'saloni.sharma+1@cariotauto.com', 'mukesh.1+1@cariotauto.com', 'mohit.sharma+1@cariotauto.com',
  'gaurav.3+1@cariotauto.com', 'mayank.singh@spyne.ai', 'praveen.agarwal@spyne.ai',
  'amit.bhadauriya@spyne.ai', 'heartika.singh@spyne.ai', 'swati.subhrajita@spyne.ai',
  'anurag.kumar1@spyne.ai', 'shivam.mishra+1@cariotauto.com', 'abhishek.mudgal@cariotauto.com',
  'priyanka.attri+1@cars24.com', 'barkha.rawat@cariotauto.com', 'rajni.1@cariotauto.com',
  'swati.sharma@cariotauto.com', 'rajni.1+1@cariotauto.com', 'barkha.rawat+1@cariotauto.com',
  'swati.sharma+1@cariotauto.com', 'mohit.10@cars24.com', 'vijender.kumar@cariotauto.com',
  'anuj.1@cariotauto.com', 'rohit.chauhan@spyne.ai', 'saloni.sharma2@cars24.com',
  'mohit.sharma11@cars24.com', 'saurabh.pandey@spyne.ai', 'barkha.rawat@cars24.com',
  'raj.tripathi@spyne.ai', 'mohit.kumar@spyne.co.in', 'raj.mani@spyne.co.in',
]);

const isImage = p => /image/i.test(p);
const is360   = p => /360|spin/i.test(p);
const isVideo = p => /video/i.test(p);
const billingUnits = row => isImage(row.product) ? row.images : row.skus;
const isVinProduct = () => true;

function getSheetsClient() {
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
  if (!clientEmail || !privateKey)
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY env vars');
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: clientEmail, private_key: privateKey },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

function parseRemovedUsers(rows) {
  const emails = new Set();
  rows.forEach(r => {
    (r || []).forEach(cell => {
      const val = (cell || '').toString().trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) emails.add(val);
    });
  });
  return [...emails];
}

function buildExcludeSet(sheetEmails) {
  return new Set([...sheetEmails.map(e => e.toLowerCase().trim()), ...ALWAYS_EXCLUDE]);
}

function parseOutput(rows, excludeSet, hasEntId) {
  if (!rows || rows.length < 2) return [];
  const o = hasEntId ? 1 : 0;
  return rows.slice(1)
    .filter(r => r && r[0])
    .map(r => ({
      date:         cleanCell(r[0]  || ''),
      product:      cleanCell(r[1]  || ''),
      verticle:     cleanCell(r[2]  || ''),
      type:         cleanCell((r[3] || '').toLowerCase().trim()),
      enterpriseId: hasEntId ? cleanCell((r[4] || '').trim()) : '',
      enterprise:   cleanCell(r[4 + o]  || ''),
      dealerType:   cleanCell(r[5 + o]  || ''),
      qcEditor:     cleanCell((r[6 + o] || '').toLowerCase().trim()),
      skus:         +r[7 + o]  || 0,
      images:       +r[8 + o]  || 0,
      tools:        +r[9 + o]  || 0,
      sumTarget:    +r[10 + o] || 0,
      actualMins:   +r[11 + o] || 0,
      factor:       +r[12 + o] || 0,
    }))
    .filter(r => !excludeSet.has((r.qcEditor || '').toLowerCase().trim()));
}

function parseFactorCalc(rows, excludeSet) {
  if (!rows || rows.length < 3) return { totalCost: 0, inhouseCost: 0, osCost: 0, employees: [], excludedEmployees: [] };
  const num = s => parseFloat((s || '').toString().replace(/,/g, '')) || 0;
  const allEditors = rows.slice(2)
    .filter(r => r && r[0] && (r[0] || '').toString().includes('@'))
    .map(r => ({
      email:       cleanCell((r[0] || '').toString().toLowerCase().trim()),
      teamType:    cleanCell((r[1] || '').toString().trim()),
      totalMins:   num(r[2]),
      inhouseCost: num(r[3]),
      osCost:      num(r[4]),
      totalCost:   num(r[5]),
      factor:      num(r[6]),
    }));
  const excludedEditors = allEditors.filter(e => excludeSet.has(e.email));
  const editors         = allEditors.filter(e => !excludeSet.has(e.email));
  const totalCost   = editors.reduce((s, e) => s + e.totalCost,   0);
  const inhouseCost = editors.reduce((s, e) => s + e.inhouseCost, 0);
  const osCost      = editors.reduce((s, e) => s + e.osCost,      0);
  return { totalCost, inhouseCost, osCost, employees: editors, excludedEmployees: excludedEditors };
}

function groupSum(rows, keyFn) {
  const acc = {};
  rows.forEach(r => {
    const k = keyFn(r) || 'Unknown';
    if (!acc[k]) acc[k] = { images:0, skus:0, units:0, vins:0, actualMins:0, sumTarget:0, rows:0 };
    acc[k].images     += r.images;
    acc[k].skus       += r.skus;
    acc[k].units      += billingUnits(r);
    acc[k].vins       += r.skus;
    acc[k].actualMins += r.actualMins;
    acc[k].sumTarget  += r.sumTarget;
    acc[k].rows++;
  });
  return acc;
}

function groupSumNormalized(rows, keyFn) {
  const acc = {};
  rows.forEach(r => {
    const rawKey = keyFn(r) || 'Unknown';
    const normKey = rawKey.toLowerCase().trim();
    if (!acc[normKey]) acc[normKey] = { images:0, skus:0, units:0, vins:0, actualMins:0, sumTarget:0, rows:0, labelCounts:{} };
    const a = acc[normKey];
    a.images     += r.images;
    a.skus       += r.skus;
    a.units      += billingUnits(r);
    a.vins       += r.skus;
    a.actualMins += r.actualMins;
    a.sumTarget  += r.sumTarget;
    a.rows++;
    a.labelCounts[rawKey] = (a.labelCounts[rawKey] || 0) + 1;
  });
  const result = {};
  Object.entries(acc).forEach(([normKey, g]) => {
    let bestLabel = normKey, bestCount = -1;
    Object.entries(g.labelCounts).forEach(([label, count]) => {
      if (count > bestCount) { bestCount = count; bestLabel = label; }
    });
    const { labelCounts, ...rest } = g;
    result[bestLabel] = rest;
  });
  return result;
}

function enrichGroup(name, g, allocatedCost) {
  const eff = g.actualMins > 0 ? (g.sumTarget / g.actualMins) * 100 : 0;
  return {
    name,
    images: Math.round(g.images), skus: Math.round(g.skus),
    units: Math.round(g.units), vins: Math.round(g.vins),
    actualMins: Math.round(g.actualMins), sumTarget: Math.round(g.sumTarget),
    rows: g.rows, efficiency: +eff.toFixed(2),
    costPerUnit:  g.units  > 0 ? +(allocatedCost / g.units).toFixed(2)  : 0,
    costPerSku:   g.skus   > 0 ? +(allocatedCost / g.skus).toFixed(2)   : 0,
    costPerVin:   g.vins   > 0 ? +(allocatedCost / g.vins).toFixed(2)   : 0,
    costPerImage: g.images > 0 ? +(allocatedCost / g.images).toFixed(2) : 0,
  };
}

function computeMonth(config, outputRows, factorRows, removedRows, metaIndex, aiAccuracyIndex) {
  const useEntId = !!config.hasEntId;
  const sheetExcluded = parseRemovedUsers(removedRows);
  const excludeSet    = buildExcludeSet(sheetExcluded);
  const output = parseOutput(outputRows, excludeSet, useEntId);
  const { totalCost, inhouseCost, osCost, employees } = parseFactorCalc(factorRows, excludeSet);

  const editorCostMap = {};
  employees.forEach(e => {
    editorCostMap[(e.email || '').toLowerCase().trim()] = { totalCost: e.totalCost, inhouseCost: e.inhouseCost, osCost: e.osCost, teamType: e.teamType, factor: e.factor };
  });

  const enriched = output.map(r => {
    const segment = lookupMeta(metaIndex, r.enterprise, useEntId ? r.enterpriseId : null)?.segment || 'Unknown';
    return { ...r, segment, teamType: editorCostMap[(r.qcEditor || '').toLowerCase().trim()]?.teamType || 'Unknown' };
  });

  const totalUnits     = enriched.reduce((s, r) => s + billingUnits(r), 0);
  const totalImages    = enriched.reduce((s, r) => s + r.images, 0);
  const totalSkus      = enriched.reduce((s, r) => s + r.skus, 0);
  const totalVins      = enriched.filter(r => isVinProduct(r.product)).reduce((s, r) => s + r.skus, 0);
  const totalActMins   = enriched.reduce((s, r) => s + r.actualMins, 0);
  const totalTarget    = enriched.reduce((s, r) => s + r.sumTarget, 0);

  let effectiveTotalCost = totalCost, effectiveInhouseCost = inhouseCost, effectiveOsCost = osCost;
  if (effectiveTotalCost === 0 && totalActMins > 0) {
    const factorBasedCost = enriched.reduce((s, r) => s + (r.actualMins || 0) * (r.factor || 0), 0);
    if (factorBasedCost > 0) {
      console.warn(`[${config.month}] factor_calculation returned ₹0 — falling back to factor column`);
      effectiveTotalCost = Math.round(factorBasedCost);
      effectiveInhouseCost = Math.round(factorBasedCost);
    }
  }

  const efficiency  = totalActMins > 0 ? +((totalTarget / totalActMins) * 100).toFixed(2) : 0;
  const costPerUnit = totalUnits > 0 ? +(effectiveTotalCost / totalUnits).toFixed(2) : 0;
  const costPerSku  = totalSkus  > 0 ? +(effectiveTotalCost / totalSkus).toFixed(2)  : 0;
  const costPerVin  = totalVins  > 0 ? +(effectiveTotalCost / totalVins).toFixed(2)  : 0;
  const total360Skus   = enriched.filter(r => is360(r.product)).reduce((s, r) => s + r.skus, 0);
  const totalVideoSkus = enriched.filter(r => isVideo(r.product)).reduce((s, r) => s + r.skus, 0);

  const inhouseRows = enriched.filter(r => /payroll/i.test(r.teamType));
  const osRows      = enriched.filter(r => /^os$/i.test(r.teamType));
  const inhouseUnits = inhouseRows.reduce((s, r) => s + billingUnits(r), 0);
  const osUnits      = osRows.reduce((s, r) => s + billingUnits(r), 0);
  const inhouseActMins = inhouseRows.reduce((s, r) => s + r.actualMins, 0);
  const osActMins      = osRows.reduce((s, r) => s + r.actualMins, 0);

  const prodGroups = groupSum(enriched, r => r.product);
  const productBreakdown = Object.entries(prodGroups).map(([name, g]) => {
    const rowCost = enriched.filter(r => r.product === name).reduce((s, r) => s + (r.actualMins || 0) * (r.factor || 0), 0);
    return { ...enrichGroup(name, g, rowCost), cost: Math.round(rowCost), costSharePct: effectiveTotalCost > 0 ? +((rowCost / effectiveTotalCost) * 100).toFixed(2) : 0, unitLabel: isImage(name) ? 'Images' : is360(name) ? 'SKUs (spins)' : 'SKUs (videos)' };
  }).sort((a, b) => b.actualMins - a.actualMins);

  const editorGroups = groupSum(enriched, r => r.qcEditor);
  const totalUnitsAllEditors = Object.values(editorGroups).reduce((s, g) => s + g.units, 0) || 1;
  const editorBreakdown = Object.entries(editorGroups).map(([email, g]) => {
    const ec = editorCostMap[email.toLowerCase().trim()];
    let cost;
    if (ec) { cost = ec.totalCost; }
    else if (g.actualMins > 0 && totalActMins > 0) { cost = (g.actualMins / totalActMins) * effectiveTotalCost; }
    else if (g.units > 0) { cost = (g.units / totalUnitsAllEditors) * effectiveTotalCost; }
    else { cost = 0; }
    const byProduct = {};
    enriched.filter(r => r.qcEditor === email).forEach(r => {
      if (!byProduct[r.product]) byProduct[r.product] = 0;
      byProduct[r.product] += billingUnits(r);
    });
    return { ...enrichGroup(email, g, cost), email, salary: ec?.totalCost || 0, inhouseCost: ec?.inhouseCost || 0, osCost: ec?.osCost || 0, teamType: ec?.teamType || 'Unknown', factor: ec?.factor || 0, byProduct };
  }).sort((a, b) => b.units - a.units);

  const segGroups = groupSum(enriched, r => r.segment);
  const segmentBreakdown = Object.entries(segGroups).map(([segName, g]) => {
    const segRows = enriched.filter(r => r.segment === segName);
    const segCost = segRows.reduce((s, r) => s + (r.actualMins || 0) * (r.factor || 0), 0);
    const byProduct = {};
    segRows.forEach(r => {
      const p = r.product;
      if (!byProduct[p]) byProduct[p] = { units:0, skus:0, images:0, vins:0, actualMins:0, sumTarget:0 };
      byProduct[p].units += billingUnits(r); byProduct[p].skus += r.skus; byProduct[p].images += r.images;
      byProduct[p].vins += r.skus; byProduct[p].actualMins += r.actualMins; byProduct[p].sumTarget += r.sumTarget;
    });
    Object.entries(byProduct).forEach(([pname, pd]) => {
      const pCost = segRows.filter(r => r.product === pname).reduce((s, r) => s + (r.actualMins || 0) * (r.factor || 0), 0);
      pd.costPerUnit = pd.units > 0 ? +(pCost / pd.units).toFixed(2) : 0;
      pd.efficiency  = pd.actualMins > 0 ? +((pd.sumTarget / pd.actualMins) * 100).toFixed(2) : 0;
      pd.units = Math.round(pd.units); pd.skus = Math.round(pd.skus); pd.images = Math.round(pd.images); pd.vins = Math.round(pd.vins); pd.actualMins = Math.round(pd.actualMins);
    });
    const segVins = segRows.filter(r => isVinProduct(r.product)).reduce((s,r) => s + r.skus, 0);
    const seg360Skus = segRows.filter(r => is360(r.product)).reduce((s,r) => s + r.skus, 0);
    const segVideoIds = segRows.filter(r => isVideo(r.product)).reduce((s,r) => s + r.skus, 0);
    const entGroups2 = groupSumNormalized(segRows, r => r.enterprise);
    const topEnterprises = Object.entries(entGroups2).map(([eName, eg]) => {
      const eNameNorm = eName.toLowerCase().trim();
      const eCost = segRows.filter(r => (r.enterprise || '').toLowerCase().trim() === eNameNorm).reduce((s, r) => s + (r.actualMins || 0) * (r.factor || 0), 0);
      return { ...enrichGroup(eName, eg, eCost) };
    }).sort((a, b) => b.units - a.units).slice(0, 10);
    return { ...enrichGroup(segName, g, segCost), vins: Math.round(segVins), seg360Skus: Math.round(seg360Skus), segVideoIds: Math.round(segVideoIds), costPerVin: segVins > 0 ? +(segCost / segVins).toFixed(2) : 0, costShare: effectiveTotalCost > 0 ? +((segCost / effectiveTotalCost) * 100).toFixed(2) : 0, byProduct, topEnterprises, uniqueEnterprises: new Set(segRows.map(r => r.enterprise)).size };
  }).sort((a, b) => b.units - a.units);

  const dealerGroups = groupSum(enriched, r => r.dealerType);
  const dealerBreakdown = Object.entries(dealerGroups).map(([name, g]) => {
    const cost = enriched.filter(r => r.dealerType === name).reduce((s, r) => s + (r.actualMins || 0) * (r.factor || 0), 0);
    return enrichGroup(name, g, cost);
  }).sort((a, b) => b.units - a.units);

  const entGroups = groupSumNormalized(enriched, r => r.enterprise);
  const enterpriseBreakdown = Object.entries(entGroups).map(([name, g]) => {
    const nameNorm = name.toLowerCase().trim();
    const entRows = enriched.filter(r => (r.enterprise || '').toLowerCase().trim() === nameNorm);
    const cost = entRows.reduce((s, r) => s + (r.actualMins || 0) * (r.factor || 0), 0);
    const byProduct = {};
    entRows.forEach(r => {
      const p = r.product;
      if (!byProduct[p]) byProduct[p] = { units:0, skus:0, images:0, vins:0, actualMins:0, sumTarget:0, rows:0 };
      byProduct[p].units += billingUnits(r); byProduct[p].skus += r.skus; byProduct[p].images += r.images;
      byProduct[p].vins += r.skus; byProduct[p].actualMins += r.actualMins; byProduct[p].sumTarget += r.sumTarget; byProduct[p].rows++;
    });
    Object.entries(byProduct).forEach(([pname, pd]) => {
      const pCost = entRows.filter(r => r.product === pname).reduce((s, r) => s + (r.actualMins || 0) * (r.factor || 0), 0);
      pd.cost = Math.round(pCost); pd.costPerUnit = pd.units > 0 ? +(pCost / pd.units).toFixed(2) : 0;
      pd.efficiency = pd.actualMins > 0 ? +((pd.sumTarget / pd.actualMins) * 100).toFixed(2) : 0;
      pd.units = Math.round(pd.units); pd.skus = Math.round(pd.skus); pd.images = Math.round(pd.images); pd.vins = Math.round(pd.vins); pd.actualMins = Math.round(pd.actualMins); pd.sumTarget = Math.round(pd.sumTarget);
    });
    const byEditor = {};
    entRows.forEach(r => {
      const email = (r.qcEditor || '').toLowerCase().trim();
      if (!email) return;
      if (!byEditor[email]) byEditor[email] = { units:0, skus:0, images:0, vins:0, actualMins:0, sumTarget:0, rows:0, byProduct:{} };
      const be = byEditor[email];
      be.units += billingUnits(r); be.skus += r.skus; be.images += r.images; be.vins += r.skus;
      be.actualMins += r.actualMins; be.sumTarget += r.sumTarget; be.rows++;
      const p = r.product;
      if (!be.byProduct[p]) be.byProduct[p] = { units: 0 };
      be.byProduct[p].units += billingUnits(r);
    });
    Object.entries(byEditor).forEach(([email, be]) => {
      const ec = editorCostMap[email];
      let beCost;
      if (ec && ec.totalCost > 0) {
        const editorAllMins = editorGroups[email]?.actualMins || be.actualMins || 1;
        beCost = ec.totalCost * (be.actualMins / editorAllMins);
      } else {
        beCost = entRows.filter(r => (r.qcEditor || '').toLowerCase().trim() === email).reduce((s, r) => s + (r.actualMins || 0) * (r.factor || 0), 0);
      }
      be.cost = Math.round(beCost); be.costPerUnit = be.units > 0 ? +(beCost / be.units).toFixed(2) : 0;
      be.efficiency = be.actualMins > 0 ? +((be.sumTarget / be.actualMins) * 100).toFixed(2) : 0;
      be.teamType = ec?.teamType || 'Unknown';
      be.units = Math.round(be.units); be.skus = Math.round(be.skus); be.images = Math.round(be.images); be.vins = Math.round(be.vins); be.actualMins = Math.round(be.actualMins); be.sumTarget = Math.round(be.sumTarget);
      Object.values(be.byProduct).forEach(pd => { pd.units = Math.round(pd.units); });
    });
    const rowEntId = useEntId ? (entRows.find(r => r.enterpriseId)?.enterpriseId || '') : '';
    const meta = metaIndex ? lookupMeta(metaIndex, name, rowEntId) : null;
    const acc = (useEntId && rowEntId) ? aiAccuracyIndex[rowEntId.toLowerCase().trim() + '|' + config.month] : null;
    return {
      ...enrichGroup(name, g, cost), byProduct, byEditor,
      segment: meta?.segment || 'Unknown',
      entId: meta?.entId || rowEntId || '', csPoc: meta?.csPoc || '', obPoc: meta?.obPoc || '',
      liveArr: meta?.liveArr || '', contractedArr: meta?.contractedArr || 0,
      rooftopCount: meta?.rooftopCount || 0, activeRooftops: meta?.activeRooftops || 0,
      trueAccuracy: acc?.trueAccuracy || 0, postQcToolAccuracy: acc?.postQcToolAccuracy || 0,
      aiTotalImages: acc?.totalImages || 0, aiIncorrectImages: acc?.incorrectImages || 0,
    };
  }).sort((a, b) => b.units - a.units);

  const productMrrAlloc = { image: 0, s360: 0, video: 0 };
  enterpriseBreakdown.forEach(ent => {
    const monthlyMRR = (ent.contractedArr || 0) / 12;
    if (!monthlyMRR) return;
    const hasImage = Object.keys(ent.byProduct || {}).some(p => isImage(p));
    const has360   = Object.keys(ent.byProduct || {}).some(p => is360(p));
    const hasVideo = Object.keys(ent.byProduct || {}).some(p => isVideo(p));
    const count = (hasImage ? 1 : 0) + (has360 ? 1 : 0) + (hasVideo ? 1 : 0);
    if (!count) return;
    const share = monthlyMRR / count;
    if (hasImage) productMrrAlloc.image += share;
    if (has360)   productMrrAlloc.s360  += share;
    if (hasVideo) productMrrAlloc.video += share;
  });
  productMrrAlloc.image = +productMrrAlloc.image.toFixed(2);
  productMrrAlloc.s360  = +productMrrAlloc.s360.toFixed(2);
  productMrrAlloc.video = +productMrrAlloc.video.toFixed(2);

  const teamBreakdown = {
    inhouse: { cost: Math.round(inhouseCost), units: Math.round(inhouseUnits), actualMins: Math.round(inhouseActMins), employees: employees.filter(e => /payroll/i.test(e.teamType)).length, costPerUnit: inhouseUnits > 0 ? +(inhouseCost / inhouseUnits).toFixed(2) : 0 },
    os: { cost: Math.round(osCost), units: Math.round(osUnits), actualMins: Math.round(osActMins), employees: employees.filter(e => /^os$/i.test(e.teamType)).length, costPerUnit: osUnits > 0 ? +(osCost / osUnits).toFixed(2) : 0 },
  };

  return {
    month: config.month, key: config.key,
    summary: { totalCost: Math.round(effectiveTotalCost), inhouseCost: Math.round(effectiveInhouseCost), osCost: Math.round(effectiveOsCost), totalImages: Math.round(totalImages), totalSkus: Math.round(totalSkus), total360Skus: Math.round(total360Skus), totalVideoSkus: Math.round(totalVideoSkus), totalVins: Math.round(totalVins), totalUnits: Math.round(totalUnits), totalActMins: Math.round(totalActMins), totalTarget: Math.round(totalTarget), efficiency, costPerUnit, costPerSku, costPerVin, employees: employees.length },
    teamBreakdown, productBreakdown, productMrrAlloc, editorBreakdown, segmentBreakdown, dealerBreakdown, enterpriseBreakdown,
  };
}

// ── Cache ─────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 25 * 60 * 1000;
const CACHE_FILE   = '/tmp/spyne_dashboard_cache.json';
let _memCache = null;

function readDiskCache() {
  try { const raw = fs.readFileSync(CACHE_FILE, 'utf8'); const c = JSON.parse(raw); if (c && c.ts && (Date.now() - c.ts) < CACHE_TTL_MS) return c; } catch (_) {}
  return null;
}

function writeDiskCache(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ data, ts: Date.now() })); } catch (_) {}
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const forceRefresh = (req.query || {}).refresh === '1';

  if (!forceRefresh && _memCache && (Date.now() - _memCache.ts) < CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'MEM');
    return res.status(200).json(_memCache.data);
  }
  if (!forceRefresh) {
    const disk = readDiskCache();
    if (disk) { _memCache = disk; res.setHeader('X-Cache', 'DISK'); return res.status(200).json(disk.data); }
  }

  try {
    const client = getSheetsClient();

    async function fetchSheet(cfg) {
      const outputRange = cfg.hasEntId ? 'output!A:N' : 'output!A:M';
      try {
        const result = await client.spreadsheets.values.batchGet({
          spreadsheetId: cfg.id,
          ranges: [outputRange, 'factor_calculation!A:G', 'remove_users!A:E'],
        });
        const vrs = result.data.valueRanges || [];
        return { cfg, outputRows: vrs[0]?.values || [], factorRows: vrs[1]?.values || [], removedRows: vrs[2]?.values || [] };
      } catch (e) {
        console.error(`[${cfg.month}] batchGet failed:`, e.message);
        return { cfg, outputRows: [], factorRows: [], removedRows: [] };
      }
    }

    function monthCacheFile(key) { return `/tmp/spyne_month_${key}.json`; }
    function readMonthCache(key) { try { return JSON.parse(fs.readFileSync(monthCacheFile(key), 'utf8')); } catch(_) { return null; } }
    function writeMonthCache(key, data) { try { fs.writeFileSync(monthCacheFile(key), JSON.stringify(data)); } catch(_) {} }

    const frozenSheets = SHEETS.filter(s => s.frozen);
    const activeSheets = SHEETS.filter(s => !s.frozen);

    const frozenCached = frozenSheets.map(cfg => { const cached = readMonthCache(cfg.key); return cached ? { cfg, ...cached, fromCache: true } : null; });
    const frozenToFetch = frozenSheets.filter((_, i) => !frozenCached[i]);
    const frozenFetched = await Promise.all(frozenToFetch.map(fetchSheet));
    frozenFetched.forEach(d => writeMonthCache(d.cfg.key, { outputRows: d.outputRows, factorRows: d.factorRows, removedRows: d.removedRows }));
    const frozenData = frozenSheets.map((cfg, i) => frozenCached[i] || frozenFetched[frozenToFetch.indexOf(cfg)]);

    const activeData = [];
    for (const cfg of activeSheets) { activeData.push(await fetchSheet(cfg)); }

    const rawSheetsData = [...frozenData, ...activeData];

    const metaDeadline   = new Promise(resolve => setTimeout(() => resolve({}), 5000));
    const enterpriseMeta = await Promise.race([fetchMetabaseCSV(), metaDeadline]);
    const metaIndex      = buildMetaIndex(enterpriseMeta);
    const { byKey: aiAccuracyIndex } = loadAiAccuracy();

    const sheetsResults = await Promise.allSettled(
      rawSheetsData.map(({ cfg, outputRows, factorRows, removedRows }) =>
        Promise.resolve(computeMonth(cfg, outputRows, factorRows, removedRows, metaIndex, aiAccuracyIndex))
      )
    );

    const months = sheetsResults.filter(r => r.status === 'fulfilled').map(r => r.value);
    const errors = sheetsResults.map((r, i) => r.status === 'rejected' ? { month: SHEETS[i].month, error: r.reason?.message || String(r.reason) } : null).filter(Boolean);

    if (months.length === 0) return res.status(500).json({ error: 'All sheet fetches failed', details: errors });

    const payload = { months, errors, enterpriseMeta, fetchedAt: new Date().toISOString() };
    _memCache = { data: payload, ts: Date.now() };
    writeDiskCache(payload);

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('[data.js error]', err);
    res.status(500).json({ error: err.message });
  }
};
