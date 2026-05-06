import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  ImageRun,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
} from "docx";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SHOTS_DIR = join(process.cwd(), "docs", "screenshots");
const OUT = join(process.cwd(), "docs", "NEM-Dashboard-User-Guide.docx");

const IMG_W = 600;
const IMG_H = Math.round((600 * 1080) / 1920);

function img(name: string) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new ImageRun({
        type: "png",
        data: readFileSync(join(SHOTS_DIR, name)),
        transformation: { width: IMG_W, height: IMG_H },
      }),
    ],
  });
}
function h1(text: string) { return new Paragraph({ text, heading: HeadingLevel.HEADING_1 }); }
function p(...runs: (string | TextRun)[]) {
  return new Paragraph({
    children: runs.map((r) => (typeof r === "string" ? new TextRun(r) : r)),
  });
}
function b(text: string) { return new TextRun({ text, bold: true }); }
function quote(text: string) {
  return new Paragraph({
    children: [new TextRun({ text, italics: true })],
    indent: { left: 360 },
  });
}
function tcell(content: string | (string | TextRun)[]) {
  const runs = Array.isArray(content)
    ? content.map((r) => (typeof r === "string" ? new TextRun(r) : r))
    : [new TextRun(content)];
  return new TableCell({ children: [new Paragraph({ children: runs })] });
}

const sections: Paragraph[] = [];

// ---------- Title ----------
sections.push(
  new Paragraph({
    text: "NEM Dashboard — User Guide",
    heading: HeadingLevel.TITLE,
  }),
  p("A short walkthrough of every page in the dashboard. Each section shows what the page is for and how to drive it."),
);

// ---------- Orientation ----------
sections.push(
  h1("Orientation"),
  img("00-overview.png"),
  p(
    "The dashboard is a single page with a slim left rail. Hover the rail to expand it and reveal labels for every tab. The tabs are grouped into ",
    b("Rebids"),
    " (live forecasts vs current dispatch), ",
    b("Market"),
    " (wider market context) and ",
    b("Tools"),
    " (Alinta-specific calculators and revenue views).",
  ),
  p(
    "Every page shares the same top strip. In the centre, the ",
    b("time tape"),
    " shows the current NEM dispatch interval-ending time in AEST with a progress bar to the next interval, and the ",
    b("price strip"),
    " under it shows the live $/MWh for each region — Q (QLD), N (NSW), V (VIC) and S (SA). On the top right, the Rebids tabs show a ",
    b("region selector"),
    " (it becomes an ",
    b("interconnector filter"),
    " on the Interconnectors tab), followed by a ",
    b("refresh"),
    " icon and a ",
    b("light/dark mode toggle"),
    ".",
  ),
);

// ---------- 1. Rebids ----------
sections.push(
  h1("1. Rebids"),
  img("01-prices.png"),
  p(
    "The ",
    b("Rebids"),
    " group contains five tabs — ",
    b("Prices"),
    ", ",
    b("Demand"),
    ", ",
    b("Interconnectors"),
    ", ",
    b("Sensitivities"),
    " and ",
    b("Actuals vs 5PD"),
    ". They all share the same layout and the same filter pattern, so once you learn one tab the rest are immediate.",
  ),
  p(
    "Every Rebids tab shows two side-by-side tables — ",
    b("5-Min Pre-Dispatch"),
    " on the left and ",
    b("30-Min Pre-Dispatch"),
    " on the right — with one row per interval. Each row has a Previous value, a Current value, and a Delta. Deltas are colour-coded: green means the forecast moved down, red means it moved up. ",
    b("Actuals vs 5PD"),
    " is the only minor exception — it stacks Prices, Demand and Interconnectors as three sections on the same page comparing the latest 5-Min PD against the dispatch outcome.",
  ),
  p(
    "The ",
    b("region selector"),
    " at the top right is the universal filter for these tabs. It applies to Prices, Demand, Sensitivities and Actuals, and on the Interconnectors tab it becomes an ",
    b("interconnector filter"),
    " — choose ",
    b("All"),
    " to see every IC, or pick one (Murraylink, QNI, VIC-NSW, Heywood, Terranora, T-V-MNSP1) to drill in.",
  ),
  p(
    b("Click any row to bring up the rebid reason."),
    " The banner across the top of the page (which by default reads ",
    b("“Select a row from the tables below”"),
    ") is populated when you click a row — it summarises the change for that interval as a copy-ready rebid reason. Use the copy icon at the right of the banner to grab the text for the rebid. The same row stays highlighted when you flip between Rebids tabs, so you can pivot from a price move to its underlying demand or interconnector change without losing your place.",
  ),
  p("What each tab actually shows:"),
  p(
    b("Prices"),
    " — $/MWh pre-dispatch forecasts vs the latest republish.",
  ),
  p(
    b("Demand"),
    " — operational demand (MW) forecasts. Useful for spotting demand revisions that explain price moves.",
  ),
  p(
    b("Interconnectors"),
    " — flow forecasts per IC; positive values follow the convention in the IC label.",
  ),
  p(
    b("Sensitivities"),
    " — 30-Min PD price sensitivities by demand offset (e.g. “what would the price have been with QLD demand +200 MW?”), sorted by largest delta.",
  ),
  p(
    b("Actuals vs 5PD"),
    " — after dispatch finalises, the 5-Min PD forecast compared against the actual outcome for prices, demand, and IC flows in one view. Use this to grade forecast accuracy and spot persistent biases.",
  ),
);

