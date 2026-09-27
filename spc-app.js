/* =========================================================================
   App layer: UI wiring, playback, replace & export
   ========================================================================= */
(() => {
  const dropzone     = document.getElementById("dropzone");
  const fileInput     = document.getElementById("fileInput");
  const metaBar       = document.getElementById("metaBar");
  const metaFileName  = document.getElementById("metaFileName");
  const metaSampleCount = document.getElementById("metaSampleCount");
  const metaDir       = document.getElementById("metaDir");
  const btnPlaySpc   = document.getElementById("btnPlaySpc");
  const btnReload     = document.getElementById("btnReload");
  const btnExport     = document.getElementById("btnExport");
  const listWrap      = document.getElementById("listWrap");
  const sampleList     = document.getElementById("sampleList");
  const emptyState    = document.getElementById("emptyState");
  const wavInput       = document.getElementById("wavInput");
  const toastEl        = document.getElementById("toast");
let isSpcPlaying = false;
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  let state = {
    fileName: "",
    originalBytes: null, // Uint8Array (ファイル全体)
    spc: null,           // { raw, aram, dsp }
    samples: [],         // scanSamples()の結果 + replacement情報
    currentPlayingIndex: -1,
    currentSourceNode: null,
    pendingReplaceIndex: -1,
  };

  // ---------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------
  let toastTimer = null;
  function showToast(msg, isErr = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("err", isErr);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
  }
btnPlaySpc.addEventListener("click", () => toggleSpcPlay());

  function toggleSpcPlay() {
    if (typeof SPCPlayer === "undefined") {
      showToast("libspc.js が読み込まれていません", true);
      return;
    }

    if (isSpcPlaying) {
      stopSpcPlayback();
      return;
    }

    // 単体サンプルの再生が動いていれば停止
    stopPlayback();

    // 置換データがあれば反映後のSPCバッファを作成、無ければ元のバッファを使用
    let bufferToPlay;
    if (state.samples.some(s => s.replacement)) {
      const newAram = new Uint8Array(state.spc.aram);
      state.samples.forEach(s => {
        if (s.replacement) {
          SPC.writeBrrToAram(newAram, s.startAddr, s.replacement.brrBytes);
        }
      });
      const outBytes = SPC.rebuildSpcFile(state.originalBytes, newAram);
      bufferToPlay = outBytes.buffer;
    } else {
      bufferToPlay = state.originalBytes.buffer;
    }

    try {
      const player = SPCPlayer.getInstance();
      player.load(bufferToPlay); // パースおよびエミュレータ状態のリセット
      player.play();

      isSpcPlaying = true;
      btnPlaySpc.textContent = "■ SPC停止";
      btnPlaySpc.classList.add("on");
      showToast("SPC楽曲の再生を開始しました");
    } catch (err) {
      console.error(err);
      showToast("SPC再生エラー: " + err.message, true);
    }
  }

  function stopSpcPlayback() {
    if (isSpcPlaying) {
      if (typeof SPCPlayer !== "undefined") {
        try {
          const player = SPCPlayer.getInstance();
          player.stop();
        } catch (e) {}
      }
      isSpcPlaying = false;
      btnPlaySpc.textContent = "▶ SPC再生";
      btnPlaySpc.classList.remove("on");
    }
  }
  // ---------------------------------------------------------------------
  // File loading (SPC)
  // ---------------------------------------------------------------------
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
    const f = e.dataTransfer.files[0];
    if (f) loadSpcFile(f);
  });
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) loadSpcFile(f);
  });
  btnReload.addEventListener("click", () => {
    fileInput.value = "";
    resetState();
  });

  function resetState() {
    stopSpcPlayback();    // ★追加
    
    stopPlayback();
    state = {
      fileName: "",
      originalBytes: null,
      spc: null,
      samples: [],
      currentPlayingIndex: -1,
      currentSourceNode: null,
      pendingReplaceIndex: -1,
    };
    metaBar.classList.add("hidden");
    listWrap.classList.add("hidden");
    emptyState.classList.remove("hidden");
    sampleList.innerHTML = "";
    btnExport.disabled = true;
  }

  async function loadSpcFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const spc = SPC.parseSpc(buf);
      const samples = SPC.scanSamples(spc);

      if (samples.length === 0) {
        showToast("有効なサンプルが見つかりませんでした", true);
        return;
      }

      state.fileName = file.name;
      state.originalBytes = spc.raw;
      state.spc = spc;
      state.samples = samples.map(s => ({
        ...s,
        replacement: null, // { pcmFloat, sourceRate, fileName, brrBytes }
      }));

      metaFileName.textContent = file.name;
      metaSampleCount.textContent = String(samples.length);
      metaDir.textContent = "0x" + (spc.dsp[0x5D] * 0x100).toString(16).toUpperCase().padStart(4, "0");
      metaBar.classList.remove("hidden");
      listWrap.classList.remove("hidden");
      emptyState.classList.add("hidden");

      renderList();
      showToast(`${samples.length} 個のサンプルを検出しました`);
    } catch (err) {
      console.error(err);
      showToast("読み込みエラー: " + err.message, true);
    }
  }

  // ---------------------------------------------------------------------
  // List rendering
  // ---------------------------------------------------------------------
  function renderList() {
    sampleList.innerHTML = "";
    state.samples.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "sample-row" + (s.replacement ? " replaced" : "");
      row.dataset.idx = i;

      const idx = document.createElement("div");
      idx.className = "idx";
      idx.textContent = "#" + s.index.toString().padStart(2, "0");
      row.appendChild(idx);

      const playBtn = document.createElement("button");
      playBtn.className = "play-btn";
      playBtn.innerHTML = playIcon();
      playBtn.title = "プレビュー再生";
      playBtn.addEventListener("click", () => togglePlay(i, playBtn));
      // idxの隣に置くレイアウトのため一旦infoの前に挿入
      row.appendChild(playBtn);

      const info = document.createElement("div");
      info.className = "info";
      const nameEl = document.createElement("div");
      nameEl.className = "name";
      if (s.replacement) {
        nameEl.innerHTML = `sample #${s.index} <span class="newname">→ ${escapeHtml(s.replacement.fileName)}</span>`;
      } else {
        nameEl.textContent = `sample #${s.index}`;
      }
      info.appendChild(nameEl);

      const stats = document.createElement("div");
      stats.className = "stats";
      const durSec = (s.pcm.length / SPC.NATIVE_RATE).toFixed(2);
      stats.innerHTML = `
        <span>${s.blockCount} blocks / ${s.byteLength}B</span>
        <span>${durSec}s</span>
        ${s.hasLoop ? '<span class="tag loop">LOOP</span>' : '<span class="tag">ONE-SHOT</span>'}
        ${s.used ? '' : '<span class="tag">unused?</span>'}
        ${s.replacement ? '<span class="tag new">REPLACED</span>' : ''}
      `;
      info.appendChild(stats);
      row.appendChild(info);

      const waveWrap = document.createElement("div");
      waveWrap.className = "waveform";
      const canvas = document.createElement("canvas");
      canvas.width = 240; canvas.height = 68;
      waveWrap.appendChild(canvas);
      row.appendChild(waveWrap);
      drawWaveform(canvas, s.replacement ? s.replacement.previewPcm || s.pcm : s.pcm);

      const actions = document.createElement("div");
      actions.className = "row-actions";
const exportWavBtn = document.createElement("button");
      exportWavBtn.className = "btn small";
      exportWavBtn.textContent = "WAV保存";
      exportWavBtn.title = "プレビュー音声をWAVファイルとして保存";
      exportWavBtn.addEventListener("click", () => downloadSampleWav(i));
      actions.appendChild(exportWavBtn);
      const replaceBtn = document.createElement("button");
      replaceBtn.className = "btn small";
      replaceBtn.textContent = s.replacement ? "WAVを変更" : "WAVで置換";
      replaceBtn.addEventListener("click", () => startReplace(i));
      actions.appendChild(replaceBtn);

      if (s.replacement) {
        const revertBtn = document.createElement("button");
        revertBtn.className = "btn small";
        revertBtn.textContent = "元に戻す";
        revertBtn.addEventListener("click", () => revertReplace(i));
        actions.appendChild(revertBtn);
      }

      row.appendChild(actions);
      sampleList.appendChild(row);
    });

    btnExport.disabled = !state.samples.some(s => s.replacement);
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function playIcon(isPlaying) {
    if (isPlaying) {
      return '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  }

  // ---------------------------------------------------------------------
  // Waveform drawing (simple min/max peak view)
  // ---------------------------------------------------------------------
  function drawWaveform(canvas, pcm) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#1e2021";
    ctx.fillRect(0, 0, w, h);
    if (!pcm || pcm.length === 0) return;

    const mid = h / 2;
    const step = Math.max(1, Math.floor(pcm.length / w));
    ctx.strokeStyle = "#5ee6c0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const start = x * step;
      let min = 32767, max = -32768;
      for (let i = 0; i < step && start + i < pcm.length; i++) {
        const v = pcm[start + i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > max) { min = 0; max = 0; }
      const y1 = mid - (max / 32768) * mid;
      const y2 = mid - (min / 32768) * mid;
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y2);
    }
    ctx.stroke();
  }

  // ---------------------------------------------------------------------
  // Playback (preview) — Web Audio API
  // ---------------------------------------------------------------------
  function stopPlayback() {
    if (state.currentSourceNode) {
      try { state.currentSourceNode.stop(); } catch (e) {}
      state.currentSourceNode = null;
    }
    state.currentPlayingIndex = -1;
    document.querySelectorAll(".play-btn.on").forEach(btn => {
      btn.classList.remove("on");
      btn.innerHTML = playIcon(false);
    });
    document.querySelectorAll(".sample-row.playing").forEach(r => r.classList.remove("playing"));
  }

  function togglePlay(i, btnEl) {
    const wasPlaying = state.currentPlayingIndex === i;
    stopPlayback();
    stopSpcPlayback();
    if (wasPlaying) return;

    const s = state.samples[i];
    const pcmSource = s.replacement ? (s.replacement.previewPcm || s.pcm) : s.pcm;
    const previewPcm = s.replacement
      ? pcmSource
      : SPC.buildPreviewPcm(s, 1.6);

    if (previewPcm.length === 0) {
      showToast("このサンプルは空です");
      return;
    }

    const ctx = getAudioCtx();
    const buffer = ctx.createBuffer(1, previewPcm.length, SPC.NATIVE_RATE);
    const chData = buffer.getChannelData(0);
    for (let i2 = 0; i2 < previewPcm.length; i2++) {
      chData[i2] = previewPcm[i2] / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => {
      if (state.currentPlayingIndex === i) stopPlayback();
    };
    src.start();

    state.currentSourceNode = src;
    state.currentPlayingIndex = i;
    btnEl.classList.add("on");
    btnEl.innerHTML = playIcon(true);
    btnEl.closest(".sample-row").classList.add("playing");
  }

  // ---------------------------------------------------------------------
  // Replace with WAV
  // ---------------------------------------------------------------------
  function startReplace(i) {
    state.pendingReplaceIndex = i;
    wavInput.value = "";
    wavInput.click();
  }

  wavInput.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    const i = state.pendingReplaceIndex;
    if (!f || i < 0) return;

    const s = state.samples[i];
    try {
      showToast("WAVを解析中…");
      const buf = await f.arrayBuffer();
      const ctx = getAudioCtx();
      const audioBuffer = await SPC.decodeWavToPcm(buf, ctx);

      // 元サンプルの基準レート(32000Hz)にリサンプリング
      const targetRate = SPC.NATIVE_RATE;
      const resampledFloat = await SPC.resampleTo(audioBuffer, targetRate);
      const pcm16Full = SPC.floatToInt16(resampledFloat);

      // 元のブロック数に一致させてBRRエンコード
      const targetBlockCount = s.blockCount;
      const brrBytes = SPC.encodeBrr(pcm16Full, targetBlockCount, { loop: s.hasLoop });

      // 検証用: 再デコードしてプレビュー波形を作る(実際にARAMに入る内容と同一)
      const verifyDecoded = SPC.decodeBrrRegion(concatForVerify(brrBytes), 0);
      let previewPcm = verifyDecoded ? verifyDecoded.pcm : pcm16Full;
      if (s.hasLoop && verifyDecoded) {
        const fakeSample = {
          pcm: verifyDecoded.pcm,
          hasLoop: true,
          loopAddr: s.loopAddr,
          startAddr: s.startAddr,
        };
        previewPcm = SPC.buildPreviewPcm(fakeSample, 1.6);
      }

      s.replacement = {
        fileName: f.name,
        brrBytes,
        previewPcm,
      };

      renderList();
      showToast(`sample #${s.index} を "${f.name}" に置き換えました`);
    } catch (err) {
      console.error(err);
      showToast("置き換えに失敗しました: " + err.message, true);
    }
  });

  // decodeBrrRegionはARAM全体+開始アドレスを期待するので、
  // 検証用に十分な長さのバッファへコピーしてから渡すヘルパー
  function concatForVerify(brrBytes) {
    const buf = new Uint8Array(brrBytes.length + 16);
    buf.set(brrBytes, 0);
    return buf;
  }

  function revertReplace(i) {
    const s = state.samples[i];
    s.replacement = null;
    renderList();
    showToast(`sample #${s.index} の置き換えを取り消しました`);
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------
  btnExport.addEventListener("click", () => {
    if (!state.spc) return;
    try {
      const newAram = new Uint8Array(state.spc.aram); // copy
      let count = 0;
      state.samples.forEach(s => {
        if (s.replacement) {
          SPC.writeBrrToAram(newAram, s.startAddr, s.replacement.brrBytes);
          count++;
        }
      });
      const outBytes = SPC.rebuildSpcFile(state.originalBytes, newAram);

      const blob = new Blob([outBytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const baseName = state.fileName.replace(/\.spc$/i, "");
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName}_replaced.spc`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 4000);

      showToast(`${count} 個のサンプルを置き換えたSPCを書き出しました`);
    } catch (err) {
      console.error(err);
      showToast("書き出しに失敗しました: " + err.message, true);
    }
  });

  // 初期状態
  resetState();
  function downloadSampleWav(i) {
    const s = state.samples[i];
    if (!s) return;

    // プレビュー再生時とまったく同じPCM音声を生成
    const pcmSource = s.replacement ? (s.replacement.previewPcm || s.pcm) : s.pcm;
    const previewPcm = s.replacement
      ? pcmSource
      : SPC.buildPreviewPcm(s, 1.6);

    if (!previewPcm || previewPcm.length === 0) {
      showToast("保存できるサンプルデータがありません", true);
      return;
    }

    const blob = SPC.encodePcmToWavBlob(previewPcm, SPC.NATIVE_RATE);
    const url = URL.createObjectURL(blob);
    const baseName = state.fileName.replace(/\.spc$/i, "");
    const sampleIdxStr = s.index.toString().padStart(2, "0");
    
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}_sample_${sampleIdxStr}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    showToast(`sample #${s.index} をWAVとして保存しました`);
  }
})();
// ---------------------------------------------------------------------
  // Export Sample as WAV
  // ---------------------------------------------------------------------
  