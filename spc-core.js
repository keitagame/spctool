/* =========================================================================
   SPC / BRR core
   - SPCファイルのパース(ヘッダ / ARAM / DSPレジスタ)
   - サンプルディレクトリの走査
   - BRR -> PCM デコード(SNES実機のガウシアン補間フィルタを使用)
   - PCM -> BRR エンコード(元のブロック数に一致させる)
   ========================================================================= */

const SPC = (() => {

  const HEADER_SIZE   = 0x100;      // SPCファイルヘッダ
  const ARAM_SIZE      = 0x10000;    // 64KB ARAM
  const ARAM_OFFSET    = 0x100;      // ファイル内でのARAM開始位置
  const DSP_OFFSET     = 0x10100;    // ファイル内でのDSPレジスタ開始位置
  const DSP_SIZE       = 0x80;       // 128バイト
  const SIGNATURE      = "SNES-SPC700 Sound File Data";

  // DSPレジスタのオフセット(グローバル)
  const R_DIR = 0x5D; // サンプルディレクトリのページ番号
  const R_KON = 0x4C;
  const R_KOFF = 0x5C;

  // ボイスごとのレジスタ(0x00 + voice*0x10 から)
  const V_SRCN = 0x04;
  const V_PITCHL = 0x02;
  const V_PITCHH = 0x03;

  const NATIVE_RATE = 32000; // SNES DSPの固定サンプルレート

  function clamp16(v) {
    if (v > 32767) return 32767;
    if (v < -32768) return -32768;
    return v;
  }

  // ------------------------------------------------------------------
  // SPCファイル読み込み
  // ------------------------------------------------------------------
  function parseSpc(buffer) {
    const bytes = new Uint8Array(buffer);
    const text = new TextDecoder("ascii").decode(bytes.slice(0, 33));
    if (!text.startsWith("SNES-SPC700 Sound File Data")) {
      throw new Error("SPCファイルとして認識できませんでした(シグネチャ不一致)");
    }
    if (bytes.length < HEADER_SIZE + ARAM_SIZE) {
      throw new Error("ファイルサイズが不足しています(64KB ARAMが見つかりません)");
    }
    const aram = bytes.slice(ARAM_OFFSET, ARAM_OFFSET + ARAM_SIZE);
    let dsp = new Uint8Array(DSP_SIZE);
    if (bytes.length >= DSP_OFFSET + DSP_SIZE) {
      dsp = bytes.slice(DSP_OFFSET, DSP_OFFSET + DSP_SIZE);
    }
    return {
      raw: bytes,
      aram: aram,
      dsp: dsp,
    };
  }

  // ディレクトリ上の全エントリを走査してサンプル一覧を作る
  // 各エントリ: DIRページ*0x100 + srcn*4 => [startAddrLo,Hi, loopAddrLo,Hi]
  function scanSamples(spc) {
    const aram = spc.aram;
    const dirPage = spc.dsp[R_DIR];
    const dirBase = dirPage * 0x100;

    // どのSRCNが実際に使われているか(KON/SRCNレジスタ)を集める
    const usedSrcn = new Set();
    for (let v = 0; v < 8; v++) {
      const srcn = spc.dsp[v * 0x10 + V_SRCN];
      usedSrcn.add(srcn);
    }

    // 実際にボイスから参照されているSRCN番号を優先的な走査対象とする。
    // ただし、曲中で命令的に切り替えられる分も拾えるよう、
    // 「妥当な(壊れていない)エントリ」は基本的に全て候補として拾い、
    // 明らかに不正/未使用な領域(全ゼロ、異常に長い等)は除外する。
    const maxEntries = 256;
    const candidates = [];
    for (let i = 0; i < maxEntries; i++) {
      const entryAddr = dirBase + i * 4;
      if (entryAddr + 4 > ARAM_SIZE) break;
      const startAddr = aram[entryAddr] | (aram[entryAddr + 1] << 8);
      const loopAddr  = aram[entryAddr + 2] | (aram[entryAddr + 3] << 8);

      // ディレクトリ領域自体を指しているなど、明らかに無効なエントリは除外
      if (startAddr >= ARAM_SIZE) continue;
      if (startAddr === 0 && loopAddr === 0) continue; // 未使用エントリの典型パターン

      const decoded = decodeBrrRegion(aram, startAddr);
      if (!decoded) continue;
      // safety上限(4096ブロック)に張り付いた場合は、BRRのendビットが
      // 見つからないまま走査を打ち切った=有効なサンプルではない可能性が高いので除外
      if (decoded.hitSafetyLimit) continue;

      candidates.push({
        index: i,
        dirEntryAddr: entryAddr,
        startAddr,
        loopAddr,
        hasLoop: decoded.hasLoop,
        blockCount: decoded.blockCount,
        byteLength: decoded.blockCount * 9,
        pcm: decoded.pcm,
        used: usedSrcn.has(i),
      });
    }

    // 同一startAddrの重複(複数SRCN番号が同じサンプルを指す)はそのまま許容するが、
    // 明らかに他の有効サンプルの内部(バイト範囲が重なる)にディレクトリの
    // ゴミが刺さっているだけのケースを弾くため、有効サンプル群のアドレス範囲と
    // 大きく重複するものを除外する。
    const ranges = candidates
      .filter(c => c.used) // 実際に使用されているものを「確実に正しい」基準とする
      .map(c => [c.startAddr, c.startAddr + c.byteLength]);

    function overlapsUsedRangeButNotStart(c) {
      for (const [s, e] of ranges) {
        if (c.startAddr > s && c.startAddr < e) return true; // 他サンプルの内部から開始している
      }
      return false;
    }

    const samples = candidates.filter(c => {
      if (c.used) return true;
      if (ranges.length > 0 && overlapsUsedRangeButNotStart(c)) return false;
      return true;
    });

    return samples;
  }

  // 開始アドレスからBRRブロックを終端(endビット)まで読み、PCMにデコード
  function decodeBrrRegion(aram, startAddr) {
    let addr = startAddr;
    const blocks = [];
    let safety = 0;
    const SAFETY_MAX = 2048; // 1サンプルあたりの上限ブロック数(約9.2秒相当)
    let hitSafetyLimit = false;
    let foundEnd = false;

    while (addr + 9 <= ARAM_SIZE && safety < SAFETY_MAX) {
      const header = aram[addr];
      const end = header & 0x01;
      const loop = (header & 0x02) >> 1;
      const filter = (header >> 2) & 0x03;
      const shift = (header >> 4) & 0x0F;

      blocks.push({ addr, header, end, loop, filter, shift });
      safety++;
      if (end) { foundEnd = true; break; }
      addr += 9;
    }
    if (blocks.length === 0) return null;
    if (!foundEnd) hitSafetyLimit = true;

    // PCMデコード(フィルタは前2サンプルに依存するので順にデコード)
    let hist1 = 0, hist2 = 0;
    const pcmBlocks = [];
    let hasLoop = false;

    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      const out = new Int16Array(16);
      for (let n = 0; n < 16; n++) {
        const byteIdx = b.addr + 1 + (n >> 1);
        const byte = aram[byteIdx];
        let nibble = (n % 2 === 0) ? (byte >> 4) : (byte & 0x0F);
        // 4bit符号拡張
        if (nibble >= 8) nibble -= 16;

        let sample;
        if (b.shift <= 12) {
          sample = (nibble << b.shift) >> 1;
        } else {
          // shift 13-15は無効値。SNES実機ではnibbleの符号に応じ特殊挙動になるが
          // 通常のサンプルデータには出現しないため0として扱う
          sample = (nibble < 0) ? -2048 : 0;
        }

        let p1 = hist1, p2 = hist2;
        switch (b.filter) {
          case 0:
            break;
          case 1:
            sample += p1 + ((-p1) >> 4);
            break;
          case 2:
            sample += p1 * 2 + ((-(p1 * 3)) >> 5) - p2 + (p2 >> 4);
            break;
          case 3:
            sample += p1 * 2 + ((-(p1 * 13)) >> 6) - p2 + (((p2 * 3) >> 4));
            break;
        }
        sample = clamp16(sample);
        out[n] = sample;
        hist2 = hist1;
        hist1 = sample;
      }
      pcmBlocks.push(out);
      if (b.end && b.loop) hasLoop = true; // ループビットは最終(endビット付き)ブロックで有効
    }

    const totalSamples = pcmBlocks.length * 16;
    const pcm = new Int16Array(totalSamples);
    for (let i = 0; i < pcmBlocks.length; i++) {
      pcm.set(pcmBlocks[i], i * 16);
    }

    return {
      blockCount: blocks.length,
      pcm,
      hasLoop,
      hitSafetyLimit,
    };
  }

  // loopAddrからループ開始サンプル位置(ブロック単位)を計算
  function computeLoopStartSample(sample) {
    if (!sample.hasLoop) return -1;
    const blockDiff = (sample.loopAddr - sample.startAddr) / 9;
    if (blockDiff < 0 || !Number.isInteger(blockDiff)) return 0;
    return blockDiff * 16;
  }

  // ------------------------------------------------------------------
  // プレビュー再生用の情報を返す。
  // ループありサンプルは「全体PCM + loopStart/loopEnd(秒)」を返し、
  // AudioBufferSourceNode.loop でネイティブにループ再生させる(実機と同じ挙動)。
  // ループなしはそのまま1回再生。
  // 戻り値: { pcm, loop:boolean, loopStartSample, loopEndSample }
  // ------------------------------------------------------------------
  function buildPreviewInfo(sample) {
    const pcm = sample.pcm;
    if (!sample.hasLoop || pcm.length === 0) {
      return { pcm, loop: false, loopStartSample: 0, loopEndSample: pcm.length };
    }
    let loopStart = computeLoopStartSample(sample);
    if (loopStart < 0) loopStart = 0;
    if (loopStart >= pcm.length) loopStart = 0;
    return { pcm, loop: true, loopStartSample: loopStart, loopEndSample: pcm.length };
  }

  // 後方互換: 旧API(固定長に伸長したPCMを返す)。WAV書き出し用に残す。
  function buildPreviewPcm(sample, minDurationSec = 1.6) {
    const info = buildPreviewInfo(sample);
    const pcm = info.pcm;
    if (!info.loop) return pcm;
    const minLen = Math.floor(minDurationSec * NATIVE_RATE);
    if (pcm.length >= minLen) return pcm;
    const loopBody = pcm.subarray(info.loopStartSample);
    if (loopBody.length === 0) return pcm;
    const total = minLen;
    const out = new Int16Array(total);
    out.set(pcm.subarray(0, Math.min(pcm.length, total)));
    let pos = pcm.length;
    while (pos < total) {
      const n = Math.min(loopBody.length, total - pos);
      out.set(loopBody.subarray(0, n), pos);
      pos += n;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // ピッチ推定(正規化自己相関)
  // buf の [start,end) 区間から基本周期(サンプル数, 小数)を推定する。
  // 見つからなければ 0 を返す。
  // ------------------------------------------------------------------
  function estimatePeriod(buf, start, end, minLag = 16, maxLag = 2048) {
    start = Math.max(0, start | 0);
    end = Math.min(buf.length, end | 0);
    // 解析窓が長すぎると重いので最大 8192 サンプルに制限
    const MAXWIN = 8192;
    if (end - start > MAXWIN) start = end - MAXWIN;
    const len = end - start;
    if (len < minLag * 3) return 0;
    maxLag = Math.min(maxLag, Math.floor(len / 2));
    if (maxLag <= minLag) return 0;

    // DC除去
    let mean = 0;
    for (let i = start; i < end; i++) mean += buf[i];
    mean /= len;

    const x = new Float64Array(len);
    for (let i = 0; i < len; i++) x[i] = buf[start + i] - mean;

    let e0 = 0;
    for (let i = 0; i < len; i++) e0 += x[i] * x[i];
    if (e0 < 1e-3) return 0;

    const corr = new Float64Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let s = 0, ea = 0, eb = 0;
      const n = len - lag;
      for (let i = 0; i < n; i++) {
        s += x[i] * x[i + lag];
        ea += x[i] * x[i];
        eb += x[i + lag] * x[i + lag];
      }
      const d = Math.sqrt(ea * eb);
      corr[lag] = d > 0 ? s / d : 0;
    }

    // 最大値を探す。ただしオクターブ下(倍周期)を選びすぎないよう、
    // 最大値の 0.9 以上を満たす最小ラグを採用する。
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (corr[lag] > best) { best = corr[lag]; bestLag = lag; }
    }
    if (best < 0.5 || bestLag === 0) return 0;
    let chosen = bestLag;
    for (let lag = minLag; lag < bestLag; lag++) {
      const isPeak = corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1];
      if (isPeak && corr[lag] >= best * 0.9) { chosen = lag; break; }
    }

    // 放物線補間でサブサンプル精度に
    const a = corr[chosen - 1], b = corr[chosen], c = corr[chosen + 1];
    const denom = (a - 2 * b + c);
    const shift = denom !== 0 ? 0.5 * (a - c) / denom : 0;
    return chosen + Math.max(-0.5, Math.min(0.5, shift));
  }

  // 元サンプルの解析: ループ区間長・推定周期・周波数
  function analyzeSample(sample) {
    const pcm = sample.pcm;
    let loopStart = sample.hasLoop ? computeLoopStartSample(sample) : 0;
    if (loopStart < 0 || loopStart >= pcm.length) loopStart = 0;
    const loopLen = pcm.length - loopStart;
    // ループ区間があればそこ、なければ全体(後半寄り)から推定
    const from = sample.hasLoop ? loopStart : Math.floor(pcm.length * 0.25);
    let period = estimatePeriod(pcm, from, pcm.length);
    let cycles = 0;
    // ループありの場合、元データはループ長が周期の整数倍になるよう作られているはず。
    // 推定周期を「ループ長 / 整数」にスナップして、実際に再生される周期に一致させる
    // (推定の微小誤差や、周期が小数のときのズレを吸収する)。
    if (sample.hasLoop && period > 0 && loopLen > 0) {
      cycles = Math.max(1, Math.round(loopLen / period));
      period = loopLen / cycles;
    }
    return {
      loopStart,
      loopLen,
      cycles,                                   // ループ区間に入る周期数(ループなしは0)
      period,                                   // サンプル数(32kHz基準)、0なら推定失敗
      freq: period > 0 ? NATIVE_RATE / period : 0,
    };
  }

  // 線形補間ではなく3次(Catmull-Rom)補間でリサンプル
  // ratio = 出力長 / 入力長
  function resampleCubic(input, outLen) {
    const n = input.length;
    const out = new Float32Array(outLen);
    if (n === 0 || outLen === 0) return out;
    const step = (n) / outLen;
    for (let i = 0; i < outLen; i++) {
      const pos = i * step;
      const i1 = Math.floor(pos);
      const t = pos - i1;
      const p0 = input[Math.max(0, i1 - 1)];
      const p1 = input[Math.min(n - 1, i1)];
      const p2 = input[Math.min(n - 1, i1 + 1)];
      const p3 = input[Math.min(n - 1, i1 + 2)];
      out[i] = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
    }
    return out;
  }

  // input の [start, start+span) (小数位置・小数長)を outLen 点に展開する。
  // 3次補間。範囲外は端をクランプ。
  function resampleRange(input, start, span, outLen) {
    const n = input.length;
    const out = new Float32Array(outLen);
    const step = span / outLen;
    for (let i = 0; i < outLen; i++) {
      const pos = start + i * step;
      const i1 = Math.floor(pos);
      const t = pos - i1;
      const p0 = input[Math.max(0, Math.min(n - 1, i1 - 1))];
      const p1 = input[Math.max(0, Math.min(n - 1, i1))];
      const p2 = input[Math.max(0, Math.min(n - 1, i1 + 1))];
      const p3 = input[Math.max(0, Math.min(n - 1, i1 + 2))];
      out[i] = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 置換用PCMを元サンプルに合わせて整形する。
  //  1. 元サンプルのループ周期(=音程)を推定
  //  2. 置換WAVの周期も推定し、比率でリサンプルして音程を揃える
  //     (WAV側が推定不能=打楽器など の場合は元の長さに単純フィット)
  //  3. ループありの場合、ループ区間が「置換WAVの周期の整数倍」になるよう
  //     長さを微調整し、継ぎ目で位相が連続するようにする
  // 戻り値: { pcm: Int16Array(blockCount*16), info }
  // ------------------------------------------------------------------
  function fitReplacementPcm(wavFloat32k, sample, opts = {}) {
    const targetSamples = sample.blockCount * 16;
    const orig = analyzeSample(sample);

    // 無音トリム(先頭・末尾)
    let a = 0, b = wavFloat32k.length;
    const thr = 0.002;
    while (a < b && Math.abs(wavFloat32k[a]) < thr) a++;
    while (b > a && Math.abs(wavFloat32k[b - 1]) < thr) b--;
    let wav = wavFloat32k.subarray(a, Math.max(a + 1, b));

    // 音量: SPCではボリュームは曲側(VOL/ADSR/エンベロープ)で調整済みなので、
    // 置換後も元サンプルと「同じ聴感音量」になるようRMSを元に揃える。
    // (ピーク基準だと、減衰音など元サンプルより大きくなり曲全体のバランスが崩れる)
    function rmsOf(arr, scale) {
      let s = 0;
      for (let i = 0; i < arr.length; i++) { const v = arr[i] * scale; s += v * v; }
      return Math.sqrt(s / Math.max(1, arr.length));
    }
    const origRms = rmsOf(sample.pcm, 1 / 32768);          // 元サンプル全体のRMS(0..1)
    const wavRms  = rmsOf(wav, 1);
    let gain = (wavRms > 1e-6 && origRms > 1e-6) ? (origRms / wavRms) : 1;
    // 安全策: ゲイン適用後のピークが 0.98 を超えないよう上限を設ける
    let peak = 0;
    for (let i = 0; i < wav.length; i++) peak = Math.max(peak, Math.abs(wav[i]));
    if (peak > 0) gain = Math.min(gain, 0.98 / peak);

    const info = { origPeriod: orig.period, origFreq: orig.freq, wavPeriod: 0, wavFreq: 0, mode: "", ratio: 1 };

    // WAV側の周期推定
    const wavPeriod = estimatePeriod(wav, Math.floor(wav.length * 0.25), wav.length);
    info.wavPeriod = wavPeriod;
    info.wavFreq = wavPeriod > 0 ? NATIVE_RATE / wavPeriod : 0;

    let out = new Float32Array(targetSamples);

    if (sample.hasLoop) {
      const loopStart = orig.loopStart;
      const loopLen = targetSamples - loopStart;

      if (wavPeriod > 0 && orig.period > 0) {
        // ---- ピッチ一致モード ----
        // WAVの周期を元サンプルの周期に合わせるための再生比
        const pitchRatio = orig.period / wavPeriod;  // >1 なら引き伸ばし
        // ループ区間に「WAV周期の整数倍」を敷き詰める。
        // cycles = ループ区間に入る周期数(元サンプルの周期基準で丸める)
        const cycles = orig.cycles > 0 ? orig.cycles : Math.max(1, Math.round(loopLen / orig.period));
        // 元WAVから取り出す区間の長さ(小数): WAV周期 × cycles
        const spanF = wavPeriod * cycles;

        // 切り出し開始位置(小数)を探索。
        // 「start の値」と「start+spanF の値」(=次のループ先頭の直前値の連続)を
        // 傾きも含めて一致させる位置を選ぶ。
        const lo = Math.max(2, Math.floor(wav.length * 0.25));
        const hi = Math.floor(wav.length - spanF - 3);
        let startF = Math.max(2, Math.min(lo, hi));
        if (hi >= lo) {
          const at = (x) => {
            const i1 = Math.floor(x), t = x - i1;
            const p0 = wav[Math.max(0, i1 - 1)], p1 = wav[Math.max(0, i1)];
            const p2 = wav[Math.min(wav.length - 1, i1 + 1)], p3 = wav[Math.min(wav.length - 1, i1 + 2)];
            return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
          };
          let bestCost = Infinity;
          for (let p = lo; p <= hi; p++) {
            const a0 = at(p), a1 = at(p + 1);
            const b0 = at(p + spanF), b1 = at(p + spanF + 1);
            // 位置ずれのペナルティは小さく(遠すぎる位置を避ける程度)
            const cost = Math.abs(a0 - b0) + Math.abs((a1 - a0) - (b1 - b0));
            if (cost < bestCost) { bestCost = cost; startF = p; }
          }
        }
        // 小数区間 [startF, startF+spanF) を loopLen 点に展開(周期の整数倍なので継ぎ目で位相連続)
        const loopPart = resampleRange(wav, startF, spanF, loopLen);

        // ループ前のアタック部(頭出し部分)はWAVの先頭から、同じ比率で
        const headLen = loopStart;
        if (headLen > 0) {
          const headSrcLen = Math.min(wav.length, Math.max(1, Math.round(headLen / pitchRatio)));
          const headPart = resampleCubic(wav.subarray(0, headSrcLen), headLen);
          out.set(headPart, 0);
        }
        out.set(loopPart, loopStart);

        // アタック部→ループ部の境目: アタック末尾をループ先頭へ短いクロスフェードで繋ぐ。
        // (ループ区間側は変更しない=ループ継ぎ目の連続性は保たれる)
        if (headLen > 0) {
          const XF = Math.min(48, headLen);
          for (let i = 0; i < XF; i++) {
            const t = (i + 1) / (XF + 1);          // 0→1
            const idx = loopStart - XF + i;
            // アタック側の値から、ループ先頭の「直前の連続値」(ループ末尾)へ寄せる
            const target = loopPart[loopLen - XF + i];
            out[idx] = out[idx] * (1 - t) + target * t;
          }
        }
        info.mode = "pitch-match";
        info.ratio = pitchRatio;
      } else {
        // ---- 周期推定不能: 元の長さにそのままフィット ----
        const fitted = resampleCubic(wav, targetSamples);
        out.set(fitted);
        info.mode = "fit-length";
        info.ratio = targetSamples / Math.max(1, wav.length);
      }

      // 継ぎ目処理: ループ区間はWAV周期の整数倍で敷き詰めているので、
      // 末尾→先頭は位相・傾きとも連続する。クロスフェードは勾配を壊すため行わない。
    } else {
      // ---- ワンショット ----
      if (wavPeriod > 0 && orig.period > 0) {
        const pitchRatio = orig.period / wavPeriod;
        const outLen = Math.max(1, Math.min(targetSamples, Math.round(wav.length * pitchRatio)));
        const fitted = resampleCubic(wav, outLen);
        out.set(fitted, 0); // 余りは無音
        // 末尾フェードアウト
        const fade = Math.min(256, outLen >> 2);
        for (let i = 0; i < fade; i++) {
          out[outLen - 1 - i] *= i / fade;
        }
        info.mode = "pitch-match";
        info.ratio = pitchRatio;
      } else {
        // 打楽器など: 長さだけ合わせず、そのまま先頭から並べる(ピッチ変更しない)
        const copyLen = Math.min(targetSamples, wav.length);
        out.set(wav.subarray(0, copyLen), 0);
        const fade = Math.min(256, copyLen >> 2);
        for (let i = 0; i < fade; i++) out[copyLen - 1 - i] *= i / fade;
        info.mode = "as-is";
        info.ratio = 1;
      }
    }

    const pcm = new Int16Array(targetSamples);
    for (let i = 0; i < targetSamples; i++) {
      let v = Math.round(out[i] * gain * 32767);
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      pcm[i] = v;
    }
    return { pcm, info };
  }

  // ------------------------------------------------------------------
  // PCM -> BRR エンコード
  // targetBlockCount: 出力を必ずこのブロック数に一致させる
  // loop: 最終ブロックにループビットを立てるか
  // ------------------------------------------------------------------
  function encodeBrr(pcm16, targetBlockCount, opts = {}) {
    const useLoop = !!opts.loop;
    const loopStartBlock = (opts.loopStartBlock !== undefined) ? opts.loopStartBlock : 0;
    const targetSamples = targetBlockCount * 16;

    // 入力を targetSamples に一致させる(足りなければ単純ループ)
    let src;
    if (pcm16.length >= targetSamples) {
      src = pcm16.subarray(0, targetSamples);
    } else {
      src = new Int16Array(targetSamples);
      if (pcm16.length > 0) {
        for (let i = 0; i < targetSamples; i++) src[i] = pcm16[i % pcm16.length];
      }
    }

    // 1回分のエンコード。tailHist が与えられた場合、ループ先頭ブロックは
    // 「直前ブロックの履歴」と「末尾ブロックの履歴(=ループで戻ってきた時の履歴)」
    // の両方でデコードした誤差の合計が最小になるfilter/shiftを選ぶ。
    // 実機ではループ後もフィルタ履歴を持ち越すため、初回再生と2周目以降で
    // ループ先頭の音がずれるのを防ぐ。
    function encodePass(tailHist) {
      const out = new Uint8Array(targetBlockCount * 9);
      let hist1 = 0, hist2 = 0;
      for (let blk = 0; blk < targetBlockCount; blk++) {
        const blockSamples = src.subarray(blk * 16, blk * 16 + 16);
        const isLast = (blk === targetBlockCount - 1);
        const dual = useLoop && tailHist && blk === loopStartBlock && blk > 0;

        let best = null;
        for (let filter = 0; filter < 4; filter++) {
          for (let shift = 0; shift <= 12; shift++) {
            const r = tryEncodeBlock(blockSamples, filter, shift, hist1, hist2);
            let score = r.err;
            if (dual) {
              // 同じnibbleを末尾履歴でデコードしたときの誤差を加算
              score += evalBlockWithHist(blockSamples, r.nibbles, filter, shift, tailHist.h1, tailHist.h2);
            }
            if (!best || score < best.score) best = { ...r, filter, shift, score };
          }
        }

        const headerByte =
          (best.shift << 4) | (best.filter << 2) |
          (useLoop ? 0x02 : 0x00) | (isLast ? 0x01 : 0x00);
        const off = blk * 9;
        out[off] = headerByte;
        for (let n = 0; n < 16; n += 2) {
          out[off + 1 + (n >> 1)] = ((best.nibbles[n] & 0x0F) << 4) | (best.nibbles[n + 1] & 0x0F);
        }
        hist1 = best.h1; hist2 = best.h2;
      }
      return { out, h1: hist1, h2: hist2 };
    }

    const pass1 = encodePass(null);
    if (!useLoop || loopStartBlock <= 0) return pass1.out;
    // 末尾履歴を使って再エンコード(履歴が変わるので2〜3回収束させる)
    let cur = pass1;
    for (let iter = 0; iter < 3; iter++) {
      cur = encodePass({ h1: cur.h1, h2: cur.h2 });
    }
    return cur.out;
  }

  // 既に決まっている nibble 列を、指定履歴でデコードした場合の二乗誤差
  function evalBlockWithHist(target, nibbles, filter, shift, h1in, h2in) {
    let h1 = h1in, h2 = h2in, err = 0;
    for (let n = 0; n < 16; n++) {
      let s = (nibbles[n] << shift) >> 1;
      switch (filter) {
        case 1: s += h1 + ((-h1) >> 4); break;
        case 2: s += h1 * 2 + ((-(h1 * 3)) >> 5) - h2 + (h2 >> 4); break;
        case 3: s += h1 * 2 + ((-(h1 * 13)) >> 6) - h2 + ((h2 * 3) >> 4); break;
      }
      s = clamp16(s);
      const d = s - target[n];
      err += d * d;
      h2 = h1; h1 = s;
    }
    return err;
  }

  function tryEncodeBlock(samples, filter, shift, hist1In, hist2In) {
    const nibbles = new Int8Array(16);
    let hist1 = hist1In, hist2 = hist2In;
    let err = 0;

    for (let n = 0; n < 16; n++) {
      const target = samples[n];

      let pred = 0;
      const p1 = hist1, p2 = hist2;
      switch (filter) {
        case 0: pred = 0; break;
        case 1: pred = p1 + ((-p1) >> 4); break;
        case 2: pred = p1 * 2 + ((-(p1 * 3)) >> 5) - p2 + (p2 >> 4); break;
        case 3: pred = p1 * 2 + ((-(p1 * 13)) >> 6) - p2 + (((p2 * 3) >> 4)); break;
      }

      const diff = target - pred;
      // diff = (nibble << shift) >> 1  => nibble ~= (diff*2) >> shift
      let nibble;
      if (shift === 0) {
        nibble = Math.round(diff * 2);
      } else {
        nibble = Math.round((diff * 2) / (1 << shift));
      }
      if (nibble > 7) nibble = 7;
      if (nibble < -8) nibble = -8;

      let decodedSample;
      if (shift <= 12) {
        decodedSample = (nibble << shift) >> 1;
      } else {
        decodedSample = 0;
      }
      decodedSample += pred;
      decodedSample = clamp16(decodedSample);

      const e = decodedSample - target;
      err += e * e;

      nibbles[n] = nibble;
      hist2 = hist1;
      hist1 = decodedSample;
    }

    return { nibbles, h1: hist1, h2: hist2, err };
  }

  // ------------------------------------------------------------------
  // WAVパース(WebAudioでdecodeAudioDataするのがメインだが、
  // 生波形取得用の簡易パーサも用意)
  // ------------------------------------------------------------------
  async function decodeWavToPcm(arrayBuffer, audioCtx) {
    // decodeAudioDataはコピーを要求するので複製して渡す
    const copy = arrayBuffer.slice(0);
    const audioBuffer = await audioCtx.decodeAudioData(copy);
    return audioBuffer;
  }

  function resampleTo(audioBuffer, targetRate) {
    // OfflineAudioContextでリサンプリング(モノラルに変換)
    const duration = audioBuffer.duration;
    const targetLength = Math.max(1, Math.ceil(duration * targetRate));
    return new Promise((resolve, reject) => {
      try {
        const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
          1, targetLength, targetRate
        );
        const src = offlineCtx.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(offlineCtx.destination);
        src.start(0);
        offlineCtx.startRendering().then((rendered) => {
          resolve(rendered.getChannelData(0));
        }).catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  function floatToInt16(floatArr) {
    const out = new Int16Array(floatArr.length);
    for (let i = 0; i < floatArr.length; i++) {
      let v = Math.round(floatArr[i] * 32767);
      if (v > 32767) v = 32767;
      if (v < -32768) v = -32768;
      out[i] = v;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 元サンプルの「基本周波数」を求める。
  // SPC/DSPには「サンプル自体の周波数」というメタ情報は存在せず、
  // ボイスのPITCHレジスタとの組で再生速度が決まる。
  // ここでは実務的な基準として「32000Hz(ネイティブレート)」を
  // サンプルの基準周波数とみなし、WAV側のサンプルレートをこれに一致させる
  // (= SNES実機がARAMのPCMをそのまま32kHzとして解釈するのと同じ考え方)。
  // ------------------------------------------------------------------
  function getNativeRate() {
    return NATIVE_RATE;
  }

  // ------------------------------------------------------------------
  // ARAMへの書き込み(同一ブロック数のBRRで上書き)
  // ------------------------------------------------------------------
  function writeBrrToAram(aramCopy, startAddr, brrBytes) {
    aramCopy.set(brrBytes, startAddr);
  }

  // SPCファイル全体を再構築(ARAMのみ書き換え、ヘッダ/DSP/ID666は保持)
  function rebuildSpcFile(originalBytes, newAram) {
    const out = new Uint8Array(originalBytes.length);
    out.set(originalBytes);
    out.set(newAram, ARAM_OFFSET);
    return out;
  }

// ------------------------------------------------------------------
  // PCM (Int16Array) を WAV フォーマット (RIFF/WAVE 16bit) の Blob に変換
  // ------------------------------------------------------------------
  function encodePcmToWavBlob(pcm16, sampleRate = NATIVE_RATE) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcm16.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(v, offset, str) {
      for (let i = 0; i < str.length; i++) {
        v.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    /* RIFF header */
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');

    /* fmt chunk */
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);          // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true);           // AudioFormat (1 = PCM)
    view.setUint16(22, numChannels, true); // NumChannels
    view.setUint32(24, sampleRate, true);  // SampleRate
    view.setUint32(28, byteRate, true);    // ByteRate
    view.setUint16(32, blockAlign, true);  // BlockAlign
    view.setUint16(34, bitsPerSample, true); // BitsPerSample

    /* data chunk */
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    /* PCM samples */
    let offset = 44;
    for (let i = 0; i < pcm16.length; i++, offset += 2) {
      view.setInt16(offset, pcm16[i], true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  return {
    NATIVE_RATE,
    parseSpc,
    scanSamples,
    decodeBrrRegion,
    computeLoopStartSample,
    buildPreviewPcm,
    buildPreviewInfo,
    analyzeSample,
    estimatePeriod,
    fitReplacementPcm,
    encodeBrr,
    decodeWavToPcm,
    resampleTo,
    floatToInt16,
    getNativeRate,
    writeBrrToAram,
    rebuildSpcFile,
    encodePcmToWavBlob, // ← 追加
  };

})();