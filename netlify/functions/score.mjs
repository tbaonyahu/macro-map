// Macro Map - Buffett screen, running on Netlify's server.
// The website calls  /api/score?t=NKE  and gets back the 4-rule result as JSON.
// SEC needs a contact email: set SEC_EMAIL in Netlify (Site configuration -> Environment variables).

const RULES = { debt_years_max: 3.0, gross_margin_min: 0.40, profit_years: 5, roic_min: 0.15 };

// Debt you checked by hand in the 10-K (dollars). Example: "PLTR": 0
const MANUAL_DEBT = {
  // PLTR: 0,
};

const GM_NOT_APPLICABLE = {
  UNH: "health insurer: main costs are medical claims, not cost of goods",
  HOOD: "broker: doesn't report gross margin",
  COIN: "crypto exchange: doesn't report gross margin",
  MSTR: "bitcoin treasury company: results are driven by bitcoin, rubric fits poorly",
};

const ANNUAL_FORMS = new Set(["10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"]);
const FLOW = new Set(["revenue", "gross", "cogs", "net", "opinc", "tax", "pretax", "interest"]);

const TAGS = {
  revenue: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet",
            "RevenueFromContractWithCustomerIncludingAssessedTax", "Revenue"],
  gross: ["GrossProfit"],
  cogs: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold", "CostOfSales"],
  net: ["NetIncomeLoss", "ProfitLossAttributableToOwnersOfParent", "ProfitLoss"],
  opinc: ["OperatingIncomeLoss", "ProfitLossFromOperatingActivities"],
  tax: ["IncomeTaxExpenseBenefit", "IncomeTaxExpenseContinuingOperations"],
  pretax: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
           "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
           "ProfitLossBeforeTax"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
           "EquityAttributableToOwnersOfParent", "Equity"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashAndCashEquivalents"],
  debt_total: ["LongTermDebt", "LongTermDebtAndCapitalLeaseObligations", "DebtLongtermAndShorttermCombinedAmount", "Borrowings"],
  debt_nc: ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligationsNoncurrent", "NoncurrentPortionOfNoncurrentBorrowings"],
  debt_cur: ["LongTermDebtCurrent", "DebtCurrent", "CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings"],
  debt_ifrs: ["BondsIssued", "NoncurrentPortionOfNoncurrentBondsIssued", "CurrentPortionOfNoncurrentBondsIssued",
              "LongtermBorrowings", "ShorttermBorrowings"],
  interest: ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "FinanceCosts"],
  debt_other: ["SecuredDebt", "ConvertibleNotesPayable", "ConvertibleDebtNoncurrent", "ConvertibleLongTermNotesPayable",
               "SeniorNotes", "LongTermNotesPayable", "NotesPayable", "LongTermLineOfCredit"],
};

const DAY = 86400000;
const toDate = (s) => new Date(s + "T00:00:00Z");

// {fiscal_year_end: value}. flow=true: full-year amounts; flow=false: balance-sheet amounts.
function series(facts, tags, flow) {
  const out = {};
  for (const taxonomy of ["us-gaap", "ifrs-full"]) {
    const node = facts[taxonomy] || {};
    for (const tag of tags) {
      if (!node[tag]) continue;
      const units = node[tag].units;
      const unit = Object.keys(units).find((u) => u !== "shares" && u !== "pure");
      if (!unit) continue;
      const best = {};
      for (const f of units[unit]) {
        if (!ANNUAL_FORMS.has(f.form)) continue;
        if (flow) {
          if (!f.start) continue;
          const days = (toDate(f.end) - toDate(f.start)) / DAY;
          if (days < 330 || days > 400) continue;
        }
        const prev = best[f.end];
        if (!prev || f.filed > prev.filed) best[f.end] = f;   // latest (restated) number wins
      }
      for (const [end, f] of Object.entries(best)) if (!(end in out)) out[end] = f.val;
    }
    if (Object.keys(out).length) break;
  }
  return out;
}

// value at a fiscal-year end, allowing a few days' gap (52/53-week years)
function valueAt(s, end, tol = 10) {
  if (end in s) return s[end];
  const target = toDate(end);
  const near = Object.keys(s).find((k) => Math.abs((toDate(k) - target) / DAY) <= tol);
  return near === undefined ? null : s[near];
}

