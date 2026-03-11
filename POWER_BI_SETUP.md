# NEM Dashboard — Power BI Recreation Guide

This guide explains how to recreate the **Rebids** page from the NEM Dashboard web app as a Power BI report, connected to the same Oracle database.

---

## Database Connection Details

| Field | Value |
|---|---|
| **Database type** | Oracle |
| **Server** | `ora-infoserver1-prod:1521/LEG1` |
| **Schema** | `AUGUSTA` |
| **Username** | `BI_REPORT_RO` |
| **Password** | `Q9zd8IhO` |

---

## Prerequisites

1. **Oracle Client** — Power BI requires the Oracle Data Access Client installed locally.
   Download from: https://www.oracle.com/database/technologies/instant-client.html
   - Install the **64-bit** version (must match your Power BI Desktop architecture).
   - After install, you may need to restart Power BI Desktop.

2. **Power BI Desktop** — Download from https://powerbi.microsoft.com/desktop/

---

## Step 1: Connect to Oracle in Power BI

1. Open Power BI Desktop.
2. Click **Get Data** > **More...** > search **Oracle Database** > click **Connect**.
3. In the **Server** field, enter:
   ```
   ora-infoserver1-prod:1521/LEG1
   ```
4. Expand **Advanced options** and paste the SQL query (see Step 2 below) into the **SQL statement** box.
5. Click **OK**.
6. When prompted for credentials, select **Database** (not Windows):
   - Username: `BI_REPORT_RO`
   - Password: `Q9zd8IhO`
7. Click **Connect**.

Repeat this for each dataset/query you need (see Step 2).

---

## Step 2: Create Datasets

Each section below maps to a tab on the web app's Rebids page. For each one:

1. **Get Data** > **Oracle Database**
2. Paste the SQL into the **SQL statement** box under Advanced options
3. Name the query in Power Query Editor (right-click the query > Rename)

### Dataset 1: `5PD_Price_Changes`

Shows 5-minute pre-dispatch price changes between the last two AEMO runs.

**Columns:**
- `INTERVAL_DATETIME` — the dispatch interval
- `REGIONID` — NEM region (`QLD1`, `NSW1`, `VIC1`, `SA1`, `TAS1`)
- `PREVIOUS_RRP` — price from the previous PD run
- `CURRENT_RRP` — price from the current (latest) PD run
- `DELTA` — price change (Current - Previous)

```sql
SELECT c.INTERVAL_DATETIME, c.REGIONID,
       c.RRP AS CURRENT_RRP, p.RRP AS PREVIOUS_RRP,
       c.RRP - p.RRP AS DELTA
FROM AUGUSTA.P5MIN_REGIONSOLUTION c
JOIN AUGUSTA.P5MIN_REGIONSOLUTION p
  ON c.INTERVAL_DATETIME = p.INTERVAL_DATETIME
  AND c.REGIONID = p.REGIONID
WHERE c.RUN_DATETIME = (
    SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_REGIONSOLUTION
  )
  AND p.RUN_DATETIME = (
    SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_REGIONSOLUTION
    WHERE RUN_DATETIME < (
      SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_REGIONSOLUTION
    )
  )
  AND c.REGIONID != 'TAS1'
ORDER BY ABS(c.RRP - p.RRP) DESC
```

---

### Dataset 2: `30PD_Price_Changes`

Shows 30-minute pre-dispatch price changes between the last two AEMO runs.

**Columns:** Same as above (`DATETIME` instead of `INTERVAL_DATETIME`).

```sql
SELECT c.DATETIME, c.REGIONID,
       c.RRP AS CURRENT_RRP, p.RRP AS PREVIOUS_RRP,
       c.RRP - p.RRP AS DELTA
FROM AUGUSTA.PREDISPATCHPRICE c
JOIN AUGUSTA.PREDISPATCHPRICE p
  ON c.DATETIME = p.DATETIME
  AND c.REGIONID = p.REGIONID
  AND p.INTERVENTION = 0
WHERE c.INTERVENTION = 0
  AND c.PREDISPATCHSEQNO = (
    SELECT MAX(PREDISPATCHSEQNO) FROM AUGUSTA.PREDISPATCHPRICE
    WHERE INTERVENTION = 0
  )
  AND p.PREDISPATCHSEQNO = (
    SELECT MAX(PREDISPATCHSEQNO) FROM AUGUSTA.PREDISPATCHPRICE
    WHERE INTERVENTION = 0
      AND PREDISPATCHSEQNO < (
        SELECT MAX(PREDISPATCHSEQNO) FROM AUGUSTA.PREDISPATCHPRICE
        WHERE INTERVENTION = 0
      )
  )
  AND c.REGIONID != 'TAS1'
ORDER BY ABS(c.RRP - p.RRP) DESC
```

---

### Dataset 3: `5PD_Demand_Changes`

Shows 5-minute pre-dispatch demand changes between the last two runs.

**Columns:**
- `INTERVAL_DATETIME`
- `REGIONID`
- `PREVIOUS_TOTALDEMAND` — demand from previous run (MW)
- `CURRENT_TOTALDEMAND` — demand from current run (MW)
- `DELTA` — demand change (MW)

