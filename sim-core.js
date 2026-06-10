/* sim-core.js — pure simulation model.
 *
 * Loaded by tcp-inflight.html via <script src="sim-core.js"></script>
 * (exposes window.SimCore) and by sim-cli.js via require() in Node.
 *
 * Contains no DOM/canvas references. Every function here mutates a `sim`
 * state object passed in by the caller; the caller is responsible for any
 * UI side effects (drawing, button states, knob mirroring).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- pure helpers ---------- */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function fmtBytes(b) {
    if (b < 1024) return b.toFixed(0) + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + " MB";
    return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function fmtMs(ms) {
    if (ms < 1000) return ms.toFixed(0) + " ms";
    if (ms < 60000) return (ms / 1000).toFixed(2) + " s";
    return (ms / 60000).toFixed(2) + " min";
  }

  function percentile(arr, p) {
    if (!arr || arr.length === 0) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    const rank = clamp(p, 0, 1) * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
  }

  /* ---------- constants (band visual ranges; numerical only) ---------- */
  const BAND_RTT_MIN_MS = 10;
  const BAND_RTT_MAX_MS = 300;
  const BAND_BW_MIN_MBPS = 50;
  const BAND_BW_MAX_MBPS = 500;

  /* ---------- presets ----------
   * Each preset is a self-contained classroom scenario. Beyond the model
   * knobs, presets may set ccMode and initCwndSeg (both honored by
   * applyPresetToSim). Card metadata: name (display), story (what the
   * scenario is), watch (what to look at on screen), expect (rough numbers
   * the run should land on, measured with sim-cli).
   */
  const presets = {
    healthy: {
      name: "Healthy path",
      story: "A well-provisioned broadband path: moderate RTT, ample router buffer, near-zero loss. TCP at its best.",
      watch: "cwnd doubles each RTT (slow-start), Hystart exits near BDP, then the link stays saturated to the end.",
      expect: "10 MB in ~0.7 s · ~115 Mbps avg · 0 drops",
      rtt: 40,
      cwndSeg: 685,
      mss: 1460,
      payloadMb: 10,
      lossPct: 0.001,
      wmemKB: 4096,
      rmemKB: 4096,
      appWriteMbps: 0,
      appReadMbps: 0,
      linkBwMbps: 200,
      // ~2x BDP (BDP = 200 Mbps x 40 ms = 1 MB) so slow-start bursts are
      // absorbed without drops.
      queueKB: 2000,
      ccMode: "cubic",
      initCwndSeg: 10,
    },
    "cwnd-buildup": {
      name: "Cwnd buildup (long fat pipe)",
      story: "Intercontinental path: 150 ms RTT and a fast link mean a huge BDP. A cold connection spends most of the transfer just ramping cwnd up.",
      watch: "Many RTTs of slow-start before the pipe fills - the link sits idle while cwnd builds. Compare with the warm-start preset.",
      expect: "20 MB in ~2.0 s · ~80 Mbps avg on a 300 Mbps link",
      rtt: 150,
      cwndSeg: 3852,
      mss: 1460,
      payloadMb: 20,
      lossPct: 0,
      wmemKB: 16384,
      rmemKB: 16384,
      appWriteMbps: 0,
      appReadMbps: 0,
      linkBwMbps: 300,
      // ~2x BDP (BDP = 300 Mbps x 150 ms = 5.6 MB).
      queueKB: 11000,
      ccMode: "cubic",
      initCwndSeg: 10,
    },
    "warm-start": {
      name: "Good initial cwnd (warm start)",
      story: "Same long fat pipe as cwnd-buildup, but the connection starts with cwnd already at BDP - like a warmed/reused connection or a tuned initcwnd.",
      watch: "The first flight fills the whole pipe; the transfer finishes in a handful of RTTs instead of a long ramp.",
      expect: "20 MB in ~0.8 s · ~215 Mbps avg · 2.6x faster than cold",
      rtt: 150,
      cwndSeg: 3852,
      mss: 1460,
      payloadMb: 20,
      lossPct: 0,
      wmemKB: 16384,
      rmemKB: 16384,
      appWriteMbps: 0,
      appReadMbps: 0,
      linkBwMbps: 300,
      // Big enough to absorb the initial 5.6 MB IW burst without drops.
      queueKB: 11000,
      ccMode: "cubic",
      initCwndSeg: 3852,
    },
    congestion: {
      name: "Congestion (shallow buffer)",
      story: "The bottleneck router has a tiny buffer. Slow-start bursts overflow it long before the pipe is full: drops, dup-ACKs, fast retransmit, cubic sawtooth.",
      watch: "Red drops fall out of the router bucket; cwnd gets cut 0.7x on each loss event and regrows along the cubic curve.",
      expect: "5 MB in ~8 s · ~5 Mbps on a 150 Mbps link · 100+ drops",
      rtt: 60,
      cwndSeg: 770,
      mss: 1460,
      payloadMb: 5,
      lossPct: 0,
      wmemKB: 4096,
      rmemKB: 4096,
      appWriteMbps: 0,
      appReadMbps: 0,
      linkBwMbps: 150,
      // ~0.08x BDP (BDP = 150 Mbps x 60 ms = 1.1 MB) - classic under-buffered switch.
      queueKB: 96,
      ccMode: "cubic",
      initCwndSeg: 10,
    },
    bufferbloat: {
      name: "Bufferbloat (oversized buffer)",
      story: "A sender window far beyond BDP meets a router buffer 20x the BDP. Nothing drops, so nothing tells the sender to slow down - the queue just sits full.",
      watch: "The router bucket stays slammed near capacity for the whole run: a standing queue adding ~400 ms of dwell to every packet. Switch cc to bbr and the queue empties.",
      expect: "10 MB in ~1.7 s · link saturated · ~450 ms standing queue dwell",
      rtt: 30,
      cwndSeg: 2000,
      mss: 1460,
      payloadMb: 10,
      lossPct: 0,
      wmemKB: 4096,
      rmemKB: 4096,
      appWriteMbps: 0,
      appReadMbps: 0,
      linkBwMbps: 50,
      // ~22x BDP (BDP = 50 Mbps x 30 ms = 188 KB).
      queueKB: 4096,
      ccMode: "custom",
      initCwndSeg: 10,
    },
    lossy: {
      name: "Lossy link (radio / Wi-Fi)",
      story: "2% random packet loss that has nothing to do with congestion. Cubic can't tell the difference and keeps cutting cwnd anyway.",
      watch: "Most runs collapse orders of magnitude below the link rate (Mathis: throughput scales with 1/sqrt(loss)); an occasional short run gets lucky - that variance IS the lesson. Switch cc to bbr: it models bandwidth instead of reacting to loss, and sails through every time.",
      expect: "cubic: usually ~1 Mbps (a lucky run escapes at ~25) · bbr: ~25 Mbps every time",
      rtt: 50,
      cwndSeg: 428,
      mss: 1460,
      payloadMb: 2,
      lossPct: 2,
      wmemKB: 4096,
      rmemKB: 4096,
      appWriteMbps: 0,
      appReadMbps: 0,
      linkBwMbps: 100,
      queueKB: 1024,
      ccMode: "cubic",
      initCwndSeg: 10,
    },
    "slow-receiver": {
      name: "Slow receiver (flow control)",
      story: "The network is fast but the receiving app drains its socket at only 40 Mbps. The receive buffer fills, the recv window collapses, and flow control - not congestion control - sets the pace.",
      watch: "The receive buffer fills and turns red, the recv window drops toward zero, zero-window time accumulates, and goodput pins at the app read rate no matter what cwnd wants.",
      expect: "5 MB in ~1.1 s · pinned at ~37 Mbps by the reader",
      rtt: 30,
      cwndSeg: 1000,
      mss: 1460,
      payloadMb: 5,
      lossPct: 0.001,
      wmemKB: 4096,
      rmemKB: 256,
      appWriteMbps: 0,
      appReadMbps: 40,
      linkBwMbps: 200,
      queueKB: 2048,
      ccMode: "cubic",
      initCwndSeg: 10,
    },
  };

  /* ---------- sim state factory ---------- */
  // Build a fresh sim state object with the same defaults the inline
  // browser literal used. Optional `overrides` shallow-merges into the
  // result so callers (e.g. the CLI) can pre-set knob-like fields.
  function createSim(overrides) {
    const sim = {
      // transport mode: "tcp" (default) or "udp".
      mode: "tcp",

      // Congestion control: "custom" keeps cwnd at the knob value; "cubic"
      // runs RFC 8312 slow-start + MD-on-loss + cubic growth; "bbr" runs the
      // 2016 BBR model-based controller (BtlBw + RTprop estimators, state
      // machine startup → drain → probe_bw → probe_rtt).
      ccMode: "cubic",
      initialCwndSeg: 10,
      ssthresh: 1e9,
      wmax: 0,
      lastLossSimTime: 0,
      ccPhase: "slow-start",
      cubicAnchored: false,  // set to true on first loss event; gates cubic vs linear AIMD in cong-avoid

      // Fast retransmit / fast recovery.
      dupAckCount: 0,
      inRecovery: false,
      recoveryHighSeq: 0,
      preLossCwnd: 0,

      // BBR state machine
      bbr_state: "startup",                  // "startup" | "drain" | "probe_bw" | "probe_rtt"
      bbr_btlBw_BytesPerMs: 0,               // estimated bottleneck bandwidth
      bbr_rtprop_ms: Infinity,               // min RTT observed
      bbr_pacingGain: 2.89,                  // current gain on BtlBw
      bbr_cwndGain: 2.0,                     // current gain on BDP
      bbr_probeBwPhase: 0,                   // 0..7 within PROBE_BW cycle
      bbr_phaseStartedAt: 0,                 // sim time at start of current phase
      bbr_lastProbeRttAt: 0,                 // sim time of last PROBE_RTT entry
      bbr_lastRttSampleAt: 0,
      bbr_startupRttCounter: 0,              // RTTs since last meaningful BtlBw growth
      bbr_lastStartupBtlBw: 0,
      bbr_btlBwHistory: [],                  // array of { rate, expiresAt } — take max
      bbr_rtpropHistory: [],                 // array of { rtt, expiresAt } — take min
      bbr_pacingRate_BytesPerMs: 0,          // current pacing rate = btlBw * pacingGain
      bbr_cwnd_seg: 10,                      // BBR's computed cwnd
      bbr_prevState: null,                   // saved state when entering PROBE_RTT

      // Generic sender pacing (used by all modes; only BBR advances it)
      lastSenderEmitTime: 0,                 // when sender wire clock will next be free

      // configurable
      rtt: 100,
      cwndSeg: 836,
      mss: 1398,
      payloadBytes: 10 * 1024 * 1024,
      speed: 0.02,
      lossPct: 0,
      linkBwMbps: 1000,

      // bottleneck queue
      queueSizeBytes: 1024 * 1024,
      queueDrops: 0,

      // kernel buffers
      wmemSize: 4096 * 1024,
      wmemUsed: 0,
      appWriteRateMbps: 0,
      appNextWriteIdx: 0,
      appWriteBlockedMs: 0,
      rmemSize: 4096 * 1024,
      rmemUsed: 0,
      rmemSet: null,
      appReadRateMbps: 0,
      appReadResidualBytes: 0,
      zeroWindowMs: 0,

      // derived
      segCount: 0,

      // runtime
      running: false,
      finished: false,
      simTime: 0,
      lastRealTs: 0,
      nextSendIdx: 0,
      lastPacketLeaveTime: 0,
      ackedCount: 0,
      highestRecvd: 0,
      recvSet: null,
      ackedSet: null,
      inflight: [],
      retransmits: 0,

      // UDP-only
      drops: 0,
      lostForeverSet: null,

      // goodput EMA
      ema: 0,
      emaBytes: 0,
      emaWindowMs: 500,
    };
    if (overrides) {
      for (const k in overrides) sim[k] = overrides[k];
    }
    return sim;
  }

  // Apply a named preset's *model* values onto a sim state object.
  // Returns the preset metadata block so the caller can update its UI.
  // Does NOT call any reset/recompute logic; caller decides.
  function applyPresetToSim(sim, key) {
    const p = presets[key];
    if (!p) return null;
    sim.rtt = p.rtt;
    sim.cwndSeg = p.cwndSeg;
    sim.mss = p.mss;
    sim.payloadBytes = Math.round(p.payloadMb * 1024 * 1024);
    sim.lossPct = p.lossPct || 0;
    sim.wmemSize = Math.round(p.wmemKB * 1024);
    sim.rmemSize = Math.round(p.rmemKB * 1024);
    sim.appWriteRateMbps = p.appWriteMbps;
    sim.appReadRateMbps = p.appReadMbps;
    sim.linkBwMbps = p.linkBwMbps;
    const queueKB = p.queueKB != null ? p.queueKB : 1024;
    sim.queueSizeBytes = Math.round(queueKB * 1024);
    // Scenario presets pick their own congestion-control mode and initial
    // window; fall back to cubic / RFC 6928 IW10 when unspecified.
    sim.ccMode = p.ccMode || "cubic";
    sim.initialCwndSeg = p.initCwndSeg != null ? p.initCwndSeg : 10;
    return p;
  }

  // Re-derive segCount from current payload/MSS.
  function recomputeDerived(sim) {
    sim.segCount = Math.max(1, Math.ceil(sim.payloadBytes / sim.mss));
  }

  // Reset all runtime fields to a fresh state. Pure: never touches UI.
  // In cubic mode, also override cwndSeg with the IW so slow-start starts
  // cleanly (the browser's resetSim used to mirror this onto the knob;
  // that mirroring now lives in HTML).
  function resetSimState(sim) {
    sim.running = false;
    sim.finished = false;
    sim.simTime = 0;
    sim.lastRealTs = 0;
    sim.nextSendIdx = 0;
    sim.ackedCount = 0;
    sim.highestRecvd = 0;
    sim.inflight = [];
    sim.retransmits = 0;
    sim.lastPacketLeaveTime = 0;
    sim.ema = 0;
    sim.emaBytes = 0;
    sim.wmemUsed = 0;
    sim.rmemUsed = 0;
    sim.appNextWriteIdx = 0;
    sim.appWriteBlockedMs = 0;
    sim.appReadResidualBytes = 0;
    sim.zeroWindowMs = 0;
    sim.drops = 0;
    sim.queueDrops = 0;
    sim.ssthresh = 1e9;
    sim.wmax = 0;
    sim.lastLossSimTime = 0;
    sim.ccPhase = "slow-start";
    sim.cubicAnchored = false;
    sim.dupAckCount = 0;
    sim.inRecovery = false;
    sim.recoveryHighSeq = 0;
    sim.preLossCwnd = 0;
    // BBR reset
    sim.bbr_state = "startup";
    sim.bbr_btlBw_BytesPerMs = 0;
    sim.bbr_rtprop_ms = Infinity;
    sim.bbr_pacingGain = 2.89;
    sim.bbr_cwndGain = 2.89;
    sim.bbr_probeBwPhase = 0;
    sim.bbr_phaseStartedAt = 0;
    sim.bbr_lastProbeRttAt = 0;
    sim.bbr_lastRttSampleAt = 0;
    sim.bbr_startupRttCounter = 0;
    sim.bbr_lastStartupBtlBw = 0;
    sim.bbr_btlBwHistory = [];
    sim.bbr_rtpropHistory = [];
    sim.bbr_pacingRate_BytesPerMs = 0;
    sim.bbr_cwnd_seg = Math.max(4, sim.initialCwndSeg);
    sim.bbr_prevState = null;
    sim.lastSenderEmitTime = 0;
    if (sim.mode === "tcp" && (sim.ccMode === "cubic" || sim.ccMode === "bbr")) {
      sim.cwndSeg = sim.initialCwndSeg;
    }
    recomputeDerived(sim);
    sim.recvSet = new Uint8Array(sim.segCount);
    sim.ackedSet = new Uint8Array(sim.segCount);
    sim.rmemSet = new Uint8Array(sim.segCount);
    sim.lostForeverSet = new Uint8Array(sim.segCount);
  }

  /* ---------- core sim helpers ---------- */
  function advertisedRwndBytes(sim) {
    return Math.max(0, sim.rmemSize - sim.rmemUsed);
  }
  function advertisedRwndSeg(sim) {
    return Math.floor(advertisedRwndBytes(sim) / sim.mss);
  }
  function effectiveWindowSeg(sim) {
    const cwnd = (sim.mode === "tcp" && sim.ccMode === "bbr")
      ? sim.bbr_cwnd_seg
      : sim.cwndSeg;
    return Math.min(cwnd, advertisedRwndSeg(sim));
  }
  function inflightSegCount(sim) {
    let n = 0;
    for (let i = 0; i < sim.inflight.length; i++) {
      if (!sim.inflight[i].done) n++;
    }
    return n;
  }

  function maybeSendMore(sim) {
    if (sim.mode === "udp") {
      while (
        sim.nextSendIdx < sim.segCount &&
        sim.nextSendIdx < sim.appNextWriteIdx
      ) {
        const idx = sim.nextSendIdx++;
        sendSegment(sim, idx, false);
      }
      return;
    }
    const win = effectiveWindowSeg(sim);
    while (
      inflightSegCount(sim) < win &&
      sim.nextSendIdx < sim.segCount &&
      sim.nextSendIdx < sim.appNextWriteIdx
    ) {
      const idx = sim.nextSendIdx++;
      sendSegment(sim, idx, false);
    }
  }

  function sendSegment(sim, idx, isRetransmit) {
    // Three-phase trajectory:
    //   pre-queue leg   (sender edge -> queue bucket)        : preTravelMs = rtt/4
    //   queue dwell     (sit in queue bucket cells)
    //   post-queue leg  (queue bucket -> receiver edge)      : postTravelMs = rtt/4
    //   ACK (TCP only)  (receiver -> sender, single leg)     : rtt/2
    // The total push-to-arrival baseline (with empty queue) stays at rtt/2,
    // matching the old single-leg model so goodput/timing semantics are preserved.
    const preTravelMs = sim.rtt / 4;
    const postTravelMs = sim.rtt / 4;

    const serializeMs = (sim.mss * 8) / (sim.linkBwMbps * 1000);

    // Generic sender wire clock. For BBR, the sender paces packets at the
    // current bbr_pacingRate_BytesPerMs so emissions are evenly spaced rather
    // than bursting cwnd-worth at once. For custom/cubic the sender emits
    // instantly (senderSerializeMs = 0) — current behavior preserved exactly.
    let senderSerializeMs;
    if (sim.mode === "tcp" && sim.ccMode === "bbr") {
      if (sim.bbr_pacingRate_BytesPerMs > 0) {
        senderSerializeMs = sim.mss / sim.bbr_pacingRate_BytesPerMs;
      } else {
        // Bootstrap: enough trickle to get the first few delivery-rate samples.
        senderSerializeMs = sim.rtt / Math.max(1, sim.initialCwndSeg);
      }
    } else {
      senderSerializeMs = 0;
    }
    const senderEmitAt = Math.max(sim.simTime, sim.lastSenderEmitTime + senderSerializeMs);
    if (sim.mode === "tcp" && sim.ccMode === "bbr") {
      sim.lastSenderEmitTime = senderEmitAt;
    }

    const pushedAt = senderEmitAt;
    const enqueuedAt = pushedAt + preTravelMs;

    // Queue-overflow check measures depth at the moment the packet ARRIVES at
    // the queue (= enqueuedAt), not at sendSegment time. Otherwise bursts
    // inside a single step see a phantom RTT/4 × link_bw of "queue" that's
    // actually just pre-queue travel time, which over-rejects packets.
    const queueWaitMs = Math.max(0, sim.lastPacketLeaveTime - enqueuedAt);
    const queuedBytes = queueWaitMs * sim.linkBwMbps * 125;

    if (
      sim.mode === "tcp" &&
      sim.ccMode === "cubic" &&
      sim.ccPhase === "slow-start"
    ) {
      // BDP-based Hystart: exit when cwnd_bytes > link's BDP.
      // BDP_bytes = link_bw_Mbps * 1e6 * RTT_ms / 1000 / 8 = link_bw * RTT * 125
      const bdpBytes = sim.linkBwMbps * sim.rtt * 125;
      if (sim.cwndSeg * sim.mss > bdpBytes) {
        sim.ssthresh = Math.max(2, sim.cwndSeg);
        sim.wmax = sim.cwndSeg;
        sim.ccPhase = "cong-avoid";
        // Do NOT set lastLossSimTime — that anchors cubic. Do NOT set cubicAnchored.
      }
    }

    const queueOverflow = queuedBytes + sim.mss > sim.queueSizeBytes;
    const backgroundLost =
      !queueOverflow && Math.random() * 100 < sim.lossPct;
    const lost = queueOverflow || backgroundLost;

    let sentAt;     // dequeuedAt — the moment the packet exits the queue onto the wire
    let arriveAt;   // post-queue travel completes (at receiver)
    let ackArriveAt;
    if (queueOverflow) {
      // Queue-dropped: visually travels the pre-queue leg, then dies at the
      // queue. It never enters the wire, so do NOT advance lastPacketLeaveTime.
      sim.queueDrops++;
      sentAt = enqueuedAt;
      arriveAt = enqueuedAt;
      ackArriveAt = enqueuedAt;
    } else {
      // Normal (or background-lost) packet: passes through the queue, then
      // travels the post-queue leg.
      sentAt = Math.max(enqueuedAt, sim.lastPacketLeaveTime + serializeMs);
      sim.lastPacketLeaveTime = sentAt;
      arriveAt = sentAt + postTravelMs;
      ackArriveAt = sim.mode === "udp" ? arriveAt : arriveAt + sim.rtt / 2;
    }
    sim.inflight.push({
      idx,
      pushedAt,
      enqueuedAt,
      // sentAt is a synonym for dequeuedAt — kept under the old name so the
      // step() state machine and any downstream consumers continue to work.
      sentAt,
      arriveAt,
      ackArriveAt,
      lost,
      rtx: isRetransmit,
      done: false,
      timeoutAt: sentAt + sim.rtt,
      wmemFreed: false,
      // BBR per-packet bookkeeping: snapshot of delivered-bytes counter at
      // send (for delivery-rate computation on ACK).
      deliveredAtSend: sim.ackedCount,
      sentSimTime: pushedAt,
      // Two independent y-jitters: yJitter for the pre-queue leg (and the
      // ACK leg, mirrored), exitYJitter for the post-queue leg. Reflects the
      // queue's lack of position preservation — same packet enters at one y
      // and exits at another.
      yJitter: Math.random(),
      exitYJitter: Math.random(),
    });
    if (isRetransmit) sim.retransmits++;
  }

  function triggerFastRetransmit(sim) {
    const lostIdx = sim.ackedCount;
    for (let i = 0; i < sim.inflight.length; i++) {
      const p = sim.inflight[i];
      if (p.idx === lostIdx && !p.done) {
        p.done = true;
        sendSegment(sim, lostIdx, true);
        break;
      }
    }
    sim.preLossCwnd = sim.cwndSeg;
    sim.wmax = sim.cwndSeg;
    sim.ssthresh = Math.max(2, Math.floor(sim.cwndSeg * 0.7));
    sim.cwndSeg = sim.ssthresh;
    sim.inRecovery = true;
    sim.recoveryHighSeq = Math.max(sim.recoveryHighSeq, sim.nextSendIdx - 1);
    sim.lastLossSimTime = sim.simTime;
    sim.cubicAnchored = true;
    sim.ccPhase = "cong-avoid";
    sim.dupAckCount = 0;
  }

  // RFC 6582 NewReno partial-ACK retransmit. Called during fast recovery
  // each time a cumulative ACK advances ackedCount but does not pass
  // recoveryHighSeq — i.e. there's still at least one more hole below the
  // recovery point. Retransmits the new lowest unacked segment without
  // doing another β cut or W_max update (those happened at the original
  // fast retransmit firing).
  function partialAckRetransmit(sim) {
    const holeIdx = sim.ackedCount;
    if (holeIdx >= sim.segCount) return;
    if (sim.ackedSet[holeIdx]) return;

    // Don't double-send if a retransmit for this hole is already pending.
    for (let i = 0; i < sim.inflight.length; i++) {
      const p = sim.inflight[i];
      if (p.idx === holeIdx && p.rtx && !p.done) return;
    }
    // Mark the original (non-rtx) inflight entry done so its RTO path
    // doesn't fire later.
    for (let i = 0; i < sim.inflight.length; i++) {
      const p = sim.inflight[i];
      if (p.idx === holeIdx && !p.rtx && !p.done) {
        p.done = true;
        break;
      }
    }
    sendSegment(sim, holeIdx, true);
  }

  /* ---------- BBR state machine ----------
   * Run from inside step() each tick when sim.mode === "tcp" && ccMode === "bbr".
   * Mutates bbr_state, bbr_pacingGain, bbr_cwndGain, bbr_pacingRate_BytesPerMs,
   * bbr_cwnd_seg in place. State transitions:
   *   STARTUP   : pacing/cwnd gain 2.89; exit when BtlBw grew <25% three RTTs in a row.
   *   DRAIN     : pacing 1/2.89 (~0.345), cwnd gain 2.89; exit when inflight <= BDP.
   *   PROBE_BW  : cwnd gain 2.0; pacing cycles [1.25, 0.75, 1, 1, 1, 1, 1, 1] every RTprop.
   *   PROBE_RTT : every 10 sec, cap cwnd at 4 segments for 200 ms.
   */
  const BBR_STARTUP_GAIN = 2.89;
  const BBR_DRAIN_GAIN = 1 / 2.89;
  const BBR_PROBE_BW_GAIN_CYCLE = [1.25, 0.75, 1, 1, 1, 1, 1, 1];
  const BBR_PROBE_RTT_INTERVAL_MS = 10000;
  const BBR_PROBE_RTT_DURATION_MS = 200;
  const BBR_PROBE_RTT_CWND_SEG = 4;
  const BBR_STARTUP_GROWTH_THRESHOLD = 1.25;
  const BBR_STARTUP_FULL_BW_COUNT = 3;

  function inflightBytesNow(sim) {
    let n = 0;
    for (let i = 0; i < sim.inflight.length; i++) {
      if (!sim.inflight[i].done) n++;
    }
    return n * sim.mss;
  }

  function runBbr(sim) {
    // PROBE_RTT entry trigger (overrides all): every 10 sec since last entry.
    if (
      sim.bbr_state !== "probe_rtt" &&
      sim.simTime - sim.bbr_lastProbeRttAt > BBR_PROBE_RTT_INTERVAL_MS &&
      sim.bbr_rtprop_ms < Infinity
    ) {
      sim.bbr_prevState = sim.bbr_state;
      sim.bbr_state = "probe_rtt";
      sim.bbr_phaseStartedAt = sim.simTime;
      sim.bbr_lastProbeRttAt = sim.simTime;
      sim.bbr_pacingGain = 1.0;
      sim.bbr_cwndGain = 0;  // cap at 4 segments
    }

    if (sim.bbr_state === "probe_rtt") {
      // Hold for 200 ms.
      if (sim.simTime - sim.bbr_phaseStartedAt > BBR_PROBE_RTT_DURATION_MS) {
        sim.bbr_state = "probe_bw";
        sim.bbr_probeBwPhase = 0;
        sim.bbr_phaseStartedAt = sim.simTime;
        sim.bbr_pacingGain = BBR_PROBE_BW_GAIN_CYCLE[0];
        sim.bbr_cwndGain = 2.0;
      } else {
        // Keep gains the same while we hold cwnd low.
        sim.bbr_pacingGain = 1.0;
        sim.bbr_cwndGain = 0;
      }
    } else if (sim.bbr_state === "startup") {
      sim.bbr_pacingGain = BBR_STARTUP_GAIN;
      sim.bbr_cwndGain = BBR_STARTUP_GAIN;
      // Every (RTprop || rtt) ms, measure BtlBw growth vs prev value.
      const tickMs = sim.bbr_rtprop_ms < Infinity ? sim.bbr_rtprop_ms : sim.rtt;
      if (sim.simTime - sim.bbr_lastRttSampleAt >= tickMs && sim.bbr_btlBw_BytesPerMs > 0) {
        const prev = sim.bbr_lastStartupBtlBw;
        const cur = sim.bbr_btlBw_BytesPerMs;
        if (prev > 0 && cur < prev * BBR_STARTUP_GROWTH_THRESHOLD) {
          sim.bbr_startupRttCounter++;
        } else {
          sim.bbr_startupRttCounter = 0;
        }
        sim.bbr_lastStartupBtlBw = cur;
        sim.bbr_lastRttSampleAt = sim.simTime;
        if (sim.bbr_startupRttCounter >= BBR_STARTUP_FULL_BW_COUNT) {
          sim.bbr_state = "drain";
          sim.bbr_phaseStartedAt = sim.simTime;
          sim.bbr_pacingGain = BBR_DRAIN_GAIN;
          sim.bbr_cwndGain = BBR_STARTUP_GAIN;  // keep the room while draining
          sim.bbr_startupRttCounter = 0;
        }
      }
    } else if (sim.bbr_state === "drain") {
      sim.bbr_pacingGain = BBR_DRAIN_GAIN;
      sim.bbr_cwndGain = BBR_STARTUP_GAIN;
      // Hold until inflight_bytes <= BDP_now
      const rtprop = sim.bbr_rtprop_ms < Infinity ? sim.bbr_rtprop_ms : sim.rtt;
      const bdpBytes = sim.bbr_btlBw_BytesPerMs * rtprop;
      const inflBytes = inflightBytesNow(sim);
      if (inflBytes <= bdpBytes || bdpBytes === 0) {
        sim.bbr_state = "probe_bw";
        sim.bbr_probeBwPhase = 0;
        sim.bbr_phaseStartedAt = sim.simTime;
        sim.bbr_pacingGain = BBR_PROBE_BW_GAIN_CYCLE[0];
        sim.bbr_cwndGain = 2.0;
      }
    } else if (sim.bbr_state === "probe_bw") {
      sim.bbr_cwndGain = 2.0;
      const rtprop = sim.bbr_rtprop_ms < Infinity ? sim.bbr_rtprop_ms : sim.rtt;
      if (sim.simTime - sim.bbr_phaseStartedAt >= rtprop) {
        sim.bbr_probeBwPhase = (sim.bbr_probeBwPhase + 1) % BBR_PROBE_BW_GAIN_CYCLE.length;
        sim.bbr_phaseStartedAt = sim.simTime;
      }
      sim.bbr_pacingGain = BBR_PROBE_BW_GAIN_CYCLE[sim.bbr_probeBwPhase];
    }

    // Derive pacing rate and cwnd.
    if (sim.bbr_btlBw_BytesPerMs > 0) {
      sim.bbr_pacingRate_BytesPerMs = sim.bbr_btlBw_BytesPerMs * sim.bbr_pacingGain;
    } else {
      // Bootstrap pacing rate before any samples land.
      const rtt = sim.rtt > 0 ? sim.rtt : 1;
      sim.bbr_pacingRate_BytesPerMs = (sim.initialCwndSeg * sim.mss) / rtt;
    }
    if (sim.bbr_state === "probe_rtt") {
      sim.bbr_cwnd_seg = BBR_PROBE_RTT_CWND_SEG;
    } else if (sim.bbr_btlBw_BytesPerMs > 0 && sim.bbr_rtprop_ms < Infinity) {
      sim.bbr_cwnd_seg = Math.max(
        4,
        Math.floor((sim.bbr_btlBw_BytesPerMs * sim.bbr_rtprop_ms * sim.bbr_cwndGain) / sim.mss)
      );
    } else {
      // No samples yet — keep a small bootstrap window so we can probe.
      sim.bbr_cwnd_seg = Math.max(4, sim.initialCwndSeg);
    }
    // Mirror BBR cwnd into the generic cwndSeg field so the existing UI and
    // event detection can read it without branching.
    sim.cwndSeg = sim.bbr_cwnd_seg;
  }

  function step(sim, dtSim) {
    if (sim.finished) return;
    const startBytesAcked = sim.ackedCount * sim.mss;
    let eligibleForDrainCount = 0;
    for (let i = 0; i < sim.segCount; i++)
      if (sim.rmemSet[i]) eligibleForDrainCount++;
    sim.simTime += dtSim;

    // Sender app -> wmem
    const totalPayloadBytes = sim.segCount * sim.mss;
    const bytesAlreadyWritten = sim.appNextWriteIdx * sim.mss;
    const bytesRemainingToWrite = Math.max(
      0,
      totalPayloadBytes - bytesAlreadyWritten,
    );
    const wmemFree = Math.max(0, sim.wmemSize - sim.wmemUsed);
    if (bytesRemainingToWrite > 0) {
      let canWrite;
      if (sim.appWriteRateMbps === 0) {
        canWrite = Math.min(wmemFree, bytesRemainingToWrite);
      } else {
        const bytesPerStep =
          (sim.appWriteRateMbps * 1e6 * dtSim) / 1000 / 8;
        canWrite = Math.min(wmemFree, bytesRemainingToWrite, bytesPerStep);
      }
      if (canWrite >= sim.mss) {
        const segsToWrite = Math.floor(canWrite / sim.mss);
        const lastSeg = Math.min(
          sim.appNextWriteIdx + segsToWrite,
          sim.segCount,
        );
        const segsActual = lastSeg - sim.appNextWriteIdx;
        sim.appNextWriteIdx = lastSeg;
        sim.wmemUsed += segsActual * sim.mss;
      } else if (wmemFree < sim.mss && bytesRemainingToWrite > 0) {
        sim.appWriteBlockedMs += dtSim;
      }
    }

    // Process inflight events
    let dupAcksThisStep = 0;
    for (let i = 0; i < sim.inflight.length; i++) {
      const p = sim.inflight[i];
      if (p.done) continue;

      if (sim.mode === "udp") {
        if (!p.wmemFreed && sim.simTime >= p.sentAt) {
          sim.wmemUsed = Math.max(0, sim.wmemUsed - sim.mss);
          p.wmemFreed = true;
        }
        if (sim.simTime >= p.arriveAt) {
          if (p.lost) {
            p.done = true;
            if (sim.lostForeverSet) sim.lostForeverSet[p.idx] = 1;
          } else {
            if (sim.rmemUsed + sim.mss > sim.rmemSize) {
              sim.drops++;
              if (sim.lostForeverSet) sim.lostForeverSet[p.idx] = 1;
            } else {
              if (!sim.recvSet[p.idx]) {
                sim.recvSet[p.idx] = 1;
                sim.rmemUsed = Math.min(
                  sim.rmemSize,
                  sim.rmemUsed + sim.mss,
                );
                sim.rmemSet[p.idx] = 1;
              }
              if (p.idx + 1 > sim.highestRecvd)
                sim.highestRecvd = p.idx + 1;
              if (!sim.ackedSet[p.idx]) sim.ackedSet[p.idx] = 1;
            }
            p.done = true;
          }
        }
        continue;
      }

      // TCP path
      if (!p.lost) {
        if (sim.simTime >= p.ackArriveAt) {
          if (!sim.ackedSet[p.idx]) {
            sim.ackedSet[p.idx] = 1;
            sim.wmemUsed = Math.max(0, sim.wmemUsed - sim.mss);
            if (sim.ccMode === "cubic" && p.idx > sim.ackedCount) {
              dupAcksThisStep++;
            }
            if (sim.ccMode === "cubic" && !sim.inRecovery) {
              if (sim.cwndSeg < sim.ssthresh) {
                sim.cwndSeg += 1;
              } else if (sim.ccPhase === "slow-start") {
                sim.ccPhase = "cong-avoid";
                sim.lastLossSimTime = sim.simTime;
              }
            }
            if (sim.ccMode === "bbr") {
              // Delivery-rate sample for this ACK (BBR).
              // We count this ACK as delivered before sampling.
              const deliveredNow = sim.ackedCount + 1;
              const deliveredAtSend = p.deliveredAtSend != null ? p.deliveredAtSend : 0;
              const sentAtSim = p.sentSimTime != null ? p.sentSimTime : p.pushedAt;
              const deltaBytes = (deliveredNow - deliveredAtSend) * sim.mss;
              const deltaMs = sim.simTime - sentAtSim;
              if (deltaMs > 0 && deltaBytes > 0) {
                const rate = deltaBytes / deltaMs;
                const rtpropForWindow = sim.bbr_rtprop_ms < Infinity ? sim.bbr_rtprop_ms : sim.rtt;
                const expiresAt = sim.simTime + 10 * Math.max(rtpropForWindow, sim.rtt);
                sim.bbr_btlBwHistory.push({ rate, expiresAt });
                // Trim and recompute BtlBw = max over window.
                let maxRate = 0;
                const kept = [];
                for (let h = 0; h < sim.bbr_btlBwHistory.length; h++) {
                  const e = sim.bbr_btlBwHistory[h];
                  if (e.expiresAt > sim.simTime) {
                    kept.push(e);
                    if (e.rate > maxRate) maxRate = e.rate;
                  }
                }
                sim.bbr_btlBwHistory = kept;
                sim.bbr_btlBw_BytesPerMs = maxRate;
              }
              // RTT sample for RTprop.
              if (deltaMs > 0) {
                const expiresAt = sim.simTime + 10000;
                sim.bbr_rtpropHistory.push({ rtt: deltaMs, expiresAt });
                let minRtt = Infinity;
                const kept2 = [];
                for (let h = 0; h < sim.bbr_rtpropHistory.length; h++) {
                  const e = sim.bbr_rtpropHistory[h];
                  if (e.expiresAt > sim.simTime) {
                    kept2.push(e);
                    if (e.rtt < minRtt) minRtt = e.rtt;
                  }
                }
                sim.bbr_rtpropHistory = kept2;
                sim.bbr_rtprop_ms = minRtt;
              }
            }
          }
          p.done = true;
          if (!sim.recvSet[p.idx]) {
            sim.recvSet[p.idx] = 1;
            sim.rmemUsed = Math.min(sim.rmemSize, sim.rmemUsed + sim.mss);
            sim.rmemSet[p.idx] = 1;
          }
          continue;
        }
        if (sim.simTime >= p.arriveAt) {
          if (!sim.recvSet[p.idx]) {
            sim.recvSet[p.idx] = 1;
            sim.rmemUsed = Math.min(sim.rmemSize, sim.rmemUsed + sim.mss);
            sim.rmemSet[p.idx] = 1;
          }
          if (p.idx + 1 > sim.highestRecvd) sim.highestRecvd = p.idx + 1;
        }
      } else {
        if (sim.simTime >= p.timeoutAt) {
          p.done = true;
          if (!sim.ackedSet[p.idx]) {
            if (sim.ccMode === "cubic" && !sim.inRecovery) {
              sim.preLossCwnd = sim.cwndSeg;
              sim.wmax = sim.cwndSeg;
              sim.ssthresh = Math.max(2, Math.floor(sim.cwndSeg * 0.7));
              sim.cwndSeg = Math.max(1, sim.initialCwndSeg);
              sim.ccPhase = "slow-start";
              sim.lastLossSimTime = sim.simTime;
              sim.cubicAnchored = true;
              sim.dupAckCount = 0;
            }
            sendSegment(sim, p.idx, true);
          }
        }
      }
    }

    if (sim.inflight.length > 4096) {
      sim.inflight = sim.inflight.filter((p) => !p.done);
    }

    // Receiver app drain
    if (sim.rmemUsed > 0 && eligibleForDrainCount > 0) {
      let drainBytes;
      if (sim.appReadRateMbps === 0) {
        drainBytes =
          eligibleForDrainCount * sim.mss + sim.appReadResidualBytes;
      } else {
        drainBytes =
          (sim.appReadRateMbps * 1e6 * dtSim) / 1000 / 8 +
          sim.appReadResidualBytes;
      }
      let segsToDrain = Math.min(
        Math.floor(drainBytes / sim.mss),
        eligibleForDrainCount,
      );
      sim.appReadResidualBytes = drainBytes - segsToDrain * sim.mss;
      if (segsToDrain > 0) {
        for (let i = 0; i < sim.segCount && segsToDrain > 0; i++) {
          if (sim.rmemSet[i]) {
            sim.rmemSet[i] = 0;
            segsToDrain--;
          }
        }
        let used = 0;
        for (let i = 0; i < sim.segCount; i++)
          if (sim.rmemSet[i]) used += sim.mss;
        sim.rmemUsed = used;
        if (sim.rmemUsed === 0) sim.appReadResidualBytes = 0;
      }
    } else if (sim.rmemUsed === 0) {
      sim.appReadResidualBytes = 0;
    }

    // cumulative acked count
    const oldAckedCount = sim.ackedCount;
    while (
      sim.ackedCount < sim.segCount &&
      sim.ackedSet[sim.ackedCount]
    ) {
      sim.ackedCount++;
    }
    const cumAdvanced = sim.ackedCount > oldAckedCount;

    // Fast retransmit / recovery state machine (TCP + cubic only)
    if (sim.mode === "tcp" && sim.ccMode === "cubic") {
      if (cumAdvanced) {
        if (sim.inRecovery) {
          if (sim.ackedCount > sim.recoveryHighSeq) {
            // Full ACK → exit recovery
            sim.cwndSeg = Math.max(2, sim.ssthresh);
            sim.inRecovery = false;
          } else {
            // Partial ACK during recovery: retransmit the new lowest
            // unacked (RFC 6582 NewReno). No β cut, no W_max update.
            partialAckRetransmit(sim);
          }
        }
        sim.dupAckCount = 0;
      } else if (dupAcksThisStep > 0) {
        if (!sim.inRecovery) {
          sim.dupAckCount += dupAcksThisStep;
          if (sim.dupAckCount >= 3) {
            triggerFastRetransmit(sim);
          }
        } else {
          sim.cwndSeg += dupAcksThisStep;
        }
      }
    }

    // zero-window tracking
    if (
      sim.mode === "tcp" &&
      advertisedRwndSeg(sim) === 0 &&
      sim.nextSendIdx < sim.segCount
    ) {
      sim.zeroWindowMs += dtSim;
    }

    // BBR state machine: must run BEFORE maybeSendMore so the wire clock
    // sees the current pacing rate this tick.
    if (sim.mode === "tcp" && sim.ccMode === "bbr") {
      runBbr(sim);
    }

    // top up window
    maybeSendMore(sim);

    // Cubic congestion-avoidance growth
    if (
      sim.mode === "tcp" &&
      sim.ccMode === "cubic" &&
      sim.ccPhase === "cong-avoid" &&
      !sim.inRecovery
    ) {
      if (sim.cubicAnchored) {
        // Standard cubic curve from the last loss event
        const C = 0.4;
        const beta = 0.7;
        const tSec = Math.max(0, (sim.simTime - sim.lastLossSimTime) / 1000);
        const K = Math.cbrt((sim.wmax * (1 - beta)) / C);
        const dt = tSec - K;
        const target = C * dt * dt * dt + sim.wmax;
        sim.cwndSeg = Math.max(2, Math.floor(target));
      } else {
        // Linear AIMD: +1 segment per RTT (no per-ACK accounting; use dtSim)
        // dCwnd/dt = 1/RTT segments per ms → cwnd += dtSim / RTT
        sim.cwndSeg += dtSim / sim.rtt;
        // Note: keep as float for smooth growth; floor when needed elsewhere
      }
    }

    // goodput EMA
    const deltaBytes = sim.ackedCount * sim.mss - startBytesAcked;
    if (dtSim > 0) {
      const inst = deltaBytes / dtSim;
      const alpha = clamp(dtSim / sim.emaWindowMs, 0, 1);
      sim.ema = sim.ema * (1 - alpha) + inst * alpha;
    }

    // done?
    if (sim.ackedCount >= sim.segCount) {
      sim.running = false;
      sim.finished = true;
    }
  }

  return {
    // factory + lifecycle
    createSim,
    resetSimState,
    applyPresetToSim,
    recomputeDerived,
    // sim primitives
    sendSegment,
    maybeSendMore,
    step,
    triggerFastRetransmit,
    // helpers exposed to the HTML side
    clamp,
    fmtBytes,
    fmtMs,
    percentile,
    // read accessors (used by HTML render code)
    advertisedRwndBytes,
    advertisedRwndSeg,
    effectiveWindowSeg,
    inflightSegCount,
    // data
    presets,
    CONSTANTS: {
      BAND_RTT_MIN_MS,
      BAND_RTT_MAX_MS,
      BAND_BW_MIN_MBPS,
      BAND_BW_MAX_MBPS,
    },
  };
});
