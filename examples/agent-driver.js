#!/usr/bin/env node
/* agent-driver.js — drive the page's window.SimAgent via puppeteer-core.
 *
 * Serve the repo first (e.g. `npm run serve` from the repo root), then:
 *   node examples/agent-driver.js                  # headless, full demo
 *   node examples/agent-driver.js --headed         # visible Chrome window
 *   node examples/agent-driver.js --url <override> # point at a deployment
 */
"use strict";

const puppeteer = require("puppeteer-core");

const URL = "http://localhost:8080/tcp-inflight.html";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const urlOverride = (() => {
  const i = args.indexOf("--url");
  return i >= 0 ? args[i + 1] : null;
})();
const targetUrl = urlOverride || URL;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !headed,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();

  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error" || t === "warning") console.error("[page " + t + "]", msg.text());
  });

  console.log("→ navigating to " + targetUrl);
  await page.goto(targetUrl, { waitUntil: "networkidle0" });

  // Wait for SimAgent to be available
  await page.waitForFunction(() => typeof window.SimAgent !== "undefined", { timeout: 5000 });
  const version = await page.evaluate(() => window.SimAgent.version);
  console.log("→ SimAgent v" + version + " ready");

  // ---- Demo 1: cold TCP, default IW=10 ----
  console.log("\n=== Demo 1: cold TCP, IW10 ===");
  const r1 = await page.evaluate(async () => {
    await window.SimAgent.applyPreset("cold-iw10");
    await window.SimAgent.runToCompletion({ visual: false, maxSimMs: 60000 });
    return window.SimAgent.getArtifact();
  });
  console.log("  run_id:", r1.run_id);
  console.log("  completed:", r1.summary.completed, "at", r1.summary.elapsed_sim_ms, "ms");
  console.log("  cwnd: min=" + r1.summary.cwnd_min, "max=" + r1.summary.cwnd_max);
  console.log("  goodput:", r1.summary.goodput_Mbps.toFixed(1), "Mbps");
  console.log("  events:", r1.events.map((e) => `${e.t_ms}ms ${e.type}`).join(", "));

  // ---- Demo 2: the three blog presets ----
  console.log("\n=== Demo 2: blog presets ===");
  for (const name of ["cold-iw10", "warm-iw10", "warm-iw3500-rwnd-warm"]) {
    const s = await page.evaluate(async (preset) => {
      await window.SimAgent.applyPreset(preset);
      await window.SimAgent.runToCompletion({ visual: false, maxSimMs: 60000 });
      return window.SimAgent.getSummary();
    }, name);
    console.log(
      "  " + name.padEnd(14) +
        "elapsed=" + String(s.elapsed_sim_ms).padStart(7) + "ms " +
        "goodput=" + s.goodput_Mbps.toFixed(1).padStart(6) + " Mbps"
    );
  }

  // ---- Demo 3: runUntil event ----
  console.log("\n=== Demo 3: runUntil Hystart exit ===");
  const r4 = await page.evaluate(async () => {
    await window.SimAgent.applyPreset("cold-iw10");
    await window.SimAgent.runUntil(
      (state) => state.cc_phase === "cong-avoid",
      { visual: false, maxSimMs: 60000 }
    );
    return window.SimAgent.getState();
  });
  console.log("  stopped at cc_phase=" + r4.cc_phase, "cwnd=" + r4.cwnd_seg);

  await browser.close();
  console.log("\n✓ done");
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