```sql
SELECT c.INTERVAL_DATETIME, c.REGIONID,
       c.TOTALDEMAND AS CURRENT_TOTALDEMAND,
       p.TOTALDEMAND AS PREVIOUS_TOTALDEMAND,
       c.TOTALDEMAND - p.TOTALDEMAND AS DELTA
FROM AUGUSTA.P5MIN_REGIONSOLUTION c
JOIN AUGUSTA.P5MIN_REGIONSOLUTION p
  ON c.INTERVAL_DATETIME = p.INTERVAL_DATETIME
  AND c.REGIONID = p.REGIONID
WHERE c.RUN_DATETIME = (
    SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_REGIONSOLUTION
  )
  AND p.RUN_DATETIME = (
    SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_REGIONSOLUTION
    WHERE RUN_DATETIME < (
      SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_REGIONSOLUTION
    )
  )
  AND c.REGIONID != 'TAS1'
ORDER BY ABS(c.TOTALDEMAND - p.TOTALDEMAND) DESC
```

---

### Dataset 4: `30PD_Demand_Changes`

Shows 30-minute pre-dispatch demand changes between the last two runs.

```sql
SELECT c.DATETIME, c.REGIONID,
       c.TOTALDEMAND AS CURRENT_TOTALDEMAND,
       p.TOTALDEMAND AS PREVIOUS_TOTALDEMAND,
       c.TOTALDEMAND - p.TOTALDEMAND AS DELTA
FROM AUGUSTA.PREDISPATCHREGIONSUM c
JOIN AUGUSTA.PREDISPATCHREGIONSUM p
  ON c.DATETIME = p.DATETIME
  AND c.REGIONID = p.REGIONID
  AND p.INTERVENTION = 0
WHERE c.INTERVENTION = 0
  AND c.PREDISPATCHSEQNO = (
    SELECT MAX(PREDISPATCHSEQNO) FROM AUGUSTA.PREDISPATCHREGIONSUM
    WHERE INTERVENTION = 0
  )
  AND p.PREDISPATCHSEQNO = (
    SELECT MAX(PREDISPATCHSEQNO) FROM AUGUSTA.PREDISPATCHREGIONSUM
    WHERE INTERVENTION = 0
      AND PREDISPATCHSEQNO < (
        SELECT MAX(PREDISPATCHSEQNO) FROM AUGUSTA.PREDISPATCHREGIONSUM
        WHERE INTERVENTION = 0
      )
  )
  AND c.REGIONID != 'TAS1'
ORDER BY ABS(c.TOTALDEMAND - p.TOTALDEMAND) DESC
```

---

### Dataset 5: `5PD_Interconnector_Changes`

Shows 5-minute pre-dispatch interconnector flow changes between the last two runs.

**Columns:**
- `INTERVAL_DATETIME`
- `INTERCONNECTORID` — e.g. `N-Q-MNSP1`, `VIC1-NSW1`, `V-SA`, `V-S-MNSP1`, `T-V-MNSP1`
- `PREVIOUS_MWFLOW` / `CURRENT_MWFLOW` — flow in MW
- `FLOW_DELTA` — change in flow

```sql
SELECT c.INTERVAL_DATETIME, c.INTERCONNECTORID,
       c.MWFLOW AS CURRENT_MWFLOW, p.MWFLOW AS PREVIOUS_MWFLOW,
       c.MWFLOW - p.MWFLOW AS FLOW_DELTA,
       c.IMPORTLIMIT AS CURRENT_IMPORTLIMIT, p.IMPORTLIMIT AS PREVIOUS_IMPORTLIMIT,
       c.IMPORTLIMIT - p.IMPORTLIMIT AS IMPORT_DELTA,
       c.EXPORTLIMIT AS CURRENT_EXPORTLIMIT, p.EXPORTLIMIT AS PREVIOUS_EXPORTLIMIT,
       c.EXPORTLIMIT - p.EXPORTLIMIT AS EXPORT_DELTA
FROM AUGUSTA.P5MIN_INTERCONNECTORSOLN c
JOIN AUGUSTA.P5MIN_INTERCONNECTORSOLN p
  ON c.INTERVAL_DATETIME = p.INTERVAL_DATETIME
  AND c.INTERCONNECTORID = p.INTERCONNECTORID
WHERE c.RUN_DATETIME = (
    SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_INTERCONNECTORSOLN
  )
  AND p.RUN_DATETIME = (
    SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_INTERCONNECTORSOLN
    WHERE RUN_DATETIME < (
      SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_INTERCONNECTORSOLN
    )
  )
  AND c.INTERCONNECTORID != 'T-V-MNSP1'
ORDER BY ABS(c.MWFLOW - p.MWFLOW) DESC
```

---

### Dataset 6: `30PD_Interconnector_Changes`

