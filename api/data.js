// api/data.js  –  Vercel Serverless Function
// Reads all 6 Google Sheets (output + Salary + enterprise_details per month)
// and returns computed analytics. No auth required on the client side.
//
// ENV VARS needed in Vercel dashboard:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY          (paste the full key, Vercel keeps \n as-is)

import { google } from 'googleapis';

// ─── Sheet registry ─────────────────────────────────────────────────────────
const SHEETS = [
  { month: 'Jan-26', key: 'jan26', id: '1VI-9hxnFIynsTOl3aCdIiR-RRAfRssISOWnZdddCz4Q' },
  { month: 'Feb-26', key: 'feb26', id: '1K2SMR34s0O21BKGpCX-EsUPgOdiAkiuUW8yDyyvFzQU' },
  { month: 'Mar-26', key: 'mar26', id: '1_2xlqYzD15vhZ4qfsH-3kGHj8LXljpdUjdgFIfS5-Iw' },
  { month: 'Apr-26', key: 'apr26', id: '1cKEaxHNOqU2vpnCsnHbf1PfQdVnReg3MsGIgqgE1UhE' },
  { month: 'May-26', key: 'may26', id: '1_3d_XJmSbBziSCicauYEiP1J5N4RRW6pGco49uWuh84' },
  { month: 'Jun-26', key: 'jun26', id: '1i3KqktELNb-ykpZeHaMh3wk3FBBV-eHNAw6736oaXbI' },
];

// ─── Google auth ─────────────────────────────────────────────────────────────
function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function fetchRange(api, sheetId, range) {
  const res = await api.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return res.data.values || [];
}

// ─── Parsers ──────────────────────────────────────────────────────────────────
// output sheet: A=Hourly_Date B=Product C=Verticle D=Type E=Enterprise
//               F=Dealer_Type G=QC H=SKU_Count I=Images J=Tool_Count
//               K=Sum_Target L=Actual_Mins M=factor
function parseOutput(rows) {
  if (rows.length < 2) return [];
  return rows.slice(1)
    .filter(r => r[0])
    .map(r => ({
      date:        r[0]  || '',
      product:     r[1]  || '',
      verticle:    r[2]  || '',
      type:        r[3]  || '',
      enterprise:  r[4]  || '',
      dealerType:  r[5]  || '',
      qcEditor:    r[6]  || '',
      skus:        +r[7]  || 0,
      images:      +r[8]  || 0,
      tools:       +r[9]  || 0,
      sumTarget:   +r[10] || 0,
      actualMins:  +r[11] || 0,
      factor:      +r[12] || 0,
    }));
}

// Salary sheet rows 1-4 = meta, row 5 = header, row 6+ = employees
// cols: A=EmpNo B=Name C=Email D=(blank) E=Type F=Salary G=Prorata H=Factor I=factor_Salary
function parseSalary(rows) {
  if (rows.length < 5) return { totalCost: 0, employees: [] };

  const num = s => parseFloat((s || '').replace(/,/g, '')) || 0;

  // Row index 3 (row 4) has total salary in col F (index 5) and H (index 7)
  const totalCost = num(rows[3]?.[7]) || num(rows[3]?.[5]) || 0;

  const employees = rows.slice(5)
    .filter(r => r[0])
    .map(r => ({
      empNo:        r[0] || '',
      name:         r[1] || '',
      email:        r[2] || '',
      type:         r[4] || '',
      salary:       num(r[5]),
      prorata:      num(r[6]),
      factor:       +r[7] || 1,
      factorSalary: num(r[8]),
    }));

  return { totalCost, employees };
}

