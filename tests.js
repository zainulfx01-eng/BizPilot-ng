// BizPilot NG - offline unit tests. Plain JS, no libraries.
// Run in Node:   node tests.js
// Run in browser: open tests-runner.html? Simpler: put this file next to logic.js and open
// a page that loads logic.js then tests.js; results print to the browser console and to #test-output if present.
(function () {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var L = isNode ? require('./logic.js') : window.BizLogic;
  var fs = isNode ? require('fs') : null;
  var path = isNode ? require('path') : null;

  var results = [];
  function test(name, fn) {
    try { fn(); results.push({ name: name, ok: true }); }
    catch (e) { results.push({ name: name, ok: false, err: e.message }); }
  }
  function eq(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'mismatch') + ': expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a));
  }
  function ok(v, msg) { if (!v) throw new Error(msg || 'expected true'); }
  function throwsMsg(fn, part) {
    try { fn(); } catch (e) { if (e.message.indexOf(part) === -1) throw new Error('wrong error: ' + e.message); return; }
    throw new Error('expected throw containing: ' + part);
  }

  // ---------- STOCK MATH ----------
  test('stock: selling 2 from 10 leaves 8', function () { eq(L.applyStockDecrement(10, 2), 8); });
  test('stock: selling exactly all stock leaves 0', function () { eq(L.applyStockDecrement(3, 3), 0); });
  test('stock: selling more than stock throws', function () { throwsMsg(function () { L.applyStockDecrement(2, 3); }, 'Not enough stock'); });
  test('stock: zero or negative qty rejected', function () {
    throwsMsg(function () { L.applyStockDecrement(5, 0); }, 'at least 1');
    throwsMsg(function () { L.applyStockDecrement(5, -1); }, 'at least 1');
  });
  test('stock: fractional qty rejected', function () { throwsMsg(function () { L.applyStockDecrement(5, 1.5); }, 'whole number'); });
  test('stock: same product on two lines is checked together', function () {
    var errs = L.checkStock([{ product_id: 'a', qty: 2 }, { product_id: 'a', qty: 2 }], { a: 3 });
    eq(errs.length, 1, 'should flag combined qty 4 > 3');
  });
  test('stock: two lines within total stock pass', function () {
    eq(L.checkStock([{ product_id: 'a', qty: 1 }, { product_id: 'a', qty: 2 }], { a: 3 }), []);
  });
  test('stock: missing product flagged', function () {
    eq(L.checkStock([{ product_id: 'zz', qty: 1 }], {}).length, 1);
  });
  test('stock: aggregateQty sums per product', function () {
    eq(L.aggregateQty([{ product_id: 'a', qty: 2 }, { product_id: 'b', qty: 1 }, { product_id: 'a', qty: 3 }]), { a: 5, b: 1 });
  });

  // ---------- PROFIT / COGS MATH ----------
  test('profit: bread 2 at cost 600 sell 800 -> total 1600, cogs 1200, profit 400', function () {
    var t = L.computeSaleTotals([{ qty: 2, unit_price: 800, unit_cost: 600 }]);
    eq(t, { total: 1600, cogs: 1200, profit: 400 });
  });
  test('profit: mixed basket adds lines correctly', function () {
    var t = L.computeSaleTotals([
      { qty: 1, unit_price: 6000, unit_cost: 5200 },
      { qty: 3, unit_price: 300, unit_cost: 220 }
    ]);
    eq(t, { total: 6900, cogs: 5860, profit: 1040 });
  });
  test('profit: kobo rounding stays exact (0.1 + 0.2 style)', function () {
    var t = L.computeSaleTotals([{ qty: 3, unit_price: 0.1, unit_cost: 0.07 }]);
    eq(t.total, 0.3); eq(t.cogs, 0.21); eq(t.profit, 0.09);
  });
  test('profit: selling below cost gives negative profit (not hidden)', function () {
    eq(L.computeSaleTotals([{ qty: 1, unit_price: 500, unit_cost: 700 }]).profit, -200);
  });
  test('profit: empty basket is zero', function () { eq(L.computeSaleTotals([]), { total: 0, cogs: 0, profit: 0 }); });
  test('round2 keeps 2 decimals', function () { eq(L.round2(1.005 + 1), 2.01); eq(L.round2(10.126), 10.13); });

  // ---------- CREDIT / DEBT ----------
  test('credit: nothing paid makes full debt', function () { eq(L.debtForSale(1600, 0, 'credit'), 1600); });
  test('credit: partial payment leaves the rest as debt', function () { eq(L.debtForSale(1600, 600, 'credit'), 1000); });
  test('credit: cash, transfer, card never create debt', function () {
    eq(L.debtForSale(1600, 1600, 'cash'), 0);
    eq(L.debtForSale(1600, 1600, 'transfer'), 0);
    eq(L.debtForSale(1600, 1600, 'card'), 0);
  });
  test('repayment: partial reduces balance', function () { eq(L.applyRepayment(1000, 400), { ok: true, balance: 600, settled: false }); });
  test('repayment: full clears debt', function () { eq(L.applyRepayment(1000, 1000), { ok: true, balance: 0, settled: true }); });
  test('repayment: more than balance rejected', function () { ok(!L.applyRepayment(1000, 1001).ok); });
  test('repayment: zero or negative rejected', function () { ok(!L.applyRepayment(1000, 0).ok); ok(!L.applyRepayment(1000, -5).ok); });

  // ---------- SALE VALIDATION ----------
  test('sale: cash sale fills paid = total automatically', function () {
    var v = L.validateSaleInput({ payment_method: 'cash', items: [{ product_id: 'p', qty: 2, unit_price: 800, unit_cost: 600 }] });
    ok(v.ok); eq(v.value.amount_paid, 1600); eq(v.value.debt, 0);
  });
  test('sale: cash with wrong amount_paid rejected', function () {
    var v = L.validateSaleInput({ payment_method: 'transfer', amount_paid: 1000, items: [{ product_id: 'p', qty: 2, unit_price: 800, unit_cost: 600 }] });
    ok(!v.ok);
  });
  test('sale: credit needs a customer', function () {
    var v = L.validateSaleInput({ payment_method: 'credit', items: [{ product_id: 'p', qty: 1, unit_price: 800, unit_cost: 600 }] });
    ok(!v.ok); ok(v.errors.join(' ').indexOf('customer') !== -1);
  });
  test('sale: credit with customer and partial payment makes debt', function () {
    var v = L.validateSaleInput({ payment_method: 'credit', customer_id: 'c1', amount_paid: '300', items: [{ product_id: 'p', qty: 2, unit_price: 800, unit_cost: 600 }] });
    ok(v.ok); eq(v.value.debt, 1300);
  });
  test('sale: credit paid more than total rejected', function () {
    ok(!L.validateSaleInput({ payment_method: 'credit', customer_id: 'c1', amount_paid: 2000, items: [{ product_id: 'p', qty: 2, unit_price: 800, unit_cost: 600 }] }).ok);
  });
  test('sale: invalid payment method rejected', function () {
    ok(!L.validateSaleInput({ payment_method: 'bitcoin', items: [{ product_id: 'p', qty: 1, unit_price: 1, unit_cost: 1 }] }).ok);
  });
  test('sale: no items rejected', function () { ok(!L.validateSaleInput({ payment_method: 'cash', items: [] }).ok); });
  test('sale: qty 0 or negative rejected', function () {
    ok(!L.validateSaleInput({ payment_method: 'cash', items: [{ product_id: 'p', qty: 0, unit_price: 1, unit_cost: 1 }] }).ok);
    ok(!L.validateSaleInput({ payment_method: 'cash', items: [{ product_id: 'p', qty: -2, unit_price: 1, unit_cost: 1 }] }).ok);
  });

  // ---------- VALIDATION ----------
  test('product: valid product passes and trims name', function () {
    var v = L.validateProduct({ name: '  Bread  ', cost_price: '600', selling_price: '800', stock_qty: '12', low_stock_threshold: '5' });
    ok(v.ok); eq(v.value.name, 'Bread'); eq(v.value.stock_qty, 12);
  });
  test('product: negative stock rejected', function () {
    var v = L.validateProduct({ name: 'x', cost_price: 1, selling_price: 2, stock_qty: -1, low_stock_threshold: 1 });
    ok(!v.ok); ok(v.errors.stock_qty);
  });
  test('product: negative price rejected', function () {
    var v = L.validateProduct({ name: 'x', cost_price: -5, selling_price: 2, stock_qty: 1, low_stock_threshold: 1 });
    ok(!v.ok); ok(v.errors.cost_price);
  });
  test('product: zero selling price rejected', function () {
    ok(!L.validateProduct({ name: 'x', cost_price: 0, selling_price: 0, stock_qty: 1, low_stock_threshold: 1 }).ok);
  });
  test('product: zero cost price is allowed (free sample item)', function () {
    ok(L.validateProduct({ name: 'x', cost_price: 0, selling_price: 100, stock_qty: 1, low_stock_threshold: 1 }).ok);
  });
  test('product: fractional stock rejected', function () {
    ok(!L.validateProduct({ name: 'x', cost_price: 1, selling_price: 2, stock_qty: 1.5, low_stock_threshold: 1 }).ok);
  });
  test('product: empty name rejected', function () {
    ok(!L.validateProduct({ name: '   ', cost_price: 1, selling_price: 2, stock_qty: 1, low_stock_threshold: 1 }).ok);
  });
  test('product: name over 120 chars rejected', function () {
    var long = new Array(122).join('a');
    ok(!L.validateProduct({ name: long, cost_price: 1, selling_price: 2, stock_qty: 1, low_stock_threshold: 1 }).ok);
  });
  test('product: text in number field rejected', function () {
    ok(!L.validateProduct({ name: 'x', cost_price: 'abc', selling_price: 2, stock_qty: 1, low_stock_threshold: 1 }).ok);
  });
  test('product: selling below cost gives warning but still valid', function () {
    var v = L.validateProduct({ name: 'x', cost_price: 900, selling_price: 800, stock_qty: 1, low_stock_threshold: 1 });
    ok(v.ok); ok(v.warning);
  });
  test('money: naira symbol and commas accepted', function () { eq(L.parseAmount('₦1,500'), 1500); });
  test('money: three decimal places rejected', function () { ok(L.validateMoney(1.125, 'x').error); ok(!L.validateMoney(1.12, 'x').error); });
  test('expense: valid expense passes', function () {
    ok(L.validateExpense({ category: 'rent', amount: '20000', expense_date: '2026-10-25', description: 'shop rent' }).ok);
  });
  test('expense: bad category rejected', function () {
    ok(!L.validateExpense({ category: 'gifts', amount: 100, expense_date: '2026-10-25' }).ok);
  });
  test('expense: zero or negative amount rejected', function () {
    ok(!L.validateExpense({ category: 'rent', amount: 0, expense_date: '2026-10-25' }).ok);
    ok(!L.validateExpense({ category: 'rent', amount: -100, expense_date: '2026-10-25' }).ok);
  });
  test('date: impossible date rejected', function () { ok(L.validateDate('2026-02-30', 'd').error); });
  test('date: wrong format rejected', function () { ok(L.validateDate('25/10/2026', 'd').error); });

  // ---------- DASHBOARD ----------
  test('dashboard: sums only today and ignores other days', function () {
    var s = L.summarizeDashboard({
      today: '2026-10-25',
      sales: [
        { sale_date: '2026-10-25', total: 1600, estimated_profit: 400 },
        { sale_date: '2026-10-24', total: 9000, estimated_profit: 3000 }
      ],
      expenses: [
        { expense_date: '2026-10-25', amount: 500 },
        { expense_date: '2026-10-23', amount: 7000 }
      ],
      debts: [{ balance: 1000 }, { balance: 250.5 }],
      products: []
    });
    eq(s.sales_total, 1600); eq(s.estimated_profit, 400); eq(s.expenses_total, 500);
    eq(s.estimated_profit_after_expenses, -100); eq(s.unpaid_debts, 1250.5);
  });
  test('low stock: at or below threshold, lowest first', function () {
    var low = L.lowStockProducts([
      { name: 'a', stock_qty: 10, low_stock_threshold: 5 },
      { name: 'b', stock_qty: 2, low_stock_threshold: 5 },
      { name: 'c', stock_qty: 5, low_stock_threshold: 5 },
      { name: 'd', stock_qty: 0, low_stock_threshold: 1 }
    ]);
    eq(low.map(function (p) { return p.name; }), ['d', 'b', 'c']);
  });
  test('dashboard: no sales today gives zeros', function () {
    var s = L.summarizeDashboard({ today: '2026-10-25', sales: [], expenses: [], debts: [], products: [] });
    eq(s.sales_total, 0); eq(s.estimated_profit, 0); eq(s.unpaid_debts, 0); eq(s.low_stock, []);
  });

  // ---------- TIMEZONE & FORMAT ----------
  test('timezone: 23:30 UTC on 24 Oct is already 25 Oct in Lagos (UTC+1)', function () {
    eq(L.todayInLagos(new Date('2026-10-24T23:30:00Z')), '2026-10-25');
  });
  test('timezone: 10:00 UTC on 25 Oct is 25 Oct in Lagos', function () {
    eq(L.todayInLagos(new Date('2026-10-25T10:00:00Z')), '2026-10-25');
  });
  test('format: naira with commas and two decimals', function () {
    eq(L.formatNaira(1600), '₦1,600.00'); eq(L.formatNaira(1234567.5), '₦1,234,567.50'); eq(L.formatNaira(-200), '-₦200.00');
  });

  // ---------- RLS ASSUMPTIONS (checked against bizpilot-setup.sql) ----------
  var sql = null;
  if (isNode) {
    try { sql = fs.readFileSync(path.join(__dirname, 'bizpilot-setup.sql'), 'utf8'); } catch (e) { sql = null; }
  } else if (window.__BIZPILOT_SQL) {
    sql = window.__BIZPILOT_SQL;
  }
  if (sql) {
    var ownedTables = ['businesses', 'products', 'customers', 'sales', 'sale_items', 'expenses', 'debts', 'debt_repayments', 'plans'];
    ownedTables.forEach(function (t) {
      test('rls: ' + t + ' has row level security turned on', function () {
        ok(sql.indexOf('alter table public.' + t + ' enable row level security') !== -1, t + ' RLS not enabled');
      });
    });
    test('rls: business-owned tables all check business_id = my_business_id()', function () {
      var scoped = ['products', 'customers', 'sales', 'sale_items', 'expenses', 'debts', 'debt_repayments'];
      scoped.forEach(function (t) {
        var re = new RegExp('create policy "[^"]+" on public\\.' + t + ' for [a-z]+ to authenticated\\s+using \\(business_id = public\\.my_business_id\\(\\)\\)|create policy "[^"]+" on public\\.' + t + ' for select to authenticated\\s+using \\(business_id = public\\.my_business_id\\(\\)\\)', 'i');
        ok(re.test(sql), t + ' has no owner-only policy');
      });
    });
    test('rls: businesses scoped to owner_id = auth.uid()', function () {
      ok(sql.indexOf('using (owner_id = auth.uid())') !== -1, 'businesses not owner-scoped');
    });
    test('rls: users cannot change plan fields on businesses', function () {
      ok(sql.indexOf('grant update (name, timezone) on public.businesses to authenticated') !== -1, 'business update not column-limited');
    });
    test('rls: no policy lets anon (not logged in) read data', function () {
      ok(sql.indexOf('to anon') === -1, 'found a policy for anon');
      ok(!/\bto public\b/.test(sql), 'found a policy for public');
    });
    test('rls: sales and sale_items cannot be updated or deleted by users', function () {
      ok(sql.indexOf('revoke update, delete on public.sales from authenticated') !== -1);
      ok(sql.indexOf('revoke update, delete on public.sale_items from authenticated') !== -1);
    });
    test('rls: sales cannot be inserted directly (only via create_sale)', function () {
      ok(!/create policy "[^"]*" on public\.sales for (all|insert)/i.test(sql), 'direct insert policy on sales');
    });
    test('rls: create_sale takes the business from the logged-in user, not from the caller', function () {
      ok(sql.indexOf('v_business uuid := public.my_business_id();') !== -1);
    });
    test('rls: no service_role or secret key in frontend files', function () {
      if (!isNode) return;
      ['app.js', 'config.js', 'index.html', 'logic.js'].forEach(function (f) {
        var src = fs.readFileSync(path.join(__dirname, f), 'utf8');
        ok(src.indexOf('service_role') === -1 && src.indexOf('sb_secret_') === -1, f + ' contains a secret key marker');
      });
    });
  }

  // ---------- REPORT ----------
  var passed = results.filter(function (r) { return r.ok; }).length;
  var failed = results.filter(function (r) { return !r.ok; });
  var summary = 'BizPilot NG tests: ' + passed + ' passed, ' + failed.length + ' failed, ' + results.length + ' total';
  if (isNode) {
    results.forEach(function (r) { if (!r.ok) console.log('FAIL  ' + r.name + '\n      ' + r.err); });
    console.log(summary);
    if (failed.length) process.exitCode = 1;
  } else {
    var out = document.getElementById('test-output');
    var lines = results.map(function (r) { return (r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : ' :: ' + r.err); });
    lines.push(summary);
    console.log(lines.join('\n'));
    if (out) out.textContent = lines.join('\n');
  }
  if (isNode) module.exports = { results: results, summary: summary };
})();
