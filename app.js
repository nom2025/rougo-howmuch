// 老後資金パーソナル計算機 v0
let lastNeedMan = null; // 直前の必要額（万円）＝サマリーバーの増減表示用
const $ = (id) => document.getElementById(id);
const yen = (n) => Math.round(n).toLocaleString("ja-JP") + "円";
const man = (n) => (n / 10000).toLocaleString("ja-JP", { maximumFractionDigits: 0 });

// GA4イベント送信（測定ID未設定/ブロック時は何もしない）
function track(name, params) {
  if (typeof window.gtag === "function" && window.GA_MEASUREMENT_ID && window.GA_MEASUREMENT_ID.indexOf("XXXX") === -1) {
    window.gtag("event", name, params || {});
  }
}

// ---- simulation_finished：この人が「最終的にどう使ったか」を1イベントに集約（利用行動分析）----
// リアルタイム計算なので「計算完了」は存在しない。途中の遊びは送らず、落ち着いた最終状態だけ送る。
let lastSimState = null;   // 直近renderの状態スナップショット（条件＝重複判定の対象）
let simSentSig = null;     // 最後に送った状態の署名（同一条件の重複送信を防止）
let finishTimer = null;    // 一定時間操作が止まったら「落ち着いた」とみなすタイマー

// 利用行動の計測用
const startTime = Date.now();   // 滞在時間の起点
let changeCount = 0;            // 入力を触った回数（どれだけ遊ばれたか）
let compareUsed = false;        // 比較チャートを見たか（スクロールで可視化）
let sensitivityUsed = false;    // 感度分析（何が効くか）を見たか
let dominantFactor = null;      // いまの条件で必要額を最も動かす要因（housing/prefecture/style/longevity）
let visitType = "repeat";       // 初回/リピーター（localStorage）
try {
  if (!localStorage.getItem("rougo_visited")) { visitType = "first"; localStorage.setItem("rougo_visited", "1"); }
} catch (e) { visitType = "unknown"; }

// 結果は金額そのものでなく「帯」で送る（プライバシー配慮＋集計しやすさ）
function resultBand(needMan) {
  if (needMan < 1000) return "0-1000";
  if (needMan < 2000) return "1000-2000";
  if (needMan < 3000) return "2000-3000";
  if (needMan < 4000) return "3000-4000";
  return "4000+";
}

// 滞在時間を「帯」に（真剣に使われたかの指標）
function engagementBand(sec) {
  if (sec < 30) return "0-30s";
  if (sec < 60) return "30-60s";
  if (sec < 180) return "1-3min";
  if (sec < 600) return "3-10min";
  return "10min+";
}

function bumpChange() { changeCount++; }

function sendSimulationFinished(trigger, force) {
  if (!lastSimState) return;
  const sig = JSON.stringify(lastSimState);
  if (!force && sig === simSentSig) return; // 条件が変わっていなければ送らない
  simSentSig = sig;
  const sec = Math.round((Date.now() - startTime) / 1000);
  track("simulation_finished", Object.assign({
    trigger: trigger,
    engagement_band: engagementBand(sec),
    change_count: changeCount,
    compare_used: compareUsed ? "true" : "false",
    sensitivity_used: sensitivityUsed ? "true" : "false",
    visit_type: visitType,
    app_version: APP_VERSION,
  }, lastSimState));
}

// 操作が止まって30秒経ったら「落ち着いた最終状態」として送る（都度リセット）
function scheduleFinish() {
  if (finishTimer) clearTimeout(finishTimer);
  finishTimer = setTimeout(() => sendSimulationFinished("settled"), 30000);
}

// 都道府県セレクトを生成
const prefsSorted = [...PREF_DATA].sort((a, b) => a.name.localeCompare(b.name, "ja"));
const sel = $("pref");
prefsSorted.forEach((p) => {
  const o = document.createElement("option");
  o.value = p.name;
  o.textContent = p.name;
  sel.appendChild(o);
});
sel.value = "東京都";

// 費目編集フィールドを生成
const catGrid = $("catGrid");
CATEGORIES.forEach((c) => {
  const wrap = document.createElement("label");
  wrap.className = "cat-item";
  wrap.innerHTML = `<span>${c.name}</span>
    <input type="number" id="cat_${c.key}" min="0" step="1000" inputmode="numeric" />
    <em class="cat-hint" id="hint_${c.key}"></em>`;
  catGrid.appendChild(wrap);
});

