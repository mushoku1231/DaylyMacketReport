/**
 * 高度な市場データ取得＆投資シグナル判定スクリプト (修正版 v3.0)
 *
 * 主な修正点は末尾の「修正履歴」を参照。
 */

// ==========================================
// 設定値（ここだけ触ればルールを変更できる）
// ==========================================
const CONFIG = {
  AU: {
    // --- エントリー ---
    ENTRY_VIX_ABOVE: 30,        // VIXがこの値を超えたら逆張りエントリー
    USE_MA200_FILTER: false,    // true にすると「NDX終値 > 200日SMA」を追加条件にする
                                // ★true にしてはいけない。NDX実データ(1995-2026)で
                                //   VIX>30単独が x58.4 に対し、200日線併用は x1.9。
                                //   取引が83回から33回に減り、残った取引の質も落ちる。
                                //   パニックの底は定義上200日線の下で起きるため。
    // --- エグジット ---
    TP: 0.12,                   // 利確 (v3.5で +15% から変更)
    SL: -0.15,                  // 損切り (v3.5で -12% から変更)
    // ★廃止: 先行利確(+13.5%×先物急騰) と ソフト損切り(-10%×先物急落)。
    //   先物の予測が100%当たると仮定した検証でも成績が悪化したため
    //   （全期間 x3.88 → x3.16）。パニック局面は値幅が大きく、
    //   +13.5%で降りると利確の実現平均 +19.7% を取り逃がす。
    TIME_LIMIT_BDAYS: 20,       // 期限（営業日）。旧版の「30日」は暦日だった
    // --- 冷却期間（営業日）---
    COOLDOWN_TP: 3,
    COOLDOWN_SL: 5,
    COOLDOWN_TIME: 2,
    // --- 基準価額の妥当性チェック ---
    NAV_MIN: 1000,
    NAV_MAX: 100000,
    NAV_MAX_MOVE: 0.35,         // 前回取得値からこれ以上動いたらスクレイプ失敗とみなす
    // 基準価額が当日分に更新される時刻の目安。ページから日付を取得できなかった
    // 場合のフォールバック判定に使う。
    NAV_UPDATE_HOUR: 18
  },
  // NQ先物の変化率は P列に参考情報として出すのみ。判定には使わない。

  TRIGGER: {
    // 基準価額の公表は夕方以降のため、旧版の 12:30 では約定を検知できない。
    // 実際の公表時刻をログで確認し、必要ならここを調整すること。
    HOUR: 19,
    MINUTE: 30,
    RETRY_MINUTES: 60,          // 約定待ちなのに基準価額が未更新なら、この間隔で再確認
    MAX_RETRIES: 3
  },

  // 営業日計算から除外する休場日 (yyyy/MM/dd)。空のままなら土日のみ除外。
  HOLIDAYS: []
};

const SHEET_NAME = "MarketData_Strategy";
const SETTINGS_SHEET_NAME = "Settings_auPay";
const TZ = "Asia/Tokyo";

// ==========================================
// 日付ユーティリティ（営業日ベース／祝日は未対応）
// ==========================================
/**
 * ★v3.6: 何を渡されても Date に寄せる。
 * Utilities.formatDate は Date 以外を渡すと即例外になり、
 * どこから来た値かも分からないまま実行全体が止まるため。
 */
function toDate(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number" && isFinite(v)) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const p = parseDateStr(v);
    if (p) return p;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function fmtDate(d) {
  const dt = toDate(d);
  if (!dt) {
    // ★v3.7: 呼び出し元が分かるようスタックトレースも出す
    let where = "";
    try { where = "\n  呼び出し元:\n" + new Error().stack; } catch (e) {}
    Logger.log("fmtDate: 日付として解釈できない値を受け取りました → "
               + Object.prototype.toString.call(d) + " / " + d + where);
    return "";
  }
  return Utilities.formatDate(dt, TZ, "yyyy/MM/dd");
}

function parseDateStr(s) {
  if (!s) return null;
  if (s instanceof Date) return isNaN(s.getTime()) ? null : s;
  const parts = s.toString().trim().split(/[\/\-]/);
  if (parts.length !== 3) return null;
  const y = Number(parts[0]), m = Number(parts[1]), day = Number(parts[2]);
  if (!isFinite(y) || !isFinite(m) || !isFinite(day)) return null;
  const d = new Date(y, m - 1, day);
  return isNaN(d.getTime()) ? null : d;
}

function isBusinessDay(d) {
  const dt = toDate(d);
  if (!dt) return true;          // 判定できないときは営業日扱いにして止めない
  const w = dt.getDay();
  if (w === 0 || w === 6) return false;
  return CONFIG.HOLIDAYS.indexOf(fmtDate(dt)) === -1;
}

/** baseからn営業日後の日付文字列を返す */
function addBusinessDays(base, n) {
  const b = toDate(base);
  if (!b) {
    Logger.log("addBusinessDays: 基準日が不正のため本日から数えます → " + base);
    return addBusinessDays(new Date(), n);
  }
  const d = new Date(b.getTime());
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    if (isBusinessDay(d)) added++;
  }
  return fmtDate(d);
}

/** fromからtoまでの営業日数（from当日は0）。toがfromより前なら負値ではなく0 */
function businessDaysBetween(from, to) {
  const f = toDate(from), t = toDate(to);
  if (!f || !t || t <= f) return 0;
  const d = new Date(f.getTime());
  let count = 0;
  while (d < t) {
    d.setDate(d.getDate() + 1);
    if (isBusinessDay(d)) count++;
  }
  return count;
}

