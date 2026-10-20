# Encoder benchmark: the measured encode choices

*Re-measured on 2026-10-18 (Apple A18 Pro, 6 CPU cores, ffmpeg 8.1) after we
corrected the order of the libvmaf inputs. See Method. Motion source: 8 s,
2816×1762 @ 30 fps of synthetic UI motion (text that scrolls, blocks that
slide, a frame counter). The `cores` column varies ~±15% between runs.*

## Method

- **CPU:** `/usr/bin/time -p` → user time ÷ duration = average cores used
- **Quality:** libvmaf against a visually lossless reference (CRF 18 capture).
  ffmpeg's filter takes the **distorted video first, reference second**. The
  8/2026 table reversed them, so every score increased by 1.5–3.6 points.
  We re-measured with:

  ```bash
  ffmpeg -i encoded.mp4 -i source.mov -lavfi \
    "[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS,scale=W:H[r];[d][r]libvmaf" \
    -f null -
  ```

  Model: the libvmaf default (`vmaf_v0.6.1`). For downscaled outputs we scale
  the reference to the encoded size first; libvmaf needs equal dimensions.
- **Size:** encoded file, video only

## Results (motion source, 8 s / 240 frames)

| Configuration | KB | cores | VMAF | Verdict |
|---|---|---|---|---|
| **x264 veryfast CRF 26** | **540** | **1.00** | **94.6** | ⭐ best mode at full resolution |
| x264 veryfast CRF 28 | 443 | 1.12 | 92.4 | ⭐ CRF 28 at full res |
| x264 vf CRF 26 + 50% scale | 241 | 0.50 | 91.0 | 💎 optional mode (`--half`) |
| x264 medium CRF 26 | 515 | 1.62 | 96.3 | +1.7 VMAF for +62% CPU; we do not use it |
| x265 fast CRF 30 | 510 | 6.37 | 96.0 | ❌ saturates all cores |
| VideoToolbox H.264 q50 | 1,625 | 0.12 | 94.4 | 3× larger at the same quality |
| VideoToolbox HEVC q50 | 1,380 | 0.12 | 92.9 | the same result |
| x264 CRF 26 @ 15 fps | 506 | 0.62 | **80.4** | ❌ −6% size, temporal fidelity collapses |

Static-source spot check: x264 vf CRF 26 = 189 KB / VMAF 95.9. A direct
avfoundation capture peaked at ~1.2 cores (capture + encode).

## Three findings that reversed the assumptions

1. **Software x264 is cheap on Apple Silicon**: about 1 of 6 cores with
   veryfast (0.87–1.0 across runs). Hardware VideoToolbox is not needed; at
   equal quality its files are ~3× larger.
2. **Resolution has the largest effect; the encoder has less.** A retina
   display captures 2× the pixels a viewer watches at. A 50% downscale saves
   ~55% of the size at VMAF 91.0.
3. **A frame-rate drop is the worst trade**: 30 → 15 fps gives −6% size, and
   VMAF falls 94.6 → 80.4. The score collapses because the VMAF temporal
   features score the missing frames; almost no size comes back in exchange.

## The selected default

Since 0.2.0 the default is full resolution at CRF 26. We selected the 50%
scale while the quality column was wrong. With correct measurement, half
scale looks soft, so `--half` is optional.

```bash
ffmpeg -f avfoundation -framerate 30 -capture_cursor 1 -pixel_format nv12 \
  -i "1:0" \
  -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p \
  -c:a aac -b:a 96k -movflags +faststart out.mp4
```

- Default (full res): **94.6** VMAF, ~70–105 KB/s of desktop motion → a
  2-minute demo ≈ 8–13 MB
- `--half` keeps the old 50% scale: **91.0** VMAF, ~55% smaller; it is the
  "send by chat" mode. The scale floors each axis to an even size
  (`scale=iw/2` alone can ask for an odd width, which libx264 refuses in
  `yuv420p`)
- `--small` = CRF 28 + half scale; composed from the rows above, ≈ 198 KB,
  ~63% less than the default. The exact combination is not measured

## Same-moment A/B against the macOS recorder (2026-10-18)

Both recorders captured the same QHD screen during the same minute
(`screencapture -v` vs `pomulum record`, 60 s). The desktop text moved
during the capture:

| | size | bitrate |
|---|---|---|
| macOS default recorder | 47.5 MB / 58.1 s | ~818 KB/s |
| pomulum (full res) | 6.3 MB / 60.0 s | ~105 KB/s |

**7.5× smaller** for the same minute of the same screen. We measured quality
against Apple's render on the never-scrolling browser-chrome strip
(bt601→bt709 normalized, aligned for the ~6 s ScreenCaptureKit start-up
latency): VMAF ≈ 91. Close, not identical; the 8× bitrate keeps more
fine-text detail.

## Limitations

- The motion source is synthetic UI, not full-motion video (which
  compresses worse); re-benchmark when a real use case appears
- VMAF values depend on the model and on which frames are paired. This
  table names both (vmaf_v0.6.1, distorted-first). Re-run the scripts
  before you quote new numbers
- We did not measure battery or thermals for long recordings (> 30 min)
- We did not benchmark the audio path (we chose 96k AAC from experience)
- One machine, one run; the numbers do not transfer to Intel Macs or other
  models