// シナリオカードのDOMを生成
const scenarioGrid = $("scenarioGrid");
SCENARIOS.forEach((sc) => {
  const card = document.createElement("div");
  card.className = "scenario-card" + (sc.key === "normal" ? " main" : "");
  card.innerHTML = `<div class="sc-name">${sc.name}</div>
    <div class="sc-need"><span id="sc_${sc.key}">―</span><span class="sc-unit">万円</span></div>
    <div class="sc-desc">${sc.desc}</div>
    <div class="sc-detail" id="scd_${sc.key}"></div>`;
  scenarioGrid.appendChild(card);
});

function currentHousehold() {
  return document.querySelector('input[name="household"]:checked').value;
}

// シナリオ別の必要額（就労収入で相殺、ローンを上乗せ、健康・介護と長生きを重ねる）
function needForScenario(consMonthly, pref, opts, sc) {
  const pension = pensionFor(pref, opts);
  const short = Math.max(consMonthly - pension, 0);
  const years = opts.years + sc.extraYears;
  const cumulative = short * years * 12;
  const workTotal = opts.workIncome * opts.workYears * 12;
  const loanTotal = opts.loanMonthly * opts.loanYears * 12;
  const gap = Math.max(cumulative + loanTotal - workTotal, 0);
  return { need: gap + opts.reserve + sc.careLump, years, short, pension, cumulative, workTotal, loanTotal };
}

// 生活スタイルに応じた目標生活費（月額）。actualはnull（県平均の実データを使う）
function styleTotal(pref, opts) {
  const s = opts.style;
  const singleF = opts.household === "single" ? SINGLE_TOTAL_RATIO : 1;
  if (s === "rich") return STYLE_TARGET.rich * singleF;
  if (s === "standard") return STYLE_TARGET.standard * singleF;
  if (s === "frugal") return pensionFor(pref, opts); // 年金の範囲内＝不足ほぼ0
  return null;
}

// 賃貸選択時に「住居」へ入れる県別の実家賃（住宅・土地統計調査2023）。単身は概算換算
function rentFor(pref, opts) {
  const base = RENT_PREF[pref.name] != null ? RENT_PREF[pref.name] : 50000;
  const rent = base * (opts.household === "single" ? RENT_SINGLE_RATIO : 1);
  return Math.round(rent / 1000) * 1000;
}

// 県別の実費目(cat)を初期値化。単身は費目別比率、生活スタイル選択時は総額を目標へスケール
function defaultCategories(pref, opts) {
  const rawTotal = pref.cat.reduce((s, v) => s + v, 0);
  const factor = rawTotal > 0 ? pref.cons / rawTotal : 1;
  const base = {};
  let baseTotal = 0;
  CATEGORIES.forEach((c, i) => {
    let v = pref.cat[i] * factor;
    if (opts.household === "single") v *= SINGLE_RATIO[c.key];
    base[c.key] = v;
    baseTotal += v;
  });
  let target = styleTotal(pref, opts);
  // 倹約は「実費が年金より安ければ実費のまま」（無理に年金額まで増やさない）
  if (opts.style === "frugal" && target != null) target = Math.min(baseTotal, target);
  const scale = target && baseTotal > 0 ? target / baseTotal : 1;
  const vals = {};
  CATEGORIES.forEach((c) => { vals[c.key] = Math.round((base[c.key] * scale) / 1000) * 1000; });
  // 賃貸は住居費を家賃相場で置き換える（家計調査の持ち家バイアスを補正）
  if (opts.tenure === "rent") vals.housing = rentFor(pref, opts);
  return vals;
}

// 月生活費（初期値の合計）＝順位計算などに使用
function prefConsFor(pref, opts) {
  const v = defaultCategories(pref, opts);
  return CATEGORIES.reduce((s, c) => s + v[c.key], 0);
}

// 想定年金（世帯・モード反映）
function pensionFor(pref, opts) {
  if (opts.mode === "flat") return opts.flat;
  return pref.pensionReg * (opts.household === "single" ? PENSION_SINGLE_RATIO : 1);
}

function setCategoryFields(vals) {
  CATEGORIES.forEach((c) => { $(`cat_${c.key}`).value = vals[c.key]; });
}

// 各費目に目安を併記（県平均実データ=県平均/推計、スタイル選択時=目安）
function updateHints(pref, opts) {
  const base = defaultCategories(pref, opts);
  let label = "県平均 ";
  if (opts.style !== "actual") label = "目安 ";
  else if (opts.household === "single") label = "推計 ";
  CATEGORIES.forEach((c) => {
    let l = label;
    if (c.key === "housing" && opts.tenure === "rent") l = "賃貸相場 ";
    $(`hint_${c.key}`).textContent = l + man(base[c.key]) + "万";
  });
}

// 全国平均の費目シェア（県別rawの単純平均）
const NAT_SHARE = (() => {
  const acc = CATEGORIES.map(() => 0);
  PREF_DATA.forEach((p) => {
    const t = p.cat.reduce((s, v) => s + v, 0);
    p.cat.forEach((v, i) => (acc[i] += v / t));
  });
  return acc.map((x) => x / PREF_DATA.length);
})();