```sql
SELECT c.DATETIME, c.INTERCONNECTORID,
       c.MWFLOW AS CURRENT_MWFLOW, p.MWFLOW AS PREVIOUS_MWFLOW,
       c.MWFLOW - p.MWFLOW AS FLOW_DELTA,
       c.IMPORTLIMIT AS CURRENT_IMPORTLIMIT, p.IMPORTLIMIT AS PREVIOUS_IMPORTLIMIT,
       c.IMPORTLIMIT - p.IMPORTLIMIT AS IMPORT_DELTA,
       c.EXPORTLIMIT AS CURRENT_EXPORTLIMIT, p.EXPORTLIMIT AS PREVIOUS_EXPORTLIMIT,
       c.EXPORTLIMIT - p.EXPORTLIMIT AS EXPORT_DELTA
FROM AUGUSTA.PREDISPATCHINTERCONNECTORRES c
JOIN AUGUSTA.PREDISPATCHINTERCONNECTORRES p
  ON c.DATETIME = p.DATETIME
  AND c.INTERCONNECTORID = p.INTERCONNECTORID
  AND p.INTERVENTION = 0
WHERE c.INTERVENTION = 0
  AND c.PREDISPATCHSEQNO = (
    SELECT MAX(PREDISPATCHSEQNO) FROM AUGUSTA.PREDISPATCHINTERCONNECTORRES
    WHERE INTERVENTION = 0
  )
  AND p.PREDISPATCHSEQNO = (
    SELECT MAX(PREDISPATCHSEQNO) FROM AUGUSTA.PREDISPATCHINTERCONNECTORRES
    WHERE INTERVENTION = 0
      AND PREDISPATCHSEQNO < (
        SELECT MAX(PREDISPATCHSEQNO) FROM AUGUSTA.PREDISPATCHINTERCONNECTORRES
        WHERE INTERVENTION = 0
      )
  )
  AND c.INTERCONNECTORID != 'T-V-MNSP1'
ORDER BY ABS(c.MWFLOW - p.MWFLOW) DESC
```

---

### Dataset 7: `5PD_Sensitivity_Changes`

Shows how price sensitivities changed between the last two 5-minute PD runs. Each row is a specific scenario (demand offset applied to a region) and how the price for a given region changed.

**Columns:**
- `INTERVAL_DATETIME`
- `REGIONID` — the region whose price is being observed
- `SCENARIO` — scenario identifier (e.g. `RRP1`, `RRP2`, ... `RRP43`)
- `OFFSET_REGIONID` — the region where demand was offset (e.g. `QLD1`)
- `DELTAMW` — the MW offset applied (e.g. `+200`, `-500`)
- `PREVIOUS_RRPSCENARIO` / `CURRENT_RRPSCENARIO` — price under this scenario
- `DELTA` — change in scenario price

```sql
SELECT c.INTERVAL_DATETIME, c.REGIONID, c.SCENARIO,
       m.DELTAMW, m.OFFSET_REGIONID,
       c.RRP_VAL AS CURRENT_RRPSCENARIO,
       p.RRP_VAL AS PREVIOUS_RRPSCENARIO,
       c.RRP_VAL - p.RRP_VAL AS DELTA
FROM (
  SELECT INTERVAL_DATETIME, REGIONID, SCENARIO, RRP_VAL
  FROM (
    SELECT * FROM AUGUSTA.P5MIN_PRICESENSITIVITIES
    WHERE RUN_DATETIME = (
      SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_PRICESENSITIVITIES
    )
  )
  UNPIVOT (RRP_VAL FOR SCENARIO IN (
    RRP1,RRP2,RRP3,RRP4,RRP5,RRP6,RRP7,RRP8,RRP9,RRP10,
    RRP11,RRP12,RRP13,RRP14,RRP15,RRP16,RRP17,RRP18,RRP19,RRP20,
    RRP21,RRP22,RRP23,RRP24,RRP25,RRP26,RRP27,RRP28,RRP29,RRP30,
    RRP31,RRP32,RRP33,RRP34,RRP35,RRP36,RRP37,RRP38,RRP39,RRP40,
    RRP41,RRP42,RRP43
  ))
) c
JOIN (
  SELECT INTERVAL_DATETIME, REGIONID, SCENARIO, RRP_VAL
  FROM (
    SELECT * FROM AUGUSTA.P5MIN_PRICESENSITIVITIES
    WHERE RUN_DATETIME = (
      SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_PRICESENSITIVITIES
      WHERE RUN_DATETIME < (
        SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_PRICESENSITIVITIES
      )
    )
  )
  UNPIVOT (RRP_VAL FOR SCENARIO IN (
    RRP1,RRP2,RRP3,RRP4,RRP5,RRP6,RRP7,RRP8,RRP9,RRP10,
    RRP11,RRP12,RRP13,RRP14,RRP15,RRP16,RRP17,RRP18,RRP19,RRP20,
    RRP21,RRP22,RRP23,RRP24,RRP25,RRP26,RRP27,RRP28,RRP29,RRP30,
    RRP31,RRP32,RRP33,RRP34,RRP35,RRP36,RRP37,RRP38,RRP39,RRP40,
    RRP41,RRP42,RRP43
  ))
) p
  ON c.INTERVAL_DATETIME = p.INTERVAL_DATETIME
  AND c.REGIONID = p.REGIONID
  AND c.SCENARIO = p.SCENARIO
LEFT JOIN (
  SELECT SCENARIO, REGIONID AS OFFSET_REGIONID, DELTAMW
  FROM AUGUSTA.PREDISPATCHSCENARIODEMAND
  WHERE DELTAMW != 0
    AND EFFECTIVEDATE = (
      SELECT MAX(EFFECTIVEDATE) FROM AUGUSTA.PREDISPATCHSCENARIODEMAND
    )
    AND VERSIONNO = (
      SELECT MAX(VERSIONNO) FROM AUGUSTA.PREDISPATCHSCENARIODEMAND
      WHERE EFFECTIVEDATE = (
        SELECT MAX(EFFECTIVEDATE) FROM AUGUSTA.PREDISPATCHSCENARIODEMAND
      )
    )
) m ON m.SCENARIO = TO_NUMBER(SUBSTR(c.SCENARIO, 4))
WHERE c.RRP_VAL != p.RRP_VAL
  AND c.REGIONID != 'TAS1'
ORDER BY ABS(c.RRP_VAL - p.RRP_VAL) DESC
```

