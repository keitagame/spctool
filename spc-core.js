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
  // プレビュー用ロング化再生バッファの生成
  // 実機のBRRループ再生と同じ考え方で「ループ区間を繰り返して伸長」する。
  // ループが無いサンプルは元の長さのまま(必要なら無音パディング)。
  // ------------------------------------------------------------------
  function buildPreviewPcm(sample, minDurationSec = 1.6) {
    const rate = NATIVE_RATE;
    const minLen = Math.floor(minDurationSec * rate);
    const pcm = sample.pcm;

    if (!sample.hasLoop || pcm.length === 0) {
      return pcm; // ループなしはそのまま(短さも情報として提示する)
    }

    const loopStart = computeLoopStartSample(sample);
    const loopStartClamped = Math.max(0, Math.min(loopStart, pcm.length - 1));
    const loopBody = pcm.subarray(loopStartClamped);
    if (loopBody.length === 0) return pcm;

    if (pcm.length >= minLen) return pcm;

    const head = pcm.subarray(0, loopStartClamped);
    const extra = minLen - pcm.length;
    const repeatCount = Math.ceil(extra / loopBody.length) + 1;

    const result = new Int16Array(head.length + loopBody.length * (repeatCount + 1));
    let off = 0;
    result.set(head, off); off += head.length;
    result.set(loopBody, off); off += loopBody.length; // 元データの1回分
    for (let r = 0; r < repeatCount; r++) {
      result.set(loopBody, off);
      off += loopBody.length;
    }
    return result.subarray(0, off);
  }

  // ------------------------------------------------------------------
  // PCM -> BRR エンコード
  // targetBlockCount: 出力を必ずこのブロック数に一致させる
  // loop: 最終ブロックにループビットを立てるか
  // ------------------------------------------------------------------
  function encodeBrr(pcm16, targetBlockCount, opts = {}) {
    const useLoop = !!opts.loop;
    const targetSamples = targetBlockCount * 16;

    // 長さ調整: 長ければトリム、短ければループ(またはゼロ埋め)して targetSamples に一致させる
    let src;
    if (pcm16.length >= targetSamples) {
      src = pcm16.subarray(0, targetSamples);
    } else {
      src = new Int16Array(targetSamples);
      if (pcm16.length > 0) {
        // 末尾を単純ループして必要な長さを確保(急な無音化を避ける)
        for (let i = 0; i < targetSamples; i++) {
          src[i] = pcm16[i % pcm16.length];
        }
      }
    }

    const out = new Uint8Array(targetBlockCount * 9);
    let hist1 = 0, hist2 = 0;

    for (let blk = 0; blk < targetBlockCount; blk++) {
      const blockSamples = src.subarray(blk * 16, blk * 16 + 16);
      const isLast = (blk === targetBlockCount - 1);

      // このブロックに最適なfilter/shiftを総当たりで探索し、誤差最小のものを採用
      let best = null;
      for (let filter = 0; filter < 4; filter++) {
        for (let shift = 0; shift <= 12; shift++) {
          const { nibbles, h1, h2, err } = tryEncodeBlock(blockSamples, filter, shift, hist1, hist2);
          if (!best || err < best.err) {
            best = { nibbles, h1, h2, err, filter, shift };
          }
        }
      }

      const headerByte =
        (best.shift << 4) |
        (best.filter << 2) |
        (useLoop ? 0x02 : 0x00) |
        (isLast ? 0x01 : 0x00);

      const blockOff = blk * 9;
      out[blockOff] = headerByte;
      for (let n = 0; n < 16; n += 2) {
        const hi = best.nibbles[n] & 0x0F;
        const lo = best.nibbles[n + 1] & 0x0F;
        out[blockOff + 1 + (n >> 1)] = (hi << 4) | lo;
      }

      hist1 = best.h1;
      hist2 = best.h2;
    }

    return out;
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

  return {
    NATIVE_RATE,
    parseSpc,
    scanSamples,
    decodeBrrRegion,
    computeLoopStartSample,
    buildPreviewPcm,
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