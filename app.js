// BizPilot NG - app logic for the browser. Uses logic.js (BizLogic) for all money and validation rules.
(function () {
  'use strict';
  var L = window.BizLogic;
  var CFG = window.BIZPILOT_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var fmt = L.formatNaira;

  var state = { user: null, business: null, products: [], customers: [], cart: [], debts: [], view: 'dashboard' };
  var sb = null;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function configOk() {
    return CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf('YOUR-PROJECT') === -1 &&
      CFG.SUPABASE_ANON_KEY && CFG.SUPABASE_ANON_KEY.indexOf('YOUR-') === -1 && window.supabase;
  }

  function showBanner(msg) { var b = $('banner'); b.textContent = msg; b.classList.remove('hidden'); }
  function hideBanner() { $('banner').classList.add('hidden'); }

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2600);
  }

  function setMsg(id, msg) {
    var el = $(id);
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = msg; el.classList.remove('hidden');
  }

  function setBusy(btn, busy, label) {
    btn.disabled = busy;
    btn.innerHTML = busy ? '<span class="spinner"></span>Please wait' : label;
  }

  function show(view) {
    ['auth', 'dashboard', 'products', 'sell', 'expenses', 'debts'].forEach(function (v) {
      $('view-' + v).classList.toggle('hidden', v !== view);
    });
    state.view = view;
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
    if (view === 'dashboard') loadDashboard();
    if (view === 'products') loadProducts();
    if (view === 'sell') prepareSell();
    if (view === 'expenses') { $('e-date').value = L.todayInLagos(); loadExpenses(); }
    if (view === 'debts') loadDebts();
  }

  // ---------- AUTH ----------
  var authMode = 'login';
  function setAuthMode(mode) {
    authMode = mode;
    $('tab-login').classList.toggle('active', mode === 'login');
    $('tab-signup').classList.toggle('active', mode === 'signup');
    $('signup-only').classList.toggle('hidden', mode !== 'signup');
    $('auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
    $('auth-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    setMsg('auth-error', ''); setMsg('auth-info', '');
  }

  function siteUrl() {
    if (CFG.SITE_URL && CFG.SITE_URL !== 'AUTO') return CFG.SITE_URL;
    return window.location.origin + window.location.pathname;
  }

  async function handleAuth(e) {
    e.preventDefault();
    setMsg('auth-error', ''); setMsg('auth-info', '');
    var email = $('auth-email').value.trim();
    var pw = $('auth-password').value;
    var shop = $('auth-shop').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return setMsg('auth-error', 'Enter a valid email address');
    if (pw.length < 8) return setMsg('auth-error', 'Password must be at least 8 characters');
    if (authMode === 'signup') {
      if (!shop) return setMsg('auth-error', 'Enter your shop name');
      if (shop.length > 120) return setMsg('auth-error', 'Shop name is too long (max 120)');
    }
    var btn = $('auth-submit');
    setBusy(btn, true, authMode === 'login' ? 'Log in' : 'Create account');
    try {
      if (authMode === 'signup') {
        var res = await sb.auth.signUp({
          email: email, password: pw,
          options: { emailRedirectTo: siteUrl(), data: { business_name: shop } }
        });
        if (res.error) throw res.error;
        if (res.data.session) { await enterApp(res.data.session.user); return; }
        setMsg('auth-info', 'Account created. We sent a verification link to ' + email + '. Open it on this phone, then come back and log in.');
        setAuthMode('login');
      } else {
        var r = await sb.auth.signInWithPassword({ email: email, password: pw });
        if (r.error) {
          if (/not confirmed/i.test(r.error.message)) throw new Error('Please verify your email first. Open the link we sent you, then try again.');
          if (/invalid login/i.test(r.error.message)) throw new Error('Wrong email or password.');
          throw r.error;
        }
        await enterApp(r.data.user);
      }
    } catch (err) {
      setMsg('auth-error', err.message || 'Something went wrong. Try again.');
    } finally {
      setBusy(btn, false, authMode === 'login' ? 'Log in' : 'Create account');
    }
  }

  async function enterApp(user) {
    state.user = user;
    var b = await sb.from('businesses').select('*').eq('owner_id', user.id).maybeSingle();
    if (b.error || !b.data) {
      showBanner('Could not load your shop. Check your connection and log in again.');
      return;
    }
    state.business = b.data;
    hideBanner();
    $('nav').classList.remove('hidden');
    $('logout-btn').classList.remove('hidden');
    $('dash-title').textContent = state.business.name;
    $('demo-banner').classList.remove('hidden');
    show('dashboard');
  }

  function leaveApp() {
    state.user = null; state.business = null; state.cart = [];
    $('nav').classList.add('hidden'); $('logout-btn').classList.add('hidden');
    $('demo-banner').classList.add('hidden');
    show('auth');
    setAuthMode('login');
  }

  // ---------- DASHBOARD ----------
  async function loadDashboard() {
    $('dash-loading').classList.remove('hidden');
    $('dash-error').classList.add('hidden');
    $('dash-cards').classList.add('hidden');
    $('dash-note').classList.add('hidden');
    var today = L.todayInLagos();
    try {
      var results = await Promise.all([
        sb.from('sales').select('sale_date,total,estimated_profit').eq('sale_date', today),
        sb.from('expenses').select('expense_date,amount').eq('expense_date', today),
        sb.from('debts').select('balance').gt('balance', 0),
        sb.from('products').select('id,name,stock_qty,low_stock_threshold').eq('is_active', true)
      ]);
      results.forEach(function (r) { if (r.error) throw r.error; });
      var s = L.summarizeDashboard({
        today: today,
        sales: results[0].data, expenses: results[1].data,
        debts: results[2].data, products: results[3].data
      });
      $('st-sales').textContent = fmt(s.sales_total);
      $('st-exp').textContent = fmt(s.expenses_total);
      $('st-profit').textContent = fmt(s.estimated_profit);
      $('st-debt').textContent = fmt(s.unpaid_debts);
      $('dash-cards').classList.remove('hidden');
      $('dash-note').classList.remove('hidden');
      var ls = $('low-stock');
      if (s.low_stock.length === 0) {
        ls.innerHTML = ''; $('low-empty').classList.remove('hidden');
      } else {
        $('low-empty').classList.add('hidden');
        ls.innerHTML = s.low_stock.map(function (p) {
          var out = Number(p.stock_qty) === 0;
          return '<div class="item"><div><strong>' + esc(p.name) + '</strong><div class="meta">' +
            'Left: ' + p.stock_qty + ' (alert at ' + p.low_stock_threshold + ')</div></div>' +
            '<span class="badge ' + (out ? 'bad' : '') + '">' + (out ? 'Out of stock' : 'Low') + '</span></div>';
        }).join('');
      }
    } catch (err) {
      $('dash-error').textContent = 'Could not load today\'s numbers. ' + (err.message || '') + ' Pull down to retry or tap Home again.';
      $('dash-error').classList.remove('hidden');
    } finally {
      $('dash-loading').classList.add('hidden');
    }
  }

  async function loadDemo() {
    var btn = $('demo-btn');
    setBusy(btn, true, 'Load demo products (sample only)');
    var r = await sb.rpc('load_demo_products');
    setBusy(btn, false, 'Load demo products (sample only)');
    if (r.error) return toast('Could not load demo: ' + r.error.message, 'bad');
    toast('Demo products added (' + r.data + '). Delete them before real use.', 'ok');
    loadDashboard();
  }

  // ---------- PRODUCTS ----------
  async function loadProducts() {
    $('products-loading').classList.remove('hidden');
    $('products-error').classList.add('hidden');
    var r = await sb.from('products').select('*').eq('is_active', true).order('name');
    $('products-loading').classList.add('hidden');
    if (r.error) { $('products-error').textContent = 'Could not load products: ' + r.error.message; $('products-error').classList.remove('hidden'); return; }
    state.products = r.data || [];
    $('products-empty').classList.toggle('hidden', state.products.length > 0);
    $('products-list').innerHTML = state.products.map(function (p) {
      var low = Number(p.stock_qty) <= Number(p.low_stock_threshold);
      return '<div class="item"><div><strong>' + esc(p.name) + '</strong>' +
        '<div class="meta">Cost ' + fmt(p.cost_price) + ' · Sell ' + fmt(p.selling_price) + '</div>' +
        '<div class="meta">Stock: ' + p.stock_qty + (low ? ' <span class="badge">low</span>' : '') + '</div></div>' +
        '<div class="actions"><button class="btn small-btn" data-edit="' + p.id + '">Edit</button>' +
        '<button class="btn small-btn" data-archive="' + p.id + '">Hide</button></div></div>';
    }).join('');
  }

  function readProductForm() {
    return {
      name: $('p-name').value,
      cost_price: $('p-cost').value,
      selling_price: $('p-sell').value,
      stock_qty: $('p-stock').value,
      low_stock_threshold: $('p-thr').value
    };
  }

  function clearProductForm() {
    ['p-id', 'p-name', 'p-cost', 'p-sell', 'p-stock', 'p-thr'].forEach(function (id) { $(id).value = ''; });
    $('p-thr').value = '5'; $('p-stock').value = '0';
    $('p-submit').textContent = 'Save product';
    setMsg('p-error', ''); setMsg('p-warn', '');
  }

  async function saveProduct(e) {
    e.preventDefault();
    setMsg('p-error', ''); setMsg('p-warn', '');
    var v = L.validateProduct(readProductForm());
    if (!v.ok) return setMsg('p-error', Object.values(v.errors).join('. '));
    if (v.warning) setMsg('p-warn', v.warning);
    var id = $('p-id').value;
    var btn = $('p-submit');
    setBusy(btn, true, 'Save product');
    var r;
    if (id) r = await sb.from('products').update(Object.assign({}, v.value, { updated_at: new Date().toISOString() })).eq('id', id);
    else r = await sb.from('products').insert(Object.assign({ business_id: state.business.id }, v.value));
    setBusy(btn, false, 'Save product');
    if (r.error) return setMsg('p-error', 'Could not save: ' + r.error.message);
    toast(id ? 'Product updated' : 'Product added', 'ok');
    clearProductForm();
    loadProducts();
  }

  function editProduct(id) {
    var p = state.products.find(function (x) { return x.id === id; });
    if (!p) return;
    $('p-id').value = p.id; $('p-name').value = p.name; $('p-cost').value = p.cost_price;
    $('p-sell').value = p.selling_price; $('p-stock').value = p.stock_qty; $('p-thr').value = p.low_stock_threshold;
    $('p-submit').textContent = 'Update product';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function archiveProduct(id) {
    if (!confirm('Hide this product? Past sales keep their record.')) return;
    var r = await sb.from('products').update({ is_active: false }).eq('id', id);
    if (r.error) return toast('Could not hide: ' + r.error.message, 'bad');
    toast('Product hidden', 'ok');
    loadProducts();
  }

  // ---------- SELL ----------
  async function prepareSell() {
    setMsg('s-error', ''); setMsg('s-success', '');
    var rp = await sb.from('products').select('*').eq('is_active', true).order('name');
    var rc = await sb.from('customers').select('id,name').order('name');
    if (rp.error || rc.error) return setMsg('s-error', 'Could not load products or customers. Try again.');
    state.products = rp.data || [];
    state.customers = rc.data || [];
    $('s-product').innerHTML = state.products.length
      ? state.products.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + ' (' + p.stock_qty + ' left, ' + fmt(p.selling_price) + ')</option>'; }).join('')
      : '<option value="">Add products in Stock first</option>';
    $('s-customer').innerHTML = '<option value="">Choose customer</option>' +
      state.customers.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
    renderCart();
  }

  function cartTotals() {
    return L.computeSaleTotals(state.cart.map(function (c) {
      return { qty: c.qty, unit_price: c.unit_price, unit_cost: c.unit_cost };
    }));
  }

  function renderCart() {
    $('s-empty').classList.toggle('hidden', state.cart.length > 0);
    $('s-lines').innerHTML = state.cart.map(function (c, i) {
      return '<div class="item"><div><strong>' + esc(c.name) + '</strong><div class="meta">' + c.qty + ' × ' + fmt(c.unit_price) + ' = ' + fmt(c.qty * c.unit_price) + '</div></div>' +
        '<button class="btn small-btn" data-remove="' + i + '">Remove</button></div>';
    }).join('');
    $('s-total').textContent = fmt(cartTotals().total);
    $('s-credit').classList.toggle('hidden', $('s-method').value !== 'credit');
  }

  function addToCart() {
    setMsg('s-error', ''); setMsg('s-success', '');
    var pid = $('s-product').value;
    var qty = L.parseAmount($('s-qty').value);
    var p = state.products.find(function (x) { return x.id === pid; });
    if (!p) return setMsg('s-error', 'Pick a product');
    if (isNaN(qty) || !Number.isInteger(qty) || qty < 1) return setMsg('s-error', 'Quantity must be a whole number of at least 1');
    var existing = state.cart.find(function (c) { return c.product_id === pid; });
    var newQty = (existing ? existing.qty : 0) + qty;
    if (newQty > p.stock_qty) return setMsg('s-error', 'Not enough stock: only ' + p.stock_qty + ' ' + p.name + ' left');
    if (existing) existing.qty = newQty;
    else state.cart.push({ product_id: p.id, name: p.name, qty: qty, unit_price: Number(p.selling_price), unit_cost: Number(p.cost_price) });
    $('s-qty').value = '1';
    renderCart();
  }

  async function completeSale() {
    setMsg('s-error', ''); setMsg('s-success', '');
    var method = $('s-method').value;
    var customerId = $('s-customer').value || null;
    var newName = $('s-newcust').value.trim();
    var btn = $('s-complete');
    if (method === 'credit' && !customerId && newName) {
      if (newName.length > 120) return setMsg('s-error', 'Customer name is too long');
      setBusy(btn, true, 'Complete sale');
      var cr = await sb.from('customers').insert({ business_id: state.business.id, name: newName }).select('id').single();
      if (cr.error) { setBusy(btn, false, 'Complete sale'); return setMsg('s-error', 'Could not add customer: ' + cr.error.message); }
      customerId = cr.data.id;
    }
    var v = L.validateSaleInput({
      payment_method: method,
      customer_id: customerId,
      items: state.cart.map(function (c) { return { product_id: c.product_id, qty: c.qty, unit_price: c.unit_price, unit_cost: c.unit_cost }; }),
      amount_paid: method === 'credit' ? $('s-paid').value : undefined
    });
    if (!v.ok) { setBusy(btn, false, 'Complete sale'); return setMsg('s-error', v.errors.join('. ')); }
    var stockById = {};
    state.products.forEach(function (p) { stockById[p.id] = p.stock_qty; });
    var stockErr = L.checkStock(v.value.items, stockById);
    if (stockErr.length) { setBusy(btn, false, 'Complete sale'); return setMsg('s-error', stockErr[0]); }

    setBusy(btn, true, 'Complete sale');
    var items = state.cart.map(function (c) { return { product_id: c.product_id, qty: c.qty }; });
    var r = await sb.rpc('create_sale', {
      p_payment_method: method,
      p_customer_id: method === 'credit' ? customerId : null,
      p_items: items,
      p_amount_paid: method === 'credit' ? v.value.amount_paid : null
    });
    setBusy(btn, false, 'Complete sale');
    if (r.error) return setMsg('s-error', 'Sale not saved: ' + r.error.message);
    setMsg('s-success', 'Sale saved. Stock updated.' + (v.value.debt > 0 ? ' Debt of ' + fmt(v.value.debt) + ' added.' : ''));
    toast('Sale completed', 'ok');
    state.cart = [];
    $('s-paid').value = '0'; $('s-newcust').value = '';
    renderCart();
    prepareSell();
  }

  // ---------- EXPENSES ----------
  async function saveExpense(e) {
    e.preventDefault();
    setMsg('e-error', ''); setMsg('e-success', '');
    var v = L.validateExpense({
      category: $('e-cat').value, amount: $('e-amt').value,
      expense_date: $('e-date').value, description: $('e-desc').value
    });
    if (!v.ok) return setMsg('e-error', Object.values(v.errors).join('. '));
    var btn = e.target.querySelector('button[type=submit]');
    setBusy(btn, true, 'Save expense');
    var r = await sb.from('expenses').insert(Object.assign({ business_id: state.business.id }, v.value));
    setBusy(btn, false, 'Save expense');
    if (r.error) return setMsg('e-error', 'Not saved: ' + r.error.message);
    setMsg('e-success', 'Expense saved (' + fmt(v.value.amount) + ').');
    $('e-amt').value = ''; $('e-desc').value = '';
    loadExpenses();
  }

  async function loadExpenses() {
    var r = await sb.from('expenses').select('*').order('expense_date', { ascending: false }).order('created_at', { ascending: false }).limit(30);
    if (r.error) return setMsg('e-error', 'Could not load expenses: ' + r.error.message);
    var list = r.data || [];
    $('expenses-list').innerHTML = list.length ? list.map(function (x) {
      return '<div class="item"><div><strong>' + fmt(x.amount) + '</strong> · ' + esc(x.category.replace('_', ' ')) +
        '<div class="meta">' + esc(x.expense_date) + (x.description ? ' · ' + esc(x.description) : '') + '</div></div></div>';
    }).join('') : '<div class="state">No expenses yet.</div>';
  }

  // ---------- DEBTS ----------
  async function loadDebts() {
    $('debts-loading').classList.remove('hidden');
    $('debts-error').classList.add('hidden');
    var r = await sb.from('debts').select('id,amount,balance,created_at,customer_id,customers(name)').gt('balance', 0).order('created_at');
    $('debts-loading').classList.add('hidden');
    if (r.error) { $('debts-error').textContent = 'Could not load debts: ' + r.error.message; $('debts-error').classList.remove('hidden'); return; }
    state.debts = r.data || [];
    var total = state.debts.reduce(function (a, d) { return a + Number(d.balance); }, 0);
    $('d-total').textContent = fmt(total);
    $('debts-empty').classList.toggle('hidden', state.debts.length > 0);
    $('debts-list').innerHTML = state.debts.map(function (d) {
      var name = d.customers && d.customers.name ? d.customers.name : 'Customer';
      return '<div class="item"><div><strong>' + esc(name) + '</strong><div class="meta">Owes ' + fmt(d.balance) +
        ' of ' + fmt(d.amount) + '</div></div><div class="actions"><input data-rep-amt="' + d.id + '" type="number" min="0" step="0.01" placeholder="₦" style="width:100px;margin:0">' +
        '<button class="btn small-btn primary" data-repay="' + d.id + '">Record</button></div></div>';
    }).join('');
  }

  async function recordRepayment(debtId) {
    setMsg('r-error', ''); setMsg('r-success', '');
    var debt = state.debts.find(function (d) { return d.id === debtId; });
    var input = document.querySelector('[data-rep-amt="' + debtId + '"]');
    var check = L.applyRepayment(Number(debt.balance), input.value);
    if (!check.ok) return setMsg('r-error', check.error);
    var r = await sb.rpc('record_repayment', { p_debt_id: debtId, p_amount: L.parseAmount(input.value) });
    if (r.error) return setMsg('r-error', 'Not saved: ' + r.error.message);
    setMsg('r-success', 'Repayment saved. Balance now ' + fmt(check.balance) + '.');
    loadDebts();
  }

  // ---------- EVENTS & INIT ----------
  function bind() {
    $('tab-login').onclick = function () { setAuthMode('login'); };
    $('tab-signup').onclick = function () { setAuthMode('signup'); };
    $('auth-form').addEventListener('submit', handleAuth);
    $('logout-btn').onclick = async function () { await sb.auth.signOut(); leaveApp(); };
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.onclick = function () { show(b.getAttribute('data-view')); };
    });
    document.querySelectorAll('[data-go]').forEach(function (b) {
      b.onclick = function () { show(b.getAttribute('data-go')); };
    });
    $('demo-btn').onclick = loadDemo;
    $('product-form').addEventListener('submit', saveProduct);
    $('p-cancel').onclick = clearProductForm;
    $('products-list').onclick = function (e) {
      var t = e.target;
      if (t.getAttribute('data-edit')) editProduct(t.getAttribute('data-edit'));
      if (t.getAttribute('data-archive')) archiveProduct(t.getAttribute('data-archive'));
    };
    $('s-add').onclick = addToCart;
    $('s-lines').onclick = function (e) {
      var i = e.target.getAttribute('data-remove');
      if (i !== null) { state.cart.splice(Number(i), 1); renderCart(); }
    };
    $('s-method').onchange = renderCart;
    $('s-complete').onclick = completeSale;
    $('expense-form').addEventListener('submit', saveExpense);
    $('debts-list').onclick = function (e) {
      var id = e.target.getAttribute('data-repay');
      if (id) recordRepayment(id);
    };
  }

  async function init() {
    bind();
    if (!configOk()) {
      showBanner('Setup needed: put your Supabase URL and key in config.js (see the setup steps).');
      show('auth');
      return;
    }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    show('auth');
    setAuthMode('login');
    try {
      var s = await sb.auth.getSession();
      if (s.data && s.data.session) await enterApp(s.data.session.user);
    } catch (err) {
      showBanner('Could not reach the server. Check your connection.');
    }
    sb.auth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_OUT') leaveApp();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