// 地域の特徴を自動生成（費目シェアを全国平均と比較）
function commentary(pref) {
  const t = pref.cat.reduce((s, v) => s + v, 0);
  const dev = CATEGORIES.map((c, i) => ({
    name: c.name,
    key: c.key,
    rel: pref.cat[i] / t / NAT_SHARE[i] - 1,
  }));
  const highs = dev.filter((d) => d.rel > 0.12).sort((a, b) => b.rel - a.rel).slice(0, 2);
  const lows = dev.filter((d) => d.rel < -0.12).sort((a, b) => a.rel - b.rel).slice(0, 1);

  const consRank = [...PREF_DATA].sort((a, b) => b.cons - a.cons).findIndex((p) => p.name === pref.name) + 1;
  const level = consRank <= 16 ? "高め" : consRank >= 32 ? "低め" : "全国並み";

  let s = `<b>${pref.name}</b>の生活費の総額は全国 <b>${consRank}位 / 47</b>（${level}）。`;
  if (highs.length) {
    s += `費目では <b>${highs.map((h) => h.name).join("・")}</b> の割合が全国平均より高いのが特徴`;
    s += lows.length ? `、` : `です。`;
  }
  if (lows.length) {
    s += `${highs.length ? "" : "費目では "}<b>${lows[0].name}</b> は低めです。`;
  }
  if (!highs.length && !lows.length) s += `費目構成は全国平均に近いバランス型です。`;

  // 交通・通信が高い地域＝車社会の注記（大都市圏は鉄道中心なので除外＝京都等の誤判定を防ぐ）
  const METRO = new Set(["東京都", "大阪府", "京都府", "神奈川県", "埼玉県", "千葉県", "愛知県", "兵庫県", "福岡県"]);
  if (highs.some((h) => h.key === "traffic") && !METRO.has(pref.name)) s += `（車社会で交通費がかさむ傾向）`;
  return s;
}

function readCategoryTotal() {
  return CATEGORIES.reduce((s, c) => s + (+$(`cat_${c.key}`).value || 0), 0);
}

// ヘッダー用: 同一条件（夫婦・県平均・標準シナリオ・各県の平均年金）での県間の差を算出
function renderSpread() {
  const opts = {
    mode: "region", household: "couple", tenure: "own", style: "actual",
    flat: FLAT_PENSION_DEFAULT.couple, years: LIFE_REMAIN.male, reserve: 3000000,
    workIncome: 0, workYears: 0, loanMonthly: 0, loanYears: 0,
  };
  const normalSc = SCENARIOS.find((s) => s.key === "normal");
  const baseOpts = {
    mode: "region", household: "couple", style: "actual",
    flat: FLAT_PENSION_DEFAULT.couple, years: LIFE_REMAIN.male, reserve: 3000000,
    workIncome: 0, workYears: 0, loanMonthly: 0, loanYears: 0,
  };
  // 高い側＝賃貸で必要額が最も高い都市（＝東京）
  const hi = PREF_DATA
    .map((p) => ({ name: p.name, need: needForScenario(prefConsFor(p, { ...baseOpts, tenure: "rent" }), p, { ...baseOpts, tenure: "rent" }, normalSc).need }))
    .sort((a, b) => b.need - a.need)[0];
  // 低い側＝持ち家で「月に実質1.5万円以上の不足がある県」のうち最安（＝予備費だけの床張り付きを除外）
  const lo = PREF_DATA
    .map((p) => {
      const o = { ...baseOpts, tenure: "own" };
      const short = Math.max(prefConsFor(p, o) - pensionFor(p, o), 0);
      return { name: p.name, need: needForScenario(prefConsFor(p, o), p, o, normalSc).need, short };
    })
    .filter((x) => x.short >= 15000)
    .sort((a, b) => a.need - b.need)[0];
  const mult = lo.need > 0 ? (hi.need / lo.need) : 0;

  $("spread").innerHTML =
    `<div class="hero-compare">` +
      `<div class="hc-item high"><span class="hc-cap">都市で賃貸なら</span>` +
        `<span class="hc-num">${man(hi.need)}<small>万円</small></span>` +
        `<span class="hc-sub">${hi.name}・夫婦</span></div>` +
      `<div class="hc-vs"><span class="hc-anchor">全国の通説</span>` +
        `<span class="hc-2000">2,000<small>万円</small></span>` +
        (mult ? `<span class="hc-mult">条件で約${mult.toFixed(1)}倍</span>` : "") + `</div>` +
      `<div class="hc-item low"><span class="hc-cap">地方で持ち家なら</span>` +
        `<span class="hc-num">${man(lo.need)}<small>万円</small></span>` +
        `<span class="hc-sub">${lo.name}・夫婦</span></div>` +
    `</div>` +
    `<p class="hero-note">どの県が“得”か、ではありません。同じ「2,000万円」が、住む場所と住まい方で倍以上ちがう意味を持つ——それを<b>あなたの条件</b>で確かめる計算機です。</p>`;
}