---

### Dataset 8: `30PD_Sensitivity_Changes`

Same as above but for 30-minute pre-dispatch. Note the column names use `RRPEEP` instead of `RRP`.

```sql
SELECT c.DATETIME, c.REGIONID, c.SCENARIO,
       m.DELTAMW, m.OFFSET_REGIONID,
       c.RRP_VAL AS CURRENT_RRPSCENARIO,
       p.RRP_VAL AS PREVIOUS_RRPSCENARIO,
       c.RRP_VAL - p.RRP_VAL AS DELTA
FROM (
  SELECT DATETIME, REGIONID, SCENARIO, RRP_VAL
  FROM (
    SELECT * FROM AUGUSTA.PREDISPATCHPRICESENSITIVITIES
    WHERE PREDISPATCHSEQNO = (
      SELECT MAX(PREDISPATCHSEQNO) FROM AUGUSTA.PREDISPATCHPRICESENSITIVITIES
    )
  )
  UNPIVOT (RRP_VAL FOR SCENARIO IN (
    RRPEEP1,RRPEEP2,RRPEEP3,RRPEEP4,RRPEEP5,RRPEEP6,RRPEEP7,RRPEEP8,RRPEEP9,RRPEEP10,
    RRPEEP11,RRPEEP12,RRPEEP13,RRPEEP14,RRPEEP15,RRPEEP16,RRPEEP17,RRPEEP18,RRPEEP19,RRPEEP20,
    RRPEEP21,RRPEEP22,RRPEEP23,RRPEEP24,RRPEEP25,RRPEEP26,RRPEEP27,RRPEEP28,RRPEEP29,RRPEEP30,
    RRPEEP31,RRPEEP32,RRPEEP33,RRPEEP34,RRPEEP35,RRPEEP36,RRPEEP37,RRPEEP38,RRPEEP39,RRPEEP40,
    RRPEEP41,RRPEEP42,RRPEEP43
  ))
) c
JOIN (
  SELECT DATETIME, REGIONID, SCENARIO, RRP_VAL
  FROM (
    SELECT * FROM AUGUSTA.PREDISPATCHPRICESENSITIVITIES
    WHERE PREDISPATCHSEQNO = (
      SELECT MAX(PREDISPATCHSEQNO) FROM AUGUSTA.PREDISPATCHPRICESENSITIVITIES
      WHERE PREDISPATCHSEQNO < (
        SELECT MAX(PREDISPATCHSEQNO) FROM AUGUSTA.PREDISPATCHPRICESENSITIVITIES
      )
    )
  )
  UNPIVOT (RRP_VAL FOR SCENARIO IN (
    RRPEEP1,RRPEEP2,RRPEEP3,RRPEEP4,RRPEEP5,RRPEEP6,RRPEEP7,RRPEEP8,RRPEEP9,RRPEEP10,
    RRPEEP11,RRPEEP12,RRPEEP13,RRPEEP14,RRPEEP15,RRPEEP16,RRPEEP17,RRPEEP18,RRPEEP19,RRPEEP20,
    RRPEEP21,RRPEEP22,RRPEEP23,RRPEEP24,RRPEEP25,RRPEEP26,RRPEEP27,RRPEEP28,RRPEEP29,RRPEEP30,
    RRPEEP31,RRPEEP32,RRPEEP33,RRPEEP34,RRPEEP35,RRPEEP36,RRPEEP37,RRPEEP38,RRPEEP39,RRPEEP40,
    RRPEEP41,RRPEEP42,RRPEEP43
  ))
) p
  ON c.DATETIME = p.DATETIME
  AND c.REGIONID = p.REGIONID
  AND c.SCENARIO = p.SCENARIO
LEFT JOIN (
  SELECT SCENARIO, REGIONID AS OFFSET_REGIONID, DELTAMW
  FROM AUGUSTA.PREDISPATCHSCENARIODEMAND
  WHERE DELTAMW != 0
    AND EFFECTIVEDATE = (
      SELECT MAX(EFFECTIVEDATE) FROM AUGUSTA.PREDISPATCHSCENARIODEMAND
    )
    AND VERSIONNO = (
      SELECT MAX(VERSIONNO) FROM AUGUSTA.PREDISPATCHSCENARIODEMAND
      WHERE EFFECTIVEDATE = (
        SELECT MAX(EFFECTIVEDATE) FROM AUGUSTA.PREDISPATCHSCENARIODEMAND
      )
    )
) m ON m.SCENARIO = TO_NUMBER(SUBSTR(c.SCENARIO, 7))
WHERE c.RRP_VAL != p.RRP_VAL
  AND c.REGIONID != 'TAS1'
ORDER BY ABS(c.RRP_VAL - p.RRP_VAL) DESC
```

---

### Dataset 9: `Actuals_vs_5PD_Prices`

Compares 5PD price forecast with actual dispatch prices.

**Columns:**
- `INTERVAL_DATETIME`
- `REGIONID`
- `FORECAST_RRP` — what 5PD predicted
- `ACTUAL_RRP` — what actually dispatched
- `DELTA` — difference (Actual - Forecast)

