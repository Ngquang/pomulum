# Encoder benchmark — why pomulum encodes the way it does

*Re-measured 2026-10-18 (Apple A18 Pro, 6 CPU cores, ffmpeg 8.1) after fixing
the libvmaf input order — see Method. Motion source: 8 s, 2816×1762 @ 30 fps
of synthetic UI motion (scrolling text, sliding blocks, a frame counter). The
`cores` column varies ~±15% between runs.*

## Method

- **CPU:** `/usr/bin/time -p` → user time ÷ duration = average cores used
- **Quality:** libvmaf against a visually lossless reference (CRF 18 capture).
  ffmpeg's filter takes the **distorted video first, reference second** — the
  8/2026 table passed them the other way round, which scores the pair
  backwards and inflates every number by ~1.5–3.6 points. Re-measured with:

  ```bash
  ffmpeg -i encoded.mp4 -i source.mov -lavfi \
    "[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS,scale=W:H[r];[d][r]libvmaf" \
    -f null -
  ```

  Model: the libvmaf default (`vmaf_v0.6.1`). For downscaled outputs the
  reference is scaled to the encoded size first — libvmaf needs equal
  dimensions.
- **Size:** encoded file, video only

## Results (motion source, 8 s / 240 frames)

| Configuration | KB | cores | VMAF | Verdict |
|---|---|---|---|---|
| **x264 veryfast CRF 26** | **540** | **1.00** | **94.6** | ⭐ sweet spot at full resolution |
| x264 veryfast CRF 28 | 443 | 1.12 | 92.4 | ⭐ CRF 28 at full res |
| x264 vf CRF 26 + 50% scale | 241 | 0.50 | 91.0 | 💎 optional mode (`--half`) |
| x264 medium CRF 26 | 515 | 1.62 | 96.3 | +1.7 VMAF for +62% CPU — not worth it |
| x265 fast CRF 30 | 510 | 6.37 | 96.0 | ❌ saturates all cores |
| VideoToolbox H.264 q50 | 1,625 | 0.12 | 94.4 | 3× larger at the same quality |
| VideoToolbox HEVC q50 | 1,380 | 0.12 | 92.9 | same story |
| x264 CRF 26 @ 15 fps | 506 | 0.62 | **80.4** | ❌ −6% size, temporal fidelity collapses |

Static-source spot check: x264 vf CRF 26 = 189 KB / VMAF 95.9. A direct
avfoundation capture peaked at ~1.2 cores (capture + encode).

## Three findings that reversed the assumptions

1. **Software x264 is cheap on Apple Silicon** — about 1 of 6 cores with
   veryfast (0.87–1.0 across runs). Hardware VideoToolbox is not needed; at
   equal quality its files are ~3× larger.
2. **Resolution is the biggest lever, not the encoder.** A retina display
   captures 2× the pixels a viewer watches at. A 50% downscale saves ~55%
   of the size at VMAF 91.0.
3. **Dropping the frame rate is the worst trade** — 30 → 15 fps: −6% size,
   VMAF 94.6 → 80.4. The score collapses because VMAF's temporal features
   price the missing frames; almost no size comes back in exchange.

## The selected sweet spot

Since 0.2.0 the default is full resolution at CRF 26. The 50% scale had been
picked while this table's quality column was inflated by the swapped libvmaf
inputs; measured correctly, half scale reads soft on real UI text, so it
moved behind a flag.

```bash
ffmpeg -f avfoundation -framerate 30 -capture_cursor 1 -pixel_format nv12 \
  -i "1:0" \
  -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p \
  -c:a aac -b:a 96k -movflags +faststart out.mp4
```

- Default (full res): **94.6** VMAF, ~70–105 KB/s of desktop motion → a
  2-minute demo ≈ 8–13 MB
- `--half` keeps the old 50% scale: **91.0** VMAF, ~55% smaller — for
  "send by chat". The scale floors each axis to an even size (`scale=iw/2`
  alone can ask for an odd width, which libx264 refuses in `yuv420p`)
- `--small` = CRF 28 + half scale — composed from the rows above ≈ 198 KB,
  ~63% less than the default; the exact combination is not measured

## Same-moment A/B against the macOS recorder (2026-10-18)

Both recorders captured the same QHD screen during the same minute
(`screencapture -v` vs `pomulum record`, 60 s, desktop with moving text):

| | size | bitrate |
|---|---|---|
| macOS default recorder | 47.5 MB / 58.1 s | ~818 KB/s |
| pomulum (full res) | 6.3 MB / 60.0 s | ~105 KB/s |

**7.5× smaller** for the same minute of the same screen. Quality, measured
against Apple's own render on the never-scrolling browser-chrome strip
(bt601→bt709 normalized, aligned for ScreenCaptureKit's ~6 s start-up
latency): **VMAF ≈ 91** — close, not identical; the 8× bitrate buys detail
on fine text that CRF 26 does not keep.

## Limitations (honest list)

- The motion source is synthetic UI, not full-motion video (which
  compresses worse); re-benchmark when a real use case appears
- VMAF values depend on the model and the frame pairing — this table names
  both (vmaf_v0.6.1, distorted-first); re-run the scripts before quoting
  new numbers
- Battery and thermals for long recordings (> 30 min) were not measured
- The audio path was not benchmarked (96k AAC chosen from experience)
- One machine, one run — not valid for Intel Macs or other models