export function scoreFacts(ticker, name, facts, today = new Date()) {
  const S = {};
  for (const [k, tags] of Object.entries(TAGS)) S[k] = series(facts, tags, FLOW.has(k));
  const notes = [];

  const years = Object.keys(S.net).sort().reverse();
  if (!years.length) return { t: ticker, name, error: "no annual profit data in SEC filings" };
  const E = years[0];
  const net = S.net[E];
  if ((today - toDate(E)) / DAY > 456) notes.push(`stale: newest SEC numbers are FY${E.slice(0, 4)}, check the latest annual report`);

  // Rule 3: profitable N years in a row
  const last = years.slice(0, RULES.profit_years).map((y) => S.net[y]);
  const profitOk = last.length === RULES.profit_years && last.every((v) => v > 0);
  if (last.length < RULES.profit_years) notes.push(`only ${last.length} years of history`);

  // Rule 2: gross margin
  const rev = valueAt(S.revenue, E);
  let gp = valueAt(S.gross, E);
  const cogs = valueAt(S.cogs, E);
  if (gp === null && rev !== null && cogs !== null) gp = rev - cogs;
  let gm = gp !== null && rev ? gp / rev : null;
  let gmNA = ticker in GM_NOT_APPLICABLE;
  if (gmNA) { gm = null; notes.push(GM_NOT_APPLICABLE[ticker]); }
  else if (gm === null) { gmNA = true; notes.push("no gross profit / cost of revenue reported: gross margin rule n/a"); }

  // Rule 1: debt vs profit
  let debt = valueAt(S.debt_total, E);
  if (debt === null) {
    const nc = valueAt(S.debt_nc, E), cur = valueAt(S.debt_cur, E);
    if (nc !== null || cur !== null) debt = (nc || 0) + (cur || 0);
  }
  if (debt === null) {
    const parts = TAGS.debt_ifrs.map((tag) => valueAt(series(facts, [tag], false), E));
    if (parts[1] !== null || parts[2] !== null) parts[0] = null;   // bonds split into long-term + current
    const found = parts.filter((v) => v !== null);
    if (found.length) debt = found.reduce((a, b) => a + b, 0);
  }
  if (debt === null) debt = valueAt(S.debt_other, E);
  if (ticker in MANUAL_DEBT) { debt = MANUAL_DEBT[ticker]; notes.push("debt entered by hand from 10-K"); }
  const debtUnknown = debt === null;
  let debtYears = null, debtOk = false;
  if (debtUnknown) notes.push("debt not found in SEC data: check the 10-K by hand");
  else {
    debtYears = net > 0 ? debt / net : null;
    debtOk = net > 0 && (debt === 0 || debtYears <= RULES.debt_years_max);
    if (net <= 0) notes.push("losing money in latest year, so debt rule fails");
  }

  // Rule 4: ROIC = after-tax operating profit / (debt + equity - cash)
  let opinc = valueAt(S.opinc, E);
  if (opinc === null && valueAt(S.pretax, E) !== null) {
    opinc = valueAt(S.pretax, E) + (valueAt(S.interest, E) || 0);
    notes.push("operating income estimated as pre-tax profit + interest");
  }
  const tax = valueAt(S.tax, E), pretax = valueAt(S.pretax, E);
  const rate = tax !== null && pretax ? Math.min(Math.max(tax / pretax, 0), 0.35) : 0.21;
  const equity = valueAt(S.equity, E);
  const cash = valueAt(S.cash, E) || 0;
  let roic = null;
  if (opinc !== null && equity !== null) {
    const d = debt || 0;
    let ic = d + equity - cash;
    if (ic <= 0) { ic = d + equity; notes.push("cash exceeds capital; ROIC uses debt + equity"); }
    roic = ic > 0 ? (opinc * (1 - rate)) / ic : null;
  }
  if (roic === null) {
    const missing = [["operating income", opinc], ["equity", equity]].filter(([, v]) => v === null).map(([k]) => k);
    notes.push("ROIC could not be calculated (missing: " + (missing.join(", ") || "capital <= 0") + ")");
  }

  const pass = {
    debt: debtOk,
    gm: gmNA ? null : gm !== null && gm >= RULES.gross_margin_min,
    profit: profitOk,
    roic: roic !== null && roic >= RULES.roic_min,
  };
  const r = (x, n = 3) => (x === null || x === undefined ? null : Math.round(x * 10 ** n) / 10 ** n);
  const vals = Object.values(pass);
  return {
    t: ticker, name, fy_end: E,
    debt_years: r(debtYears, 2), debt_zero: debt === 0, debt_unknown: debtUnknown, loss_making: net <= 0,
    gm: r(gm), roic: r(roic),
    profit_years: years.slice(0, RULES.profit_years).map((y) => y.slice(0, 4)),
    profit_vals_positive: last.map((v) => v > 0),
    pass, score: vals.filter((v) => v).length, applicable: vals.filter((v) => v !== null).length,
    notes, live: true, generated: new Date().toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------- web handler
let tickerMap = null;   // reused while the function stays warm

async function secJSON(url, email) {
  const res = await fetch(url, { headers: { "User-Agent": `MacroMap personal research ${email}`, "Accept-Encoding": "gzip, deflate" } });
  if (!res.ok) throw new Error(`SEC returned ${res.status}`);
  return res.json();
}

const json = (body, status = 200, cache = true) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "Content-Type": "application/json",
    // Netlify's CDN keeps each answer for a day, so SEC isn't asked again and again
    "Cache-Control": cache ? "public, max-age=3600" : "no-store",
    "Netlify-CDN-Cache-Control": cache ? "public, s-maxage=86400, stale-while-revalidate=86400" : "no-store",
  },
});

export default async (req) => {
  const email = (globalThis.Netlify?.env.get("SEC_EMAIL")) || process.env.SEC_EMAIL;
  if (!email) return json({ error: "SEC_EMAIL is not set in Netlify environment variables" }, 500, false);
  const ticker = (new URL(req.url).searchParams.get("t") || "").toUpperCase().replace(".", "-").split(":").pop();
  if (!/^[A-Z0-9-]{1,10}$/.test(ticker)) return json({ error: "bad ticker" }, 400, false);
  try {
    if (!tickerMap) {
      const raw = await secJSON("https://www.sec.gov/files/company_tickers.json", email);
      tickerMap = {};
      for (const v of Object.values(raw)) tickerMap[v.ticker] = [v.cik_str, v.title];
    }
    if (!tickerMap[ticker]) return json({ t: ticker, error: "not found in SEC list (ETF, foreign, or new listing)" });
    const [cik, name] = tickerMap[ticker];
    const data = await secJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`, email);
    return json(scoreFacts(ticker, name, data.facts));
  } catch (e) {
    return json({ t: ticker, error: String(e.message || e) }, 502, false);
  }
};

export const config = { path: "/api/score" };
