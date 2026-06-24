// api/data.js — Vercel Serverless Function (CommonJS)

const { google } = require('googleapis');
const https = require('https');

const METABASE_CSV_URL = 'https://metabase.spyne.ai/public/question/84265073-fe7b-4ee1-81d7-5eb37a7e9b2f.csv';

// ── Fetch & parse Metabase enterprise CSV ─────────────────────────────────────
// Returns map: enterpriseName → { segment, csPoc, obPoc, liveArr }
function fetchMetabaseCSV() {
  return new Promise((resolve) => {
    const req = https.get(METABASE_CSV_URL, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(parseEnterpriseMeta(data));
        } catch (e) {
          console.error('[metabase] parse error:', e.message);
          resolve({});
        }
      });
    });
    req.on('error', (e) => {
      console.error('[metabase] fetch error:', e.message);
      resolve({});
    });
    req.on('timeout', () => {
      console.error('[metabase] fetch timeout');
      req.destroy();
      resolve({});
    });
  });
}

function parseEnterpriseMeta(csvText) {
  const map = {};
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return map;

  // Parse a CSV line respecting quoted fields
  function parseLine(line) {
    const cols = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && !inQ)               { inQ = true; }
      else if (c === '"' && inQ && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"' && inQ)           { inQ = false; }
      else if (c === ',' && !inQ)          { cols.push(cur); cur = ''; }
      else                                  { cur += c; }
    }
    cols.push(cur);
    return cols;
  }

  const headers = parseLine(lines[0]);
  const idx = {
    name:    headers.findIndex(h => /enterprise name/i.test(h)),
    seg:     headers.findIndex(h => /customer segment/i.test(h)),
    csPoc:   headers.findIndex(h => /cs poc/i.test(h)),
    obPoc:   headers.findIndex(h => /ob poc/i.test(h)),
    liveArr: headers.findIndex(h => /live arr/i.test(h)),
  };

  lines.slice(1).forEach(line => {
    if (!line.trim()) return;
    const cols = parseLine(line);
    const name = (cols[idx.name] || '').trim();
    if (!name) return;

    const segment = (cols[idx.seg]    || '').trim();
    const csPoc   = (cols[idx.csPoc]  || '').trim();
    const obPoc   = (cols[idx.obPoc]  || '').trim();
    const liveArr = (cols[idx.liveArr]|| '').trim();

    if (!map[name]) {
      // First row for this enterprise — create entry
      map[name] = { segment, csPoc, obPoc, liveArr };
    } else {
      // Subsequent team row — merge: keep first non-empty value for each field
      // (all teams share the same enterprise-level details, but some rows may
      //  have blanks; take the first populated value seen)
      if (!map[name].segment && segment) map[name].segment = segment;
      if (!map[name].csPoc   && csPoc)   map[name].csPoc   = csPoc;
      if (!map[name].obPoc   && obPoc)   map[name].obPoc   = obPoc;
      if (!map[name].liveArr && liveArr) map[name].liveArr = liveArr;
    }
  });
  return map;
}

// Build a normalized (lowercase+trim) lookup index from the meta map
// so output's "Enterprise" column can match Metabase's "Enterprise Name"
// even if casing or spacing differs slightly
function buildMetaIndex(metaMap) {
  const index = {};
  Object.entries(metaMap).forEach(([name, val]) => {
    index[name.toLowerCase().trim()] = { originalKey: name, ...val };
  });
  return index;
}

