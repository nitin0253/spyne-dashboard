// api/data.js  –  Vercel Serverless Function
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
// VIN model:
//   Images+360 enterprise  → 1 VIN creates 2 SKUs (1 Image SKU + 1 360 SKU)
//   Images+360+Video ent   → 1 VIN creates 2 SKUs (Image + 360); Video reuses Image SKU → video_id
//   VINs = Image SKU count (proxy for unique vehicles)
//
// Billing units:
//   Images → Images column (many images per SKU)
//   360    → SKU_Count (1 per spin)
//   Video  → SKU_Count (1 per video), reqc rows ONLY
//
// ENV VARS: GOOGLE_SERVICE_ACCOUNT_EMAIL  GOOGLE_PRIVATE_KEY

import { google } from 'googleapis';

const SHEETS = [
  { month: 'Jan-26', key: 'jan26', id: '1VI-9hxnFIynsTOl3aCdIiR-RRAfRssISOWnZdddCz4Q' },
  { month: 'Feb-26', key: 'feb26', id: '1K2SMR34s0O21BKGpCX-EsUPgOdiAkiuUW8yDyyvFzQU' },
  { month: 'Mar-26', key: 'mar26', id: '1_2xlqYzD15vhZ4qfsH-3kGHj8LXljpdUjdgFIfS5-Iw' },
  { month: 'Apr-26', key: 'apr26', id: '1cKEaxHNOqU2vpnCsnHbf1PfQdVnReg3MsGIgqgE1UhE' },
  { month: 'May-26', key: 'may26', id: '1_3d_XJmSbBziSCicauYEiP1J5N4RRW6pGco49uWuh84' },
  { month: 'Jun-26', key: 'jun26', id: '1i3KqktELNb-ykpZeHaMh3wk3FBBV-eHNAw6736oaXbI' },
];

// Always-excluded emails (hardcoded + dynamically read from remove_users sheet)
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
const billingUnits  = row => isImage(row.product) ? row.images : row.skus;
const isVinProduct  = product => isImage(product);

// ── Google auth ───────────────────────────────────────────────────────────────
function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key:  process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function fetchRange(client, sheetId, range) {
  try {
    const res = await client.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    return res.data.values || [];
  } catch (_) { return []; }
}

// ── Parsers ───────────────────────────────────────────────────────────────────

// remove_users: scan every cell in every row for valid email pattern
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

// Build the full exclusion set once (sheet + hardcoded)
function buildExcludeSet(sheetEmails) {
  return new Set([...sheetEmails.map(e => e.toLowerCase().trim()), ...ALWAYS_EXCLUDE]);
}

