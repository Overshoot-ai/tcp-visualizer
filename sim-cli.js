#!/usr/bin/env node
/* sim-cli.js — Node CLI runner for the in-browser TCP/queue/cubic sim.
 *
 * Loads the pure model from sim-core.js and the shared runner from
 * sim-runner.js. Emits a CSV trace (one row per runner sample) plus a
 * summary block so we can sanity-check the queue-driven loss + cubic
 * dynamics without opening a browser.
 *
 * Usage:
 *   node sim-cli.js --preset cold-iw10 --seconds 5
 *   node sim-cli.js --preset warm-iw10 --seconds 5
 *   node sim-cli.js --preset warm-iw3500-rwnd-warm --seconds 5 --artifact
 *
 * Flags:
 *   --preset <name>               (default cold-iw10; see sim-core.js presets)
 *   --cc <custom|cubic|bbr>       (default: the preset's ccMode)
 *   --mode <tcp|udp>              (default tcp)
 *   --seconds <n>                 (default 5)
 *   --interval <ms>               (default 100; sample period in sim ms)
 *   --initial-cwnd <n>            (default: the preset's initCwndSeg)
 *   --router-read-mbps <n>        (default: the preset's routerReadMbps)
 *   --router-write-mbps <n>       (default: the preset's routerWriteMbps)
 *   --artifact                    (also dump the JSON artifact to stderr)
 */
"use strict";

const SC = require("./sim-core.js");
const SR = require("./sim-runner.js");
const { createSim, resetSimState, applyPresetToSim, presets } = SC;

/* ---------- arg parsing (Node stdlib only) ---------- */
function parseArgs(argv) {
  const out = {
    preset: "cold-iw10",
    cc: null, // null = use the preset's ccMode
    mode: "tcp",
    seconds: 5,
    interval: 100,
    initialCwnd: null, // null = use the preset's initCwndSeg
    routerReadMbps: null,
    routerWriteMbps: null,
    artifact: false,
    queueKB: null,
    handshake: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--preset": out.preset = next; i++; break;
      case "--cc": out.cc = next; i++; break;
      case "--mode": out.mode = next; i++; break;
      case "--seconds": out.seconds = parseFloat(next); i++; break;
      case "--interval": out.interval = parseFloat(next); i++; break;
      case "--initial-cwnd": out.initialCwnd = parseInt(next, 10); i++; break;
      case "--router-read-mbps": out.routerReadMbps = parseFloat(next); i++; break;
      case "--router-write-mbps": out.routerWriteMbps = parseFloat(next); i++; break;
      case "--queue-kb": out.queueKB = parseInt(next, 10); i++; break;
      case "--handshake": out.handshake = true; break;
      case "--artifact": out.artifact = true; break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        console.error("unknown flag: " + a);
        printHelp();
        process.exit(1);
    }
  }
  if (!presets[out.preset]) {
    console.error("unknown preset: " + out.preset);
    process.exit(1);
  }
  if (out.cc !== null && out.cc !== "custom" && out.cc !== "cubic" && out.cc !== "bbr") {
    console.error("--cc must be 'custom', 'cubic', or 'bbr'");
    process.exit(1);
  }
  if (out.mode !== "tcp" && out.mode !== "udp") {
    console.error("--mode must be 'tcp' or 'udp'");
    process.exit(1);
  }
  return out;
}

function printHelp() {
  console.error(
    "Usage: node sim-cli.js [--preset " + Object.keys(presets).join("|") + "] " +
      "[--cc custom|cubic|bbr] [--mode tcp|udp] [--seconds N] " +
      "[--interval ms] [--initial-cwnd N] [--router-read-mbps N] [--router-write-mbps N] [--queue-kb N] [--handshake] [--artifact]"
  );
}