// Lookup enterprise meta by output enterprise name (normalized match)
function lookupMeta(metaIndex, outputName) {
  if (!outputName) return null;
  return metaIndex[outputName.toLowerCase().trim()] || null;
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  ADD A NEW MONTH — edit ONLY this array, nothing else needed    ║
// ║                                                                  ║
// ║  1. Extract Sheet ID from the URL:                               ║
// ║     https://docs.google.com/spreadsheets/d/ ► SHEET_ID ◄ /edit  ║
// ║  2. Add one line below                                           ║
// ║  3. Share the sheet with the service account email (Viewer)      ║
// ║  4. Commit & push — Vercel auto-deploys                          ║
// ╚══════════════════════════════════════════════════════════════════╝
const SHEETS = [
  { month: 'Jan-26', key: 'jan26', id: '1VI-9hxnFIynsTOl3aCdIiR-RRAfRssISOWnZdddCz4Q' },
  { month: 'Feb-26', key: 'feb26', id: '1K2SMR34s0O21BKGpCX-EsUPgOdiAkiuUW8yDyyvFzQU' },
  { month: 'Mar-26', key: 'mar26', id: '1_2xlqYzD15vhZ4qfsH-3kGHj8LXljpdUjdgFIfS5-Iw' },
  { month: 'Apr-26', key: 'apr26', id: '1cKEaxHNOqU2vpnCsnHbf1PfQdVnReg3MsGIgqgE1UhE' },
  { month: 'May-26', key: 'may26', id: '1_3d_XJmSbBziSCicauYEiP1J5N4RRW6pGco49uWuh84' },
  { month: 'Jun-26', key: 'jun26', id: '1i3KqktELNb-ykpZeHaMh3wk3FBBV-eHNAw6736oaXbI' },
  // ↓ ADD NEW MONTHS HERE ↓
  // { month: 'Jul-26', key: 'jul26', id: 'PASTE_SHEET_ID_HERE' },
];

// Always-excluded emails
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
  'raj.tripathi@spyne.ai',
]);

// ── Product helpers ───────────────────────────────────────────────────────────
const isImage = p => /image/i.test(p);
const is360   = p => /360|spin/i.test(p);
const isVideo = p => /video/i.test(p);
const billingUnits = row => isImage(row.product) ? row.images : row.skus;
const isVinProduct = p => isImage(p);

// ── Google auth ───────────────────────────────────────────────────────────────
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

async function fetchRange(client, sheetId, range) {
  try {
    const res = await client.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    return res.data.values || [];
  } catch (e) {
    console.error(`fetchRange failed [${sheetId}][${range}]:`, e.message);
    return [];
  }
}

// ── Parsers ───────────────────────────────────────────────────────────────────

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

// Output: A=Date B=Product C=Verticle D=Type E=Enterprise
//         F=DealerType G=QCEditor H=SKU_Count I=Images J=Tools K=SumTarget L=ActualMins M=factor
function parseOutput(rows, excludeSet) {
  if (!rows || rows.length < 2) return [];
  return rows.slice(1)
    .filter(r => r && r[0])
    .map(r => ({
      date:       r[0]  || '',
      product:    r[1]  || '',
      verticle:   r[2]  || '',
      type:       (r[3] || '').toLowerCase().trim(),
      enterprise: r[4]  || '',
      dealerType: r[5]  || '',
      qcEditor:   r[6]  || '',
      skus:       +r[7]  || 0,
      images:     +r[8]  || 0,
      tools:      +r[9]  || 0,
      sumTarget:  +r[10] || 0,
      actualMins: +r[11] || 0,
      factor:     +r[12] || 0,
    }))
    .filter(r => !excludeSet.has((r.qcEditor || '').toLowerCase().trim()))
    .filter(r => isVideo(r.product) ? r.type === 'reqc' : true);
}

