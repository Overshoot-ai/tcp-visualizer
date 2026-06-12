/* sim-runner.js — shared runner for the in-browser TCP/queue/cubic sim.
 *
 * Loaded by tcp-inflight.html via <script src="sim-runner.js"></script>
 * (exposes window.SimRunner) and by sim-cli.js via require() in Node.
 *
 * Wraps the pure model in sim-core.js. Provides:
 *   - stepBy(dtSim)       : single sub-stepped advance + sample/event capture
 *   - runDeterministic    : tight loop (no RAF) for CLI / runToCompletion
 *   - attachRafLoop / startRaf / pauseRaf : browser-driven visual mode
 *   - reset()             : clears trace, events, snapshot caches; re-inits sim
 *   - getTrace / getEvents / getSummary / getArtifact
 *   - replay(artifact, ...): re-apply config + run
 *
 * Sim-core is the source of truth for all state mutation. The runner only
 * snapshots and records.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./sim-core.js"));
  } else {
    root.SimRunner = factory(root.SimCore);
  }
})(typeof self !== "undefined" ? self : this, function (SimCore) {
  "use strict";

  const VERSION = "1.0";

  /* ---------- uuid ---------- */
  function uuidv4() {
    // Prefer crypto.randomUUID() (browser ≥92, Node ≥14.17).
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch (e) {}
    // Fallback RFC4122 v4.
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        out += "-";
      } else if (i === 14) {
        out += "4";
      } else if (i === 19) {
        out += hex[(Math.random() * 4) | 0 | 8];
      } else {
        out += hex[(Math.random() * 16) | 0];
      }
    }
    return out;
  }

  /* ---------- helpers ---------- */
  function inflightCount(sim) {
    let n = 0;
    for (let i = 0; i < sim.inflight.length; i++) {
      if (!sim.inflight[i].done) n++;
    }
    return n;
  }
  function recvCount(sim) {
    let n = 0;
    for (let i = 0; i < sim.segCount; i++) if (sim.recvSet[i]) n++;
    return n;
  }
  function queueDepthBytes(sim) {
    const waitMs = Math.max(0, sim.lastPacketLeaveTime - sim.simTime);
    return Math.round(waitMs * sim.linkBwMbps * 125);
  }
  function advRwndSeg(sim) {
    return Math.floor(Math.max(0, sim.rmemSize - sim.rmemUsed) / sim.mss);
  }

  /* ---------- runner factory ---------- */
  function create(sim, opts) {
    opts = opts || {};
    const sampleEveryMs = opts.sampleEveryMs != null ? opts.sampleEveryMs : 100;

    // Internal record state.
    let trace = [];
    let events = [];
    let lastSampleSimTime = 0;
    let lastSampleAckedSeg = 0;
    let lastSampleQueueDrops = 0;
    let summary = makeEmptySummary();
    // Event-detection snapshot.
    let snap = newSnap();
    let runId = uuidv4();
    let lastAppliedPreset = null;

    // RAF loop state.
    let rafHandle = null;
    let rafActive = false;
    let lastRealTs = 0;
    let rafCallbacks = { onTick: null, onFinished: null };

    function newSnap() {
      return {
        ccPhase: sim.ccPhase,
        inRecovery: sim.inRecovery,
        queueDrops: sim.queueDrops,
        retransmits: sim.retransmits,
        cwndSeg: sim.cwndSeg,
        ssthresh: sim.ssthresh,
        wmax: sim.wmax,
        recoveryHighSeq: sim.recoveryHighSeq,
        finished: sim.finished,
        firstLossSeen: false,
        hystartExitSeen: false,
        bbrState: sim.bbr_state,
      };
    }
    function makeEmptySummary() {
      return {
        completed: false,
        elapsed_sim_ms: 0,
        acked_segments: 0,
        acked_pct: 0,
        goodput_KBms: 0,
        goodput_Mbps: 0,
        cwnd_min: null,
        cwnd_max: 0,
        cwnd_final: 0,
        queue_drops_total: 0,
        retransmits_total: 0,
        wmem_peak_bytes: 0,
        rmem_peak_bytes: 0,
        first_loss_t_ms: null,
        hystart_exit_t_ms: null,
      };
    }

    function reset() {
      SimCore.resetSimState(sim);
      trace = [];
      events = [];
      summary = makeEmptySummary();
      lastSampleSimTime = 0;
      lastSampleAckedSeg = 0;
      lastSampleQueueDrops = 0;
      snap = newSnap();
      runId = uuidv4();
      // Take the initial t=0 sample so callers see a non-empty trace.
      takeSample(true);
    }

    function takeSample(forceInitial) {
      const t = sim.simTime;
      const intervalMs = t - lastSampleSimTime;
      const ackedSegNow = sim.ackedCount;
      const dAcked = ackedSegNow - lastSampleAckedSeg;
      const dBytes = dAcked * sim.mss;
      const goodput_KBms = intervalMs > 0 ? dBytes / 1000 / intervalMs : 0;
      const goodput_Mbps = intervalMs > 0 ? (dBytes * 8) / (intervalMs * 1000) : 0;
      const infl = inflightCount(sim);
      const q_drops_cumulative = sim.queueDrops;
      const q_drops_delta = q_drops_cumulative - lastSampleQueueDrops;
      const cwndInt = Math.floor(sim.cwndSeg);
      const sample = {
        t_ms: +t.toFixed(3),
        cwnd_seg: cwndInt,
        cc_phase: sim.ccPhase,
        in_recovery: !!sim.inRecovery,
        inflight_seg: infl,
        inflight_bytes: infl * sim.mss,
        q_depth_bytes: queueDepthBytes(sim),
        q_drops_cumulative: q_drops_cumulative,
        retransmits_cumulative: sim.retransmits,
        acked_seg: ackedSegNow,
        recv_seg: recvCount(sim),
        goodput_KBms: +goodput_KBms.toFixed(4),
        goodput_Mbps: +goodput_Mbps.toFixed(4),
        rtt_ms: sim.rtt,
        link_bw_mbps: sim.linkBwMbps,
        mss_B: sim.mss,
        wmem_used_bytes: sim.wmemUsed,
        rmem_used_bytes: sim.rmemUsed,
        advertised_rwnd_seg: advRwndSeg(sim),
      };
      trace.push(sample);

      // queue_drop_burst event: ≥5 drops in this sample interval.
      if (!forceInitial && q_drops_delta >= 5) {
        pushEvent("queue_drop_burst", { count: q_drops_delta });
      }

      // Track peaks.
      if (sim.wmemUsed > summary.wmem_peak_bytes) summary.wmem_peak_bytes = sim.wmemUsed;
      if (sim.rmemUsed > summary.rmem_peak_bytes) summary.rmem_peak_bytes = sim.rmemUsed;
      if (summary.cwnd_min == null || cwndInt < summary.cwnd_min) summary.cwnd_min = cwndInt;
      if (cwndInt > summary.cwnd_max) summary.cwnd_max = cwndInt;
      summary.cwnd_final = cwndInt;

      lastSampleSimTime = t;
      lastSampleAckedSeg = ackedSegNow;
      lastSampleQueueDrops = q_drops_cumulative;
    }

    function pushEvent(type, data) {
      events.push({ t_ms: +sim.simTime.toFixed(3), type: type, data: data || {} });
    }

    // Detect transitions across a stepBy call.
    function detectEvents(prev) {
      // first_loss: queueDrops increased from 0 OR retransmits increased from 0.
      if (!prev.firstLossSeen && !snap.firstLossSeen) {
        if (sim.queueDrops > prev.queueDrops || sim.retransmits > prev.retransmits) {
          // Find an approximate idx — use ackedCount as the hole indicator.
          pushEvent("first_loss", { idx: sim.ackedCount });
          snap.firstLossSeen = true;
          if (summary.first_loss_t_ms == null) {
            summary.first_loss_t_ms = +sim.simTime.toFixed(3);
          }
        }
      }
      // hystart_exit: ccPhase went slow-start → cong-avoid without recovery
      // (i.e., not because of a loss → ssthresh = cwnd, no cubicAnchored).
      if (
        !snap.hystartExitSeen &&
        prev.ccPhase === "slow-start" &&
        sim.ccPhase === "cong-avoid" &&
        !sim.cubicAnchored
      ) {
        pushEvent("hystart_exit", { cwnd_at_exit: Math.floor(sim.cwndSeg) });
        snap.hystartExitSeen = true;
        if (summary.hystart_exit_t_ms == null) {
          summary.hystart_exit_t_ms = +sim.simTime.toFixed(3);
        }
      }
      // recovery_enter
      if (!prev.inRecovery && sim.inRecovery) {
        pushEvent("recovery_enter", {
          cwnd: Math.floor(sim.cwndSeg),
          wmax: sim.wmax,
          ssthresh: sim.ssthresh,
        });
      }
      // recovery_exit
      if (prev.inRecovery && !sim.inRecovery) {
        pushEvent("recovery_exit", {
          cwnd: Math.floor(sim.cwndSeg),
          recovery_high_seq: prev.recoveryHighSeq,
        });
      }
      // rto: ccPhase reset to "slow-start" while previously in cong-avoid
      // with cubic anchored — that's the RTO path inside step().
      // Also: cwnd dropped ≥30% in one step (defensive catch).
      if (
        prev.ccPhase === "cong-avoid" &&
        sim.ccPhase === "slow-start" &&
        sim.cubicAnchored
      ) {
        pushEvent("rto", {
          cwnd_before: Math.floor(prev.cwndSeg),
          cwnd_after: Math.floor(sim.cwndSeg),
        });
      } else if (
        // Not in BBR mode: there the bootstrap cwnd (initialCwndSeg) snaps
        // down to BtlBw×RTprop×gain as the first samples land — a normal
        // model convergence, not an RTO.
        sim.ccMode !== "bbr" &&
        prev.cwndSeg > 0 &&
        sim.cwndSeg <= prev.cwndSeg * 0.3 &&
        prev.cwndSeg - sim.cwndSeg >= 5 &&
        sim.ccPhase === "slow-start"
      ) {
        pushEvent("rto", {
          cwnd_before: Math.floor(prev.cwndSeg),
          cwnd_after: Math.floor(sim.cwndSeg),
        });
      }
      // BBR state transitions (only in BBR mode).
      if (sim.ccMode === "bbr" && prev.bbrState && sim.bbr_state !== prev.bbrState) {
        pushEvent("bbr_state_change", {
          from: prev.bbrState,
          to: sim.bbr_state,
          btlBw_Mbps: +((sim.bbr_btlBw_BytesPerMs * 8) / 1000).toFixed(3),
          rtprop_ms: sim.bbr_rtprop_ms === Infinity ? null : +sim.bbr_rtprop_ms.toFixed(3),
        });
      }
      // finished
      if (!prev.finished && sim.finished) {
        pushEvent("finished", { elapsed_ms: +sim.simTime.toFixed(3) });
      }

      // refresh snapshot.
      snap.ccPhase = sim.ccPhase;
      snap.inRecovery = sim.inRecovery;
      snap.queueDrops = sim.queueDrops;
      snap.retransmits = sim.retransmits;
      snap.cwndSeg = sim.cwndSeg;
      snap.ssthresh = sim.ssthresh;
      snap.wmax = sim.wmax;
      snap.recoveryHighSeq = sim.recoveryHighSeq;
      snap.finished = sim.finished;
      snap.bbrState = sim.bbr_state;
    }

    /* ---------- step / run ---------- */
    function stepBy(dtSim) {
      if (sim.finished || dtSim <= 0) return;
      // Snapshot before.
      const prev = {
        ccPhase: snap.ccPhase,
        inRecovery: snap.inRecovery,
        queueDrops: snap.queueDrops,
        retransmits: snap.retransmits,
        cwndSeg: snap.cwndSeg,
        recoveryHighSeq: snap.recoveryHighSeq,
        finished: snap.finished,
        bbrState: snap.bbrState,
      };
      // Sub-step so cubic / FRR transitions land on consistent dtSim granules.
      const maxStep = Math.max(0.1, sim.rtt / 8);
      let remaining = dtSim;
      while (remaining > maxStep) {
        SimCore.step(sim, maxStep);
        // Sample any boundaries crossed inside this sub-step.
        sampleIfDue();
        remaining -= maxStep;
        if (sim.finished) break;
      }
      if (!sim.finished && remaining > 0) {
        SimCore.step(sim, remaining);
        sampleIfDue();
      }
      detectEvents(prev);
    }

    function sampleIfDue() {
      // Take samples for any sampleEveryMs boundaries crossed since the last
      // sample. (Usually exactly one per stepBy in visual mode.)
      while (sim.simTime - lastSampleSimTime >= sampleEveryMs) {
        takeSample(false);
      }
    }

    function finalizeSummary() {
      const t = sim.simTime;
      const ackedBytes = sim.ackedCount * sim.mss;
      const goodput_KBms = t > 0 ? ackedBytes / 1000 / t : 0;
      const goodput_Mbps = t > 0 ? (ackedBytes * 8) / (t * 1000) : 0;
      summary.completed = !!sim.finished;
      summary.elapsed_sim_ms = +t.toFixed(3);
      summary.acked_segments = sim.ackedCount;
      summary.acked_pct =
        sim.segCount > 0 ? +((sim.ackedCount / sim.segCount) * 100).toFixed(3) : 0;
      summary.goodput_KBms = +goodput_KBms.toFixed(4);
      summary.goodput_Mbps = +goodput_Mbps.toFixed(4);
      summary.queue_drops_total = sim.queueDrops;
      summary.retransmits_total = sim.retransmits;
      summary.cwnd_final = Math.floor(sim.cwndSeg);
      if (summary.cwnd_min == null) summary.cwnd_min = Math.floor(sim.cwndSeg);
    }

    function runDeterministic(options) {
      options = options || {};
      const maxSimMs = options.maxSimMs != null ? options.maxSimMs : 60000;
      const untilFn = options.untilFn || null;
      const stepMs = options.stepMs || Math.max(0.1, sim.rtt / 8);

      // Ensure we have an initial sample at t=0 if trace is empty.
      if (trace.length === 0) takeSample(true);

      sim.running = true;
      while (sim.simTime < maxSimMs && !sim.finished) {
        if (untilFn && untilFn(getState())) break;
        const dt = Math.min(stepMs, maxSimMs - sim.simTime);
        stepBy(dt);
      }
      // Final sample if we drifted past the last sample boundary.
      if (sim.simTime - lastSampleSimTime > 1e-6) {
        takeSample(false);
      }
      finalizeSummary();
      return getArtifact();
    }

    /* ---------- RAF loop ---------- */
    function attachRafLoop(cbs) {
      cbs = cbs || {};
      rafCallbacks.onTick = cbs.onTick || null;
      rafCallbacks.onFinished = cbs.onFinished || null;
    }
    function detachRafLoop() {
      pauseRaf();
      rafCallbacks.onTick = null;
      rafCallbacks.onFinished = null;
    }
    function rafFrame(realTs) {
      if (!rafActive) return;
      if (lastRealTs === 0) lastRealTs = realTs;
      const dtReal = realTs - lastRealTs;
      lastRealTs = realTs;

      const wasFinished = sim.finished;
      if (sim.running) {
        const dtSim = dtReal * sim.speed;
        if (dtSim > 0) stepBy(dtSim);
      }
      if (rafCallbacks.onTick) rafCallbacks.onTick();
      if (!wasFinished && sim.finished) {
        finalizeSummary();
        if (rafCallbacks.onFinished) rafCallbacks.onFinished();
      }
      rafHandle = requestAnimationFrame(rafFrame);
    }
    function startRaf() {
      if (typeof requestAnimationFrame !== "function") return;
      sim.running = true;
      lastRealTs = 0;
      sim.lastRealTs = 0;
      if (rafActive) return;
      rafActive = true;
      rafHandle = requestAnimationFrame(rafFrame);
    }
    function pauseRaf() {
      sim.running = false;
      rafActive = false;
      if (rafHandle != null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafHandle);
      }
      rafHandle = null;
    }

    /* ---------- read accessors ---------- */
    function getState() {
      return {
        t_ms: sim.simTime,
        finished: !!sim.finished,
        running: !!sim.running,
        mode: sim.mode,
        cc_mode: sim.ccMode,
        cc_phase: sim.ccPhase,
        in_recovery: !!sim.inRecovery,
        cwnd_seg: Math.floor(sim.cwndSeg),
        cwnd_seg_float: sim.cwndSeg,
        ssthresh: sim.ssthresh,
        wmax: sim.wmax,
        inflight_seg: inflightCount(sim),
        acked_seg: sim.ackedCount,
        recv_seg: recvCount(sim),
        seg_count: sim.segCount,
        retransmits: sim.retransmits,
        queue_drops: sim.queueDrops,
        wmem_used_bytes: sim.wmemUsed,
        rmem_used_bytes: sim.rmemUsed,
        advertised_rwnd_seg: advRwndSeg(sim),
        rtt_ms: sim.rtt,
        link_bw_mbps: sim.linkBwMbps,
        mss_B: sim.mss,
        payload_bytes: sim.payloadBytes,
        // BBR-only fields (zero/null in other CC modes).
        bbr_state: sim.bbr_state,
        bbr_btlBw_Mbps: +((sim.bbr_btlBw_BytesPerMs * 8) / 1000).toFixed(3),
        bbr_rtprop_ms: sim.bbr_rtprop_ms === Infinity ? null : +sim.bbr_rtprop_ms.toFixed(3),
        bbr_pacing_Mbps: +((sim.bbr_pacingRate_BytesPerMs * 8) / 1000).toFixed(3),
      };
    }
    function getSummary() {
      // Live-refresh in case the caller polls during a run.
      finalizeSummary();
      return Object.assign({}, summary);
    }
    function getTrace() {
      return trace.slice();
    }
    function getEvents() {
      return events.slice();
    }
    function getConfig() {
      return {
        mode: sim.mode,
        cc_mode: sim.ccMode,
        preset: lastAppliedPreset,
        rtt_ms: sim.rtt,
        mss_B: sim.mss,
        payload_MB: +(sim.payloadBytes / 1024 / 1024).toFixed(6),
        initial_cwnd_seg: sim.initialCwndSeg,
        cwnd_seg: Math.floor(sim.cwndSeg),
        link_bw_mbps: sim.linkBwMbps,
        queue_KB: +(sim.queueSizeBytes / 1024).toFixed(3),
        loss_pct: sim.lossPct,
        wmem_KB: +(sim.wmemSize / 1024).toFixed(3),
        rmem_KB: +(sim.rmemSize / 1024).toFixed(3),
        app_write_mbps: sim.appWriteRateMbps,
        app_read_mbps: sim.appReadRateMbps,
        sim_speed: sim.speed,
      };
    }
    function getArtifact() {
      return {
        run_id: runId,
        version: VERSION,
        config: getConfig(),
        samples: trace.slice(),
        events: events.slice(),
        summary: Object.assign({}, summary),
      };
    }
    function setPresetTag(name) {
      lastAppliedPreset = name || null;
    }

    /* ---------- replay ---------- */
    function applyConfigToSim(cfg) {
      if (!cfg) return;
      if (cfg.mode) sim.mode = cfg.mode;
      if (cfg.cc_mode) sim.ccMode = cfg.cc_mode;
      if (cfg.rtt_ms != null) sim.rtt = cfg.rtt_ms;
      if (cfg.mss_B != null) sim.mss = cfg.mss_B;
      if (cfg.payload_MB != null) {
        sim.payloadBytes = Math.round(cfg.payload_MB * 1024 * 1024);
      }
      if (cfg.initial_cwnd_seg != null) sim.initialCwndSeg = cfg.initial_cwnd_seg;
      if (cfg.cwnd_seg != null) sim.cwndSeg = cfg.cwnd_seg;
      if (cfg.link_bw_mbps != null) sim.linkBwMbps = cfg.link_bw_mbps;
      if (cfg.queue_KB != null) sim.queueSizeBytes = Math.round(cfg.queue_KB * 1024);
      if (cfg.loss_pct != null) sim.lossPct = cfg.loss_pct;
      if (cfg.wmem_KB != null) sim.wmemSize = Math.round(cfg.wmem_KB * 1024);
      if (cfg.rmem_KB != null) sim.rmemSize = Math.round(cfg.rmem_KB * 1024);
      if (cfg.app_write_mbps != null) sim.appWriteRateMbps = cfg.app_write_mbps;
      if (cfg.app_read_mbps != null) sim.appReadRateMbps = cfg.app_read_mbps;
      if (cfg.sim_speed != null) sim.speed = cfg.sim_speed;
      if (cfg.preset) lastAppliedPreset = cfg.preset;
    }

    function replay(artifact, options) {
      options = options || {};
      const visual = !!options.visual;
      const speed = options.speed != null ? options.speed : null;
      applyConfigToSim(artifact && artifact.config);
      if (speed != null) sim.speed = speed;
      reset();
      if (visual) {
        return new Promise((resolve) => {
          const prevFinished = rafCallbacks.onFinished;
          rafCallbacks.onFinished = function () {
            if (prevFinished) prevFinished();
            rafCallbacks.onFinished = prevFinished;
            resolve(getArtifact());
          };
          startRaf();
        });
      }
      const art = runDeterministic({ maxSimMs: 60000 });
      return Promise.resolve(art);
    }

    /* ---------- public API ---------- */
    const api = {
      sim: sim,
      version: VERSION,
      reset: reset,
      stepBy: stepBy,
      runDeterministic: runDeterministic,
      attachRafLoop: attachRafLoop,
      detachRafLoop: detachRafLoop,
      startRaf: startRaf,
      pauseRaf: pauseRaf,
      getState: getState,
      getSummary: getSummary,
      getTrace: getTrace,
      getEvents: getEvents,
      getArtifact: getArtifact,
      setPresetTag: setPresetTag,
      applyConfigToSim: applyConfigToSim,
      replay: replay,
      // expose isRunning as a getter via Object.defineProperty
    };
    Object.defineProperty(api, "isRunning", {
      get: function () { return !!sim.running || !!rafActive; },
      enumerable: true,
    });
    return api;
  }

  return { create: create, version: VERSION };
});
