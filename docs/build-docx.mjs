/**
 * Generates a Word document (.docx) for the NEM Dashboard user guide,
 * with embedded annotated screenshots and reference tables.
 *
 * Usage:  node docs/build-docx.mjs
 * Output: docs/NEM-Dashboard-User-Guide.docx
 */

import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  HeadingLevel, AlignmentType, ShadingType,
  TableLayoutType,
} from "docx";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SS = (name) => join(__dirname, "screenshots", name);
const OUT = join(__dirname, "NEM-Dashboard-User-Guide.docx");

// Helper: load image as ImageRun
function img(filename, widthPx = 900) {
  const buf = readFileSync(SS(filename));
  // Images are 2x DPI (deviceScaleFactor: 2), so actual pixel width is 1920×1080×2
  // We want them to display at ~900px wide in the doc = ~675pt ≈ 6.75in
  return new ImageRun({
    data: buf,
    transformation: { width: 680, height: 380 },
    type: "png",
  });
}

// Helper: bold text run
const b = (text) => new TextRun({ text, bold: true });
const t = (text) => new TextRun({ text });
const it = (text) => new TextRun({ text, italics: true });

// Helper: heading paragraph
const h1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [b(text)] });
const h2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [b(text)] });
const h3 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [b(text)] });

// Helper: normal paragraph
const p = (...runs) => new Paragraph({ children: runs, spacing: { after: 120 } });

// Helper: bullet point
const bullet = (text) => new Paragraph({
  children: [t(text)],
  bullet: { level: 0 },
  spacing: { after: 60 },
});

// Helper: image paragraph (centered)
const imgPara = (filename) => new Paragraph({
  children: [img(filename)],
  alignment: AlignmentType.CENTER,
  spacing: { before: 200, after: 200 },
});

// Helper: table cell with shading for colour samples
function colorCell(text, bgHex) {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, color: "FFFFFF", bold: true, size: 20 })] })],
    shading: { type: ShadingType.SOLID, color: bgHex, fill: bgHex },
    width: { size: 1800, type: WidthType.DXA },
  });
}

// Helper: standard table cell
function cell(text, bold = false, width = undefined) {
  const opts = {
    children: [new Paragraph({
      children: [new TextRun({ text, bold, size: 20 })],
      spacing: { before: 40, after: 40 },
    })],
  };
  if (width) opts.width = { size: width, type: WidthType.DXA };
  return new TableCell(opts);
}

// Helper: multi-line cell
function multiCell(lines) {
  return new TableCell({
    children: lines.map(l => new Paragraph({
      children: [new TextRun({ text: l, size: 20 })],
      spacing: { before: 20, after: 20 },
    })),
  });
}

// Helper: header cell
function hCell(text, width = undefined) {
  const opts = {
    children: [new Paragraph({
      children: [new TextRun({ text, bold: true, size: 20, color: "FFFFFF" })],
      spacing: { before: 40, after: 40 },
    })],
    shading: { type: ShadingType.SOLID, color: "1f2937", fill: "1f2937" },
  };
  if (width) opts.width = { size: width, type: WidthType.DXA };
  return new TableCell(opts);
}

// Helper: build a simple table from rows of [ref, area, description]
function refTable(headers, rows) {
  const headerRow = new TableRow({
    children: headers.map(h => hCell(h)),
    tableHeader: true,
  });
  const dataRows = rows.map(cols =>
    new TableRow({
      children: cols.map((c, i) => i === 0 ? cell(c, true) : cell(c)),
    })
  );
  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
  });
}

// ================================================================
// BUILD DOCUMENT
// ================================================================