// ---------- 2. NEM Market Summary ----------
sections.push(
  h1("2. NEM Market Summary (Market)"),
  img("06-nem-market-summary.png"),
  p(
    "A one-screen daily briefing for the whole NEM. Per-region cards (NSW, QLD, VIC, SA) show max temperature, current and peak wind & solar, and demand peak / current. Below them, an ",
    b("Interconnectors"),
    " chip list shows which ICs are binding, when, and into where; ",
    b("Outages"),
    " and ",
    b("Upcoming Outages"),
    " chip lists show units currently or about to be unavailable, colour-coded by fuel type.",
  ),
  p(
    "The right-hand panel renders the same content as copyable text. Toggle ",
    b("Compact / Dot Point / Narrative / Table"),
    " at the top to change the format, click region or IC chips to include or exclude them, then use the copy icon at the top-right to grab the text for an email or chat.",
  ),
);

// ---------- 7. Market Notices ----------
sections.push(
  h1("3. Market Notices (Market)"),
  img("07-market-notices.png"),
  p(
    "Rolling feed of AEMO Market Notices. Each row shows the notice ID, type chip (e.g. RESERVE NOTICE, NON-CONFORMANCE), region chip, severity such as ",
    b("LOR1"),
    ", time, and headline. Click a row's caret on the left to expand the full notice body.",
  ),
  p(
    "The filter row across the top lets you narrow the feed quickly. The ",
    b("search box"),
    " filters by free text across type, description, reason and ID. The ",
    b("Show all types"),
    " dropdown lets you pick which categories to include. The ",
    b("region pills"),
    " (NSW / QLD / VIC / SA / TAS / All regions) filter geographically. The ",
    b("Hide types"),
    " button at the right of the filter row lets you suppress repetitive low-value notice types entirely. The top right shows a counter — e.g. ",
    b("19 / 499 shown · 9434 available · refreshed HH:MM"),
    " — alongside a refresh icon.",
  ),
);

// ---------- 8. Braemar Start ----------
sections.push(
  h1("4. Braemar Start (Tools)"),
  img("08-braemar-start.png"),
  p(
    "Profitability calculator for a Braemar (QLD1) start over the next 24 hours. Choose ",
    b("Today"),
    " or ",
    b("D+1"),
    " at the top to set the horizon, then pick the ",
    b("Price"),
    " basis (Base RRP, etc.).",
  ),
  p(
    "Fill the input row with ",
    b("Gas ($/GJ)"),
    ", ",
    b("Heat Rate (GJ/MWh)"),
    ", ",
    b("Load (MW)"),
    ", ",
    b("Ramp Rate (MW/min)"),
    " and ",
    b("Start Cost ($)"),
    "; the calculator derives ",
    b("SRMC ($/MWh)"),
    " automatically. The chart below shows the price curve, with profitable start windows (where price exceeds SRMC) shaded as bands. If there are no profitable starts you'll see ",
    b("No profitable starts today (SRMC $X/MWh)"),
    " in place of the bands.",
  ),
  quote("Tip: Braemar must run at least 110 MW when on (minimum base load) — set Load accordingly."),
);

