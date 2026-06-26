// api/data.js  –  Vercel Serverless Function (CommonJS)
// Reads all 6 Google Sheets (output + Salary + enterprise_details per month)
// and returns computed analytics. No auth required on the client side.
//
// Salary sheet columns (A=0 … H=7):
//   A=EmpNo  B=Name  C=WorkEmail  D=Type  E=Salary  F=ProrataSalary  G=Factor  H=factor_Salary
//   Row 1: Month meta | Row 2: Data Till | Row 3: Factor | Row 4: Employees + Total Salary
//   Row 5: Header     | Row 6+: Employee data
//
// Output sheet columns (A=0 … M=12):
//   A=Date  B=Product  C=Verticle  D=Type  E=Enterprise  F=DealerType
//   G=QCEditor  H=SKU_Count  I=Images  J=Tools  K=SumTarget  L=ActualMins  M=factor
//
// ENV VARS: GOOGLE_SERVICE_ACCOUNT_EMAIL  GOOGLE_PRIVATE_KEY

'use strict';

const { google } = require('googleapis');

// ─── Sheet registry ──────────────────────────────────────────────────────────
const SHEETS = [
  { month: 'Jan-26', key: 'jan26', id: '1VI-9hxnFIynsTOl3aCdIiR-RRAfRssISOWnZdddCz4Q' },
  { month: 'Feb-26', key: 'feb26', id: '1K2SMR34s0O21BKGpCX-EsUPgOdiAkiuUW8yDyyvFzQU' },
  { month: 'Mar-26', key: 'mar26', id: '1_2xlqYzD15vhZ4qfsH-3kGHj8LXljpdUjdgFIfS5-Iw' },
  { month: 'Apr-26', key: 'apr26', id: '1cKEaxHNOqU2vpnCsnHbf1PfQdVnReg3MsGIgqgE1UhE' },
  { month: 'May-26', key: 'may26', id: '1_3d_XJmSbBziSCicauYEiP1J5N4RRW6pGco49uWuh84' },
  { month: 'Jun-26', key: 'jun26', id: '1i3KqktELNb-ykpZeHaMh3wk3FBBV-eHNAw6736oaXbI' },
];

// Always-excluded emails (merged with remove_users sheet)
const ALWAYS_EXCLUDE = new Set([
  'ranbir.manoranjan@spyne.ai', 'ankit.choudhary@spyne.ai', 'ddroppova810@gmail.com',
  'nitin.kumar@spyne.ai', 'vinod.singh+1@cariotauto.com', 'kishor@spyne.ai',
  'saloni.sharma+1@cariotauto.com', 'mukesh.1+1@cariotauto.com', 'mohit.sharma+1@cariotauto.com',
  'ajay.kumar+1@cariotauto.com', 'rahul.kumar+1@cariotauto.com', 'test@spyne.ai',
  'demo@spyne.ai', 'admin@spyne.ai', 'ravi.shankar@spyne.ai', 'deepak.kumar@spyne.ai',
  'amit.verma@spyne.ai', 'sanjay.gupta@spyne.ai', 'vijay.singh@spyne.ai',
  'praveen@spyne.ai', 'rohit.sharma@spyne.ai', 'suresh.kumar@spyne.ai',
]);

// ─── Google Auth ──────────────────────────────────────────────────────────────
function getAuth() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!clientEmail || !privateKey) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY env vars');
  }
  return new google.auth.GoogleAuth({
    credentials: { client_email: clientEmail, private_key: privateKey },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

// ─── Fetch a single range ─────────────────────────────────────────────────────
async function fetchRange(sheets, spreadsheetId, range) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values || [];
  } catch (e) {
    console.warn(`fetchRange failed: ${spreadsheetId} ${range}:`, e.message);
    return [];
  }
}

