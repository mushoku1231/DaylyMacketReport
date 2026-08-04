function exportHistoryForBacktest(fromDate, toDate) {
  const P1 = Math.floor(new Date(fromDate || "1995-01-01").getTime() / 1000);
  const P2 = Math.floor((toDate ? new Date(toDate) : new Date()).getTime() / 1000);

  const symbols = [
    { key: "SPX",    ticker: "^GSPC" },
    { key: "NDX",    ticker: "^NDX" },
    { key: "VIX",    ticker: "^VIX" },
    { key: "USDJPY", ticker: "JPY=X" }
  ];

  const series = {};
  const allDates = {};

  symbols.forEach(s => {
    const url = "https://query2.finance.yahoo.com/v8/finance/chart/"
              + encodeURIComponent(s.ticker)
              + "?interval=1d&period1=" + P1 + "&period2=" + P2;
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    if (res.getResponseCode() !== 200) {
      Logger.log(s.key + ": HTTP " + res.getResponseCode());
      return;
    }
    const r = JSON.parse(res.getContentText()).chart.result[0];
    const ts = r.timestamp || [];
    const closes = r.indicators.quote[0].close || [];
    const map = {};
    for (let i = 0; i < ts.length; i++) {
      if (typeof closes[i] !== "number") continue;
      const d = Utilities.formatDate(new Date(ts[i] * 1000), "GMT", "yyyy-MM-dd");
      map[d] = closes[i];
      allDates[d] = true;
    }
    series[s.key] = map;
    Logger.log(s.key + ": " + Object.keys(map).length + "件");
  });

  // SPXが存在する日だけを残す（為替だけの休場日を落とす）
  const dates = Object.keys(allDates).sort()
                  .filter(d => series["SPX"] && series["SPX"][d] !== undefined);

  const rows = [["Date", "SPX", "NDX", "VIX", "USDJPY"]];
  dates.forEach(d => {
    rows.push([d,
      series["SPX"]    ? (series["SPX"][d]    ?? "") : "",
      series["NDX"]    ? (series["NDX"][d]    ?? "") : "",
      series["VIX"]    ? (series["VIX"][d]    ?? "") : "",
      series["USDJPY"] ? (series["USDJPY"][d] ?? "") : ""
    ]);
  });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Backtest_Export");
  if (!sheet) sheet = ss.insertSheet("Backtest_Export");
  sheet.clear();
  sheet.getRange(1, 1, rows.length, 5).setValues(rows);
  sheet.getRange(1, 1, 1, 5).setFontWeight("bold");
  Logger.log(rows.length - 1 + "行 (" + dates[0] + " 〜 " + dates[dates.length - 1] + ")");
}
function exportPart1() { exportHistoryForBacktest("1995-01-01", "2010-01-01"); }
function exportPart2() { exportHistoryForBacktest("2010-01-01"); }