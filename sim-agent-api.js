/* sim-agent-api.js — exposes window.SimAgent.
 *
 * Loaded by tcp-inflight.html AFTER sim-core.js and sim-runner.js.
 * The HTML attaches window.__simUi = { setKnob, applyCcModeUi, ... } and
 * calls SimAgent.__bind(sim, runner) at init time. Everything in this file
 * routes through the runner (for run/step) and the UI helper bag (for
 * knob/DOM mirroring), so page semantics stay identical.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    // Node-side stub: the agent API is browser-only, but loading via require()
    // shouldn't blow up.
    module.exports = factory();
  } else {
    root.SimAgent = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  let _sim = null;
  let _runner = null;

  function ui() {
    return (typeof window !== "undefined" && window.__simUi) || {};
  }

  function ensureBound() {
    if (!_sim || !_runner) {
      throw new Error("SimAgent not bound. tcp-inflight.html must call SimAgent.__bind(sim, runner) at init.");
    }
  }

  /* ---------- config helpers ---------- */
  // Map "agent-facing" param names to the (sim field, ui-setter) pair. Keys
  // are kept loose so callers can use either snake or camel case familiar
  // names. Values: { apply(sim, v) -> void, after?(ui, v) }.
  const PARAM_HANDLERS = {
    rtt: (v) => { _sim.rtt = v; ui().setKnob && ui().setKnob("rtt", "rttN", v); },
    cwnd: (v) => {
      _sim.cwndSeg = Math.round(v);
      const u = ui();
      if (u.setCwnd) u.setCwnd(v);
      else if (u.setKnob) u.setKnob("cwnd", "cwndN", v);
    },
    mss: (v) => { _sim.mss = Math.round(v); ui().setKnob && ui().setKnob("mss", "mssN", v); },
    payloadMb: (v) => {
      _sim.payloadBytes = Math.round(v * 1024 * 1024);
      ui().setKnob && ui().setKnob("payload", "payloadN", v);
    },
    ccMode: (v) => {
      _sim.ccMode = (v === "cubic" || v === "bbr") ? v : "custom";
      ui().applyCcModeUi && ui().applyCcModeUi();
    },
    initialCwndSeg: (v) => {
      _sim.initialCwndSeg = Math.round(v);
      const u = ui();
      if (u.setInitCwnd) u.setInitCwnd(v);
      else if (u.setKnob) u.setKnob("initCwnd", "initCwndN", v);
    },
    routerReadMbps: (v) => {
      _sim.routerReadMbps = v;
      const u = ui();
      if (u.setRouterReadRate) u.setRouterReadRate(v);
      else if (u.setKnob) u.setKnob("routerRead", "routerReadN", v);
    },
    linkBwMbps: (v) => {
      _sim.linkBwMbps = v;
      const u = ui();
      if (u.setLinkBwRate) u.setLinkBwRate(v);
      else if (u.setKnob) u.setKnob("linkbw", "linkbwN", v);
    },
    routerWriteMbps: (v) => {
      _sim.routerWriteMbps = v;
      const u = ui();
      if (u.setRouterWriteRate) u.setRouterWriteRate(v);
      else if (u.setKnob) u.setKnob("routerWrite", "routerWriteN", v);
    },
    queueKB: (v) => {
      _sim.queueSizeBytes = Math.round(v * 1024);
      const u = ui();
      if (u.setQueueKB) u.setQueueKB(v);
      else if (u.setKnob) u.setKnob("queue", "queueN", v);
    },
    lossPct: (v) => { _sim.lossPct = v; },
    wmemKB: (v) => {
      _sim.wmemSize = Math.round(v * 1024);
      ui().setKnob && ui().setKnob("wmem", "wmemN", v);
    },
    rmemKB: (v) => {
      _sim.rmemSize = Math.round(v * 1024);
      ui().setKnob && ui().setKnob("rmem", "rmemN", v);
    },
    appWriteMbps: (v) => {
      _sim.appWriteRateMbps = v;
      const u = ui();
      if (u.setAppWriteRate) u.setAppWriteRate(v);
      else if (u.setKnob) u.setKnob("appWrite", "appWriteN", v);
    },
    appReadMbps: (v) => {
      _sim.appReadRateMbps = v;
      const u = ui();
      if (u.setAppReadRate) u.setAppReadRate(v);
      else if (u.setKnob) u.setKnob("appRead", "appReadN", v);
    },
    simSpeed: (v) => {
      _sim.speed = v;
      const u = ui();
      if (u.setSpeed) u.setSpeed(v);
    },
    mode: (v) => {
      if (ui().setMode) ui().setMode(v);
      else _sim.mode = v === "udp" ? "udp" : "tcp";
    },
    handshake: (v) => {
      _sim.handshake = !!v;
      ui().applyHandshakeUi && ui().applyHandshakeUi();
    },
  };

  /* ---------- API ---------- */
  const SimAgent = {
    version: "1.0",

    __bind(sim, runner) {
      _sim = sim;
      _runner = runner;
    },

    configure(params) {
      ensureBound();
      if (!params || typeof params !== "object") return;
      for (const key in params) {
        const handler = PARAM_HANDLERS[key];
        if (handler) {
          try { handler(params[key]); } catch (e) { /* swallow per-knob failures */ }
        }
      }
      // Apply UI-side derived state (segCount recompute, knob tooltips, etc.)
      if (ui().recompute) ui().recompute();
      if (ui().resetSim) ui().resetSim();
      else _runner.reset();
    },

    applyPreset(name) {
      ensureBound();
      const u = ui();
      if (u.applyPreset) u.applyPreset(name, true);
      _runner.setPresetTag && _runner.setPresetTag(name);
    },

    setMode(mode) {
      ensureBound();
      const u = ui();
      if (u.setMode) u.setMode(mode);
      else _sim.mode = mode === "udp" ? "udp" : "tcp";
      if (u.resetSim) u.resetSim();
      else _runner.reset();
    },

    setCcMode(cc) {
      ensureBound();
      const u = ui();
      if (u.setCcMode) u.setCcMode(cc);
      else {
        _sim.ccMode = (cc === "cubic" || cc === "bbr") ? cc : "custom";
        _runner.reset();
      }
    },

    reset() {
      ensureBound();
      const u = ui();
      if (u.resetSim) u.resetSim();
      else _runner.reset();
    },

    start() {
      ensureBound();
      if (_sim.finished) this.reset();
      _runner.startRaf();
      const u = ui();
      if (u.onStartedUI) u.onStartedUI();
    },

    pause() {
      ensureBound();
      _runner.pauseRaf();
      const u = ui();
      if (u.onPausedUI) u.onPausedUI();
    },

    step(ms) {
      ensureBound();
      const dt = +ms || 0;
      if (dt <= 0) return;
      _runner.stepBy(dt);
      const u = ui();
      // Drive a draw + stats update so the visual reflects the stepped state.
      if (u.draw) u.draw();
      if (u.updateStats) u.updateStats(0);
    },

    runToCompletion(options) {
      ensureBound();
      options = options || {};
      const visual = !!options.visual;
      const maxSimMs = options.maxSimMs != null ? options.maxSimMs : 60000;
      if (!visual) {
        const art = _runner.runDeterministic({ maxSimMs });
        // Refresh the on-page display once at the end.
        const u = ui();
        if (u.draw) u.draw();
        if (u.updateStats) u.updateStats(0);
        return Promise.resolve(art);
      }
      // Visual mode: start RAF and resolve when finished.
      return new Promise((resolve) => {
        const u = ui();
        const prev = u.onAgentFinish;
        u.onAgentFinish = function () {
          u.onAgentFinish = prev;
          resolve(_runner.getArtifact());
        };
        if (_sim.finished) this.reset();
        _runner.startRaf();
        if (u.onStartedUI) u.onStartedUI();
        // Safety: if maxSimMs is exceeded with no finish, poll.
        const startReal = performance.now();
        const watchdog = setInterval(() => {
          if (_sim.finished || _sim.simTime >= maxSimMs) {
            clearInterval(watchdog);
            _runner.pauseRaf();
            if (u.onAgentFinish === arguments.callee) u.onAgentFinish = prev;
            resolve(_runner.getArtifact());
          } else if (performance.now() - startReal > 5 * 60 * 1000) {
            // Hard 5-min wall-clock cap regardless of sim speed.
            clearInterval(watchdog);
            _runner.pauseRaf();
            resolve(_runner.getArtifact());
          }
        }, 200);
      });
    },

    runUntil(predicate, options) {
      ensureBound();
      options = options || {};
      const visual = !!options.visual;
      const maxSimMs = options.maxSimMs != null ? options.maxSimMs : 60000;
      if (!visual) {
        const art = _runner.runDeterministic({
          maxSimMs,
          untilFn: predicate,
        });
        const u = ui();
        if (u.draw) u.draw();
        if (u.updateStats) u.updateStats(0);
        return Promise.resolve(art);
      }
      // Visual mode: start RAF, poll predicate.
      return new Promise((resolve) => {
        if (_sim.finished) this.reset();
        _runner.startRaf();
        const u = ui();
        if (u.onStartedUI) u.onStartedUI();
        const startReal = performance.now();
        const watchdog = setInterval(() => {
          let stop = false;
          try { stop = !!predicate(_runner.getState()); } catch (e) { stop = true; }
          if (stop || _sim.finished || _sim.simTime >= maxSimMs) {
            clearInterval(watchdog);
            _runner.pauseRaf();
            resolve(_runner.getArtifact());
          } else if (performance.now() - startReal > 5 * 60 * 1000) {
            clearInterval(watchdog);
            _runner.pauseRaf();
            resolve(_runner.getArtifact());
          }
        }, 50);
      });
    },

    getState() {
      ensureBound();
      return _runner.getState();
    },
    getSummary() {
      ensureBound();
      return _runner.getSummary();
    },
    getTrace() {
      ensureBound();
      return _runner.getTrace();
    },
    getEvents() {
      ensureBound();
      return _runner.getEvents();
    },
    getArtifact() {
      ensureBound();
      return _runner.getArtifact();
    },

    replay(artifact, options) {
      ensureBound();
      options = options || {};
      const speed = options.speed != null ? options.speed : 1;
      const cfg = artifact && artifact.config;
      // Re-apply config through configure() so the DOM knobs reflect it.
      if (cfg) {
        const params = {
          mode: cfg.mode,
          handshake: cfg.handshake,
          ccMode: cfg.cc_mode,
          rtt: cfg.rtt_ms,
          mss: cfg.mss_B,
          payloadMb: cfg.payload_MB,
          initialCwndSeg: cfg.initial_cwnd_seg,
          routerReadMbps: cfg.router_read_mbps,
          routerWriteMbps: cfg.router_write_mbps != null ? cfg.router_write_mbps : cfg.link_bw_mbps,
          linkBwMbps: cfg.link_bw_mbps,
          queueKB: cfg.queue_KB,
          lossPct: cfg.loss_pct,
          wmemKB: cfg.wmem_KB,
          rmemKB: cfg.rmem_KB,
          appWriteMbps: cfg.app_write_mbps,
          appReadMbps: cfg.app_read_mbps,
          simSpeed: speed,
          cwnd: cfg.cwnd_seg,
        };
        this.configure(params);
        if (cfg.preset) {
          _runner.setPresetTag && _runner.setPresetTag(cfg.preset);
        }
      }
      return this.runToCompletion({ visual: true });
    },

    isRunning() {
      ensureBound();
      return _runner.isRunning;
    },
  };

  return SimAgent;
});