// 「あなたの条件のまま他県は？」比較チャート（あなた・最高県・最低県・全国2,000万）
function renderCompare(pref, ranked, rNormal, rank) {
  const hi = ranked[0], lo = ranked[ranked.length - 1];
  const rows = [];
  rows.push({ label: "あなた：", name: pref.name, val: rNormal.need, cls: "me" });
  if (hi.name !== pref.name) rows.push({ label: "最高：", name: hi.name, val: hi.need, cls: "high" });
  if (lo.name !== pref.name) rows.push({ label: "最低：", name: lo.name, val: lo.need, cls: "low" });
  rows.push({ label: "", name: "全国の通説「2,000万円」", val: NATIONAL_AVG_JPY, cls: "nat" });
  rows.sort((a, b) => b.val - a.val);
  const maxV = Math.max.apply(null, rows.map((r) => r.val)) || 1;
  $("compareChart").innerHTML = rows.map((r) =>
    `<div class="cmp-row ${r.cls}">` +
      `<span class="cmp-name">${r.label}<b>${r.name}</b></span>` +
      `<div class="cmp-track"><div class="cmp-fill" style="width:${(r.val / maxV * 100).toFixed(1)}%"></div></div>` +
      `<span class="cmp-val">${man(r.val)}<small>万</small></span>` +
    `</div>`
  ).join("");

  const mult = lo.need > 0 ? (hi.need / lo.need) : 0;
  $("compareLead").innerHTML =
    `いまの条件のまま住む場所だけ変えると、必要額は ` +
    `<b>${lo.name}（${man(lo.need)}万円）</b>〜<b>${hi.name}（${man(hi.need)}万円）</b>` +
    (mult ? `の<b>約${mult.toFixed(1)}倍</b>の幅。` : `の幅。`) +
    `平均の「2,000万円」は、この幅のどこか1点にすぎません（優劣ではなく地域差です）。`;
}

// 感度：いまの条件で、各選択が必要額をどれだけ動かすか（★で相対表示）
function renderSensitivity(pref, opts, normalSc) {
  const easySc = SCENARIOS.find((s) => s.key === "easy");
  const hardSc = SCENARIOS.find((s) => s.key === "hard");
  const nw = (p, o, sc) => needForScenario(prefConsFor(p, o), p, o, sc || normalSc).need;
  const housing = Math.abs(nw(pref, { ...opts, tenure: "own" }) - nw(pref, { ...opts, tenure: "rent" }));
  const regionVals = PREF_DATA.map((p) => nw(p, opts));
  const region = Math.max.apply(null, regionVals) - Math.min.apply(null, regionVals);
  const styleVals = ["frugal", "standard", "rich", "actual"].map((s) => nw(pref, { ...opts, style: s }));
  const style = Math.max.apply(null, styleVals) - Math.min.apply(null, styleVals);
  const health = nw(pref, opts, hardSc) - nw(pref, opts, easySc);

  const rows = [
    { name: "住まい（持ち家⇄賃貸）", key: "housing", v: housing },
    { name: "住む地域（都道府県）", key: "prefecture", v: region },
    { name: "生活スタイル（倹約⇄ゆとり）", key: "style", v: style },
    { name: "健康・介護リスク（低⇄高）", key: "longevity", v: health },
  ].sort((a, b) => b.v - a.v);
  dominantFactor = rows[0].key; // 最も必要額を動かす要因＝このアプリの肝
  const maxV = rows[0].v || 1;
  const stars = (v) => {
    const n = Math.max(1, Math.min(5, Math.round(v / maxV * 5)));
    return `<span class="on">${"★".repeat(n)}</span>${"★".repeat(5 - n)}`;
  };
  $("sensList").innerHTML = rows.map((r) =>
    `<div class="sens-row">` +
      `<span class="sens-name">${r.name}</span>` +
      `<span class="sens-stars">${stars(r.v)}</span>` +
      `<span class="sens-amt">約${man(r.v)}万円</span>` +
    `</div>`
  ).join("");
}

// 費目を今の条件（県・世帯・スタイル）の初期値へリセット
function resetCategories() {
  const pref = PREF_DATA.find((p) => p.name === sel.value);
  const opts = currentOpts();
  setCategoryFields(defaultCategories(pref, opts));
  updateHints(pref, opts);
  $("prefComment").innerHTML = commentary(pref);
}