```sql
SELECT p.INTERVAL_DATETIME, p.REGIONID,
       p.RRP AS FORECAST_RRP, d.RRP AS ACTUAL_RRP,
       d.RRP - p.RRP AS DELTA
FROM AUGUSTA.P5MIN_REGIONSOLUTION p
JOIN AUGUSTA.DISPATCHPRICE d
  ON p.INTERVAL_DATETIME = d.SETTLEMENTDATE
  AND p.REGIONID = d.REGIONID
  AND d.INTERVENTION = 0
WHERE p.RUN_DATETIME = (
    SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_REGIONSOLUTION
  )
  AND p.REGIONID != 'TAS1'
ORDER BY ABS(d.RRP - p.RRP) DESC
```

---

### Dataset 10: `Actuals_vs_5PD_Demand`

```sql
SELECT p.INTERVAL_DATETIME, p.REGIONID,
       p.TOTALDEMAND AS FORECAST_TOTALDEMAND,
       d.TOTALDEMAND AS ACTUAL_TOTALDEMAND,
       d.TOTALDEMAND - p.TOTALDEMAND AS DELTA
FROM AUGUSTA.P5MIN_REGIONSOLUTION p
JOIN AUGUSTA.DISPATCHREGIONSUM d
  ON p.INTERVAL_DATETIME = d.SETTLEMENTDATE
  AND p.REGIONID = d.REGIONID
  AND d.INTERVENTION = 0
WHERE p.RUN_DATETIME = (
    SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_REGIONSOLUTION
  )
  AND p.REGIONID != 'TAS1'
ORDER BY ABS(d.TOTALDEMAND - p.TOTALDEMAND) DESC
```

---

### Dataset 11: `Actuals_vs_5PD_Interconnectors`

```sql
SELECT p.INTERVAL_DATETIME, p.INTERCONNECTORID,
       p.MWFLOW AS FORECAST_MWFLOW, d.MWFLOW AS ACTUAL_MWFLOW,
       d.MWFLOW - p.MWFLOW AS FLOW_DELTA,
       p.IMPORTLIMIT AS FORECAST_IMPORTLIMIT, d.IMPORTLIMIT AS ACTUAL_IMPORTLIMIT,
       d.IMPORTLIMIT - p.IMPORTLIMIT AS IMPORT_DELTA,
       p.EXPORTLIMIT AS FORECAST_EXPORTLIMIT, d.EXPORTLIMIT AS ACTUAL_EXPORTLIMIT,
       d.EXPORTLIMIT - p.EXPORTLIMIT AS EXPORT_DELTA
FROM AUGUSTA.P5MIN_INTERCONNECTORSOLN p
JOIN AUGUSTA.DISPATCHINTERCONNECTORRES d
  ON p.INTERVAL_DATETIME = d.SETTLEMENTDATE
  AND p.INTERCONNECTORID = d.INTERCONNECTORID
WHERE p.RUN_DATETIME = (
    SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_INTERCONNECTORSOLN
  )
  AND p.INTERCONNECTORID != 'T-V-MNSP1'
ORDER BY ABS(d.MWFLOW - p.MWFLOW) DESC
```

---

### Dataset 12: `Data_Freshness`

A single-row query that returns timestamps for the latest 5PD run. Use this to build a staleness indicator card so you know at a glance whether the data is current.

**Columns:**
- `P5MIN_RUN_DATETIME` — when AEMO published the latest 5PD run
- `FIRST_5PD_INTERVAL` — the first forecast interval in that run (should be close to current NEM time)
- `LAST_DISPATCH_INTERVAL` — the most recent actual dispatch interval

```sql
SELECT
  (SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_REGIONSOLUTION) AS P5MIN_RUN_DATETIME,
  (SELECT MIN(INTERVAL_DATETIME) FROM AUGUSTA.P5MIN_REGIONSOLUTION
   WHERE RUN_DATETIME = (SELECT MAX(RUN_DATETIME) FROM AUGUSTA.P5MIN_REGIONSOLUTION)
  ) AS FIRST_5PD_INTERVAL,
  (SELECT MAX(SETTLEMENTDATE) FROM AUGUSTA.DISPATCHPRICE WHERE INTERVENTION = 0) AS LAST_DISPATCH_INTERVAL
FROM DUAL
```

---

## Step 3: Build the Report Pages

### 3.1 Data Freshness Card (First 5PD indicator)

This card shows the first 5PD interval so you can tell at a glance if data is stale.

#### A. Add the Card visual

1. Make sure you've loaded the `Data_Freshness` query (Dataset 12 above) and clicked **Close & Apply**.
2. On your report page, go to the **Visualizations** pane (right side) and click the **Card** icon (looks like a single number tile).
3. A blank card appears on the canvas. Click it to select it.
4. In the **Data** pane (far right), expand `Data_Freshness` — you'll see the three columns.
5. Drag `FIRST_5PD_INTERVAL` into the **Fields** well of the card (or just tick the checkbox).
6. The card will show a date/time value. Resize and position it where you want (e.g. top-right corner).

#### B. Format the timestamp display

1. With the card selected, click the **Format** tab in the Visualizations pane (paint roller icon).
2. Expand **Callout value**:
   - Set **Display units** to **None** (otherwise it might show "2026" or abbreviate weirdly).
3. To control the date format: click the dropdown arrow on `FIRST_5PD_INTERVAL` in the Fields well > choose **FIRST_5PD_INTERVAL** (not "Count" or "Earliest") — you want the raw value.
4. Add a title: in the Format pane, expand **Title** > turn it **On** > type `First 5PD` or `Data As At`.