// ─── Parse output sheet ───────────────────────────────────────────────────────
function parseOutput(rows, excludeSet) {
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 8) continue;
    const editor = (r[6] || '').trim().toLowerCase();
    if (!editor) continue;
    if (excludeSet.has(editor)) continue;

    const skuCount  = parseFloat(r[7])  || 0;
    const images    = parseFloat(r[8])  || 0;
    const tools     = parseFloat(r[9])  || 0;
    const sumTarget = parseFloat(r[10]) || 0;
    const actualMins= parseFloat(r[11]) || 0;
    const factor    = parseFloat(r[12]) || 1;

    records.push({
      date:        (r[0] || '').trim(),
      product:     (r[1] || '').trim(),
      vertical:    (r[2] || '').trim(),
      type:        (r[3] || '').trim().toLowerCase(),   // 'qc' or 'reqc'
      enterprise:  (r[4] || '').trim(),
      dealerType:  (r[5] || '').trim(),
      editor,
      skuCount, images, tools, sumTarget, actualMins, factor,
    });
  }
  return records;
}

// ─── Parse salary sheet ────────────────────────────────────────────────────────
// Cols: A=EmpNo B=Name C=WorkEmail D=Type E=Salary F=ProrataSalary G=Factor H=factor_Salary
// Rows 1-4 = metadata, Row 5 = header, Row 6+ = employee rows
function parseSalary(rows, excludeSet) {
  const employees = [];
  let totalCostFromSheet = 0;

  // Row 4 (index 3) has "Employees / Total Salary" — try to read total from col H
  if (rows[3]) {
    const metaRow = rows[3];
    for (let c = metaRow.length - 1; c >= 0; c--) {
      const v = parseFloat((metaRow[c] || '').toString().replace(/,/g, ''));
      if (!isNaN(v) && v > 10000) { totalCostFromSheet = v; break; }
    }
  }

  for (let i = 5; i < rows.length; i++) {  // row 6+ = index 5+
    const r = rows[i];
    if (!r || r.length < 5) continue;
    const email = (r[2] || '').trim().toLowerCase();
    if (!email || !email.includes('@')) continue;
    if (excludeSet.has(email)) continue;

    const salary       = parseFloat((r[4] || '0').toString().replace(/,/g, '')) || 0;
    const prorata      = parseFloat((r[5] || '0').toString().replace(/,/g, '')) || salary;
    const factorVal    = parseFloat((r[6] || '1').toString().replace(/,/g, '')) || 1;
    const factorSalary = parseFloat((r[7] || '0').toString().replace(/,/g, '')) || (prorata * factorVal);

    employees.push({
      empNo:  (r[0] || '').trim(),
      name:   (r[1] || '').trim(),
      email,
      type:   (r[3] || '').trim(),
      salary, prorata, factorVal, factorSalary,
    });
  }

  const computedTotal = employees.reduce((s, e) => s + e.factorSalary, 0);
  return {
    employees,
    totalCost: totalCostFromSheet > 0 ? totalCostFromSheet : computedTotal,
  };
}

// ─── Parse enterprise_details sheet ──────────────────────────────────────────
// Cols: A=Enterprise  B=CustomerSegment  C=... (variable)
function parseEnterprise(rows) {
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const name = r[0].trim();
    if (!name) continue;
    map[name.toLowerCase()] = {
      originalName:    name,
      customerSegment: (r[1] || '').trim(),
      dealerType:      (r[2] || '').trim(),
      mrr:             parseFloat((r[3] || '0').toString().replace(/,/g, '')) || 0,
    };
  }
  return map;
}

// ─── Parse remove_users sheet ─────────────────────────────────────────────────
function parseRemovedUsers(rows) {
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
  const set = new Set(ALWAYS_EXCLUDE);
  for (const row of rows) {
    if (!row) continue;
    for (const cell of row) {
      if (!cell) continue;
      const m = cell.toString().match(EMAIL_RE);
      if (m) set.add(m[0].toLowerCase().trim());
    }
  }
  return set;
}

// ─── Build normalized meta index ──────────────────────────────────────────────
function buildMetaIndex(entMap) {
  // entMap is keyed by lowercase name already (from parseEnterprise)
  return entMap; // already normalized
}