// 性別→65歳時点の平均余命→老後年数
function currentYears() {
  const sex = document.querySelector('input[name="sex"]:checked').value;
  return LIFE_REMAIN[sex];
}

function currentOpts() {
  const household = currentHousehold();
  const husband = +$("husbandPension").value;
  const wifeType = $("wifeType").value;
  // 夫婦は「夫の年金＋妻の区分」の合計、単身は単身スライダー
  const flat = household === "couple" ? husband + (WIFE_PENSION[wifeType] || 0) : +$("flatPension").value;
  return {
    mode: document.querySelector('input[name="pensionMode"]:checked').value,
    household,
    tenure: document.querySelector('input[name="tenure"]:checked').value,
    style: $("style").value,
    flat,
    husband,
    wifeType,
    years: currentYears(),
    reserve: +$("reserve").value,
    workIncome: +$("workIncome").value,
    workYears: +$("workYears").value,
    loanMonthly: +$("loanMonthly").value,
    loanYears: +$("loanYears").value,
  };
}

function render() {
  const opts = currentOpts();
  const pref = PREF_DATA.find((p) => p.name === sel.value);
  const consMonthly = readCategoryTotal();

  // スライダー/前提のラベル更新
  $("reserveVal").textContent = man(opts.reserve) + "万円";
  $("workIncomeVal").textContent = opts.workIncome > 0 ? man(opts.workIncome) + "万円" : "なし";
  $("workYearsVal").textContent = opts.workYears + "年";
  $("loanMonthlyVal").textContent = opts.loanMonthly > 0 ? man(opts.loanMonthly) + "万円" : "なし";
  $("loanYearsVal").textContent = opts.loanYears + "年";
  $("flatWrap").style.display = opts.mode === "flat" ? "block" : "none";
  // 年金一律モードの内訳表示（夫婦は夫＋妻／単身は1本スライダー）
  const isCouple = opts.household === "couple";
  $("coupleWrap").style.display = isCouple ? "block" : "none";
  $("singleWrap").style.display = isCouple ? "none" : "block";
  if (isCouple) {
    $("husbandVal").textContent = man(opts.husband) + "万円";
    $("pensionSum").innerHTML = `世帯合計（想定年金）＝ 夫${man(opts.husband)}万 ＋ 妻${man(WIFE_PENSION[opts.wifeType] || 0)}万 ＝ <b>${man(opts.flat)}万円/月</b>`;
    $("coupleNote").textContent = "妻の年金は働き方で大きく変わります（区分は目安）。夫のスライダーを動かすと世帯合計も変わります。";
  } else {
    $("flatVal").textContent = man(opts.flat) + "万円";
    $("flatNote").textContent = "単身の目安：約13万円/月（基礎年金のみなら約6.8万円）。";
  }
  // 住まいの注記
  if (opts.tenure === "rent") {
    $("tenureNote").innerHTML =
      `賃貸：住居費を<b>${pref.name}の平均家賃 約${man(rentFor(pref, opts))}万円/月</b>に置き換えます` +
      `（住宅・土地統計調査2023の借家家賃${opts.household === "single" ? "・単身は概算換算" : ""}）。` +
      `家計調査の高齢世帯は持ち家が多く住居費が低めに出るため、賃貸は必要額が大きく上振れします。`;
  } else {
    $("tenureNote").innerHTML =
      `持ち家：住居費は県平均（修繕・維持中心で低め）。<b>賃貸の方はこの下を「賃貸」に切り替えてください。</b>`;
  }
  $("catTotal").textContent = yen(consMonthly);
  const endAge = Math.round(65 + opts.years);
  $("yearsInfo").textContent = `65歳〜約${endAge}歳（約${opts.years}年間）で試算`;

  // 3シナリオを計算
  const results = {};
  SCENARIOS.forEach((sc) => (results[sc.key] = needForScenario(consMonthly, pref, opts, sc)));
  const normalSc = SCENARIOS.find((s) => s.key === "normal");
  const rNormal = results.normal;

  // メイン数値＝標準シナリオ
  $("need").textContent = man(rNormal.need);

  // 1人あたり（世帯総額 vs 1人あたりの「ねじれ」を可視化）
  const persons = opts.household === "single" ? 1 : 2;
  $("perPerson").textContent =
    persons === 2
      ? `1人あたり 約${man(rNormal.need / 2)}万円（夫婦の総額を2人で割った額）`
      : `1人あたり ＝ 総額（単身）`;

  // 倹約スタイルの注記（不足がほぼ0でも必要額が残る理由を明示）
  const stn = $("styleNote");
  if (opts.style === "frugal" && rNormal.short < 5000) {
    stn.style.display = "";
    stn.innerHTML =
      `倹約：毎月の生活費は年金でほぼ賄える想定ですが、必要額が<b>0にならない</b>のは、` +
      `<b>医療・介護の予備費</b>（標準 ${man(normalSc.careLump)}万）と<b>生活の予備費</b>（${man(opts.reserve)}万）は別途要るためです。`;
  } else {
    stn.style.display = "none";
  }

  // 単身の構造的な注意（規模の経済＝割り勘が効かない）
  const sn = $("singleNote");
  if (opts.household === "single") {
    sn.style.display = "";
    sn.innerHTML =
      `単身は年金1本で固定費（住居・光熱・通信）を1人で負担するため、` +
      `世帯の赤字総額が小さくても<b>家計の余裕（バッファ）は薄く</b>なりがちです（規模の経済が効かない）。` +
      `病気・介護などの想定外に1人で備える意味でも、<b>予備費は厚めが安心</b>です。`;
  } else {
    sn.style.display = "none";
  }
  $("bdCons").textContent = yen(consMonthly);
  $("bdPensionLabel").textContent = opts.household === "single" ? "月の年金（想定・単身1人分）" : "月の年金（想定・世帯合計）";
  $("bdPension").textContent = yen(rNormal.pension);
  $("bdShort").textContent = rNormal.short > 0 ? yen(rNormal.short) : "不足なし";
  $("bdCumLabel").textContent = `不足の累計（標準：約${rNormal.years}年分）`;
  $("bdCum").textContent = yen(rNormal.cumulative);
  $("rowWork").style.display = rNormal.workTotal > 0 ? "" : "none";
  $("bdWork").textContent = "−" + yen(rNormal.workTotal);
  $("rowLoan").style.display = rNormal.loanTotal > 0 ? "" : "none";
  $("bdLoan").textContent = yen(rNormal.loanTotal);
  $("bdReserve").textContent = yen(opts.reserve);
  $("bdCare").textContent = yen(normalSc.careLump);

  // シナリオカード更新
  SCENARIOS.forEach((sc) => {
    const r = results[sc.key];
    $(`sc_${sc.key}`).textContent = man(r.need);
    $(`scd_${sc.key}`).textContent =
      `65歳〜約${Math.round(65 + r.years)}歳／健康・介護 ${man(sc.careLump)}万`;
  });
  $("scenarioRange").innerHTML =
    `この条件での必要額は <b>${man(results.easy.need)}万円（リスク低）〜${man(results.hard.need)}万円（リスク高）</b> の幅。` +
    `健康・介護と寿命の不確実性で、これだけ変わります。`;

  // 固定サマリーバー（常時表示＋前回からの増減）
  const needMan = Math.round(rNormal.need / 10000);
  $("ssNeed").textContent = needMan.toLocaleString("ja-JP");
  $("ssSub").textContent =
    `1人あたり 約${man(rNormal.need / persons)}万円 ／ リスク低 ${man(results.easy.need)}万〜リスク高 ${man(results.hard.need)}万`;
  const deltaEl = $("ssDelta");
  if (lastNeedMan === null || needMan === lastNeedMan) {
    deltaEl.textContent = "";
    deltaEl.className = "ss-delta";
  } else {
    const d = needMan - lastNeedMan;
    deltaEl.textContent = (d > 0 ? "▲ +" : "▼ −") + Math.abs(d).toLocaleString("ja-JP") + "万円";
    deltaEl.className = "ss-delta " + (d > 0 ? "up" : "down");
  }
  lastNeedMan = needMan;

  // シェア用リード文
  const sl = $("shareLead");
  if (sl) sl.innerHTML = `あなたの必要額は <b>${man(rNormal.need)}万円</b>（標準シナリオ）。この結果をシェアできます。`;

  // ゲージ（標準シナリオ vs 2,000万）
  const maxScale = Math.max(rNormal.need, NATIONAL_AVG_JPY) * 1.05;
  $("barYou").style.width = (rNormal.need / maxScale * 100) + "%";
  $("barAvg").style.width = (NATIONAL_AVG_JPY / maxScale * 100) + "%";
  $("youVal").textContent = man(rNormal.need) + "万円";

  // 乖離（標準シナリオ）
  const diffEl = $("diff");
  const d = rNormal.need - NATIONAL_AVG_JPY;
  if (Math.abs(d) < 500000) {
    diffEl.textContent = "全国「2,000万円」とほぼ同じ水準です（標準シナリオ）。";
    diffEl.className = "diff";
  } else if (d > 0) {
    diffEl.textContent = `全国目安より約 ${man(d)}万円 多く必要（標準シナリオ。2,000万円では足りない）。`;
    diffEl.className = "diff over";
  } else {
    diffEl.textContent = `全国目安より約 ${man(-d)}万円 少なくて済む（標準シナリオ）。`;
    diffEl.className = "diff under";
  }

  // 47県中の順位（各県の平均構成 × 標準シナリオ・同じ条件）
  const ranked = PREF_DATA
    .map((p) => ({ name: p.name, need: needForScenario(prefConsFor(p, opts), p, opts, normalSc).need }))
    .sort((a, b) => b.need - a.need);
  const rank = ranked.findIndex((x) => x.name === pref.name) + 1;
  $("rank").textContent = `同条件で見た生活コストの高さ：全国 ${rank} / 47 番目（地域差であり、暮らしの優劣ではありません）`;

  renderCompare(pref, ranked, rNormal, rank);
  renderSensitivity(pref, opts, normalSc);

  // 「最終的にどんな条件で使ったか」用のスナップショットを更新し、落ち着き検知を仕込む
  lastSimState = {
    prefecture: sel.value,
    housing: opts.tenure,        // own / rent
    household: opts.household,   // couple / single
    style: opts.style,           // actual / rich / standard / frugal
    pension_mode: opts.mode,     // flat / region
    result_band: resultBand(needMan),
    dominant_factor: dominantFactor, // housing / prefecture / style / longevity
  };
  scheduleFinish();
}