/* ---------- main ---------- */
function main() {
  const args = parseArgs(process.argv);

  // Build a sim with preset values applied (including the preset's ccMode
  // and initCwndSeg), then apply CLI overrides. resetSimState() initializes
  // counters and, in cubic/bbr mode, overrides cwndSeg with initialCwndSeg
  // so slow-start starts cleanly (matches the browser's reset).
  const sim = createSim();
  applyPresetToSim(sim, args.preset);
  sim.mode = args.mode;
  if (args.cc != null) sim.ccMode = args.cc;
  if (args.initialCwnd != null) sim.initialCwndSeg = args.initialCwnd;
  if (args.routerReadMbps != null) sim.routerReadMbps = args.routerReadMbps;
  if (args.routerWriteMbps != null) sim.routerWriteMbps = args.routerWriteMbps;
  if (args.queueKB != null) {
    sim.queueSizeBytes = args.queueKB * 1024;
  }
  if (args.handshake) sim.handshake = true;
  resetSimState(sim);

  // Hand off to the shared runner.
  const runner = SR.create(sim, { sampleEveryMs: args.interval });
  runner.setPresetTag(args.preset);
  runner.reset();
  // Reproducible runs would need a seeded RNG; the sim uses Math.random()
  // for loss + jitter. Leaving it unseeded — variance run-to-run is part of
  // what we want to see.

  const totalSimMs = args.seconds * 1000;
  const stepMs = Math.max(0.1, sim.rtt / 8);
  const artifact = runner.runDeterministic({
    maxSimMs: totalSimMs,
    stepMs: stepMs,
  });

  // CSV header — column set kept compatible with the prior layout that
  // downstream analysis scripts may depend on.
  console.log(
    [
      "t_ms",
      "cwnd",
      "ccPhase",
      "inflightSeg",
      "queueDepthBytes",
      "queueDrops",
      "retransmits",
      "ackedSeg",
      "recvSeg",
      "goodputMbps_inst",
      "goodputMbps_avg",
    ].join(",")
  );

  const samples = artifact.samples;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const avgMbps =
      s.t_ms > 0 ? (s.acked_seg * s.mss_B * 8) / (s.t_ms * 1000) : 0;
    console.log(
      [
        s.t_ms.toFixed(2),
        s.cwnd_seg,
        s.cc_phase,
        s.inflight_seg,
        s.q_depth_bytes,
        s.q_drops_cumulative,
        s.retransmits_cumulative,
        s.acked_seg,
        s.recv_seg,
        s.goodput_Mbps.toFixed(3),
        avgMbps.toFixed(3),
      ].join(",")
    );
  }

  // Summary derived from the runner.
  const sm = artifact.summary;
  const cfg = artifact.config;
  const pct =
    sim.segCount > 0 ? (sim.ackedCount / sim.segCount) * 100 : 0;
  console.log("# summary");
  console.log("# preset=" + args.preset + " cc=" + sim.ccMode + " mode=" + args.mode);
  console.log(
    "# rtt_ms=" + cfg.rtt_ms +
    " mss_B=" + cfg.mss_B +
    " router_read_Mbps=" + cfg.router_read_mbps +
    " router_write_Mbps=" + cfg.router_write_mbps +
    " linkBw_Mbps=" + cfg.link_bw_mbps +
    " effective_drain_Mbps=" + cfg.effective_drain_mbps +
    " queue_KB=" + Math.round(cfg.queue_KB)
  );
  console.log("# avg_goodput_Mbps=" + sm.goodput_Mbps.toFixed(3));
  console.log(
    "# cwnd_min=" + (sm.cwnd_min == null ? "-" : sm.cwnd_min) +
      " cwnd_max=" + sm.cwnd_max +
      " cwnd_final=" + sm.cwnd_final
  );
  console.log(
    "# queue_drops=" + sm.queue_drops_total +
      " retransmits=" + sm.retransmits_total +
      " udp_drops=" + sim.drops
  );
  if (sm.completed) {
    console.log("# completed_at_ms=" + sm.elapsed_sim_ms.toFixed(2));
  } else {
    console.log(
      "# incomplete acked_pct=" + pct.toFixed(2) +
        " elapsed_ms=" + sm.elapsed_sim_ms.toFixed(2)
    );
  }

  if (args.artifact) {
    // Dump the full artifact to stderr so stdout (CSV) stays clean.
    process.stderr.write(JSON.stringify(artifact, null, 2) + "\n");
  }
}

main();