function lookupMeta(entMap, outputName) {
  if (!outputName) return null;
  return entMap[outputName.toLowerCase().trim()] || null;
}

// ─── Aggregate per-month analytics ────────────────────────────────────────────
function aggregateMonth(records, salaryData, entMap) {
  const { employees, totalCost } = salaryData;

  // Salary lookup by email
  const salaryByEmail = {};
  for (const e of employees) salaryByEmail[e.email] = e;

  // Total production units
  let totalImages = 0, totalSKUs = 0, totalVINs = 0;
  let totalTarget = 0, totalActual = 0;

  // Per-product
  const productMap = {};
  // Per-editor
  const editorMap = {};
  // Per-enterprise
  const enterpriseMap = {};
  // Per-segment
  const segmentMap = {};
  // Per-dealer
  const dealerMap = {};

  for (const row of records) {
    const meta   = lookupMeta(entMap, row.enterprise);
    const seg    = meta ? (meta.customerSegment || 'Unknown') : 'Unknown';
    const dealer = row.dealerType || (meta ? meta.dealerType : '') || 'Unknown';
    const mrr    = meta ? meta.mrr : 0;

    const imgs  = row.images;
    const skus  = row.skuCount;
    const prod  = row.product || 'Unknown';
    const isReqc = row.type === 'reqc';

    // Billing units by product type
    let units = 0;
    const pl = prod.toLowerCase();
    if (pl.includes('image')) units = imgs;
    else if (pl.includes('360')) units = skus;
    else if (pl.includes('video')) units = isReqc ? skus : 0;
    else units = imgs || skus;

    // VINs proxy = image SKU count only
    let vins = 0;
    if (pl.includes('image')) vins = skus;

    totalImages += imgs;
    totalSKUs   += skus;
    totalVINs   += vins;
    totalTarget += row.sumTarget;
    totalActual += row.actualMins;

    // Product
    if (!productMap[prod]) productMap[prod] = { product: prod, images: 0, skus: 0, vins: 0, units: 0, target: 0, actual: 0, rows: 0 };
    productMap[prod].images += imgs;
    productMap[prod].skus   += skus;
    productMap[prod].vins   += vins;
    productMap[prod].units  += units;
    productMap[prod].target += row.sumTarget;
    productMap[prod].actual += row.actualMins;
    productMap[prod].rows   += 1;

    // Editor
    const ed = row.editor;
    if (!editorMap[ed]) editorMap[ed] = { editor: ed, images: 0, skus: 0, units: 0, target: 0, actual: 0, rows: 0, salary: 0, factorSalary: 0 };
    editorMap[ed].images += imgs;
    editorMap[ed].skus   += skus;
    editorMap[ed].units  += units;
    editorMap[ed].target += row.sumTarget;
    editorMap[ed].actual += row.actualMins;
    editorMap[ed].rows   += 1;
    const sal = salaryByEmail[ed];
    if (sal) { editorMap[ed].salary = sal.salary; editorMap[ed].factorSalary = sal.factorSalary; }

    // Enterprise
    const entKey = row.enterprise.toLowerCase();
    if (!enterpriseMap[entKey]) enterpriseMap[entKey] = {
      enterprise: row.enterprise, seg, dealer, mrr,
      images: 0, skus: 0, vins: 0, units: 0, target: 0, actual: 0,
    };
    enterpriseMap[entKey].images += imgs;
    enterpriseMap[entKey].skus   += skus;
    enterpriseMap[entKey].vins   += vins;
    enterpriseMap[entKey].units  += units;
    enterpriseMap[entKey].target += row.sumTarget;
    enterpriseMap[entKey].actual += row.actualMins;

    // Segment
    if (!segmentMap[seg]) segmentMap[seg] = { seg, images: 0, skus: 0, units: 0, cost: 0 };
    segmentMap[seg].images += imgs;
    segmentMap[seg].skus   += skus;
    segmentMap[seg].units  += units;

    // Dealer
    if (!dealerMap[dealer]) dealerMap[dealer] = { dealer, images: 0, skus: 0, units: 0 };
    dealerMap[dealer].images += imgs;
    dealerMap[dealer].skus   += skus;
    dealerMap[dealer].units  += units;
  }

  // Cost per unit (total / total units)
  const totalUnits = Object.values(productMap).reduce((s, p) => s + p.units, 0);
  const costPerUnit = totalUnits > 0 ? totalCost / totalUnits : 0;

  // Enrich editors with cost
  const editors = Object.values(editorMap).map(e => ({
    ...e,
    efficiency: e.target > 0 ? (e.target / (e.actual || e.target)) : 0,
    costPerUnit: e.units > 0 ? e.factorSalary / e.units : 0,
  })).sort((a, b) => b.units - a.units);

  // Enrich enterprises with delivery cost
  const enterprises = Object.values(enterpriseMap).map(e => ({
    ...e,
    efficiency: e.target > 0 ? (e.target / (e.actual || e.target)) : 0,
    costPerUnit: e.units > 0 ? costPerUnit : 0,
    totalCost:   e.units > 0 ? Math.round(costPerUnit * e.units) : 0,
  })).sort((a, b) => b.costPerUnit - a.costPerUnit).slice(0, 30);

  // Products enriched
  const products = Object.values(productMap).map(p => ({
    ...p,
    efficiency: p.target > 0 ? (p.target / (p.actual || p.target)) : 0,
    costPerUnit: p.units > 0 ? costPerUnit : 0,
    totalCost:   p.units > 0 ? Math.round(costPerUnit * p.units) : 0,
  }));

  // Segment cost distribution
  const segments = Object.values(segmentMap).map(s => ({
    ...s,
    totalCost: s.units > 0 ? Math.round(costPerUnit * s.units) : 0,
    pct: totalUnits > 0 ? Math.round(s.units / totalUnits * 100) : 0,
  }));

  return {
    totalImages, totalSKUs, totalVINs,
    totalTarget, totalActual,
    totalCost,
    totalUnits,
    costPerUnit: Math.round(costPerUnit * 100) / 100,
    efficiency: totalTarget > 0 ? Math.round(totalTarget / (totalActual || totalTarget) * 100) / 100 : 0,
    headcount: employees.length,
    products,
    editors,
    enterprises,
    segments,
    dealers: Object.values(dealerMap),
  };
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Serve cache
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) {
    return res.status(200).json(_cache);
  }

  try {
    const auth   = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // Fetch all sheets in parallel
    const monthData = await Promise.all(SHEETS.map(async (sh) => {
      const [outputRows, salaryRows, entRows, removeRows] = await Promise.all([
        fetchRange(sheets, sh.id, 'output!A:M'),
        fetchRange(sheets, sh.id, 'Salary!A:H'),
        fetchRange(sheets, sh.id, 'enterprise_details!A:D'),
        fetchRange(sheets, sh.id, 'remove_users!A:E').catch(() => []),
      ]);

      const excludeSet  = parseRemovedUsers(removeRows);
      const entMap      = parseEnterprise(entRows);
      const metaIndex   = buildMetaIndex(entMap);
      const records     = parseOutput(outputRows, excludeSet);
      const salaryData  = parseSalary(salaryRows, excludeSet);
      const analytics   = aggregateMonth(records, salaryData, metaIndex);

      return { month: sh.month, key: sh.key, ...analytics };
    }));

    // Build enterprise meta map (for frontend enrichment)
    // Aggregate across all months — last seen wins for static fields
    const enterpriseMeta = {};
    for (const md of monthData) {
      for (const e of (md.enterprises || [])) {
        const key = e.enterprise.toLowerCase().trim();
        if (!enterpriseMeta[key]) {
          enterpriseMeta[key] = {
            originalName:    e.enterprise,
            customerSegment: e.seg,
            dealerType:      e.dealer,
            mrr:             e.mrr || 0,
          };
        }
      }
    }

    const payload = { months: monthData, enterpriseMeta };
    _cache   = payload;
    _cacheTs = Date.now();

    return res.status(200).json(payload);
  } catch (err) {
    console.error('[data.js] Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