// 「年金の範囲で（倹約）」選択時は年金額で生活費が決まるため、年金変更で内訳も引き直す
function onPensionChanged() {
  if ($("style").value === "frugal") resetCategories();
  render();
}

// ===== 結果シェア（入力条件＋結果をURLパラメータ化） =====
// いまの状態をURLに直列化（費目は千円単位に圧縮して短く）
function buildShareUrl() {
  const opts = currentOpts();
  const sex = document.querySelector('input[name="sex"]:checked').value;
  const cats = CATEGORIES.map((c) => Math.round((+$(`cat_${c.key}`).value || 0) / 1000)).join("-");
  const q = new URLSearchParams();
  q.set("p", sel.value);
  q.set("h", opts.household);
  q.set("t", opts.tenure);
  q.set("s", sex);
  q.set("st", opts.style);
  q.set("pm", opts.mode);
  if (opts.household === "couple") { q.set("hp", opts.husband); q.set("wt", opts.wifeType); }
  else { q.set("fp", opts.flat); }
  q.set("rs", opts.reserve);
  if (opts.workIncome) { q.set("wi", opts.workIncome); q.set("wy", opts.workYears); }
  if (opts.loanMonthly) { q.set("lm", opts.loanMonthly); q.set("ly", opts.loanYears); }
  q.set("cat", cats);
  return location.origin + location.pathname + "?" + q.toString();
}