// Output sheet parser — excludes rows whose qcEditor is in the exclusion set
function parseOutput(rows, excludeSet) {
  if (rows.length < 2) return [];
  return rows.slice(1)
    .filter(r => r[0])
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

// Salary sheet parser
// Columns: A=EmpNo(0) B=Name(1) C=WorkEmail(2) D=Type(3) E=Salary(4)
//          F=ProrataSalary(5) G=Factor(6) H=factor_Salary(7)
// Row 5 (index 4) = header, Row 6+ (index 5+) = employees
function parseSalary(rows, excludeSet) {
  if (!rows || rows.length < 6) return { totalCost: 0, employees: [], excludedEmployees: [] };
  const num = s => parseFloat((s || '').toString().replace(/,/g, '')) || 0;

  const allEmployees = rows.slice(5)          // skip meta rows 1-4 + header row 5
    .filter(r => r && r[0])                   // must have employee number
    .map(r => ({
      empNo:        (r[0] || '').toString().trim(),
      name:         (r[1] || '').toString().trim(),
      email:        (r[2] || '').toString().toLowerCase().trim(),
      type:         (r[3] || '').toString().trim(),   // D = Type (was wrongly r[4])
      salary:       num(r[4]),                        // E = Salary (was wrongly r[5])
      prorata:      num(r[5]),                        // F = Prorata (was wrongly r[6])
      factor:       +r[6] || 1,                      // G = Factor (was wrongly r[7])
      factorSalary: num(r[7]),                        // H = factor_Salary (was wrongly r[8])
    }));

  const excludedEmployees = allEmployees.filter(e => excludeSet.has(e.email));
  const employees         = allEmployees.filter(e => !excludeSet.has(e.email));
  const totalCost         = employees.reduce((s, e) => s + e.factorSalary, 0);

  return { totalCost, employees, excludedEmployees };
}

// enterprise_details: A=ID(0) B=Name(1) C=InvVersion(2) D=CustomerSegment(3)
function parseEnterprise(rows) {
  const map = {};
  rows.slice(1).forEach(r => {
    if (r[1]) map[r[1].trim()] = { segment: r[3] || 'Unknown', inventoryVersion: r[2] || '' };
  });
  return map;
}

// ── Aggregation ───────────────────────────────────────────────────────────────
function groupSum(rows, keyFn) {
  const acc = {};
  rows.forEach(r => {
    const k = keyFn(r);
    if (!acc[k]) acc[k] = { images: 0, skus: 0, units: 0, vins: 0, actualMins: 0, sumTarget: 0, rows: 0 };
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
    efficiency:   +eff.toFixed(1),
    costPerUnit:  g.units > 0 ? +(allocatedCost / g.units).toFixed(4) : 0,
    costPerSku:   g.skus  > 0 ? +(allocatedCost / g.skus).toFixed(4)  : 0,
    costPerVin:   g.vins  > 0 ? +(allocatedCost / g.vins).toFixed(4)  : 0,
    costPerImage: g.images > 0 ? +(allocatedCost / g.images).toFixed(4) : 0,
  };
}

// ── Per-month compute ─────────────────────────────────────────────────────────
function computeMonth(config, outputRows, salaryRows, enterpriseRows, removedRows) {
  const sheetExcluded = parseRemovedUsers(removedRows);
  const excludeSet    = buildExcludeSet(sheetExcluded);

  const output   = parseOutput(outputRows, excludeSet);
  const { totalCost, employees, excludedEmployees } = parseSalary(salaryRows, excludeSet);
  const entMap   = parseEnterprise(enterpriseRows);

  // Editor → salary lookup
  const editorSalaryMap = {};
  employees.forEach(e => { if (e.email) editorSalaryMap[e.email] = e.factorSalary; });

  // Enrich output rows with segment
  const enriched = output.map(r => ({
    ...r,
    segment:          entMap[r.enterprise]?.segment          || 'Unknown',
    inventoryVersion: entMap[r.enterprise]?.inventoryVersion || '',
  }));

  // ── Totals
  const totalUnits     = enriched.reduce((s, r) => s + billingUnits(r), 0);
  const totalImages    = enriched.reduce((s, r) => s + r.images, 0);
  const totalSkus      = enriched.reduce((s, r) => s + r.skus, 0);
  const totalVins      = enriched.filter(r => isVinProduct(r.product)).reduce((s, r) => s + r.skus, 0);
  const totalActMins   = enriched.reduce((s, r) => s + r.actualMins, 0);
  const totalTarget    = enriched.reduce((s, r) => s + r.sumTarget, 0);
  const efficiency     = totalActMins > 0 ? +((totalTarget / totalActMins) * 100).toFixed(1) : 0;
  const costPerUnit    = totalUnits > 0 ? +(totalCost / totalUnits).toFixed(4) : 0;
  const costPerSku     = totalSkus  > 0 ? +(totalCost / totalSkus).toFixed(4)  : 0;
  const costPerVin     = totalVins  > 0 ? +(totalCost / totalVins).toFixed(4)  : 0;
  const total360Skus   = enriched.filter(r => is360(r.product)).reduce((s, r) => s + r.skus, 0);
  const totalVideoSkus = enriched.filter(r => isVideo(r.product)).reduce((s, r) => s + r.skus, 0);

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

  // ── QC Editor breakdown
  const editorGroups = groupSum(enriched, r => r.qcEditor);
  const editorBreakdown = Object.entries(editorGroups).map(([email, g]) => {
    const own  = editorSalaryMap[email];
    const cost = own != null ? own : totalActMins > 0 ? (g.actualMins / totalActMins) * totalCost : 0;
    const byProduct = {};
    enriched.filter(r => r.qcEditor === email).forEach(r => {
      if (!byProduct[r.product]) byProduct[r.product] = 0;
      byProduct[r.product] += billingUnits(r);
    });
    return { ...enrichGroup(email, g, cost), email, salary: own || 0, byProduct };
  }).sort((a, b) => b.units - a.units);

  // ── Segment breakdown (VIN-aware)
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
      pd.costPerUnit = pd.units > 0 ? +(pCost / pd.units).toFixed(4) : 0;
      pd.efficiency  = pd.actualMins > 0 ? +((pd.sumTarget / pd.actualMins) * 100).toFixed(1) : 0;
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
      vins:              Math.round(segVins),
      seg360Skus:        Math.round(seg360Skus),
      segVideoIds:       Math.round(segVideoIds),
      costPerVin:        segVins > 0 ? +(segCost / segVins).toFixed(4) : 0,
      costShare:         totalCost > 0 ? +((segCost / totalCost) * 100).toFixed(1) : 0,
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
    return { ...enrichGroup(name, g, cost), segment: entMap[name]?.segment || 'Unknown', inventoryVersion: entMap[name]?.inventoryVersion || '' };
  }).sort((a, b) => b.units - a.units).slice(0, 25);

  // ── Excluded users for the Excluded Users page
  // Also pick up emails that appear in output rows but not in the Salary sheet
  const outputExcludedEmails = new Set(
    outputRows.slice(1)
      .filter(r => r[0] && r[6])
      .map(r => (r[6] || '').toLowerCase().trim())
      .filter(email => excludeSet.has(email))
  );
  const excludedSalaryEmails = new Set(excludedEmployees.map(e => e.email));
  const outputOnlyExcluded = [...outputExcludedEmails]
    .filter(email => !excludedSalaryEmails.has(email))
    .map(email => ({ email, name: '—', empNo: '—', salary: 0, factorSalary: 0 }));

  return {
    month: config.month,
    key:   config.key,
    excludedUsers: [
      ...excludedEmployees.map(e => ({ email: e.email, name: e.name, empNo: e.empNo, salary: e.salary, factorSalary: e.factorSalary })),
      ...outputOnlyExcluded,
    ],
    summary: {
      totalCost:       Math.round(totalCost),
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
      excludedCount:   excludedEmployees.length + outputOnlyExcluded.length,
    },
    productBreakdown,
    editorBreakdown,
    segmentBreakdown,
    dealerBreakdown,
    enterpriseBreakdown,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });
  try {
    const client = getSheetsClient();
    const results = await Promise.allSettled(
      SHEETS.map(async cfg => {
        const [outputRows, salaryRows, entRows, removedRows] = await Promise.all([
          fetchRange(client, cfg.id, 'output!A:M'),
          fetchRange(client, cfg.id, 'Salary!A:H'),
          fetchRange(client, cfg.id, 'enterprise_details!A:D'),
          fetchRange(client, cfg.id, 'remove_users!A:E'),
        ]);
        return computeMonth(cfg, outputRows, salaryRows, entRows, removedRows);
      })
    );
    const months = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const errors = results
      .map((r, i) => r.status === 'rejected' ? { month: SHEETS[i].month, error: r.reason?.message } : null)
      .filter(Boolean);
    res.status(200).json({ months, errors, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[data.js]', err);
    res.status(500).json({ error: err.message });
  }
}