// factor_calculation sheet:
//   Row 1: summary totals (C=totalMins, D=inhouseCostTotal, E=osCostTotal, F=totalCost)
//   Row 2: headers (A=QC, B=Type, C=Total Mins, D=Inhouse, E=OS, F=Cost, G=Factor)
//   Row 3+: one row per editor
//     A=email  B=type(Payroll|OS)  C=totalMins  D=inhouseCost  E=osCost  F=totalCost  G=factor
//
// Type "Payroll" = inhouse employee
// Type "OS"      = outsourced/contractor
function parseFactorCalc(rows, excludeSet) {
  if (!rows || rows.length < 3) return {
    totalCost: 0, inhouseCost: 0, osCost: 0,
    employees: [], excludedEmployees: [],
  };
  const num = s => parseFloat((s || '').toString().replace(/,/g, '')) || 0;

  // Row 0 (row 1 in sheet) = totals summary — use as cross-check
  // Row 1 (row 2) = headers — skip
  // Row 2+ = editor data
  const allEditors = rows.slice(2)
    .filter(r => r && r[0] && (r[0] || '').toString().includes('@'))
    .map(r => ({
      email:       (r[0] || '').toString().toLowerCase().trim(),
      teamType:    (r[1] || '').toString().trim(),   // 'Payroll' = inhouse, 'OS' = outsource
      totalMins:   num(r[2]),
      inhouseCost: num(r[3]),  // col D — inhouse cost portion
      osCost:      num(r[4]),  // col E — OS cost portion
      totalCost:   num(r[5]),  // col F — total cost (primary cost figure)
      factor:      num(r[6]),  // col G — cost per minute
    }));

  const excludedEditors = allEditors.filter(e => excludeSet.has(e.email));
  const editors         = allEditors.filter(e => !excludeSet.has(e.email));

  const totalCost   = editors.reduce((s, e) => s + e.totalCost,   0);
  const inhouseCost = editors.reduce((s, e) => s + e.inhouseCost, 0);
  const osCost      = editors.reduce((s, e) => s + e.osCost,      0);

  return { totalCost, inhouseCost, osCost, employees: editors, excludedEmployees: excludedEditors };
}

// enterprise_details: A=ID B=Name C=InvVersion D=CustomerSegment
function parseEnterprise(rows) {
  const map = {};
  (rows || []).slice(1).forEach(r => {
    if (r && r[1]) map[r[1].trim()] = { segment: r[3] || 'Unknown', inventoryVersion: r[2] || '' };
  });
  return map;
}

// ── Aggregation ───────────────────────────────────────────────────────────────
function groupSum(rows, keyFn) {
  const acc = {};
  rows.forEach(r => {
    const k = keyFn(r) || 'Unknown';
    if (!acc[k]) acc[k] = { images:0, skus:0, units:0, vins:0, actualMins:0, sumTarget:0, rows:0 };
    acc[k].images     += r.images;
    acc[k].skus       += r.skus;
    acc[k].units      += billingUnits(r);
    acc[k].vins       += isVinProduct(r.product) ? r.skus : 0;
    acc[k].actualMins += r.actualMins;
    acc[k].sumTarget  += r.sumTarget;
    acc[k].rows++;
  });
  return acc;
}

function enrichGroup(name, g, allocatedCost) {
  const eff = g.actualMins > 0 ? (g.sumTarget / g.actualMins) * 100 : 0;
  return {
    name,
    images:       Math.round(g.images),
    skus:         Math.round(g.skus),
    units:        Math.round(g.units),
    vins:         Math.round(g.vins),
    actualMins:   Math.round(g.actualMins),
    sumTarget:    Math.round(g.sumTarget),
    rows:         g.rows,
    efficiency:   +eff.toFixed(2),
    costPerUnit:  g.units  > 0 ? +(allocatedCost / g.units).toFixed(2)  : 0,
    costPerSku:   g.skus   > 0 ? +(allocatedCost / g.skus).toFixed(2)   : 0,
    costPerVin:   g.vins   > 0 ? +(allocatedCost / g.vins).toFixed(2)   : 0,
    costPerImage: g.images > 0 ? +(allocatedCost / g.images).toFixed(2) : 0,
  };
}