// ==========================================
// メイン
// ==========================================
function recordAdvancedMarketData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  // ★修正: todayStr を関数の先頭で定義（旧版は使用箇所より後で const 宣言していたため
  //          Lv2判定が走った瞬間に ReferenceError で全体が停止していた）
  const nowDate = new Date();
  const todayStr = fmtDate(nowDate);

  const tickers = {
    "S&P 500": "^GSPC",
    "Nifty 50": "^NSEI",
    "USD/JPY": "JPY=X",
    "VIX": "^VIX",
    "S&P 500 Futures": "ES=F",
    "NASDAQ 100 Futures": "NQ=F",
    "NASDAQ 100": "^NDX"
  };
  const columns = ["S&P 500", "Nifty 50", "USD/JPY", "VIX",
                   "S&P 500 Futures", "NASDAQ 100 Futures", "NASDAQ 100"];

  const headerRow = [
    "取得日時 (JST)",
    "S&P 500 現在値", "S&P 500 ATH",
    "S&P 500 Lv.1 (-5%)", "S&P 500 Lv.2 (-10%)", "S&P 500 Lv.3 (-20%)",
    "USD/JPY 現在値", "USD/JPY 200SMA", "為替フィルター",
    "VIX 現在値", "VIX 前日終値", "VIX 5日MA",
    "S&P 500 スポット判定",
    "Nifty 50 現在値", "Nifty 50 アクション",
    "NASDAQ先物 動向",
    "au PAY 新規投入判定",
    "auAMレバナス 基準価額",
    "au PAY 運用状況",
    "★au PAY 決済判定",
    "ACWX 現在値", "SPX/ACWX Ratio", "★覇権ステータス",
    "NDX 現在値", "NDX 200SMA", "基準価額 基準日", "S&P500 今サイクル最大DD"
  ];

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headerRow);
    sheet.getRange(1, 1, 1, headerRow.length).setFontWeight("bold").setBackground("#e6f2ff");
    sheet.setFrozenRows(1);
  } else {
    // ★修正: 列を追加したので、既存シートのヘッダーが短ければ書き直す
    const currentHeader = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (currentHeader.length !== headerRow.length
        || currentHeader.join("\u0001") !== headerRow.join("\u0001")) {
      sheet.getRange(1, 1, 1, headerRow.length).setValues([headerRow])
           .setFontWeight("bold").setBackground("#e6f2ff");
    }
  }

  // ------------------------------------------
  // 1. APIリクエストの生成
  // ------------------------------------------
  const rangeMap = {
    "S&P 500": { range: "max", interval: "1d" },
    "USD/JPY": { range: "2y", interval: "1d" },
    "VIX": { range: "1mo", interval: "1d" },
    "NASDAQ 100": { range: "2y", interval: "1d" },
    "S&P 500 Futures": { range: "1d", interval: "1m" },
    "NASDAQ 100 Futures": { range: "1d", interval: "1m" }
  };

  const requests = columns.map(key => {
    const cfg = rangeMap[key] || { range: "1d", interval: "1d" };
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tickers[key])}`
              + `?interval=${cfg.interval}&range=${cfg.range}`;
    return {
      url: url,
      method: "get",
      muteHttpExceptions: true,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    };
  });

  // ★修正: 基準価額は公式の履歴CSVを第一情報源にする。
  //         HTMLスクレイピングはレイアウト変更に弱く、実際に誤取得していたため。
  const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
  requests.push({
    url: "https://www.kddi-am.com/wp-content/themes/aufunds/csv/fund_nav_4003.csv",
    method: "get", muteHttpExceptions: true, headers: UA
  });
  requests.push({
    url: "https://www.kddi-am.com/funds/4003/",
    method: "get", muteHttpExceptions: true, headers: UA
  });

  const marketValues = {
    "S&P 500": { price: null, ath: null, closes: [] },
    "USD/JPY": { price: null, sma200: null },
    "VIX": { price: null, yday: null, ma5: null },
    "Nifty 50": { price: null },
    "S&P 500 Futures": { price: null, prevClose: null, changeRate: null },
    "NASDAQ 100 Futures": { price: null, prevClose: null, changeRate: null },
    "NASDAQ 100": { price: null, sma200: null },
    "ACWX": { price: null, closes: [] },
    "DXY": { price: null, closes: [], sma200: null }
  };

  const props = PropertiesService.getScriptProperties();
  let auRebanasPrice = null;
  let auNavHtml = null;
  let auNavDateRaw = '';
  const auLastPrice = parseFloat(props.getProperty('auPayLastPrice')) || null;

  // ------------------------------------------
  // 基準価額の取得
  // ★修正: 旧版の正規表現は「基準価額基準日（2026/07/31）16,520円」という
  //         実際のページ構造に対し、先に現れる西暦「2026」を拾ってしまい、
  //         妥当性チェックで棄却されて N/A になっていた。
  //         公式の履歴CSVを第一情報源にし、HTMLは構造に合わせ直した。
  // ------------------------------------------
  const validateNav = (val, checkMove) => {
    if (val === null || isNaN(val)) return null;
    if (val < CONFIG.AU.NAV_MIN || val > CONFIG.AU.NAV_MAX) {
      Logger.log(`基準価額の候補が範囲外のため棄却: ${val}`);
      return null;
    }
    // CSVは公式の一次情報なので乖離チェックを掛けない。
    // 掛けてしまうと、過去に誤った値がキャッシュされている場合、
    // 正しい値が永久に棄却され続ける。
    if (checkMove && auLastPrice !== null) {
      const move = Math.abs(val - auLastPrice) / auLastPrice;
      if (move > CONFIG.AU.NAV_MAX_MOVE) {
        Logger.log(`基準価額が前回値から${(move * 100).toFixed(1)}%乖離のため棄却: ${val}`);
        return null;
      }
    }
    return val;
  };

  /**
   * 公式CSV（日付,基準価額,分配金,分配金再投資基準価額,純資産総額）の最終行を読む。
   * 日付は yyyymmdd。ヘッダーがShift_JISのため、その指定で読む。
   */
  const parseNavCsv = (text) => {
    if (!text) return { price: null, date: '' };
    const lines = text.split(/\r?\n/).filter(l => /^\s*\d{8}\s*,/.test(l));
    if (lines.length === 0) return { price: null, date: '' };
    const cols = lines[lines.length - 1].split(',');
    const ymd = cols[0].trim();
    const price = validateNav(parseInt(cols[1].replace(/[^0-9]/g, ''), 10), false);
    const date = `${ymd.substr(0, 4)}/${ymd.substr(4, 2)}/${ymd.substr(6, 2)}`;
    return { price: price, date: price !== null ? date : '' };
  };

  /** HTMLから基準価額を拾う（CSVが取れなかったときの予備） */
  const extractPrice = (html) => {
    if (!html) return null;
    const t = html.replace(/<[^>]*>/g, ' ');
    // 「基準価額基準日（2026/07/31） 16,520円」の並びを想定
    let m = t.match(/基準価額基準日[\s\S]{0,60}?([0-9]{1,3},[0-9]{3})\s*円/);
    if (!m) m = t.match(/基準価額[\s\S]{0,150}?([0-9]{1,3},[0-9]{3})\s*円/);
    if (!m) m = t.match(/基準価額[\s\S]{0,150}?([0-9]{1,3},[0-9]{3})/);
    if (!m) return null;
    return validateNav(parseInt(m[1].replace(/,/g, ''), 10), true);
  };

  /** HTMLから基準日を拾う（CSVが取れなかったときの予備） */
  const extractNavDate = (html) => {
    if (!html) return '';
    const t = html.replace(/<[^>]*>/g, ' ');
    let m = t.match(/基準価額基準日[\s\S]{0,20}?(20\d{2})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
    if (!m) m = t.match(/基準日[\s\S]{0,20}?(20\d{2})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? '' : fmtDate(d);
  };

  // ------------------------------------------
  // 2. データ取得
  // ------------------------------------------
  try {
    const responses = UrlFetchApp.fetchAll(requests);

    for (let i = 0; i < columns.length; i++) {
      const key = columns[i];
      const response = responses[i];
      if (response.getResponseCode() !== 200) {
        Logger.log(`[${key}] HTTP ${response.getResponseCode()}`);
        continue;
      }
      try {
        const json = JSON.parse(response.getContentText());
        const result = json.chart.result[0];
        marketValues[key].price = result.meta.regularMarketPrice;

        if (key === "S&P 500") {
          const highs = (result.indicators.quote[0].high || []).filter(v => typeof v === 'number');
          if (highs.length > 0) {
            marketValues[key].ath = highs.reduce((max, v) => (v > max ? v : max), highs[0]);
          }
          marketValues[key].closes =
            (result.indicators.quote[0].close || []).filter(v => typeof v === 'number');

        } else if (key === "USD/JPY" || key === "NASDAQ 100") {
          const closes = (result.indicators.quote[0].close || []).filter(v => typeof v === 'number');
          if (closes.length > 0) {
            const period = Math.min(200, closes.length);
            const lastN = closes.slice(-period);
            marketValues[key].sma200 = lastN.reduce((a, b) => a + b, 0) / period;
            // ★修正: 200本に満たない場合は SMA を信用しない
            if (closes.length < 200) marketValues[key].sma200 = null;
          }

        } else if (key === "VIX") {
          const closes = (result.indicators.quote[0].close || []).filter(v => typeof v === 'number');
          if (closes.length >= 2) marketValues[key].yday = closes[closes.length - 2];
          if (closes.length >= 5) {
            marketValues[key].ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
          }

        } else if (key === "S&P 500 Futures" || key === "NASDAQ 100 Futures") {
          const m = result.meta;
          if (m.chartPreviousClose !== undefined && m.regularMarketPrice !== undefined) {
            marketValues[key].prevClose = m.chartPreviousClose;
            marketValues[key].price = m.regularMarketPrice;
            marketValues[key].changeRate =
              (m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose;
          }
        }
      } catch (e) {
        Logger.log(`[${key}] データ解析エラー: ${e.message}`);
      }
    }

    // 第一情報源: 公式の基準価額履歴CSV
    const csvResponse = responses[responses.length - 2];
    if (csvResponse.getResponseCode() === 200) {
      let csvText;
      try {
        csvText = csvResponse.getContentText("Shift_JIS");
      } catch (e) {
        csvText = csvResponse.getContentText();
      }
      const parsed = parseNavCsv(csvText);
      if (parsed.price !== null) {
        auRebanasPrice = parsed.price;
        auNavDateRaw = parsed.date;
        Logger.log(`CSVから取得: ${auRebanasPrice}円 (基準日 ${auNavDateRaw})`);
      } else {
        Logger.log("CSVの解析に失敗しました。");
      }
    }

    // 第二情報源: ファンドページのHTML
    const auResponse = responses[responses.length - 1];
    if (auRebanasPrice === null && auResponse.getResponseCode() === 200) {
      auNavHtml = auResponse.getContentText();
      auRebanasPrice = extractPrice(auNavHtml);
      if (auRebanasPrice !== null) {
        auNavDateRaw = extractNavDate(auNavHtml);
        Logger.log(`HTMLから取得: ${auRebanasPrice}円 (基準日 ${auNavDateRaw || "不明"})`);
      }
    }
  } catch (e) {
    Logger.log(`通信一括処理でエラー: ${e.message}`);
  }

  // フォールバック
  if (auRebanasPrice === null) {
    Logger.log("メイン取得先で失敗。フォールバックを実行します。");
    const fallbacks = [
      "https://finance.yahoo.co.jp/quote/AY311243",
      "https://www.nikkei.com/nkd/fund/?fcode=03314227"
    ];
    for (let i = 0; i < fallbacks.length; i++) {
      try {
        const res = UrlFetchApp.fetch(fallbacks[i], { muteHttpExceptions: true });
        if (res.getResponseCode() === 200) {
          const html = res.getContentText();
          auRebanasPrice = extractPrice(html);
          if (auRebanasPrice !== null) {
            auNavHtml = html;
            auNavDateRaw = extractNavDate(html);
            Logger.log(`フォールバック (${fallbacks[i]}) で取得成功: ${auRebanasPrice}円`);
            break;
          }
        }
      } catch (e) { /* 次へ */ }
    }
  }

  if (auRebanasPrice !== null) {
    props.setProperty('auPayLastPrice', auRebanasPrice.toString());
  }

  // 基準価額が「当日分に更新済みか」の判定。
  //   基準日が取れればそれを使い、取れなければ時刻で代用する。
  //   朝6時の実行時点の基準価額は前営業日分なので、これを見ないと
  //   約定単価を1日ずれて記録してしまう。
  const auNavDate = auRebanasPrice !== null ? auNavDateRaw : '';
  const navIsFresh = auNavDate
    ? (auNavDate === todayStr)
    : (nowDate.getHours() >= CONFIG.AU.NAV_UPDATE_HOUR);
  Logger.log(`基準価額: ${auRebanasPrice} / 日付: ${auNavDate || "取得不可"} / 当日分: ${navIsFresh}`);

  // ------------------------------------------
  // 3. 各種指標の算出
  // ------------------------------------------
  const spPrice = marketValues["S&P 500"].price;
  const spAth = marketValues["S&P 500"].ath;
  const ujPrice = marketValues["USD/JPY"].price;
  const ujSma = marketValues["USD/JPY"].sma200;
  const vixPrice = marketValues["VIX"].price;
  const vixYday = marketValues["VIX"].yday;
  const vixMa5 = marketValues["VIX"].ma5;
  const nfPrice = marketValues["Nifty 50"].price;
  const ndxPrice = marketValues["NASDAQ 100"].price;
  const ndxSma200 = marketValues["NASDAQ 100"].sma200;

  const nqFutChange = marketValues["NASDAQ 100 Futures"].changeRate;
  const nqFutChangeStr = nqFutChange !== null
    ? (nqFutChange > 0 ? "+" : "") + (nqFutChange * 100).toFixed(2) + "%"
    : "取得失敗";

  const spLv1 = spAth !== null ? spAth * 0.95 : null;
  const spLv2 = spAth !== null ? spAth * 0.90 : null;
  const spLv3 = spAth !== null ? spAth * 0.80 : null;

  // --- 為替フィルター ---
  let exchangeFilterText = "データ不足";
  if (ujPrice !== null && ujSma !== null) {
    const fxDev = (ujPrice / ujSma) - 1;
    if (fxDev >= 0.10)      exchangeFilterText = "通常25%・ヘッジ75% (極端な円安)";
    else if (fxDev >= 0.05) exchangeFilterText = "通常50%・ヘッジ50% (円安警戒)";
    else                    exchangeFilterText = "通常100% (通常水準)";
  }

  // ------------------------------------------
  // S&P 500 スポット投資ゲージ (v3.8で全面改修)
  //
  // 旧版はLv1/Lv2/Lv3のフラグを持つ状態機械だったが、
  // 「+2%反発かつ7日経過でLv2を全解除」する再武装が回数無制限に働き、
  // ATHを下回り続けるかぎり1〜2週間おきに買い判定を出し続けていた。
  // 検証(1999-2019, QQQ)では20年で402回、うち378回が再武装由来。
  //
  // S&P500は積立が基本で、判定はスポット投資の目安として使うため、
  // 売買シグナルではなく「今どれくらい深いか」を示すゲージに変更した。
  // 保有状態を持たないので、買ったかどうかをスクリプトが知る必要もない。
  // ------------------------------------------
  const vixCalm = vixPrice !== null && vixMa5 !== null
    && (vixPrice < 30) && (vixPrice < vixMa5);

  let dropRate = null;
  if (spPrice !== null && spAth !== null && spAth > 0) {
    dropRate = (spPrice - spAth) / spAth;
  }

  // ATH更新でサイクルをリセット
  const prevAth = parseFloat(props.getProperty('spPrevAth')) || 0;
  if (spAth !== null && spAth > prevAth) {
    props.setProperty('spPrevAth', spAth.toString());
    props.setProperty('spCycleMaxDrop', '0');
    // 旧版の未使用プロパティを掃除
    ['spLv1Bought', 'spLv2_10', 'spLv2_12', 'spLv2_14', 'spLv2_16', 'spLv2_18',
     'spLv2WaveBottom', 'spLv2LastActionDate', 'spLv3Bought']
      .forEach(k => props.deleteProperty(k));
  }

  // 今サイクルの最大ドローダウンを更新
  let prevMaxDrop = parseFloat(props.getProperty('spCycleMaxDrop'));
  if (isNaN(prevMaxDrop)) prevMaxDrop = 0;
  let cycleMaxDrop = prevMaxDrop;
  if (dropRate !== null && dropRate < cycleMaxDrop) {
    cycleMaxDrop = dropRate;
    props.setProperty('spCycleMaxDrop', cycleMaxDrop.toString());
  }

  // ★v3.9: -25/-30/-40% を追加。
  //   実データ(S&P500 1995-2026)では、-20%を一度踏むとゲージが飽和し、
  //   2002-2006年と2009-2012年は初到達イベントがゼロだった。
  //   2002年のS&P500は最大-49%まで落ちているのに無反応になる。
  const BANDS = [
    { th: -0.40, level: 10, label: "危機" },
    { th: -0.30, level: 9,  label: "極大" },
    { th: -0.25, level: 8,  label: "甚大" },
    { th: -0.20, level: 7,  label: "最大" },
    { th: -0.18, level: 6,  label: "特大" },
    { th: -0.16, level: 5,  label: "大" },
    { th: -0.14, level: 4,  label: "中〜大" },
    { th: -0.12, level: 3,  label: "中" },
    { th: -0.10, level: 2,  label: "小〜中" },
    { th: -0.05, level: 1,  label: "小" }
  ];

  let spAction = "データ不足";
  if (dropRate !== null) {
    let band = null;
    for (let i = 0; i < BANDS.length; i++) {
      if (dropRate <= BANDS[i].th) { band = BANDS[i]; break; }
    }
    const ddStr = `${(dropRate * 100).toFixed(1)}%`;
    if (!band) {
      spAction = `積立のみ (ATHから${ddStr} / スポット水準未達)`;
    } else {
      // 今サイクルで初めてこの水準に届いた日か
      let prevLevel = 0;
      for (let i = 0; i < BANDS.length; i++) {
        if (prevMaxDrop <= BANDS[i].th) { prevLevel = BANDS[i].level; break; }
      }
      const first = band.level > prevLevel;
      spAction = `スポット強度${band.level}/10 (${band.label}) `
               + `ATHから${ddStr}`
               + (first ? " ★本日この水準に初到達" : "")
               + ` / 今サイクル最安 ${(cycleMaxDrop * 100).toFixed(1)}%`
               + ` / ${vixCalm ? "VIX鎮静化" : "VIXまだ高止まり"}`;
    }
  }

  const nfAction = "完全静観";

  // ------------------------------------------
  // 覇権システム用データ (GoogleFinance合成)
  // ------------------------------------------
  const hegData = fetchHegemonyDataViaGoogle(ss);
  if (hegData) {
    marketValues["S&P 500"].closes = hegData.spx;
    marketValues["ACWX"].closes = hegData.acwx;
    marketValues["ACWX"].price = hegData.acwx[hegData.acwx.length - 1];
    marketValues["DXY"].closes = hegData.dxy;
    marketValues["DXY"].price = hegData.dxy[hegData.dxy.length - 1];
    if (hegData.dxy.length >= 200) {
      const last200 = hegData.dxy.slice(-200);
      marketValues["DXY"].sma200 = last200.reduce((a, b) => a + b, 0) / 200;
    }
    Logger.log(`GoogleFinance連携成功: SPX(${hegData.spx.length}) ACWX(${hegData.acwx.length}) DXY(${hegData.dxy.length})`);
  }

  let hegStatusText = "データ不足";
  let hegRatio = null;
  const spxCloses = marketValues["S&P 500"].closes || [];
  const acwxPrice = marketValues["ACWX"].price;
  const acwxCloses = marketValues["ACWX"].closes || [];
  const dxyPrice = marketValues["DXY"].price;
  const dxyCloses = marketValues["DXY"].closes || [];
  const dxySma200 = marketValues["DXY"].sma200;

  if (spxCloses.length >= 200 && acwxCloses.length >= 200 && dxyCloses.length >= 21
      && spPrice !== null && acwxPrice !== null && acwxPrice > 0 && dxyPrice !== null) {

    const hasDxySma = dxySma200 !== null;
    const spxSma200 = spxCloses.slice(-200).reduce((a, b) => a + b, 0) / 200;

    const ratioLen = Math.min(spxCloses.length, acwxCloses.length);
    const spxTail = spxCloses.slice(-ratioLen);
    const acwxTail = acwxCloses.slice(-ratioLen);
    const ratios = [];
    for (let i = 0; i < ratioLen; i++) {
      if (acwxTail[i] > 0) ratios.push(spxTail[i] / acwxTail[i]);
    }
    hegRatio = ratios.length > 0 ? ratios[ratios.length - 1] : null;

    let ratioSma50 = null, ratioSma200Val = null;
    if (ratios.length >= 200) {
      ratioSma50 = ratios.slice(-50).reduce((a, b) => a + b, 0) / 50;
      ratioSma200Val = ratios.slice(-200).reduce((a, b) => a + b, 0) / 200;
    }

    let roc20 = null, dxyZ = null;
    const dxyLen = dxyCloses.length;
    if (dxyLen >= 21) roc20 = (dxyCloses[dxyLen - 1] / dxyCloses[dxyLen - 21]) - 1;
    if (dxyLen >= 272) {
      const roc20Series = [];
      for (let i = 20; i < dxyLen; i++) roc20Series.push((dxyCloses[i] / dxyCloses[i - 20]) - 1);
      const recent252 = roc20Series.slice(-252);
      if (recent252.length > 1) {
        const avgRoc = recent252.reduce((a, b) => a + b, 0) / recent252.length;
        const stdRoc = Math.sqrt(recent252.reduce((a, b) => a + (b - avgRoc) ** 2, 0) / recent252.length);
        if (stdRoc > 0 && roc20 !== null) dxyZ = (roc20 - avgRoc) / stdRoc;
      }
    }

    const spxTrend = spPrice > spxSma200;
    let ratioTrend = props.getProperty('hegRatioTrend') === 'true';
    if (ratioSma50 !== null && ratioSma200Val !== null) {
      if (ratioSma50 > ratioSma200Val * 1.005) ratioTrend = true;
      if (ratioSma50 < ratioSma200Val * 0.995) ratioTrend = false;
    }
    props.setProperty('hegRatioTrend', ratioTrend.toString());

    const dxyTrend = hasDxySma ? (dxyPrice > dxySma200) : true;
    const dxySpike = (dxyZ !== null && dxyZ >= 2.0) || (roc20 !== null && roc20 >= 0.05);

    let rawStatus;
    if (!spxTrend && !ratioTrend)      rawStatus = (dxySpike || !dxyTrend) ? "HEGEMONY_RISK" : "HEGEMONY_WATCH";
    else if (!spxTrend && ratioTrend)  rawStatus = "BUY_OPPORTUNITY";
    else if (spxTrend && !ratioTrend)  rawStatus = "MILD_ROTATION";
    else                               rawStatus = "SAFE";

    const prevRaw = props.getProperty('hegRawStatus') || '';
    let rawCount = parseInt(props.getProperty('hegRawCount')) || 0;
    const lastRawDate = props.getProperty('hegLastRawDate') || '';
    if (rawStatus === prevRaw) {
      if (todayStr !== lastRawDate) {
        rawCount++;
        props.setProperty('hegLastRawDate', todayStr);
      }
    } else {
      rawCount = 1;
      props.setProperty('hegRawStatus', rawStatus);
      props.setProperty('hegLastRawDate', todayStr);
    }
    props.setProperty('hegRawCount', rawCount.toString());

    let confirmedStatus = props.getProperty('hegConfirmedStatus') || 'SAFE';
    if (rawCount >= 5 && rawStatus !== confirmedStatus) {
      props.setProperty('hegPrevConfirmed', confirmedStatus);
      confirmedStatus = rawStatus;
      props.setProperty('hegConfirmedStatus', confirmedStatus);
      props.setProperty('hegConfirmedDate', todayStr);
    }

    const prevConfirmed = props.getProperty('hegPrevConfirmed') || 'SAFE';
    const wasInDanger = (prevConfirmed === 'HEGEMONY_RISK' || prevConfirmed === 'HEGEMONY_WATCH');
    if (wasInDanger && (confirmedStatus === 'SAFE' || confirmedStatus === 'BUY_OPPORTUNITY')) {
      const confirmedDate = parseDateStr(props.getProperty('hegConfirmedDate') || '');
      const daysInNew = confirmedDate
        ? Math.floor((nowDate - confirmedDate) / (1000 * 60 * 60 * 24)) : 0;
      const requiredDays = confirmedStatus === 'SAFE' ? 60 : 20;
      const ratioMax252 = ratios.length >= 252
        ? Math.max.apply(null, ratios.slice(-252))
        : Math.max.apply(null, ratios);
      const ratioRecovery = hegRatio !== null && hegRatio >= ratioMax252 * 0.95;
      if (daysInNew < requiredDays || !ratioRecovery) confirmedStatus = "RECOVERY_PENDING";
    }

    const statusIcons = {
      "SAFE": "✅", "MILD_ROTATION": "🔄", "BUY_OPPORTUNITY": "📉",
      "HEGEMONY_WATCH": "⚠️", "HEGEMONY_RISK": "🚨", "RECOVERY_PENDING": "🔃"
    };
    hegStatusText = `${statusIcons[confirmedStatus] || "❓"} ${confirmedStatus} (Raw: ${rawStatus} ${rawCount}日目)`;
  } else {
    hegStatusText = `データ不足 (SPX:${spxCloses.length} ACWX:${acwxCloses.length} DXY:${dxyCloses.length})`;
  }

  // ==========================================
  // au PAY ポイント運用：状態遷移
  // ★修正: 1回の実行で複数状態を通過しないよう else if で分離
  // ==========================================
  let auState = props.getProperty('auPayState') || 'WAITING';
  const auOrderDate = props.getProperty('auPayOrderDate') || '';
  const auOrderNav = parseFloat(props.getProperty('auPayOrderNav'));
  const auPurchasePrice = parseFloat(props.getProperty('auPayPurchasePrice'));
  const auPurchaseDate = props.getProperty('auPayPurchaseDate') || '';
  const auCooldownUntil = props.getProperty('auPayCooldownUntil') || '';

  let auEntryAction = "-";
  let auStatusText = "-";
  let auSettlementAction = "-";

  const closePosition = (label, cooldownBDays) => {
    auSettlementAction = label;
    props.setProperty('auPayState', 'WAITING');
    props.setProperty('auPayCooldownUntil', addBusinessDays(nowDate, cooldownBDays));
    ['auPayOrderDate', 'auPayOrderNav', 'auPayPurchasePrice', 'auPayPurchaseDate']
      .forEach(k => props.deleteProperty(k));
    auState = 'WAITING';
  };

  if (vixPrice === null || auRebanasPrice === null) {
    auEntryAction = "データ不足";
    auStatusText = `データ不足 (VIX:${vixPrice} 基準価額:${auRebanasPrice})`;
    auSettlementAction = "データ不足";

  } else if (auState === 'WAITING') {
    auStatusText = "待機中 (保有ゼロ)";
    auSettlementAction = "未保有";

    const ma200Pass = !CONFIG.AU.USE_MA200_FILTER
      || (ndxPrice !== null && ndxSma200 !== null && ndxPrice > ndxSma200);

    if (auCooldownUntil !== "" && todayStr <= auCooldownUntil) {
      auEntryAction = `待機 (冷却・警戒期間中 / ${auCooldownUntil}まで)`;
    } else if (vixPrice <= CONFIG.AU.ENTRY_VIX_ABOVE) {
      auEntryAction = `待機 (VIX${CONFIG.AU.ENTRY_VIX_ABOVE}以下 / パニック待ち)`;
    } else if (!ma200Pass) {
      auEntryAction = `待機 (VIX条件成立だが200日線割れ NDX=${ndxPrice} SMA=${ndxSma200 ? ndxSma200.toFixed(0) : "N/A"})`;
    } else {
      // フィルタが無効でも、200日線との位置関係は記録に残す。
      // 後から「200日線割れでの逆張りが実際どうだったか」を検証できるようにするため。
      let maNote = "200日線: 不明";
      if (ndxPrice !== null && ndxSma200 !== null) {
        maNote = ndxPrice > ndxSma200 ? "200日線: 上" : "200日線: 下";
      }
      auEntryAction = `★全額投入 (VIX${CONFIG.AU.ENTRY_VIX_ABOVE}超え逆張り / ${maNote}) → 注文実行`;
      props.setProperty('auPayState', 'ORDERED');
      props.setProperty('auPayOrderDate', todayStr);
      props.setProperty('auPayOrderNav', auRebanasPrice.toString());
      auState = 'ORDERED';
      auStatusText = "本日発注 (約定は翌営業日)";
    }

  } else if (auState === 'ORDERED') {
    auEntryAction = "注文処理中 (追加投入なし)";
    // ★修正: 約定とみなす条件を「当日分に更新された基準価額」に限定した。
    //         朝6時の実行では基準価額が前営業日分のため、この判定を入れないと
    //         約定単価を1日前の値で記録してしまう。
    const navMoved = isNaN(auOrderNav) ? true : (auRebanasPrice !== auOrderNav);
    const navAfterOrder = auNavDate ? (auNavDate > auOrderDate) : (todayStr > auOrderDate);
    if (auOrderDate !== '' && navIsFresh && navAfterOrder && navMoved) {
      props.setProperty('auPayState', 'HOLDING');
      props.setProperty('auPayPurchasePrice', auRebanasPrice.toString());
      props.setProperty('auPayPurchaseDate', auNavDate || todayStr);
      auState = 'HOLDING';
      auStatusText = `本日約定 (単価: ${auRebanasPrice}円 / 基準日: ${auNavDate || todayStr})`;
      auSettlementAction = "保有開始";
    } else {
      auStatusText = `発注済・約定待ち (発注日: ${auOrderDate} / 基準価額: ${auNavDate || "日付不明"})`;
      auSettlementAction = "未保有";
    }

  } else if (auState === 'HOLDING') {
    auEntryAction = "運用中 (追加投入なし)";

    if (isNaN(auPurchasePrice) || auPurchasePrice <= 0) {
      // ★修正: 状態が壊れている場合に 0除算・NaN を出さず、明示的に警告する
      auStatusText = "エラー: 取得単価が未設定です。メニューから手動補正してください";
      auSettlementAction = "判定不能";
    } else {
      const profitLossRate = (auRebanasPrice - auPurchasePrice) / auPurchasePrice;
      const pDate = parseDateStr(auPurchaseDate);
      const heldBDays = businessDaysBetween(pDate, nowDate);
      const plStr = `${profitLossRate >= 0 ? "+" : ""}${(profitLossRate * 100).toFixed(1)}%`;
      auStatusText = `単価: ${auPurchasePrice}円 | 損益: ${plStr} | 経過: ${heldBDays}営業日`
                   + (navIsFresh ? "" : " ※前営業日の基準価額");

      // ★修正: 決済判定も当日分の基準価額が出てから行う。
      //         前営業日の値で決済すると、1日古い損益で手仕舞いすることになる。
      if (!navIsFresh) {
        auSettlementAction = "判定待ち (基準価額が未更新)";
      } else if (profitLossRate >= CONFIG.AU.TP) {
        closePosition(`★利確実行 (損益: ${plStr})`, CONFIG.AU.COOLDOWN_TP);
      } else if (profitLossRate <= CONFIG.AU.SL) {
        closePosition(`★損切り実行 (損益: ${plStr})`, CONFIG.AU.COOLDOWN_SL);
      } else if (heldBDays >= CONFIG.AU.TIME_LIMIT_BDAYS) {
        closePosition(`★期限切れ決済 (経過: ${heldBDays}営業日)`, CONFIG.AU.COOLDOWN_TIME);
      } else {
        auSettlementAction = "保有継続";
      }
    }

  } else {
    auEntryAction = `不正な状態: ${auState}`;
    auStatusText = "メニューから状態をリセットしてください";
    auSettlementAction = "判定不能";
  }

  // ------------------------------------------
  // 4. シート出力
  // ------------------------------------------
  const now = Utilities.formatDate(nowDate, TZ, "yyyy/MM/dd HH:mm:ss");
  const formatNum = (val, decimals = 2) => {
    if (val === null || val === undefined || isNaN(val)) return "N/A";
    const factor = Math.pow(10, decimals);
    return Math.round(val * factor) / factor;
  };

  const rowData = [
    now,
    formatNum(spPrice), formatNum(spAth),
    formatNum(spLv1), formatNum(spLv2), formatNum(spLv3),
    formatNum(ujPrice, 3), formatNum(ujSma, 3), exchangeFilterText,
    formatNum(vixPrice), formatNum(vixYday), formatNum(vixMa5),
    spAction,
    formatNum(nfPrice), nfAction,
    nqFutChangeStr,
    auEntryAction,
    auRebanasPrice !== null ? auRebanasPrice : "N/A",
    auStatusText,
    auSettlementAction,
    formatNum(acwxPrice),
    hegRatio !== null ? formatNum(hegRatio, 4) : "N/A",
    hegStatusText,
    formatNum(ndxPrice), formatNum(ndxSma200),
    auNavDate || "不明",
    dropRate !== null ? `${(cycleMaxDrop*100).toFixed(1)}%` : "N/A"
  ];

  sheet.appendRow(rowData);

  // 最新行のみ別スプレッドシートへエクスポート
  try {
    exportLatestRow(ss, headerRow, rowData);
  } catch (e) {
    Logger.log("最新行エクスポート処理でエラー: " + e.message);
  }

  deleteDoneTriggers();
  scheduleNextRun(auState, navIsFresh, props);
}

// ==========================================
// 最新行のエクスポート
// ==========================================
function exportLatestRow(ss, headerRow, rowData) {
  const exportFileName = "日時マーケット指数最新";
  const driveFile = DriveApp.getFileById(ss.getId());
  const parents = driveFile.getParents();
  const parentFolder = parents.hasNext() ? parents.next() : null;

  const query = `title = '${exportFileName}' and mimeType = '${MimeType.GOOGLE_SHEETS}'`;
  const files = parentFolder ? parentFolder.searchFiles(query) : DriveApp.searchFiles(query);

  let exportSs;
  if (files.hasNext()) {
    exportSs = SpreadsheetApp.openById(files.next().getId());
  } else {
    exportSs = SpreadsheetApp.create(exportFileName);
    if (parentFolder) DriveApp.getFileById(exportSs.getId()).moveTo(parentFolder);
  }

  const exportSheet = exportSs.getSheets()[0];
  exportSheet.clear();
  exportSheet.getRange(1, 1, 1, headerRow.length).setValues([headerRow]);
  exportSheet.getRange(2, 1, 1, rowData.length).setValues([rowData]);
}

// ==========================================
// 状態の強制リセット
// ==========================================
function resetAuPayState() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('auPayState', 'WAITING');
  ['auPayOrderDate', 'auPayOrderNav', 'auPayPurchasePrice',
   'auPayPurchaseDate', 'auPayCooldownUntil', 'auPayLastPrice']
     .forEach(k => props.deleteProperty(k));
  Logger.log("au PAY ポイント運用の状態を「待機中（保有ゼロ）」にリセットしました。");
}

// ==========================================
// トリガー管理
// ==========================================
/**
 * 次回の使い捨てトリガーを設定する。
 *  - 設定時刻（既定19:30）より前なら、その時刻にセット
 *  - 既に過ぎており、かつ約定待ち(ORDERED)なら、一定間隔で再確認をセット
 *  - それ以外は何もしない（翌朝の定期トリガーに任せる）
 */
function scheduleNextRun(auState, navIsFresh, props) {
  const now = new Date();
  const target = new Date();
  target.setHours(CONFIG.TRIGGER.HOUR, CONFIG.TRIGGER.MINUTE, 0, 0);

  let next = null;
  const retries = parseInt(props.getProperty('navRetryCount')) || 0;
  const needsFreshNav = (auState === 'ORDERED' || auState === 'HOLDING') && !navIsFresh;

  if (now < target) {
    next = target;
    props.setProperty('navRetryCount', '0');
  } else if (needsFreshNav && retries < CONFIG.TRIGGER.MAX_RETRIES) {
    // 建玉があるのに基準価額がまだ当日分でない。公表遅れの可能性があるため再確認する。
    next = new Date(now.getTime() + CONFIG.TRIGGER.RETRY_MINUTES * 60 * 1000);
    props.setProperty('navRetryCount', (retries + 1).toString());
    Logger.log(`基準価額の更新待ち。${CONFIG.TRIGGER.RETRY_MINUTES}分後に再確認します (${retries + 1}/${CONFIG.TRIGGER.MAX_RETRIES})`);
  } else {
    props.setProperty('navRetryCount', '0');
    Logger.log("本日の追加実行はありません。");
    return;
  }

  const newTrigger = ScriptApp.newTrigger("recordAdvancedMarketData")
    .timeBased().at(next).create();
  props.setProperty('tempTriggerId', newTrigger.getUniqueId());
  Logger.log(`次回実行を ${Utilities.formatDate(next, TZ, "yyyy/MM/dd HH:mm")} にセットしました。`);
}

function deleteDoneTriggers() {
  const props = PropertiesService.getScriptProperties();
  // 旧キー(temp1230TriggerId)も掃除対象に含める
  const ids = ['tempTriggerId', 'temp1230TriggerId']
    .map(k => ({ key: k, id: props.getProperty(k) }))
    .filter(o => o.id);
  if (ids.length === 0) return;

  const triggers = ScriptApp.getProjectTriggers();
  ids.forEach(o => {
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getUniqueId() === o.id) {
        ScriptApp.deleteTrigger(triggers[i]);
        break;
      }
    }
    props.deleteProperty(o.key);
  });
}

// ==========================================
// UI・手動設定管理
// ==========================================
function onOpen(e) {
  SpreadsheetApp.getUi().createMenu('🤖 au自動運用ツール')
    .addItem('1. 現在の設定(約定日・ステータス)をシートに読込', 'loadAuPaySettingsToSheet')
    .addItem('2. シートの値をシステムに強制上書き', 'saveAuPaySettingsFromSheet')
    .addItem('3. 状態を強制リセット (保有ゼロに戻す)', 'resetAuPayState')
    .addToUi();
}

const AU_SETTING_KEYS = [
  ["auPayState", "WAITING(待機), ORDERED(注文中), HOLDING(保有中)"],
  ["auPayOrderDate", "注文日 (yyyy/MM/dd形式)"],
  ["auPayOrderNav", "発注時点の基準価額 (数字のみ)"],
  ["auPayPurchasePrice", "約定単価 (数字のみ)"],
  ["auPayPurchaseDate", "約定日 (yyyy/MM/dd形式)"],
  ["auPayCooldownUntil", "クールダウン解除日 (yyyy/MM/dd形式)"],
  ["auPayLastPrice", "直近で取得した基準価額 (参考用)"]
];

function loadAuPaySettingsToSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SETTINGS_SHEET_NAME);
  sheet.clear();

  const props = PropertiesService.getScriptProperties();
  const data = [["設定項目", "現在の値 (ここを書き換えてください)", "説明"]];
  AU_SETTING_KEYS.forEach(([key, desc]) => {
    data.push([key, props.getProperty(key) || '', desc]);
  });

  sheet.getRange(1, 1, data.length, 3).setValues(data);
  sheet.getRange(1, 1, 1, 3).setFontWeight("bold").setBackground("#ffd966");
  // ★修正: 日付が自動変換されないよう、値の列を書式なしテキストにする
  sheet.getRange(2, 2, data.length - 1, 1).setNumberFormat("@");
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 250);
  sheet.setColumnWidth(3, 400);

  SpreadsheetApp.getUi().alert(
    `設定の読み込みが完了しました。\n「${SETTINGS_SHEET_NAME}」シートの B列 を必要に応じて書き換え、\nメニューから上書きを実行してください。`);
}

function saveAuPaySettingsFromSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('エラー：設定シートが見つかりません。先に読込を実行してください。');
    return;
  }
  // ★修正: 行数を固定値6から実データ長に変更（項目追加で取りこぼしていた）
  const data = sheet.getRange(2, 1, AU_SETTING_KEYS.length, 2).getValues();
  const props = PropertiesService.getScriptProperties();

  for (let i = 0; i < data.length; i++) {
    const key = data[i][0];
    const value = data[i][1];
    if (!key) continue;
    if (value === "" || value === null || value === undefined) {
      props.deleteProperty(key);
    } else {
      const strValue = (value instanceof Date)
        ? Utilities.formatDate(value, TZ, "yyyy/MM/dd")
        : value.toString().trim();
      props.setProperty(key, strValue);
    }
  }
  SpreadsheetApp.getUi().alert('システム値の強制上書きが完了しました。\n次回実行時よりこの値が損益計算に利用されます。');
}

// ==========================================
// GoogleFinance連携・覇権指標算出
// ==========================================
function fetchHegemonyDataViaGoogle(ss) {
  let sheet = ss.getSheetByName("Hegemony_Data");
  if (!sheet) {
    sheet = ss.insertSheet("Hegemony_Data");
    sheet.hideSheet();
  }

  const symbols = [
    { key: "SPX", ticker: "INDEXSP:.INX" },
    { key: "ACWX", ticker: "ACWX" },
    { key: "EURUSD", ticker: "CURRENCY:EURUSD" },
    { key: "USDJPY", ticker: "CURRENCY:USDJPY" },
    { key: "GBPUSD", ticker: "CURRENCY:GBPUSD" },
    { key: "USDCAD", ticker: "CURRENCY:USDCAD" },
    { key: "USDSEK", ticker: "CURRENCY:USDSEK" },
    { key: "USDCHF", ticker: "CURRENCY:USDCHF" }
  ];

  const firstCell = sheet.getRange("A1").getValue();
  if (!firstCell || firstCell.toString().indexOf("Date") === -1) {
    symbols.forEach((s, i) => {
      sheet.getRange(1, i * 2 + 1)
           .setFormula(`=GOOGLEFINANCE("${s.ticker}", "price", TODAY()-500, TODAY())`);
    });
    SpreadsheetApp.flush();
    Utilities.sleep(5000);
  }

  const rawData = sheet.getDataRange().getValues();
  if (rawData.length < 2) return null;

  const dataMap = {};
  symbols.forEach((s, idx) => {
    const colIdx = idx * 2;
    dataMap[s.key] = {};
    for (let r = 1; r < rawData.length; r++) {
      const date = rawData[r][colIdx];
      const price = rawData[r][colIdx + 1];
      if (date instanceof Date && typeof price === "number") {
        dataMap[s.key][Utilities.formatDate(date, "GMT", "yyyy-MM-dd")] = price;
      }
    }
  });

  if (!dataMap["EURUSD"]) return null;
  const dates = Object.keys(dataMap["EURUSD"]).sort();
  const result = { spx: [], acwx: [], dxy: [] };

  dates.forEach(d => {
    const e = dataMap["EURUSD"][d], j = dataMap["USDJPY"][d], g = dataMap["GBPUSD"][d];
    const c = dataMap["USDCAD"][d], s = dataMap["USDSEK"][d], f = dataMap["USDCHF"][d];
    const sp = dataMap["SPX"][d], ac = dataMap["ACWX"][d];

    if (e && j && g && c && s && f) {
      const dxy = 50.14348112
        * Math.pow(e, -0.576) * Math.pow(j, 0.136) * Math.pow(g, -0.119)
        * Math.pow(c, 0.091) * Math.pow(s, 0.042) * Math.pow(f, 0.036);
      result.dxy.push(dxy);

      if (sp) result.spx.push(sp);
      else if (result.spx.length > 0) result.spx.push(result.spx[result.spx.length - 1]);

      if (ac) result.acwx.push(ac);
      else if (result.acwx.length > 0) result.acwx.push(result.acwx[result.acwx.length - 1]);
    }
  });

  return (result.spx.length > 0 && result.dxy.length > 0) ? result : null;
}

/**
 * ==========================================
 * 修正履歴 (v3.0)
 * ==========================================
 * [致命的]
 *  1. todayStr が使用箇所より後で const 宣言されており、S&P 500 の Lv2 判定に
 *     入った瞬間に ReferenceError で関数全体が停止していた。関数先頭へ移動。
 *  2. au PAY の状態遷移が if の連続だったため、1回の実行で
 *     WAITING → ORDERED → HOLDING と一気に進み、発注当日の基準価額で
 *     約定したことにされていた。else if に分離し、約定判定を
 *     「発注日より後の日付」かつ「発注時点の基準価額から変化」に変更。
 *  3. 約定判定に使っていた isPriceUpdated は前回取得値との比較だったため、
 *     1日に複数回実行すると2回目以降は常に false になり約定を取り逃していた。
 *     発注時点の基準価額 auPayOrderNav を別途保存する方式へ変更。
 *
 * [ロジック]
 *  4. 保有日数・冷却期間が暦日だったのを営業日に変更（祝日は未対応）。
 *     期限は「30暦日」から「20営業日」に読み替えた。
 *  5. new Date("yyyy/MM/dd") の暗黙パースをやめ、parseDateStr で明示的に解釈。
 *  6. 取得単価が未設定のまま HOLDING になっている場合に NaN を出さず警告する。
 *  7. USD/JPY と NDX の 200SMA は、データが200本未満なら null にして誤判定を防ぐ。
 *
 * [データ取得]
 *  8. 基準価額のスクレイピングに妥当性チェックを追加（範囲外・前回比35%超の
 *     乖離は棄却）。正規表現もカンマなし表記に対応。
 *  9. NDX (^NDX) を取得対象に追加し、200日SMAを算出。CONFIG.AU.USE_MA200_FILTER
 *     を true にするとエントリー条件に加わる。既定は false。
 *
 * [保守性]
 * 10. 閾値をすべて CONFIG に集約。
 * 11. 設定シートの読み書きを AU_SETTING_KEYS 駆動に変更（項目追加時の
 *     取りこぼしを防止）。値の列は書式なしテキストに固定。
 * 12. 未使用だった NQ_FUT_BUY_DIP_THRESHOLD を削除。
 * 13. 既存シートのヘッダーが古い場合、列追加に合わせて自動で書き直す。
 *
 * ==========================================
 * 修正履歴 (v3.1)
 * ==========================================
 * 14. 時限トリガーを 12:30 固定から CONFIG.TRIGGER（既定19:30）へ変更。
 *     基準価額の公表は夕方以降のため、12:30 では発注翌日の約定を
 *     その日のうちに検知できなかった。
 * 15. 約定待ち(ORDERED)のまま基準価額が未更新の場合、60分間隔で最大3回
 *     再確認するトリガーを自動でセットする。公表が遅れた日でも当日中に
 *     約定を拾える。それ以外の状態では追加実行しない。
 * 16. 営業日計算に CONFIG.HOLIDAYS を追加。休場日を列挙すれば、保有日数と
 *     冷却期間の計算から除外される（既定は空＝土日のみ除外）。
 * 17. エントリー時に NDX と200日SMAの位置関係を判定文へ記録するようにした。
 *     USE_MA200_FILTER は既定 false のままで挙動は変えず、
 *     「200日線割れでの逆張りが実際どうだったか」を後から検証できるようにする。
 * 18. 使い捨てトリガーの管理キーを tempTriggerId に統一（旧キーも掃除する）。
 *     実体のなかった cleanupOrphanTriggers を削除。
 *
 * ==========================================
 * 修正履歴 (v3.2) — 朝6時の定期実行を前提とした整合
 * ==========================================
 * 19. 基準価額の「基準日」をページから抽出する extractNavDate を追加。
 *     取得できない場合は CONFIG.AU.NAV_UPDATE_HOUR (既定18時) で代用する。
 * 20. 朝6時の実行時点では基準価額が前営業日分のため、そのまま約定判定に使うと
 *     約定単価を1日ずれて記録していた。約定判定を「当日分の基準価額が
 *     公表済み」の場合に限定し、約定日も基準日で記録するよう変更。
 * 21. 決済判定も同様に当日分の基準価額が出てから行う。未更新のときは
 *     「判定待ち (基準価額が未更新)」と表示し、損益は参考値として出す。
 * 22. 建玉があるのに基準価額が当日分でない場合、ORDERED だけでなく HOLDING でも
 *     再確認トリガーをセットするよう scheduleNextRun を変更。
 * 23. 出力に「基準価額 基準日」列を追加。ズレの検証に使う。
 *
 * ==========================================
 * 修正履歴 (v3.3) — R/T/Z列が取得できない問題の修正
 * ==========================================
 * 24. [原因] v3.0で正規表現に「カンマなし4〜6桁」の選択肢を足したことで、
 *     「基準価額基準日（2026/07/31）16,520円」の並びに対し、先に現れる
 *     西暦の 2026 を基準価額として拾っていた。2026 は前回値から大きく
 *     乖離するため妥当性チェックで棄却され、R列が N/A になっていた。
 *     連鎖して S/T列（運用状況・決済判定）が「データ不足」、
 *     Z列（基準日）が「不明」になっていた。
 * 25. 基準価額の第一情報源を公式の履歴CSVに変更した。
 *     https://www.kddi-am.com/wp-content/themes/aufunds/csv/fund_nav_4003.csv
 *     日付(yyyymmdd)と基準価額を最終行から読む。Shift_JISで読み込む。
 *     HTMLスクレイピングは第二情報源として残し、実際の並びに合わせて修正。
 * 26. CSVは一次情報なので前回値との乖離チェックを掛けない。掛けると、
 *     誤った値がキャッシュされている間、正しい値が永久に棄却され続ける。
 * 27. resetAuPayState で auPayLastPrice も消すようにした。
 *     誤ってキャッシュされた値を手動で捨てられるようにするため。
 *
 * ==========================================
 * 修正履歴 (v3.4) — VIX>30ルールの検証結果を反映
 * ==========================================
 * 28. 先行利確(+13.5%×NQ先物+1%)とソフト損切り(-10%×NQ先物-0.7%)を廃止。
 *     QQQ+VIX実データ(1999/3-2019/10)で稼働中ルールを検証したところ、
 *     先物の予測が100%当たると仮定した上限ケースでも成績が悪化した
 *     (全期間 x3.88 → x3.16)。パニック局面は値幅が大きく、+13.5%で
 *     降りると利確の実現平均 +19.7% を取り逃がすため。
 *     NQ先物の変化率は P列に参考情報として残す。
 * 29. VIX>30 の閾値は変更しない。25では x0.77、35では x0.86 と
 *     いずれも悪化し、30が良い位置にあることが確認できたため。
 *
 * ==========================================
 * 修正履歴 (v3.5) — 全期間のデータを揃えた上でのパラメータ最適化
 * ==========================================
 * 30. 利確を +15% から +12% へ、損切りを -12% から -15% へ変更。
 *     手順: 1999-2019 を調整区間として360通りを探索し、
 *     2020-2022 と 2024-2026(実ファンド基準価額) を検証区間として
 *     一度だけ評価した。
 *
 *     現行 +15%/-12%   1999-2019 x5.30 Calmar0.18 / 2020-2022 +67.5% / 2024-2026 +81.3%
 *     推奨 +12%/-15%   1999-2019 x14.05 Calmar0.30 / 2020-2022 +134.0% / 2024-2026 +67.4%
 *
 *     利確 8〜12% × 損切り -12〜-18% の範囲はどこを取っても同水準で、
 *     単独の尖った最適値ではない(=過学習の可能性が低い)。
 *     利確を +15% 以上に広げると 2020-2022 が急激に悪化する。
 * 31. VIX>30、期限20営業日、冷却3/5/2日はいずれも変更なし。
 *     VIX閾値は全180通りの中央値で30が最良(Calmar 0.153、
 *     28は0.058、32は0.084)。期限は10日だけが明確に劣り、20と30は同等。
 *
 * ==========================================
 * 修正履歴 (v3.6) — fmtDate の例外対策
 * ==========================================
 * 32. Utilities.formatDate は Date 以外を渡すと
 *     「Invalid argument: date」で即例外になり、実行全体が停止していた。
 *     toDate() を追加し、Date / 数値 / 文字列のいずれでも Date に寄せる。
 *     解釈できない場合は例外ではなく空文字を返し、受け取った値を
 *     ログに出す。原因の特定は実行ログの「fmtDate:」行を参照すること。
 * 33. isBusinessDay / addBusinessDays / businessDaysBetween も同様に
 *     不正な引数で止まらないようにした。判定不能な日は営業日扱いとし、
 *     基準日が不正な場合は本日から数える。
 * 34. parseDateStr が Date オブジェクトをそのまま受け取れるようにした。
 *     設定シートの B列が日付型セルになっていると、プロパティに
 *     Date が入ることがあるため。
 *
 * ==========================================
 * 修正履歴 (v3.7)
 * ==========================================
 * 35. fmtDate が値を解釈できなかったとき、スタックトレースも記録する。
 *     v3.6 のログでは undefined を受け取ったことは分かったが、
 *     どの呼び出し元から来たのかが特定できなかったため。
 *
 * ==========================================
 * 修正履歴 (v3.8) — S&P500をスポット投資ゲージへ変更
 * ==========================================
 * 36. Lv1/Lv2/Lv3のフラグ管理と再武装ロジックを全廃した。
 *     旧実装は「+2%反発かつ7日経過でLv2の5段階を全解除」を
 *     回数無制限に繰り返すため、ATHを下回り続けるかぎり
 *     1〜2週間おきに買い判定を出し続けていた。
 *     検証(1999-2019, QQQで代用)では20年で402回の購入判定が出て、
 *     うち378回が再武装由来。購入時ドローダウンの中央値は-59%だった。
 *     再武装を止めた場合は30回で、購入後6ヶ月の平均は+0.5%から
 *     +14.9%へ改善した。
 * 37. S&P500は積立が基本でスポット投資の目安として使うため、
 *     売買シグナルではなく「今どれくらい深いか」を示すゲージにした。
 *     M列は ★購入判定 から スポット判定 に変更。
 *     スポット強度1〜7(-5/-10/-12/-14/-16/-18/-20%)と、
 *     今サイクルの最安値、VIXが鎮静化しているかを併記する。
 *     ★は「本日この水準に初到達」した日だけ付く。
 * 38. VIXフィルタは判定を止める条件から外し、表示に変更した。
 *     到達ベースの検証ではフィルタの有無で購入後6ヶ月が
 *     +14.3%対+13.4%とほぼ差がなく、機会だけが31回から44回へ
 *     減っていたため。パニックの最中かどうかは自分で判断できる。
 * 39. 出力に「S&P500 今サイクル最大DD」列を追加。
 * 40. ヘッダーは長さだけでなく内容が変わった場合も自動で書き直す。
 *
 * ==========================================
 * 修正履歴 (v3.9) — 実データ(1995-2026)での再検証を反映
 * ==========================================
 * 41. スポットゲージに -25/-30/-40% のバンドを追加し、強度を1〜10に拡張。
 *     S&P500実データでは -20% を一度踏むとゲージが飽和し、
 *     2002-2006年と2009-2012年は初到達イベントがゼロだった。
 *     2002年は最大 -49% まで落ちているのに無反応。
 *     追加後の到達回数は69回→77回。到達後6ヶ月の平均は
 *     +8.4%→+7.5% とほぼ変わらず、成績は落とさずに沈黙が消える。
 * 42. USE_MA200_FILTER のコメントに実測値を追記した。
 *
 * ==========================================
 * 検証結果の要点（すべて実データ、翌日終値約定）
 * ==========================================
 * [au PAY VIX>30ルール] NDX日次 1995/1-2026/7、2倍相当、利確+12%/損切-15%/期限20営業日
 *   x58.41 / CAGR 13.7% / 最大DD -46.8% / Calmar 0.29 / 83取引 / 勝率72%
 *   市場滞在率は12%。最大連敗2回。損切りの実現平均 -15.5%、最悪 -24.6%。
 *   マイナスの年は1997(-1.3%) 1999(-4.4%) 2000(-5.2%) 2008(-14.7%) の4年のみ。
 *   旧パラメータ +15%/-12% は x20.01 / CAGR 10.0% なので、v3.5の変更は31年で追認された。
 *
 * [エントリー条件の比較] 同期間・同エグジット、Calmarで評価
 *   VIX>30      x58.4  CAGR13.7% DD-46.8% Calmar0.29 滞在12%  ← 採用
 *   VIX>28      x76.2  CAGR14.7% DD-63.3% Calmar0.23 滞在15%
 *   VIX>22      x135   CAGR16.8% DD-73.9% Calmar0.23 滞在33%
 *   VIX>18      x217   CAGR18.6% DD-87.4% Calmar0.21 滞在51%
 *   フィルタなし  x74.1  CAGR14.6% DD-89.5% Calmar0.16 滞在79%
 *   2倍買い持ち   x138   CAGR16.9% DD-98.6% Calmar0.17 滞在97%
 *   VIX>30+200日線超   x1.90  / VIX>30 かつ VIX<5日MA   x3.79  ← 併用は壊滅
 *   閾値を下げるほど累積は増えるが、ドローダウンが耐えられない水準になる。
 *
 * [S&P500 スポットゲージ] S&P500日次 1995/1-2026/7、初到達69回(年2.2回)
 *   到達後 3ヶ月 +6.5%(勝80%) / 6ヶ月 +8.4%(勝70%) / 1年 +9.0%(勝71%)
 *   毎月積立の同期間は +2.5% / +5.0% / +10.1%
 *   → 短期はスポットが有利、1年では積立に追いつかれる。
 *   VIXフィルタを条件に戻してはいけない。強度1〜3の48回のうち、
 *   その日にVIXが鎮静化していたのは3回だけで、45回を取り逃していた。
 *
 * [参考: 積立との比較] 毎月1単位を拠出、1995-2026
 *   2倍に毎月積立      52.4倍 / 最大DD -98.1%
 *   1倍NDXに毎月積立   13.8倍 / 最大DD -78.4%
 *   VIX>30ルール      17.4倍 / 最大DD -46.6%
 *   資金効率では積立が圧勝するが、2000年開始だと拠出額を7.3年間下回り続ける。
 *   このスクリプトは判定を出すだけで、資金配分は扱っていない。
 */