#### C. Create DAX measures (for staleness coloring)

DAX measures are calculated values that update dynamically. Here's how to create one:

1. In the **Data** pane (right side), right-click on `Data_Freshness` > **New measure**.
2. A formula bar appears at the top. Delete everything and paste:

```dax
Minutes_Stale =
DATEDIFF(
    MAX(Data_Freshness[FIRST_5PD_INTERVAL]),
    NOW() - TIME(1, 0, 0),
    MINUTE
)
```

> **Why the `- TIME(1, 0, 0)`?** AEMO data is always in AEST (UTC+10, no daylight saving). Your machine is in AEDT (UTC+11) during daylight saving, so `NOW()` is 1 hour ahead of the data. Subtracting 1 hour converts your local AEDT back to AEST so the comparison is correct.
>
> **When clocks go back to AEST** (first Sunday in April): remove the `- TIME(1, 0, 0)` so it's just `NOW()`.

3. Press **Enter**. You'll see `Minutes_Stale` appear under `Data_Freshness` in the Data pane (with a calculator icon — that means it's a measure, not a column).

4. Right-click `Data_Freshness` again > **New measure**. Paste:

```dax
Staleness_Color =
SWITCH(
    TRUE(),
    [Minutes_Stale] > 15, "#F43F5E",
    [Minutes_Stale] > 7, "#F59E0B",
    "#10B981"
)
```

5. Press **Enter**. Now you have two measures.

> **What these do:** `Minutes_Stale` calculates how many minutes ago the first 5PD interval was. `Staleness_Color` returns a hex color — green if fresh (<7 min), amber if getting old (7–15 min), red if stale (>15 min).

#### D. Show staleness — two options

The Card visual doesn't support conditional formatting well. Use one of these instead:

**Option 1: Use a Table visual styled as a card (supports color rules)**

1. Add a **Table** visual (grid icon) instead of a Card.
2. Drag `FIRST_5PD_INTERVAL` and `Minutes_Stale` into the Columns well.
3. Style it to look like a card:
   - Format pane > **Column headers** > toggle **Off**.
   - Format pane > **Grid** > **Border** > toggle **Off**.
   - Format pane > **Values** > **Font size** > set to **18–24**.
   - Format pane > **Style presets** > **None**.
4. Apply color rules:
   - Format pane > **Cell elements** > pick `Minutes_Stale` column.
   - Toggle **Background color** On > click **fx**.
   - **Format style**: Rules.
   - Add: `>= 15` → `#F43F5E` (red), `>= 7` → `#F59E0B` (amber), `< 7` → `#10B981` (green).
   - Click **OK**.
5. Resize it small.

**Option 2: Bake the status into the text (simplest, no formatting needed)**

1. Right-click `Data_Freshness` > **New measure** and paste:

```dax
First_5PD_Status =
VAR First5PD = MAX(Data_Freshness[FIRST_5PD_INTERVAL])
VAR Stale = DATEDIFF(First5PD, NOW() - TIME(1, 0, 0), MINUTE)
RETURN
FORMAT(First5PD, "DD MMM HH:mm") & " (" & Stale & "m ago)" &
IF(Stale > 15, " - STALE", IF(Stale > 7, " - CHECK", " - OK"))
```

2. Drag `First_5PD_Status` into a regular **Card** visual.
3. It shows e.g. `20 Feb 14:35 (3m ago) - OK` or `20 Feb 14:10 (28m ago) - STALE`.
4. No conditional formatting needed — the status is in the text.

#### E. Optional: show Minutes_Stale as a second card

1. Add another **Card** visual.
2. Drag `Minutes_Stale` into its Fields well.
3. Title it `Minutes Since 5PD`.
4. Apply the same `Staleness_Color` conditional formatting.
5. Now you've got a number like `3` (fresh) or `22` (stale) with color-coding.

#### F. Copy the card to every page

1. Click the card visual(s) > **Ctrl+C**.
2. Navigate to another report page tab (bottom of screen).
3. **Ctrl+V** to paste. It keeps all formatting and measures.

---

### 3.2 Recommended page structure

Create **5 report pages** in Power BI (click the **+** at the bottom to add pages), one for each tab on the web app:

| Page | Datasets used | Visuals |
|---|---|---|
| **1. Prices** | `5PD_Price_Changes`, `30PD_Price_Changes` | Two tables side by side |
| **2. Demand** | `5PD_Demand_Changes`, `30PD_Demand_Changes` | Two tables side by side |
| **3. Interconnectors** | `5PD_Interconnector_Changes`, `30PD_Interconnector_Changes` | Two tables side by side |
| **4. Sensitivities** | `5PD_Sensitivity_Changes`, `30PD_Sensitivity_Changes` | Two tables side by side |
| **5. Actuals vs 5PD** | `Actuals_vs_5PD_Prices`, `Actuals_vs_5PD_Demand`, `Actuals_vs_5PD_Interconnectors` | Three tables stacked |

To add a table visual:

1. Click the **Table** icon in the Visualizations pane (grid icon).
2. From the Data pane, drag columns into the **Columns** well. For example on the Prices page, drag `INTERVAL_DATETIME`, `REGIONID`, `PREVIOUS_RRP`, `CURRENT_RRP`, `DELTA` from `5PD_Price_Changes`.
3. Resize the table to fill half the page. Repeat for the 30PD table next to it.

