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
  const DEFAULT_RTO_MIN_MS = 200;
  const DEFAULT_CUBIC_PACING_GAIN = 1.2;

  /* ---------- presets ----------
   * Each preset is a self-contained classroom scenario. Beyond the model
   * knobs, presets may set ccMode and initCwndSeg (both honored by
   * applyPresetToSim). Card metadata: name (display), story (what the
   * scenario is), watch (what to look at on screen), expect (rough numbers
   * the run should land on, measured with sim-cli).
   */
  const H100_BLOG_PATH = {
    rtt: 31,
    cwndSeg: 10,
    mss: 1298,
    payloadMb: 5,
    lossPct: 0,
    wmemKB: 16384,
    rmemKB: 9825.5,
    appWriteMbps: 10000,
    appReadMbps: 10000,
    routerReadMbps: 10000,
    routerWriteMbps: 1000,
    linkBwMbps: 1000,
    cubicPacing: false,
    cubicPacingGain: DEFAULT_CUBIC_PACING_GAIN,
    queueKB: 5120,
    ccMode: "cubic",
  };

  const presets = {
    "cold-iw10": {
      ...H100_BLOG_PATH,
      name: "1. Cold TCP, IW10",
      story: "A fresh TCP connection starts with the three-way handshake and the default 10-packet initial congestion window.",
      watch: "The SYN, SYN-ACK, and ACK happen before data starts; after that, cubic still has to ramp cwnd from 10 packets.",
      expect: "5 MB in ~353 ms in the sim · worker transport p50 ~347 ms",
      handshake: true,
      initCwndSeg: 10,
    },
    "warm-iw10": {
      ...H100_BLOG_PATH,
      name: "2. Warm TCP, IW10",
      story: "The TCP connection is already open, so the request skips the handshake, but the sender still starts from a small 10-packet initial window.",
      watch: "Data starts immediately, saving about one RTT, while the rest of the transfer still spends several RTTs growing cwnd.",
      expect: "5 MB in ~326 ms in the sim · worker transport p50 ~303 ms",
      handshake: false,
      initCwndSeg: 10,
    },
    "warm-iw3500-rwnd-warm": {
      ...H100_BLOG_PATH,
      name: "3. Warm TCP, IW3500 + rwnd warm",
      story: "The connection is warm, the sender starts near the path BDP, and the receiver window has already been opened by a prior large upload.",
      watch: "The first flight can fill the pipe immediately; there is no handshake delay and no small receive-window bottleneck.",
      expect: "5 MB in ~78 ms in the sim · worker transport after 10 MB prewarm ~53-58 ms",
      handshake: false,
      initCwndSeg: 3500,
      cwndSeg: 3500,
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
      cubicPacing: false,
      cubicPacingGain: DEFAULT_CUBIC_PACING_GAIN,

      // Fast retransmit / fast recovery.
      dupAckCount: 0,
      inRecovery: false,
      recoveryHighSeq: 0,
      preLossCwnd: 0,
      retransmitUntilIdx: 0,

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
      lastRouterReadTime: 0,                 // when router ingress clock will next be free

      // Model the TCP 3-way handshake (SYN → SYN-ACK → ACK). When set, the
      // first data segment leaves exactly one RTT after t=0: SYN reaches the
      // receiver at RTT/2, SYN-ACK returns at RTT, and the client's ACK rides
      // along with the first data flight. Off by default; ignored in UDP mode.
      handshake: false,

      // configurable
      rtt: 100,
      cwndSeg: 836,
      mss: 1398,
      payloadBytes: 10 * 1024 * 1024,
      speed: 0.02,
      lossPct: 0,
      routerReadMbps: 10000,
      routerWriteMbps: 1000,
      linkBwMbps: 1000,
      rtoMinMs: DEFAULT_RTO_MIN_MS,

      // bottleneck queue
      queueSizeBytes: 1024 * 1024,
      queueDrops: 0,

      // kernel buffers
      wmemSize: 4096 * 1024,
      wmemUsed: 0,
      appWriteRateMbps: 200,
      appNextWriteIdx: 0,
      appWriteBlockedMs: 0,
      rmemSize: 4096 * 1024,
      rmemUsed: 0,
      rmemSet: null,
      appReadRateMbps: 200,
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
      // Total segments ACKed regardless of order (SACK-style). ackedCount
      // only advances in-order, so it stalls at every loss hole; BBR's
      // delivery-rate samples must keep flowing through holes.
      deliveredCount: 0,
      // Highest segment idx ACKed so far (-1 = none). Sends are in-order, so
      // an unACKed segment with ≥3 ACKed segments above it is presumed lost.
      highestAckedIdx: -1,
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
    sim.routerReadMbps = p.routerReadMbps != null ? p.routerReadMbps : 10000;
    sim.routerWriteMbps = p.routerWriteMbps != null ? p.routerWriteMbps : p.linkBwMbps;
    sim.linkBwMbps = p.linkBwMbps;
    sim.cubicPacing = !!p.cubicPacing;
    sim.cubicPacingGain = p.cubicPacingGain != null
      ? p.cubicPacingGain
      : DEFAULT_CUBIC_PACING_GAIN;
    const queueKB = p.queueKB != null ? p.queueKB : 1024;
    sim.queueSizeBytes = Math.round(queueKB * 1024);
    // Scenario presets pick their own congestion-control mode and initial
    // window; fall back to cubic / RFC 6928 IW10 when unspecified.
    sim.ccMode = p.ccMode || "cubic";
    sim.initialCwndSeg = p.initCwndSeg != null ? p.initCwndSeg : 10;
    // Presets are calibrated without a handshake unless they say otherwise.
    sim.handshake = !!p.handshake;
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
    sim.deliveredCount = 0;
    sim.highestAckedIdx = -1;
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
    sim.retransmitUntilIdx = 0;
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
    sim.lastRouterReadTime = 0;
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
  // Time spent in the 3-way handshake before any data may flow.
  function handshakeMs(sim) {
    return sim.mode === "tcp" && sim.handshake ? sim.rtt : 0;
  }
  function inHandshake(sim) {
    return sim.simTime < handshakeMs(sim);
  }
  function rtoDelayMs(sim) {
    const floor = Math.max(1, sim.rtoMinMs || DEFAULT_RTO_MIN_MS);
    return Math.max(floor, sim.rtt || 1);
  }
  function cubicPacingRateBytesPerMs(sim) {
    const rtt = Math.max(1, sim.rtt || 1);
    const gain = Math.max(0.05, sim.cubicPacingGain || DEFAULT_CUBIC_PACING_GAIN);
    const cwnd = Math.max(1, sim.cwndSeg || sim.initialCwndSeg || 1);
    return (cwnd * sim.mss * gain) / rtt;
  }

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
  function effectiveDrainMbps(sim) {
    const link = Math.max(1, sim.linkBwMbps || 1);
    const routerWrite = Math.max(1, sim.routerWriteMbps || link);
    return Math.min(link, routerWrite);
  }
  function inflightSegCount(sim) {
    let n = 0;
    for (let i = 0; i < sim.inflight.length; i++) {
      if (!sim.inflight[i].done && !sim.inflight[i].abandoned) n++;
    }
    return n;
  }
  function queuedBytesNow(sim) {
    let bytes = 0;
    for (let i = 0; i < sim.inflight.length; i++) {
      const p = sim.inflight[i];
      if (p.done) continue;
      const enq = typeof p.enqueuedAt === "number" ? p.enqueuedAt : p.sentAt;
      if (sim.simTime >= enq && sim.simTime < p.sentAt) bytes += sim.mss;
    }
    return Math.min(bytes, sim.queueSizeBytes);
  }

  function maybeSendMore(sim) {
    if (inHandshake(sim)) return;
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
      while (
        sim.nextSendIdx < sim.segCount &&
        sim.ackedSet &&
        sim.ackedSet[sim.nextSendIdx]
      ) {
        sim.nextSendIdx++;
      }
      if (
        sim.nextSendIdx >= sim.segCount ||
        sim.nextSendIdx >= sim.appNextWriteIdx
      ) {
        break;
      }
      const idx = sim.nextSendIdx++;
      const isRetransmit = idx < sim.retransmitUntilIdx;
      sendSegment(sim, idx, isRetransmit);
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

    const routerReadMbps = Math.max(1, sim.routerReadMbps || 10000);
    const routerReadSerializeMs = (sim.mss * 8) / (routerReadMbps * 1000);
    const drainMbps = effectiveDrainMbps(sim);
    const serializeMs = (sim.mss * 8) / (drainMbps * 1000);

    // Generic sender wire clock. BBR is always paced. Cubic can optionally
    // pace at cwnd/RTT × gain so we can compare bursty and paced senders while
    // keeping the same loss-based cwnd algorithm.
    let senderSerializeMs;
    if (sim.mode === "tcp" && sim.ccMode === "bbr") {
      if (sim.bbr_pacingRate_BytesPerMs > 0) {
        senderSerializeMs = sim.mss / sim.bbr_pacingRate_BytesPerMs;
      } else {
        // Bootstrap: enough trickle to get the first few delivery-rate samples.
        senderSerializeMs = sim.rtt / Math.max(1, sim.initialCwndSeg);
      }
    } else if (sim.mode === "tcp" && sim.ccMode === "cubic" && sim.cubicPacing) {
      senderSerializeMs = sim.mss / cubicPacingRateBytesPerMs(sim);
    } else {
      senderSerializeMs = 0;
    }
    const senderEmitAt = Math.max(sim.simTime, sim.lastSenderEmitTime + senderSerializeMs);
    if (
      sim.mode === "tcp" &&
      (sim.ccMode === "bbr" || (sim.ccMode === "cubic" && sim.cubicPacing))
    ) {
      sim.lastSenderEmitTime = senderEmitAt;
    }

    const pushedAt = senderEmitAt;
    const enqueuedAt = Math.max(
      pushedAt + preTravelMs,
      sim.lastRouterReadTime + routerReadSerializeMs
    );
    sim.lastRouterReadTime = enqueuedAt;

    // Queue-overflow check measures depth at the moment the packet ARRIVES at
    // the queue (= enqueuedAt), not at sendSegment time. Otherwise bursts
    // inside a single step see a phantom RTT/4 × link_bw of "queue" that's
    // actually just pre-queue travel time, which over-rejects packets.
    const queueWaitMs = Math.max(0, sim.lastPacketLeaveTime - enqueuedAt);
    const queuedBytes = queueWaitMs * drainMbps * 125;

    if (
      sim.mode === "tcp" &&
      sim.ccMode === "cubic" &&
      sim.ccPhase === "slow-start"
    ) {
      // BDP-based Hystart: exit when cwnd_bytes > link's BDP.
      // BDP_bytes = effective_drain_Mbps * 1e6 * RTT_ms / 1000 / 8 = drain * RTT * 125
      const bdpBytes = drainMbps * sim.rtt * 125;
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
      abandoned: false,
      timeoutAt: pushedAt + rtoDelayMs(sim),
      wmemFreed: false,
      // BBR per-packet bookkeeping for delivery-rate sampling on ACK. The
      // pacer schedules emission (pushedAt) into the future, so the snapshot
      // pair (deliveredAtSend, sentSimTime) taken now is provisional; step()
      // re-snapshots both at the first tick after actual emission
      // (delivSnapped). Snapshotting now but measuring time from pushedAt
      // would inflate the sample (BtlBw above link rate → standing
      // self-queue); measuring time from now would deflate it by the pacer
      // backlog (STARTUP overdrives the pacer by design).
      deliveredAtSend: sim.deliveredCount,
      sentSimTime: sim.simTime,
      delivSnapped: false,
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
      if (p.idx === lostIdx && !p.done && !p.abandoned) {
        p.done = true;
        sendSegment(sim, lostIdx, true);
        break;
      }
    }
    sim.inRecovery = true;
    sim.recoveryHighSeq = Math.max(sim.recoveryHighSeq, sim.nextSendIdx - 1);
    sim.dupAckCount = 0;
    // BBR retransmits the hole but does NOT cut its window on loss — its
    // rate is set by the BtlBw/RTprop model, not by loss events.
    if (sim.ccMode === "bbr") return;
    sim.preLossCwnd = sim.cwndSeg;
    sim.wmax = sim.cwndSeg;
    sim.ssthresh = Math.max(2, Math.floor(sim.cwndSeg * 0.7));
    sim.cwndSeg = sim.ssthresh;
    sim.lastLossSimTime = sim.simTime;
    sim.cubicAnchored = true;
    sim.ccPhase = "cong-avoid";
  }

  function triggerCubicRto(sim) {
    const flight = Math.max(1, inflightSegCount(sim));
    const restartAt = sim.ackedCount;
    const retransmitUntil = Math.max(sim.retransmitUntilIdx || 0, sim.nextSendIdx);

    sim.preLossCwnd = sim.cwndSeg;
    // RFC 5681's RTO path uses FlightSize, not an inflated recovery window,
    // then restarts from a one-segment loss window.
    sim.wmax = Math.max(2, Math.floor(flight));
    sim.ssthresh = Math.max(2, Math.floor(flight / 2));
    sim.cwndSeg = 1;
    sim.ccPhase = "slow-start";
    sim.lastLossSimTime = sim.simTime;
    sim.cubicAnchored = true;
    sim.dupAckCount = 0;
    sim.inRecovery = false;
    sim.recoveryHighSeq = 0;
    sim.retransmitUntilIdx = retransmitUntil;

    // RTO is a pipe-clearing event in this simplified model. Do not let a
    // burst loss keep thousands of stale per-packet timers alive; restart the
    // sender at the lowest unacked byte and let cwnd pace retransmission.
    // Keep old packets visible until they naturally arrive/drop; they are no
    // longer counted against cwnd and their timers no longer drive recovery.
    for (let i = 0; i < sim.inflight.length; i++) {
      const p = sim.inflight[i];
      if (!p.done) p.abandoned = true;
    }
    sim.nextSendIdx = restartAt;
    sim.lastPacketLeaveTime = sim.simTime;
    sim.lastRouterReadTime = sim.simTime;
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
      if (p.idx === holeIdx && p.rtx && !p.done && !p.abandoned) return;
    }
    // Mark the original (non-rtx) inflight entry done so its RTO path
    // doesn't fire later.
    for (let i = 0; i < sim.inflight.length; i++) {
      const p = sim.inflight[i];
      if (p.idx === holeIdx && !p.rtx && !p.done && !p.abandoned) {
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

  // Bytes actually in the network: emitted (pushedAt reached) but not yet
  // ACKed. Excludes the pacer backlog — packets scheduled into the future.
  // Used by the DRAIN exit check, which compares against 1×BDP; counting the
  // backlog would keep DRAIN's 2.89×BDP of committed segments permanently
  // above the threshold, and a never-ending DRAIN (pacing 0.345×BtlBw) lets
  // the good BtlBw samples expire from the max-filter — a death spiral.
  function inflightBytesNow(sim) {
    let n = 0;
    for (let i = 0; i < sim.inflight.length; i++) {
      const p = sim.inflight[i];
      if (!p.done && !p.abandoned && p.pushedAt <= sim.simTime) n++;
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

    // Derive pacing rate and cwnd. Until STARTUP declares the pipe full,
    // neither is allowed to DECREASE (mirrors Linux bbr_update_pacing_rate /
    // bbr_set_cwnd): the first delivery-rate samples are noisy-low (one ACK
    // over a full RTT), and acting on them would collapse the pacer and bake
    // huge inter-packet gaps into the send schedule.
    const pipeFilling = sim.bbr_state === "startup";
    if (sim.bbr_btlBw_BytesPerMs > 0) {
      const rate = sim.bbr_btlBw_BytesPerMs * sim.bbr_pacingGain;
      sim.bbr_pacingRate_BytesPerMs = pipeFilling
        ? Math.max(rate, sim.bbr_pacingRate_BytesPerMs)
        : rate;
    } else {
      // Bootstrap pacing rate before any samples land.
      const rtt = sim.rtt > 0 ? sim.rtt : 1;
      sim.bbr_pacingRate_BytesPerMs = Math.max(
        sim.bbr_pacingRate_BytesPerMs,
        (sim.initialCwndSeg * sim.mss) / rtt
      );
    }
    if (sim.bbr_state === "probe_rtt") {
      sim.bbr_cwnd_seg = BBR_PROBE_RTT_CWND_SEG;
    } else if (sim.bbr_btlBw_BytesPerMs > 0 && sim.bbr_rtprop_ms < Infinity) {
      const target = Math.max(
        4,
        Math.floor((sim.bbr_btlBw_BytesPerMs * sim.bbr_rtprop_ms * sim.bbr_cwndGain) / sim.mss)
      );
      sim.bbr_cwnd_seg = pipeFilling ? Math.max(target, sim.bbr_cwnd_seg) : target;
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

    // Sender app -> wmem. During the handshake the connection isn't
    // established yet, so the app can't write into the socket buffer either
    // (connect() hasn't returned).
    const totalPayloadBytes = inHandshake(sim) ? 0 : sim.segCount * sim.mss;
    const bytesAlreadyWritten = sim.appNextWriteIdx * sim.mss;
    const bytesRemainingToWrite = Math.max(
      0,
      totalPayloadBytes - bytesAlreadyWritten,
    );
    const wmemFree = Math.max(0, sim.wmemSize - sim.wmemUsed);
    if (bytesRemainingToWrite > 0) {
      const bytesPerStep =
        sim.appWriteRateMbps > 0
          ? (sim.appWriteRateMbps * 1e6 * dtSim) / 1000 / 8
          : 0;
      const canWrite = Math.min(wmemFree, bytesRemainingToWrite, bytesPerStep);
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
      // Deferred delivery snapshot at actual emission (≤ one sub-step late;
      // always lands before the ACK, which is ≥ 3/4 RTT after emission).
      if (!p.delivSnapped && sim.simTime >= p.pushedAt) {
        p.deliveredAtSend = sim.deliveredCount;
        p.sentSimTime = sim.simTime;
        p.delivSnapped = true;
      }
      if (p.abandoned) {
        if (!p.lost) {
          if (sim.simTime >= p.arriveAt) {
            if (!sim.recvSet[p.idx]) {
              sim.recvSet[p.idx] = 1;
              sim.rmemUsed = Math.min(sim.rmemSize, sim.rmemUsed + sim.mss);
              sim.rmemSet[p.idx] = 1;
            }
            if (p.idx + 1 > sim.highestRecvd) sim.highestRecvd = p.idx + 1;
          }
          if (sim.simTime >= p.ackArriveAt) {
            if (!sim.ackedSet[p.idx]) {
              sim.ackedSet[p.idx] = 1;
              sim.deliveredCount++;
              if (p.idx > sim.highestAckedIdx) sim.highestAckedIdx = p.idx;
              sim.wmemUsed = Math.max(0, sim.wmemUsed - sim.mss);
            }
            p.done = true;
          }
        } else if (sim.simTime >= p.timeoutAt) {
          p.done = true;
        }
        continue;
      }
      if (!p.lost) {
        if (sim.simTime >= p.ackArriveAt) {
          if (!sim.ackedSet[p.idx]) {
            sim.ackedSet[p.idx] = 1;
            sim.deliveredCount++;
            if (p.idx > sim.highestAckedIdx) sim.highestAckedIdx = p.idx;
            sim.wmemUsed = Math.max(0, sim.wmemUsed - sim.mss);
            if (p.idx > sim.ackedCount) {
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
              // Delivery-rate sample for this ACK (BBR). deliveredCount
              // already includes this ACK (incremented above) and keeps
              // advancing through loss holes, unlike the in-order ackedCount.
              const deliveredNow = sim.deliveredCount;
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
          if (!sim.ackedSet[p.idx]) {
            if (sim.ccMode === "cubic") {
              triggerCubicRto(sim);
            } else {
              p.done = true;
              sendSegment(sim, p.idx, true);
            }
          } else {
            p.done = true;
          }
        }
      }
    }

    // SACK-style loss repair (BBR only): the receiver ACKs every segment, so
    // an unACKed original with ≥3 ACKed segments above it is presumed lost
    // and retransmitted immediately — Linux BBR repairs via SACK/RACK rather
    // than waiting out a timer. Originals only: a re-lost retransmit has the
    // whole window ACKed above it already, so it must fall back to its timer
    // or it would re-fire instantly before the rtx even lands. Cubic keeps
    // its NewReno-style (non-SACK) recovery on purpose.
    if (sim.mode === "tcp" && sim.ccMode === "bbr") {
      const n = sim.inflight.length;
      for (let i = 0; i < n; i++) {
        const p = sim.inflight[i];
        if (p.done || p.abandoned || !p.lost || p.rtx) continue;
        if (sim.highestAckedIdx >= p.idx + 3 && !sim.ackedSet[p.idx]) {
          p.done = true;
          sendSegment(sim, p.idx, true);
        }
      }
    }

    if (sim.inflight.length > 4096) {
      sim.inflight = sim.inflight.filter((p) => !p.done);
    }

    // Receiver app drain
    if (sim.rmemUsed > 0 && eligibleForDrainCount > 0) {
      let drainBytes;
      drainBytes =
        (sim.appReadRateMbps > 0
          ? (sim.appReadRateMbps * 1e6 * dtSim) / 1000 / 8
          : 0) + sim.appReadResidualBytes;
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

    // Fast retransmit / recovery state machine (TCP, cubic + bbr). BBR uses
    // the same hole-detection and retransmit path but none of the cwnd
    // surgery — runBbr() recomputes its window from the model every tick.
    if (sim.mode === "tcp" && (sim.ccMode === "cubic" || sim.ccMode === "bbr")) {
      const isBbr = sim.ccMode === "bbr";
      if (cumAdvanced) {
        if (sim.inRecovery) {
          if (sim.ackedCount > sim.recoveryHighSeq) {
            // Full ACK → exit recovery
            if (!isBbr) sim.cwndSeg = Math.max(2, sim.ssthresh);
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
        } else if (!isBbr) {
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
    effectiveDrainMbps,
    inflightSegCount,
    queuedBytesNow,
    rtoDelayMs,
    cubicPacingRateBytesPerMs,
    handshakeMs,
    inHandshake,
    // data
    presets,
    CONSTANTS: {
      BAND_RTT_MIN_MS,
      BAND_RTT_MAX_MS,
      BAND_BW_MIN_MBPS,
      BAND_BW_MAX_MBPS,
      DEFAULT_RTO_MIN_MS,
      DEFAULT_CUBIC_PACING_GAIN,
    },
  };
});