const doc = new Document({
  styles: {
    paragraphStyles: [
      {
        id: "Normal",
        run: { size: 22, font: "Calibri" },
        paragraph: { spacing: { line: 276 } },
      },
    ],
  },
  sections: [{
    children: [
      // ── TITLE ──
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: "NEM Dashboard — User Guide", bold: true, size: 52 })],
        spacing: { after: 200 },
      }),

      p(
        b("NEM Dashboard"), t(" — "),
        new TextRun({ text: "https://nem-rebids-beta.vercel.app/", color: "2563EB", underline: {} }),
      ),
      p(t("Real-time pre-dispatch change tracker for the NEM. Compares the latest two AEMO runs (5-min and 30-min pre-dispatch) and shows what moved — prices, demand, interconnectors, and sensitivities.")),
      p(t("Data auto-refreshes every ~30 seconds. No login, VPN, or software install required.")),

      // ── 1. DASHBOARD OVERVIEW ──
      h1("1. Dashboard Overview"),
      p(t("Navigate to the URL above in any modern browser (Chrome, Edge, Firefox). No login or installation needed.")),
      p(t("The screenshot below shows the default view (Prices tab). The Demand tab has an identical layout but displays MW instead of $.")),

      imgPara("01-dashboard-overview.png"),

      refTable(["Ref", "Area", "Description"], [
        ["1", "Tab Navigation", "Switch between views: Prices, Demand, Interconnectors, Sensitivities, Actuals vs 5PD, Spikes, BR Start. The refresh button (circular arrow) beside the tabs forces an immediate update — hover to see last refresh time."],
        ["2", "Interval Countdown + Prices", "Live countdown bar to the next 5-minute NEM dispatch interval. Colour shifts green → yellow → orange → red as time runs out. Shows current dispatch prices for Q (QLD), N (NSW), V (VIC), S (SA). All times in AEST."],
        ["3", "Filters & Theme", "Region dropdown — filter by QLD, NSW, VIC, or SA. Direction dropdown — show only increases, decreases, or all. Theme toggle (sun/moon) — switch dark/light mode."],
        ["4", "Rebid Reason Generator", "Click any data row to auto-generate a rebid reason here. Click the copy button to copy to clipboard for emails or AEMO submissions."],
        ["5", "5-Min Pre-Dispatch (5PD)", "Price changes from the latest vs previous P5MIN AEMO run. Covers the next ~60 minutes in 5-minute intervals. Columns: Interval | Previous | Current | Delta."],
        ["6", "30-Min Pre-Dispatch (30PD)", "Price changes from the latest vs previous PREDISPATCH run. Covers the remainder of the trading day in 30-minute intervals."],
      ]),

      h3("Colour Coding"),

      refTable(["Delta Direction", "Colour"], [
        ["Increase (positive delta)", "Red / Rose"],
        ["Decrease (negative delta)", "Green / Emerald"],
      ]),

      p(t("")),

      refTable(["Price Range", "Colour"], [
        ["Below $0 (negative)", "Blue"],
        ["$0 – $50", "Green"],
        ["$50 – $100", "Yellow"],
        ["$100 – $300", "Orange"],
        ["Above $300", "Red"],
      ]),

      // ── 2. REBID REASON ──
      h1("2. Rebid Reason Generator"),
      p(t("Click any data row to select it. A human-readable rebid reason is auto-generated in the text area at the top of the page.")),

      imgPara("02-rebid-reason.png"),

      refTable(["Ref", "Description"], [
        ["1", "The auto-generated rebid reason text. Example: \"Change in 5PD price for QLD at 31 Mar, 09:30 — increased by $0.09 from $0.75 to $0.84 vs previous run.\" Click the copy button (clipboard icon, top-right) to copy to clipboard. Click the row again or press Clear to deselect."],
      ]),

      p(it("Tip: This works on all data tabs (Prices, Demand, Interconnectors, Sensitivities) — the generated reason adapts to the data type.")),

      // ── 3. INTERCONNECTORS ──
      h1("3. Interconnectors Tab"),
      p(t("Shows MW power flow changes between NEM regions via high-voltage transmission links.")),

      imgPara("03-interconnectors.png"),

      refTable(["Ref", "Area", "Description"], [
        ["1", "IC Selector / Direction / Theme", "The region dropdown is replaced by an interconnector dropdown — filter by a specific IC or view all. Direction filter and theme toggle also available."],
        ["2", "Rebid Reason", "Same as other tabs — click a row to generate a reason."],
        ["3", "5PD Interconnector Flows", "5-minute pre-dispatch MW flow changes for each interconnector."],
        ["4", "30PD Interconnector Flows", "30-minute pre-dispatch MW flow changes."],
      ]),

      h3("Tracked Interconnectors"),

      refTable(["Name", "ID", "Regions"], [
        ["QNI", "NSW1-QLD1", "NSW ↔ QLD"],
        ["Terranora", "N-Q-MNSP1", "NSW ↔ QLD (alternate)"],
        ["VIC–NSW", "VIC1-NSW1", "VIC ↔ NSW"],
        ["Heywood", "V-SA", "VIC ↔ SA"],
        ["Murraylink", "V-S-MNSP1", "VIC ↔ SA (alternate)"],
      ]),

      // ── 4. SENSITIVITIES ──
      h1("4. Sensitivities Tab"),
      p(t("Shows how prices would change under different demand offset scenarios (e.g., QLD +100 MW, -200 MW, +500 MW). Only shows 30-minute pre-dispatch data.")),

      imgPara("04-sensitivities.png"),

      refTable(["Ref", "Area", "Description"], [
        ["1", "Filters", "Region dropdown, direction filter, and theme toggle — same as other tabs."],
        ["2", "Rebid Reason", "Click a row to generate a sensitivity-specific rebid reason."],
        ["3", "Sensitivity Data", "30PD price changes for each demand offset scenario. Columns: Interval | Demand Offset | Previous | Current | Delta. Use this to understand price elasticity — how sensitive prices are to demand changes in each region."],
      ]),

      // ── 5. ACTUALS VS 5PD ──
      h1("5. Actuals vs 5PD Tab"),
      p(t("Compares what the 5-minute pre-dispatch forecast against what actually happened in dispatch.")),

      imgPara("05-actuals-vs-5pd.png"),

      refTable(["Ref", "Area", "Description"], [
        ["1", "Region Filter", "Filter by region. No direction filter on this tab."],
        ["2+", "Data Sections", "Three sub-sections showing forecast vs actual for: Prices ($/MWh), Demand (MW), and Interconnectors (MW). Columns: Interval | 5PD Forecast | Actual | Delta."],
      ]),

      p(t("Use this to assess forecast accuracy and identify when pre-dispatch is systematically over- or under-forecasting.")),

      // ── 6. SPIKES ──
      h1("6. Spikes Tab"),
      p(t("Tracks price spike events with historical lookback and root-cause analysis via binding constraints.")),

      imgPara("06-spikes.png"),

      refTable(["Ref", "Element", "Description"], [
        ["1", "Time Range", "Select the lookback period: 24h, 3d (3 days), or 7d (7 days)."],
        ["2", "Region Filter", "Filter spikes by region: All regions, QLD, NSW, VIC, or SA. Also shows severity filter buttons (All, High, Negative)."],
        ["3", "Spike Cards", "Each card shows: timestamp (AEST), severity badge (colour-coded), region and price ($/MWh), and binding constraints causing the spike with their marginal value ($/MWh)."],
      ]),

      h3("Severity Levels"),

      refTable(["Severity", "Threshold", "Badge Colour"], [
        ["EXTREME", "> $1,000/MWh", "Red"],
        ["HIGH", "> $300/MWh", "Orange"],
        ["NEGATIVE", "≤ -$30/MWh", "Cyan"],
      ]),

      // ── 7. BR START ──
      h1("7. BR Start Tab (Generator Start Cost Calculator)"),
      p(t("Calculates whether it is profitable to start a generator given current and forecast prices.")),

      imgPara("07-br-start.png"),

      refTable(["Ref", "Element", "Description"], [
        ["1", "Title & Region", "Shows \"BR Start Profitability\" and the region (e.g., QLD1)."],
        ["2", "Trading Day Toggle", "Switch between Today (current trading day) and D+1 (day-ahead)."],
        ["3", "Price Scenario", "Select price scenario: Base RRP (5-min + 30-min combined) or sensitivity scenarios (e.g., QLD +100 MW, +500 MW)."],
        ["4", "Generator Parameters", "Gas ($/GJ), Heat Rate (GJ/MWh), Load (MW), Start Cost ($), Ramp Rate (MW/min). Saved in your browser automatically."],
        ["5", "SRMC", "Calculated Short-Run Marginal Cost based on gas cost × heat rate. Prices above this line are profitable to generate."],
        ["6", "Price Forecast Chart", "Blue area = RRP price forecast. Dashed line = your SRMC. When profitable starts exist, an amber area shows the MW generation curve."],
        ["7", "Results", "If profitable: interval-by-interval breakdown with optimal start/stop times, revenue, gas cost, margin, cumulative balance. Otherwise: \"No profitable starts today\"."],
      ]),

      // ── 8. DATA REFRESH ──
      h1("8. Data Refresh & Timing"),
      bullet("Data auto-refreshes every ~30 seconds, aligned to AEMO publication times"),
      bullet("New AEMO pre-dispatch runs are published approximately every 5 minutes"),
      bullet("The refresh button (circular arrow next to the tabs) forces an immediate update — hover to see last refresh time"),
      bullet("All timestamps are in AEST (Australian Eastern Standard Time, UTC+10)"),

      p(t("")),
      p(b("Why is this faster than Power BI?")),
      bullet("30-second refresh vs Power BI's 30-minute minimum"),
      bullet("No infrastructure — no Oracle drivers, VPN, on-prem gateway, or BI licence"),
      bullet("Shareable — just send a URL, works in any browser"),
      bullet("Free — no per-user licence cost"),

      // ── 9. TIPS ──
      h1("9. Tips & Tricks"),
      bullet("Quick region switch: Use the region dropdown to instantly filter all data to your region of interest"),
      bullet("Direction filter: Set to \"Increase\" to focus only on upward price/demand movements"),
      bullet("Copy rebid reasons: Click a row, then use the copy button to paste the auto-generated reason into emails or AEMO submissions"),
      bullet("Dark mode: Toggle the sun/moon icon for comfortable viewing in low-light environments"),
      bullet("Keyboard navigation: Use Tab to move between rows and Enter/Space to select"),
      bullet("BR Start config persists: Your generator parameters are saved in your browser automatically"),
      bullet("Bookmark it: Add the URL to your browser favourites for instant access"),

      // ── 10. FAQ ──
      h1("10. FAQ"),

      p(b("Where does the data come from?")),
      p(t("Directly from AEMO NEMWeb public reports. No database, VPN, or Oracle connection is involved.")),

      p(b("Do I need to install anything?")),
      p(t("No. Just open the URL in any modern browser.")),

      p(b("Why are some intervals missing?")),
      p(t("The dashboard only shows intervals where the value changed between the latest and previous AEMO run.")),

      p(b("What does the delta column mean?")),
      p(t("Delta = Current value minus Previous value. Positive = increased between runs; negative = decreased.")),

      p(b("Can I verify the numbers?")),
      p(t("Yes — cross-check against OpenElectricity (openelectricity.org.au) or AEMO's own NEMWeb reports.")),
    ],
  }],
});

// Write the file
const buffer = await Packer.toBuffer(doc);
writeFileSync(OUT, buffer);
console.log(`Done! Word document saved to: ${OUT}`);