---

### 3.3 Adding slicers (filters)

Slicers let you filter data by region, direction, etc.

1. Click the **Slicer** icon in the Visualizations pane (funnel with lines).
2. Drag `REGIONID` from one of your datasets into the slicer's **Field** well.
3. Format it as a dropdown: with the slicer selected, go to **Format** > **Slicer settings** > **Style** > choose **Dropdown**.
4. Values will be: `QLD1`, `NSW1`, `VIC1`, `SA1`.
5. On the Interconnectors page, use `INTERCONNECTORID` instead.

**Direction slicer (increase/decrease filter):**

This requires a calculated column (different from a measure — a column adds a value to every row):

1. In the Data pane, right-click `5PD_Price_Changes` > **New column**.
2. Paste into the formula bar:

```dax
Direction = IF([DELTA] > 0, "Increase", IF([DELTA] < 0, "Decrease", "No Change"))
```

3. Press **Enter**. A new `Direction` column appears in that table.
4. Add a **Slicer** visual and drag `Direction` into it.
5. Repeat for each dataset where you want this filter.

> **Measure vs Column vs Calculated column — when to use what:**
> - **Measure** (New measure): a dynamic calculation that changes based on filters/context. Use for things like `Minutes_Stale` or totals. Shows a calculator icon.
> - **Calculated column** (New column): adds a fixed value to every row in the table. Use for things like `Direction` that categorize each row. Shows a table column icon.
> - **Column from query**: comes directly from your SQL. No DAX needed.

---

### 3.4 Formatting the Delta column (red/green color coding)

1. Click your **Table** visual to select it.
2. In the **Format** pane (paint roller), expand **Cell elements**.
3. Find **Background color** and toggle it **On**.
4. Click the **fx** button next to it.
5. In the dialog:
   - **Apply to**: select `DELTA`
   - **Format style**: Rules
   - Click **+ New rule** and set up:

| Rule | Min | Max | Color |
|---|---|---|---|
| 1 | (blank) | 0 | `#10B981` (green) |
| 2 | 0 | (blank) | `#F43F5E` (red/rose) |

   - Click **OK**.
6. Now positive deltas show red (price went up), negative show green (price went down).

**Alternative — font color instead of background:**
Same steps but use **Font color** instead of **Background color** under Cell elements.

---

### 3.5 Formatting currency and MW columns

#### In Model view (sets default format everywhere):
1. Click the **Model view** icon in the left sidebar (looks like a database diagram).
2. Click a table (e.g. `5PD_Price_Changes`).
3. Click a price column (e.g. `CURRENT_RRP`).
4. In the **Properties** pane on the right:
   - **Data type**: Fixed decimal number
   - **Format**: Currency
   - **Currency symbol**: `$ (English - Australia)`
   - **Decimal places**: 2
5. Repeat for `PREVIOUS_RRP` and `DELTA`.

#### For MW columns (`CURRENT_TOTALDEMAND`, etc.):
1. Same process — click the column in Model view.
2. **Format**: Whole number.
3. **Thousands separator**: On (shows `12,345` instead of `12345`).

---

## Step 4: Refresh & Publish

### Manual refresh (Power BI Desktop)
- Click **Refresh** in the Home ribbon to re-run all queries against Oracle.
- Keyboard shortcut: **Ctrl+Alt+F5** (refresh all) or **F5** (refresh selected).

### Automatic page refresh (Power BI Service — recommended)
This is the best option for near-real-time data without DirectQuery:

1. **Publish** the report to Power BI Service.
2. In Power BI Desktop, select the page > **Format** pane > **Page refresh**.
3. Turn it **On** and set the interval (e.g. every **5 minutes** to match AEMO dispatch).
4. Publish again.
5. In Power BI Service, go to **Workspace** > **Settings** (gear icon) > **Datasets** > your dataset:
   - Enable **Scheduled refresh** and set a frequency (minimum 30 min for Pro, 15 min with Premium/PPU).
   - The auto page refresh will re-query on top of this.
6. You need an **On-premises Data Gateway** installed since Oracle is on your internal network.

> **Note:** Auto page refresh at intervals below 30 min requires Power BI Premium or Premium Per User (PPU). With Pro, the minimum interval is 30 minutes.

### DirectQuery (real-time alternative)
If you need the data to be truly live on every interaction:
1. When connecting to Oracle, choose **DirectQuery** instead of **Import**.
2. Every visual interaction will run the SQL live against Oracle.
3. With DirectQuery, you can enable **Auto page refresh** down to every **5 seconds** (Premium) or **30 minutes** (Pro).
4. Trade-off: slower per-interaction, but always shows current data.
5. Note: Some Power Query transformations are not supported in DirectQuery mode.

### Quick refresh checklist

| Method | Min interval | Requires Gateway? | Notes |
|---|---|---|---|
| Manual (Desktop) | On-demand | No | Ctrl+Alt+F5 |
| Scheduled (Service, Pro) | 30 min | Yes | 8 refreshes/day |
| Scheduled (Service, PPU/Premium) | 15 min | Yes | 48 refreshes/day |
| Auto page refresh (Import) | 30 min (Pro) / 1 min (Premium) | Yes | Triggers dataset refresh |
| Auto page refresh (DirectQuery) | 5 sec (Premium) / 30 min (Pro) | Yes | Queries Oracle live |