// ── Per-month compute ─────────────────────────────────────────────────────────
function computeMonth(config, outputRows, factorRows, enterpriseRows, removedRows, metaIndex) {
  const sheetExcluded = parseRemovedUsers(removedRows);
  const excludeSet    = buildExcludeSet(sheetExcluded);

  const output = parseOutput(outputRows, excludeSet);
  const {
    totalCost, inhouseCost, osCost,
    employees, excludedEmployees,
  } = parseFactorCalc(factorRows, excludeSet);
  const entMap = parseEnterprise(enterpriseRows);

  // Editor cost lookup: email → { totalCost, inhouseCost, osCost, teamType, factor }
  const editorCostMap = {};
  employees.forEach(e => {
    editorCostMap[e.email] = {
      totalCost:   e.totalCost,
      inhouseCost: e.inhouseCost,
      osCost:      e.osCost,
      teamType:    e.teamType,
      factor:      e.factor,
    };
  });

  const enriched = output.map(r => ({
    ...r,
    segment:          entMap[r.enterprise]?.segment          || 'Unknown',
    inventoryVersion: entMap[r.enterprise]?.inventoryVersion || '',
    // Editor team type from factor_calculation
    teamType: editorCostMap[(r.qcEditor || '').toLowerCase().trim()]?.teamType || 'Unknown',
  }));

  const totalUnits     = enriched.reduce((s, r) => s + billingUnits(r), 0);
  const totalImages    = enriched.reduce((s, r) => s + r.images, 0);
  const totalSkus      = enriched.reduce((s, r) => s + r.skus, 0);
  const totalVins      = enriched.filter(r => isVinProduct(r.product)).reduce((s, r) => s + r.skus, 0);
  const totalActMins   = enriched.reduce((s, r) => s + r.actualMins, 0);
  const totalTarget    = enriched.reduce((s, r) => s + r.sumTarget, 0);
  const efficiency     = totalActMins > 0 ? +((totalTarget / totalActMins) * 100).toFixed(2) : 0;
  const costPerUnit    = totalUnits > 0 ? +(totalCost / totalUnits).toFixed(2) : 0;
  const costPerSku     = totalSkus  > 0 ? +(totalCost / totalSkus).toFixed(2)  : 0;
  const costPerVin     = totalVins  > 0 ? +(totalCost / totalVins).toFixed(2)  : 0;
  const total360Skus   = enriched.filter(r => is360(r.product)).reduce((s, r) => s + r.skus, 0);
  const totalVideoSkus = enriched.filter(r => isVideo(r.product)).reduce((s, r) => s + r.skus, 0);

  // Inhouse vs OS volume split
  const inhouseRows = enriched.filter(r => /payroll/i.test(r.teamType));
  const osRows      = enriched.filter(r => /^os$/i.test(r.teamType));
  const inhouseUnits = inhouseRows.reduce((s, r) => s + billingUnits(r), 0);
  const osUnits      = osRows.reduce((s, r) => s + billingUnits(r), 0);
  const inhouseActMins = inhouseRows.reduce((s, r) => s + r.actualMins, 0);
  const osActMins      = osRows.reduce((s, r) => s + r.actualMins, 0);

  // ── Product breakdown
  const prodGroups = groupSum(enriched, r => r.product);
  const productBreakdown = Object.entries(prodGroups).map(([name, g]) => {
    const costShare = totalActMins > 0 ? (g.actualMins / totalActMins) * totalCost : 0;
    return {
      ...enrichGroup(name, g, costShare),
      costSharePct: totalCost > 0 ? +((costShare / totalCost) * 100).toFixed(1) : 0,
      unitLabel: isImage(name) ? 'Images' : is360(name) ? 'SKUs (spins)' : 'SKUs (videos)',
    };
  }).sort((a, b) => b.actualMins - a.actualMins);

  // ── Editor breakdown — use exact cost from factor_calculation
  const editorGroups = groupSum(enriched, r => r.qcEditor);
  const editorBreakdown = Object.entries(editorGroups).map(([email, g]) => {
    const ec   = editorCostMap[email.toLowerCase().trim()];
    const cost = ec ? ec.totalCost
               : totalActMins > 0 ? (g.actualMins / totalActMins) * totalCost : 0;
    const byProduct = {};
    enriched.filter(r => r.qcEditor === email).forEach(r => {
      if (!byProduct[r.product]) byProduct[r.product] = 0;
      byProduct[r.product] += billingUnits(r);
    });
    return {
      ...enrichGroup(email, g, cost),
      email,
      salary:      ec?.totalCost   || 0,   // keep 'salary' key for compat
      inhouseCost: ec?.inhouseCost || 0,
      osCost:      ec?.osCost      || 0,
      teamType:    ec?.teamType    || 'Unknown',
      factor:      ec?.factor      || 0,
      byProduct,
    };
  }).sort((a, b) => b.units - a.units);

  // ── Segment breakdown
  const segGroups = groupSum(enriched, r => r.segment);
  const segmentBreakdown = Object.entries(segGroups).map(([segName, g]) => {
    const segCost = totalActMins > 0 ? (g.actualMins / totalActMins) * totalCost : 0;
    const segRows = enriched.filter(r => r.segment === segName);

    const byProduct = {};
    segRows.forEach(r => {
      const p = r.product;
      if (!byProduct[p]) byProduct[p] = { units:0, skus:0, images:0, vins:0, actualMins:0, sumTarget:0 };
      byProduct[p].units      += billingUnits(r);
      byProduct[p].skus       += r.skus;
      byProduct[p].images     += r.images;
      byProduct[p].vins       += isVinProduct(r.product) ? r.skus : 0;
      byProduct[p].actualMins += r.actualMins;
      byProduct[p].sumTarget  += r.sumTarget;
    });
    Object.entries(byProduct).forEach(([, pd]) => {
      const pCost = totalActMins > 0 ? (pd.actualMins / totalActMins) * totalCost : 0;
      pd.costPerUnit = pd.units > 0 ? +(pCost / pd.units).toFixed(2) : 0;
      pd.efficiency  = pd.actualMins > 0 ? +((pd.sumTarget / pd.actualMins) * 100).toFixed(2) : 0;
      pd.units = Math.round(pd.units); pd.skus = Math.round(pd.skus);
      pd.images = Math.round(pd.images); pd.vins = Math.round(pd.vins);
      pd.actualMins = Math.round(pd.actualMins);
    });

    const segVins     = segRows.filter(r => isVinProduct(r.product)).reduce((s,r) => s + r.skus, 0);
    const seg360Skus  = segRows.filter(r => is360(r.product)).reduce((s,r) => s + r.skus, 0);
    const segVideoIds = segRows.filter(r => isVideo(r.product)).reduce((s,r) => s + r.skus, 0);

    const entGroups2 = groupSum(segRows, r => r.enterprise);
    const topEnterprises = Object.entries(entGroups2).map(([eName, eg]) => {
      const eCost = totalActMins > 0 ? (eg.actualMins / totalActMins) * totalCost : 0;
      return { ...enrichGroup(eName, eg, eCost), inventoryVersion: entMap[eName]?.inventoryVersion || '' };
    }).sort((a, b) => b.units - a.units).slice(0, 10);

    return {
      ...enrichGroup(segName, g, segCost),
      vins: Math.round(segVins), seg360Skus: Math.round(seg360Skus), segVideoIds: Math.round(segVideoIds),
      costPerVin:        segVins > 0 ? +(segCost / segVins).toFixed(2) : 0,
      costShare:         totalCost > 0 ? +((segCost / totalCost) * 100).toFixed(2) : 0,
      byProduct, topEnterprises,
      uniqueEnterprises: new Set(segRows.map(r => r.enterprise)).size,
    };
  }).sort((a, b) => b.units - a.units);

  // ── Dealer breakdown
  const dealerGroups = groupSum(enriched, r => r.dealerType);
  const dealerBreakdown = Object.entries(dealerGroups).map(([name, g]) => {
    const cost = totalActMins > 0 ? (g.actualMins / totalActMins) * totalCost : 0;
    return enrichGroup(name, g, cost);
  }).sort((a, b) => b.units - a.units);

  // ── Enterprise breakdown (top 25)
  const entGroups = groupSum(enriched, r => r.enterprise);
  const enterpriseBreakdown = Object.entries(entGroups).map(([name, g]) => {
    const cost = totalActMins > 0 ? (g.actualMins / totalActMins) * totalCost : 0;
    // Look up Metabase meta by normalized name match
    const meta = metaIndex ? lookupMeta(metaIndex, name) : null;
    return {
      ...enrichGroup(name, g, cost),
      segment:          entMap[name]?.segment          || meta?.segment || 'Unknown',
      inventoryVersion: entMap[name]?.inventoryVersion || '',
      // Metabase enrichment fields
      csPoc:   meta?.csPoc   || '',
      obPoc:   meta?.obPoc   || '',
      liveArr: meta?.liveArr || '',
    };
  }).sort((a, b) => b.units - a.units).slice(0, 25);

  // ── Inhouse vs OS breakdown
  const teamBreakdown = {
    inhouse: {
      cost:        Math.round(inhouseCost),
      units:       Math.round(inhouseUnits),
      actualMins:  Math.round(inhouseActMins),
      employees:   employees.filter(e => /payroll/i.test(e.teamType)).length,
      costPerUnit: inhouseUnits > 0 ? +(inhouseCost / inhouseUnits).toFixed(2) : 0,
    },
    os: {
      cost:        Math.round(osCost),
      units:       Math.round(osUnits),
      actualMins:  Math.round(osActMins),
      employees:   employees.filter(e => /^os$/i.test(e.teamType)).length,
      costPerUnit: osUnits > 0 ? +(osCost / osUnits).toFixed(2) : 0,
    },
  };

  return {
    month: config.month,
    key:   config.key,
    summary: {
      totalCost:       Math.round(totalCost),
      inhouseCost:     Math.round(inhouseCost),
      osCost:          Math.round(osCost),
      totalImages:     Math.round(totalImages),
      totalSkus:       Math.round(totalSkus),
      total360Skus:    Math.round(total360Skus),
      totalVideoSkus:  Math.round(totalVideoSkus),
      totalVins:       Math.round(totalVins),
      totalUnits:      Math.round(totalUnits),
      totalActMins:    Math.round(totalActMins),
      totalTarget:     Math.round(totalTarget),
      efficiency,
      costPerUnit,
      costPerSku,
      costPerVin,
      employees:       employees.length,
    },
    teamBreakdown,
    productBreakdown,
    editorBreakdown,
    segmentBreakdown,
    dealerBreakdown,
    enterpriseBreakdown,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });
  try {
    const client = getSheetsClient();

    // Fetch Sheets data + Metabase enterprise meta in parallel
    // Fetch Metabase meta and Sheets data concurrently
    // metaIndex is built after both resolve so computeMonth gets enriched data
    const [rawSheetsData, enterpriseMeta] = await Promise.all([
      // Fetch all sheet ranges in parallel (without computing yet)
      Promise.all(
        SHEETS.map(async cfg => {
          const [outputRows, factorRows, entRows, removedRows] = await Promise.all([
            fetchRange(client, cfg.id, 'output!A:M'),
            fetchRange(client, cfg.id, 'factor_calculation!A:G'),
            fetchRange(client, cfg.id, 'enterprise_details!A:D'),
            fetchRange(client, cfg.id, 'remove_users!A:E'),
          ]);
          return { cfg, outputRows, factorRows, entRows, removedRows };
        })
      ),
      fetchMetabaseCSV(), // concurrent — never blocks if it fails
    ]);

    // Now build metaIndex and compute months with enriched enterprise data
    const metaIndex = buildMetaIndex(enterpriseMeta);
    const sheetsResults = await Promise.allSettled(
      rawSheetsData.map(({ cfg, outputRows, factorRows, entRows, removedRows }) =>
        Promise.resolve(computeMonth(cfg, outputRows, factorRows, entRows, removedRows, metaIndex))
      )
    );
    const months = sheetsResults.filter(r => r.status === 'fulfilled').map(r => r.value);
    const errors = sheetsResults
      .map((r, i) => r.status === 'rejected'
        ? { month: SHEETS[i].month, error: r.reason?.message || String(r.reason) }
        : null)
      .filter(Boolean);

    if (months.length === 0)
      return res.status(500).json({ error: 'All sheet fetches failed', details: errors });

    res.status(200).json({
      months,
      errors,
      enterpriseMeta,   // ← included in every response
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[data.js error]', err);
    res.status(500).json({ error: err.message });
  }
};