// enterprise_details: A=ID B=Name C=InvVersion D=CustomerSegment
function parseEnterprise(rows) {
  const map = {};
  rows.slice(1).forEach(r => {
    if (r[1]) map[r[1].trim()] = r[3] || 'Unknown';
  });
  return map;
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────
function groupSum(rows, keyFn) {
  const acc = {};
  rows.forEach(r => {
    const k = keyFn(r);
    if (!acc[k]) acc[k] = { images: 0, skus: 0, actualMins: 0, sumTarget: 0, rows: 0 };
    acc[k].images     += r.images;
    acc[k].skus       += r.skus;
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
    actualMins:   Math.round(g.actualMins),
    sumTarget:    Math.round(g.sumTarget),
    rows:         g.rows,
    efficiency:   +eff.toFixed(1),
    costPerImage: g.images > 0 ? +(allocatedCost / g.images).toFixed(2) : 0,
    costPerSku:   g.skus   > 0 ? +(allocatedCost / g.skus).toFixed(2)   : 0,
  };
}

// ─── Per-month compute ────────────────────────────────────────────────────────
function computeMonth(config, outputRows, salaryRows, enterpriseRows) {
  const output    = parseOutput(outputRows);
  const { totalCost, employees } = parseSalary(salaryRows);
  const segMap    = parseEnterprise(enterpriseRows);

  // Build editor salary map  email → factorSalary
  const editorSalaryMap = {};
  employees.forEach(e => { if (e.email) editorSalaryMap[e.email] = e.factorSalary; });

  // Enrich output rows
  const enriched = output.map(r => ({
    ...r,
    segment: segMap[r.enterprise] || 'Unknown',
  }));

  const totalImages    = enriched.reduce((s, r) => s + r.images, 0);
  const totalSkus      = enriched.reduce((s, r) => s + r.skus, 0);
  const totalActMins   = enriched.reduce((s, r) => s + r.actualMins, 0);
  const totalTarget    = enriched.reduce((s, r) => s + r.sumTarget, 0);
  const efficiency     = totalActMins > 0 ? +((totalTarget / totalActMins) * 100).toFixed(1) : 0;
  const costPerImage   = totalImages > 0 ? +(totalCost / totalImages).toFixed(2) : 0;
  const costPerSku     = totalSkus   > 0 ? +(totalCost / totalSkus).toFixed(2)   : 0;

  // ── Product breakdown
  const prodGroups = groupSum(enriched, r => r.product);
  const productBreakdown = Object.entries(prodGroups).map(([name, g]) => {
    const costShare = totalActMins > 0 ? (g.actualMins / totalActMins) * totalCost : 0;
    return enrichGroup(name, g, costShare);
  }).sort((a, b) => b.images - a.images);

  // ── QC Editor breakdown
  const editorGroups = groupSum(enriched, r => r.qcEditor);
  const editorBreakdown = Object.entries(editorGroups).map(([email, g]) => {
    const own = editorSalaryMap[email];
    const cost = own != null ? own
      : totalActMins > 0 ? (g.actualMins / totalActMins) * totalCost : 0;
    return { ...enrichGroup(email, g, cost), email, salary: own || 0 };
  }).sort((a, b) => b.images - a.images);

  // ── Segment breakdown
  const segGroups = groupSum(enriched, r => r.segment);
  const segmentBreakdown = Object.entries(segGroups).map(([name, g]) => {
    const cost = totalActMins > 0 ? (g.actualMins / totalActMins) * totalCost : 0;
    return {
      ...enrichGroup(name, g, cost),
      costShare: totalCost > 0 ? +((cost / totalCost) * 100).toFixed(1) : 0,
    };
  }).sort((a, b) => b.images - a.images);

  // ── Dealer type breakdown
  const dealerGroups = groupSum(enriched, r => r.dealerType);
  const dealerBreakdown = Object.entries(dealerGroups).map(([name, g]) => {
    const cost = totalActMins > 0 ? (g.actualMins / totalActMins) * totalCost : 0;
    return enrichGroup(name, g, cost);
  }).sort((a, b) => b.images - a.images);

  // ── Top enterprises (top 20 by images)
  const entGroups = groupSum(enriched, r => r.enterprise);
  const enterpriseBreakdown = Object.entries(entGroups).map(([name, g]) => {
    const cost = totalActMins > 0 ? (g.actualMins / totalActMins) * totalCost : 0;
    const seg  = segMap[name] || 'Unknown';
    return { ...enrichGroup(name, g, cost), segment: seg };
  }).sort((a, b) => b.images - a.images).slice(0, 25);

  return {
    month:   config.month,
    key:     config.key,
    summary: {
      totalCost:    Math.round(totalCost),
      totalImages:  Math.round(totalImages),
      totalSkus:    Math.round(totalSkus),
      totalActMins: Math.round(totalActMins),
      totalTarget:  Math.round(totalTarget),
      efficiency,
      costPerImage,
      costPerSku,
      employees:    employees.length,
    },
    productBreakdown,
    editorBreakdown,
    segmentBreakdown,
    dealerBreakdown,
    enterpriseBreakdown,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS – wide open as requested
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  try {
    const sheetsApi = getSheets();

    // Fetch all sheets in parallel
    const results = await Promise.allSettled(
      SHEETS.map(async cfg => {
        const [outputRows, salaryRows, entRows] = await Promise.all([
          fetchRange(sheetsApi, cfg.id, 'output!A:M'),
          fetchRange(sheetsApi, cfg.id, 'Salary!A:I'),
          fetchRange(sheetsApi, cfg.id, 'enterprise_details!A:D'),
        ]);
        return computeMonth(cfg, outputRows, salaryRows, entRows);
      })
    );

    const months = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    const errors = results
      .map((r, i) => r.status === 'rejected' ? { month: SHEETS[i].month, error: r.reason?.message } : null)
      .filter(Boolean);

    res.status(200).json({ months, errors, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error('[data.js]', err);
    res.status(500).json({ error: err.message });
  }
}