// ---------- 9. Bairnsdale Start ----------
sections.push(
  h1("5. Bairnsdale Start (Tools)"),
  img("09-bairnsdale-start.png"),
  p(
    "Same idea as Braemar Start but for ",
    b("Bairnsdale (VIC1)"),
    ", which has two units. Toggle ",
    b("Unit 1"),
    " / ",
    b("Unit 2"),
    " at the top to choose which unit's economics to plot, then pick ",
    b("Today"),
    " / ",
    b("D+1"),
    " and the ",
    b("Price"),
    " basis as on the Braemar tab.",
  ),
  p(
    "Inputs are similar with two additions: ",
    b("Transport ($/GJ)"),
    " and per-unit ",
    b("Var Maint ($/h)"),
    " and ",
    b("Fixed Start ($)"),
    " for both U1 and U2. The header row updates Fuel cost, U1 SRMC and U2 SRMC as you type. The chart shades profitable windows; if none qualify, a ",
    b("No profitable starts today"),
    " line appears below.",
  ),
);

// ---------- 10. Coal Offloading ----------
sections.push(
  h1("6. Coal Offloading (Tools)"),
  img("10-coal-offloading.png"),
  p(
    "Bid plan for a Loy Yang B coal-offloading event — reduce LYB output by a target MWh from time A to time B while staying inside ramp and capacity limits.",
  ),
  p(
    "Set the event window with ",
    b("Start Date"),
    ", ",
    b("Start Time"),
    " (HH/MM/AM-PM) and ",
    b("Duration (hrs)"),
    ", then enter the ",
    b("MWh Reduction"),
    " target. Fill in the unit caps (",
    b("LYB1 CAP"),
    ", ",
    b("LYB2 CAP"),
    " in MW), ramp rates (",
    b("LYB1 RAMP"),
    ", ",
    b("LYB2 RAMP"),
    " in MW/min), optional ",
    b("Pre-Offload"),
    " values, and a ",
    b("Buffer (MWh)"),
    ". The header summarises the resulting reduction rate and total capacity.",
  ),
  p(
    "The table below shows, for every 5-minute interval: ",
    b("Actual gen"),
    " (live), ",
    b("Δ vs target"),
    ", ",
    b("Reduction"),
    ", ",
    b("Forecast gen"),
    ", ",
    b("LYB1 Bid"),
    " and ",
    b("LYB2 Bid"),
    " (MW targets), and a cumulative ",
    b("MWh offloaded"),
    " column versus target. Use the ",
    b("Copy"),
    " button on the BID REASON banner at the top to copy the bid-reason text for the rebid.",
  ),
);

// ---------- Common controls table ----------
const controls = new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [
    new TableRow({
      tableHeader: true,
      children: [tcell([b("Control")]), tcell([b("Where")]), tcell([b("What it does")])],
    }),
    new TableRow({
      children: [
        tcell("Region selector"),
        tcell("Top right of Rebids tabs (except Interconnectors)"),
        tcell("Filters Prices / Demand / Sensitivities / Actuals to one region"),
      ],
    }),
    new TableRow({
      children: [
        tcell("IC selector"),
        tcell("Top right on Interconnectors tab"),
        tcell("Filters to a single interconnector or All"),
      ],
    }),
    new TableRow({
      children: [
        tcell("Refresh icon"),
        tcell("Top right, next to theme toggle"),
        tcell("Forces an immediate data refetch (the dashboard auto-refreshes)"),
      ],
    }),
    new TableRow({
      children: [
        tcell("Light / Dark toggle"),
        tcell("Top right"),
        tcell("Switches theme"),
      ],
    }),
    new TableRow({
      children: [
        tcell("Time tape"),
        tcell("Centre top, every page"),
        tcell("Current NEM interval-ending time (AEST) with a progress bar to the next interval"),
      ],
    }),
    new TableRow({
      children: [
        tcell("Price strip"),
        tcell("Centre top, every page"),
        tcell("Live $/MWh for Q (QLD), N (NSW), V (VIC), S (SA)"),
      ],
    }),
  ],
});

const doc = new Document({
  sections: [
    {
      properties: {},
      children: [
        ...sections,
        new Paragraph({ text: "Common controls (reference)", heading: HeadingLevel.HEADING_1 }),
        controls,
      ],
    },
  ],
});

(async () => {
  const buf = await Packer.toBuffer(doc);
  writeFileSync(OUT, buf);
  console.log(`Wrote ${OUT} (${(buf.length / 1024).toFixed(1)} KB)`);
})();