// URLパラメータから状態を復元（あれば true）
function applyStateFromUrl() {
  const q = new URLSearchParams(location.search);
  if (![...q.keys()].length) return false;
  const setRadio = (name, val) => {
    const el = document.querySelector(`input[name="${name}"][value="${val}"]`);
    if (el) el.checked = true;
  };
  if (q.get("p") && PREF_DATA.some((p) => p.name === q.get("p"))) sel.value = q.get("p");
  if (q.get("h")) setRadio("household", q.get("h"));
  if (q.get("t")) setRadio("tenure", q.get("t"));
  if (q.get("s")) setRadio("sex", q.get("s"));
  if (q.get("pm")) setRadio("pensionMode", q.get("pm"));
  if (q.get("st")) $("style").value = q.get("st");
  if (q.get("hp")) $("husbandPension").value = q.get("hp");
  if (q.get("wt") && WIFE_PENSION[q.get("wt")] != null) $("wifeType").value = q.get("wt");
  if (q.get("fp")) $("flatPension").value = q.get("fp");
  if (q.get("rs")) $("reserve").value = q.get("rs");
  $("workIncome").value = q.get("wi") || 0;
  $("workYears").value = q.get("wy") || 0;
  $("loanMonthly").value = q.get("lm") || 0;
  $("loanYears").value = q.get("ly") || 0;
  // まず県・世帯・スタイルの初期費目を入れ、その後URLの費目で上書き
  resetCategories();
  if (q.get("cat")) {
    const arr = q.get("cat").split("-").map((x) => Math.round(+x || 0) * 1000);
    CATEGORIES.forEach((c, i) => {
      if (arr[i] != null && !isNaN(arr[i])) $(`cat_${c.key}`).value = arr[i];
    });
  }
  return true;
}