---

## Step 5: Install the On-Premises Data Gateway (for scheduled refresh)

Since the Oracle database is on the internal network:

1. Download the gateway: https://powerbi.microsoft.com/gateway/
2. Install on a machine that can reach `ora-infoserver1-prod:1521`.
3. Sign in with your Power BI account.
4. Register the gateway in Power BI Service.
5. Add the Oracle data source in the gateway config with the credentials above.

---

## Oracle Tables Reference

All tables are in the `AUGUSTA` schema:

| Table | Used for |
|---|---|
| `P5MIN_REGIONSOLUTION` | 5-min PD prices and demand |
| `PREDISPATCHPRICE` | 30-min PD prices |
| `PREDISPATCHREGIONSUM` | 30-min PD demand |
| `P5MIN_INTERCONNECTORSOLN` | 5-min PD interconnector flows |
| `PREDISPATCHINTERCONNECTORRES` | 30-min PD interconnector flows |
| `P5MIN_PRICESENSITIVITIES` | 5-min PD price sensitivities (43 scenarios) |
| `PREDISPATCHPRICESENSITIVITIES` | 30-min PD price sensitivities (43 scenarios) |
| `PREDISPATCHSCENARIODEMAND` | Scenario labels (which region/MW offset per scenario) |
| `DISPATCHPRICE` | Actual dispatch prices |
| `DISPATCHREGIONSUM` | Actual dispatch demand |
| `DISPATCHINTERCONNECTORRES` | Actual interconnector flows |

---

## Interconnector ID Reference

| ID | Name |
|---|---|
| `N-Q-MNSP1` | Terranora (NSW-QLD) |
| `NSW1-QLD1` | QNI (NSW-QLD) |
| `VIC1-NSW1` | VIC-NSW |
| `V-SA` | Heywood (VIC-SA) |
| `V-S-MNSP1` | Murraylink (VIC-SA) |
| `T-V-MNSP1` | Basslink (TAS-VIC) |

---

## Troubleshooting: "No ODAC driver is found on the system"

If you get this error when connecting Power BI to Oracle:

> An error happened while reading data from the provider: 'No ODAC driver is found on the system.'

Follow these steps:

### 1. Install the correct Oracle package

You need **Oracle Client for Microsoft Tools** (ODAC/ODP.NET), not just the basic Instant Client.

Download: https://www.oracle.com/database/technologies/appdev/ocmt.html

- Install the **64-bit** version (must match Power BI Desktop's architecture).
- If you have both 32-bit and 64-bit Oracle clients installed, **uninstall the 32-bit** version to avoid conflicts.

### 2. Set environment variables

After installing, open **System Properties** > **Environment Variables** and add/update these **System variables** (adjust the path to match your install):

| Variable | Value (example) |
|---|---|
| `ORACLE_HOME` | `C:\oracle\product\19.0\client_1` |
| `TNS_ADMIN` | `C:\oracle\product\19.0\client_1\network\admin` |
| `PATH` (append) | `C:\oracle\product\19.0\client_1;C:\oracle\product\19.0\client_1\bin` |

### 3. Restart your machine

A full restart is required for the new environment variables and driver registration to take effect. Restarting Power BI alone is not sufficient.

### 4. If still not working — register ODP.NET in the GAC

Open an **elevated Command Prompt** and run:

```cmd
cd C:\oracle\product\19.0\client_1\odp.net\bin\4
OraProvCfg.exe /action:gac /providerPath:"Oracle.DataAccess.dll"
OraProvCfg.exe /action:config /product:odp /frameworkversion:v4.0.30319 /providerPath:"Oracle.DataAccess.dll"
```

Adjust the path to your actual Oracle install location.

### 5. Verify the driver is registered

In an elevated Command Prompt, run:

```cmd
reg query "HKLM\SOFTWARE\Oracle" /s
```

You should see an `ORACLE_HOME` entry. If missing, the install didn't register properly — try reinstalling.

### 6. Alternative: use ODBC connection

If ODAC still doesn't work, you can connect via ODBC instead:

1. Install the **Oracle ODBC driver** (included in the Oracle Client for Microsoft Tools installer).
2. In Power BI, use **Get Data** > **ODBC** instead of **Oracle Database**.
3. Configure a DSN pointing to `ora-infoserver1-prod:1521/LEG1`.

### Reference links

- [Power BI — Connect to Oracle Database](https://learn.microsoft.com/en-us/power-bi/connect-data/desktop-connect-oracle-database#installing-the-oracle-client)
- [Oracle Client for Microsoft Tools](https://www.oracle.com/database/technologies/appdev/ocmt.html)
- [Oracle — Connecting Power BI to Oracle (PDF)](https://www.oracle.com/a/ocom/docs/database/microsoft-powerbi-connection-adw.pdf)
- [Power BI — ODBC Support](https://learn.microsoft.com/en-us/power-bi/paginated-reports/paginated-reports-odbc-support)

---

## Limitations vs the Web App

| Feature | Web App | Power BI |
|---|---|---|
| Auto-refresh | Every 30 seconds | Minimum 30 min (scheduled) or on-demand (DirectQuery) |
| Rebid reason generator | Click rows to build text | Not available natively |
| Sensitivity UNPIVOT queries | Handled in code | May need Oracle views if Power Query struggles |
| Dark theme | Built-in | Use Power BI dark theme or custom theme JSON |
