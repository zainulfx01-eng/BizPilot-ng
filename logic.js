/* BizPilot NG - pure business logic (no browser or network calls).
 * Used by app.js in the browser and by tests.js in Node.
 * Money is in naira (NGN). Dates are YYYY-MM-DD in Africa/Lagos.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.BizLogic = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAYMENT_METHODS = ['cash', 'transfer', 'card', 'credit'];
  var EXPENSE_CATEGORIES = ['rent', 'transport', 'utilities', 'salaries', 'stock_purchase', 'data_airtime', 'other'];
  var NAME_MAX = 120;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function isWhole(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
  }

  // Accepts "1,500", "₦1500", " 20 " etc. Returns NaN when not a number.
  function parseAmount(v) {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return NaN;
    var s = v.replace(/[,\s\u20A6]/g, '');
    if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }

  function validateName(v, label) {
    var s = (v === null || v === undefined ? '' : String(v)).trim();
    if (!s) return { error: label + ' is required' };
    if (s.length > NAME_MAX) return { error: label + ' is too long (max ' + NAME_MAX + ' characters)' };
    return { value: s };
  }

  function validateMoney(v, label, opts) {
    opts = opts || {};
    var n = parseAmount(v);
    if (isNaN(n)) return { error: label + ' must be a number' };
    if (n < 0) return { error: label + ' cannot be negative' };
    if (opts.positive && n === 0) return { error: label + ' must be more than zero' };
    if (round2(n) !== n) return { error: label + ' can have at most 2 decimal places' };
    return { value: n };
  }

  function validateQty(v, label, opts) {
    opts = opts || {};
    var n = parseAmount(v);
    if (isNaN(n) || !isWhole(n)) return { error: label + ' must be a whole number' };
    if (n < 0) return { error: label + ' cannot be negative' };
    if (opts.min !== undefined && n < opts.min) return { error: label + ' must be at least ' + opts.min };
    return { value: n };
  }

  function validateDate(v, label) {
    var s = String(v || '');
    if (!DATE_RE.test(s)) return { error: label + ' must be a date (YYYY-MM-DD)' };
    var d = new Date(s + 'T00:00:00Z');
    if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return { error: label + ' is not a real date' };
    return { value: s };
  }

  // Product input: name, cost_price, selling_price, stock_qty, low_stock_threshold
  function validateProduct(input) {
    input = input || {};
    var errors = {};
    var name = validateName(input.name, 'Product name');
    var cost = validateMoney(input.cost_price, 'Cost price');
    var sell = validateMoney(input.selling_price, 'Selling price', { positive: true });
    var stock = validateQty(input.stock_qty, 'Stock quantity');
    var thr = validateQty(input.low_stock_threshold, 'Low stock alert level');
    if (name.error) errors.name = name.error;
    if (cost.error) errors.cost_price = cost.error;
    if (sell.error) errors.selling_price = sell.error;
    if (stock.error) errors.stock_qty = stock.error;
    if (thr.error) errors.low_stock_threshold = thr.error;
    if (Object.keys(errors).length) return { ok: false, errors: errors };

    var warning = cost.value > sell.value ? 'Selling price is lower than cost price (you will lose money on each sale)' : null;
    return {
      ok: true,
      warning: warning,
      value: {
        name: name.value,
        cost_price: cost.value,
        selling_price: sell.value,
        stock_qty: stock.value,
        low_stock_threshold: thr.value
      }
    };
  }

  function validateExpense(input) {
    input = input || {};
    var errors = {};
    if (EXPENSE_CATEGORIES.indexOf(input.category) === -1) errors.category = 'Pick a valid category';
    var amt = validateMoney(input.amount, 'Amount', { positive: true });
    if (amt.error) errors.amount = amt.error;
    var date = validateDate(input.expense_date, 'Date');
    if (date.error) errors.expense_date = date.error;
    var desc = String(input.description || '').trim();
    if (desc.length > 200) errors.description = 'Description is too long (max 200 characters)';
    if (Object.keys(errors).length) return { ok: false, errors: errors };
    return { ok: true, value: { category: input.category, amount: amt.value, expense_date: date.value, description: desc } };
  }

  // Quantity per product across all lines (same product can appear twice).
  function aggregateQty(items) {
    var map = {};
    (items || []).forEach(function (it) {
      map[it.product_id] = (map[it.product_id] || 0) + Number(it.qty || 0);
    });
    return map;
  }

  // Line totals and sale totals. unit_price = selling price, unit_cost = cost price.
  function computeSaleTotals(items) {
    var total = 0;
    var cogs = 0;
    (items || []).forEach(function (it) {
      var qty = Number(it.qty);
      total += round2(qty * Number(it.unit_price));
      cogs += round2(qty * Number(it.unit_cost));
    });
    total = round2(total);
    cogs = round2(cogs);
    return { total: total, cogs: cogs, profit: round2(total - cogs) };
  }

  // Returns the new stock after a sale line. Throws when stock is not enough.
  function applyStockDecrement(stock, qty) {
    if (!isWhole(qty) || qty < 1) throw new Error('Quantity must be a whole number of at least 1');
    if (!isWhole(stock) || stock < 0) throw new Error('Stock on record is invalid');
    if (qty > stock) throw new Error('Not enough stock: only ' + stock + ' left');
    return stock - qty;
  }

  // Checks every product's total requested qty against its stock.
  // stockById: { productId: stock_qty }. Returns array of error strings (empty when fine).
  function checkStock(items, stockById) {
    var need = aggregateQty(items);
    var errors = [];
    Object.keys(need).forEach(function (pid) {
      var have = stockById[pid];
      if (have === undefined) errors.push('A product in this sale no longer exists');
      else if (need[pid] > have) errors.push('Not enough stock: only ' + have + ' left for one product');
    });
    return errors;
  }

  // Validates a whole sale before it is sent to the database.
  // The database recomputes prices and cost from its own product rows; this is a pre-check.
  function validateSaleInput(input) {
    input = input || {};
    var errors = [];
    if (PAYMENT_METHODS.indexOf(input.payment_method) === -1) errors.push('Pick a payment method');
    var items = Array.isArray(input.items) ? input.items : [];
    if (items.length === 0) errors.push('Add at least one product');
    items.forEach(function (it, i) {
      if (!it.product_id) errors.push('Line ' + (i + 1) + ': product missing');
      if (!isWhole(Number(it.qty)) || Number(it.qty) < 1) errors.push('Line ' + (i + 1) + ': quantity must be a whole number of at least 1');
    });
    if (input.payment_method === 'credit' && !input.customer_id) errors.push('Credit sales need a customer');
    if (errors.length) return { ok: false, errors: errors };

    var totals = computeSaleTotals(items.map(function (it) {
      return { qty: it.qty, unit_price: it.unit_price, unit_cost: it.unit_cost };
    }));
    var paid;
    if (input.payment_method === 'credit') {
      paid = input.amount_paid === undefined || input.amount_paid === null || input.amount_paid === '' ? 0 : parseAmount(input.amount_paid);
      if (isNaN(paid) || paid < 0 || paid > totals.total) return { ok: false, errors: ['Amount paid must be between 0 and the sale total'] };
    } else {
      paid = totals.total;
      if (input.amount_paid !== undefined && input.amount_paid !== null && input.amount_paid !== '' && parseAmount(input.amount_paid) !== totals.total) {
        return { ok: false, errors: ['Cash, transfer and card sales must be paid in full'] };
      }
    }
    return {
      ok: true,
      value: {
        payment_method: input.payment_method,
        customer_id: input.customer_id || null,
        items: items,
        totals: totals,
        amount_paid: round2(paid),
        debt: debtForSale(totals.total, paid, input.payment_method)
      }
    };
  }

  // Credit sales create a debt for the part not paid yet. Other methods never do.
  function debtForSale(total, paid, method) {
    return method === 'credit' ? round2(total - paid) : 0;
  }

  // Repayment against an open debt balance.
  function applyRepayment(balance, amount) {
    var amt = parseAmount(amount);
    if (isNaN(amt) || amt <= 0) return { ok: false, error: 'Repayment must be more than zero' };
    if (round2(amt) !== amt) return { ok: false, error: 'Repayment can have at most 2 decimal places' };
    if (amt > balance) return { ok: false, error: 'Repayment is more than the balance (' + formatNaira(balance) + ')' };
    var left = round2(balance - amt);
    return { ok: true, balance: left, settled: left === 0 };
  }

  function lowStockProducts(products) {
    return (products || [])
      .filter(function (p) { return Number(p.stock_qty) <= Number(p.low_stock_threshold); })
      .sort(function (a, b) { return Number(a.stock_qty) - Number(b.stock_qty); });
  }

  // Dashboard numbers for one day (today is YYYY-MM-DD in Lagos).
  function summarizeDashboard(data) {
    var today = data.today;
    var sales = (data.sales || []).filter(function (s) { return s.sale_date === today; });
    var expenses = (data.expenses || []).filter(function (e) { return e.expense_date === today; });
    var salesTotal = round2(sales.reduce(function (a, s) { return a + Number(s.total); }, 0));
    var profit = round2(sales.reduce(function (a, s) { return a + Number(s.estimated_profit); }, 0));
    var expTotal = round2(expenses.reduce(function (a, e) { return a + Number(e.amount); }, 0));
    var unpaid = round2((data.debts || []).reduce(function (a, d) { return a + Math.max(0, Number(d.balance)); }, 0));
    return {
      sales_total: salesTotal,
      expenses_total: expTotal,
      estimated_profit: profit,
      estimated_profit_after_expenses: round2(profit - expTotal),
      unpaid_debts: unpaid,
      low_stock: lowStockProducts(data.products)
    };
  }

  // Today's date in Africa/Lagos as YYYY-MM-DD.
  function todayInLagos(now) {
    var d = now || new Date();
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(d);
  }

  function formatNaira(n) {
    var fixed = round2(Number(n) || 0).toFixed(2);
    var neg = fixed.charAt(0) === '-';
    if (neg) fixed = fixed.slice(1);
    var parts = fixed.split('.');
    var int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + '\u20A6' + int + '.' + parts[1];
  }

  return {
    PAYMENT_METHODS: PAYMENT_METHODS,
    EXPENSE_CATEGORIES: EXPENSE_CATEGORIES,
    round2: round2,
    parseAmount: parseAmount,
    validateName: validateName,
    validateMoney: validateMoney,
    validateQty: validateQty,
    validateDate: validateDate,
    validateProduct: validateProduct,
    validateExpense: validateExpense,
    validateSaleInput: validateSaleInput,
    aggregateQty: aggregateQty,
    computeSaleTotals: computeSaleTotals,
    applyStockDecrement: applyStockDecrement,
    checkStock: checkStock,
    debtForSale: debtForSale,
    applyRepayment: applyRepayment,
    lowStockProducts: lowStockProducts,
    summarizeDashboard: summarizeDashboard,
    todayInLagos: todayInLagos,
    formatNaira: formatNaira
  };
}));