function share(method) {
  const url = buildShareUrl();
  const needMan = $("need").textContent;
  const text = `私の老後資金の必要額は約${needMan}万円でした（標準シナリオ）。あなたはいくら？｜あなたの老後資金、HOW MUCH?`;
  if (method === "copy") {
    const done = () => {
      const m = $("shareMsg");
      m.hidden = false;
      setTimeout(() => (m.hidden = true), 2500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, () => window.prompt("このURLをコピーしてください", url));
    } else {
      window.prompt("このURLをコピーしてください", url);
    }
  } else {
    let sh = "";
    if (method === "twitter") sh = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    else if (method === "line") sh = `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}`;
    else if (method === "facebook") sh = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
    window.open(sh, "_blank", "noopener,noreferrer,width=600,height=640");
  }
  // 「どんな条件だとシェアされやすいか」を見るため、share自体にも条件を付ける
  track("share", Object.assign({ method: method }, lastSimState || {}));
  // シェアは強い意思表示。この時点の最終条件を集約イベントでも送る（重複でも送る）
  sendSimulationFinished("share", true);
}

// イベント（GA4計測：離散的な選択のみ送信。スライダーは確定時=changeで1回だけ）
// change_count は「どれだけ触られたか」の指標。確定操作（change/click）でカウント。
sel.addEventListener("change", () => { bumpChange(); resetCategories(); render(); track("select_pref", { pref: sel.value }); });
$("style").addEventListener("change", () => { bumpChange(); resetCategories(); render(); track("change_style", { style: $("style").value }); });
["reserve", "workIncome", "workYears", "loanMonthly", "loanYears"].forEach((id) => {
  $(id).addEventListener("input", render);
  $(id).addEventListener("change", () => { bumpChange(); track("adjust_slider", { control: id, value: +$(id).value }); });
});
$("flatPension").addEventListener("input", onPensionChanged);
$("flatPension").addEventListener("change", () => { bumpChange(); track("adjust_slider", { control: "flatPension", value: +$("flatPension").value }); });
$("husbandPension").addEventListener("input", onPensionChanged);
$("husbandPension").addEventListener("change", () => { bumpChange(); track("adjust_slider", { control: "husbandPension", value: +$("husbandPension").value }); });
$("wifeType").addEventListener("change", () => { bumpChange(); onPensionChanged(); track("change_wife_type", { wife: $("wifeType").value }); });
CATEGORIES.forEach((c) => {
  $(`cat_${c.key}`).addEventListener("input", render);
  $(`cat_${c.key}`).addEventListener("change", bumpChange); // 費目編集の確定でカウント
});
document.querySelectorAll('input[name="pensionMode"]').forEach((el) =>
  el.addEventListener("change", () => { bumpChange(); onPensionChanged(); track("change_pension_mode", { mode: el.value }); })
);
document.querySelectorAll('input[name="sex"]').forEach((el) =>
  el.addEventListener("change", () => { bumpChange(); render(); track("change_sex", { sex: el.value }); })
);
document.querySelectorAll('input[name="tenure"]').forEach((el) =>
  el.addEventListener("change", () => { bumpChange(); resetCategories(); render(); track("change_tenure", { tenure: el.value }); })
);
document.querySelectorAll('input[name="household"]').forEach((el) =>
  el.addEventListener("change", () => {
    bumpChange();
    // 単身に切り替えたときだけ単身の年金初期値へ（夫婦は夫＋妻の入力を使う）
    if (currentHousehold() === "single") $("flatPension").value = FLAT_PENSION_DEFAULT.single;
    resetCategories();
    render();
    track("change_household", { household: el.value });
  })
);
$("resetCat").addEventListener("click", () => { bumpChange(); resetCategories(); render(); track("reset_categories"); });
$("shareX").addEventListener("click", () => share("twitter"));
$("shareLine").addEventListener("click", () => share("line"));
$("shareFb").addEventListener("click", () => share("facebook"));
$("shareCopy").addEventListener("click", () => share("copy"));

// 目玉機能（比較チャート・感度分析）が実際に見られたかをスクロールで検知
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      if (e.target.id === "compareChart") compareUsed = true;
      if (e.target.id === "sensList") sensitivityUsed = true;
    });
  }, { threshold: 0.4 });
  ["compareChart", "sensList"].forEach((id) => { const el = $(id); if (el) io.observe(el); });
}

// 離脱時（タブ非表示/ページ破棄）に「最後に落ち着いた条件」を1回だけ送る
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") sendSimulationFinished("pagehide");
});
window.addEventListener("pagehide", () => sendSimulationFinished("pagehide"));

// フッターにバージョン表示（改善効果を版で比較できるよう可視化）
if ($("appVer")) $("appVer").textContent = "v" + APP_VERSION;

// 初期化（共有リンクで開かれた場合は状態を復元）
renderSpread();
if (!applyStateFromUrl()) resetCategories();
render();
