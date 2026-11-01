<p align="center">
  <img src="img/icons/icon.svg" width="128" alt="Harmonics Lab icon">
</p>

<h1 align="center">Harmonics Lab</h1>

A static HTML/CSS/JS instrument for studying the **harmonic series**, **consonance & dissonance**, and **tuning systems** of any sound, live from your microphone, a built-in tone generator or an audio file. It has no build step, no dependencies and no network access.

## Run it

Serve the folder with any static web server (microphone access needs
`localhost` or HTTPS), for example `python3 -m http.server`, then open `http://localhost:8000`.

Live demo is hosted at: https://abpaudel.com/harmonics-lab/

## What you see

| Area | What it shows |
|---|---|
| **Spectrum** | Log-frequency spectrum. Every peak is labelled with note, cents and sargam. Each detected note gets a coloured **comb** of harmonic numbers (filled = present, hollow = missing). Partials shared by two notes are ringed in green. Gold ticks mark where the selected tuning places each svara. The red **roughness band** at the bottom shows where in frequency the beating comes from. The piano strip lights up the detected notes. |
| **Detected notes** | Note and octave, svara (komal underlined, tivra marked, mandra/taar dots), frequency, a cents needle relative to the chosen tuning, 12-TET reading, and nearest of the 22 shrutis. |
| **Intervals** | For every pair of notes: interval name, exact cents, deviation from ET and from the nearest just ratio, which harmonics meet (for example "harmonic 3 of C4 ≈ harmonic 2 of G4") and the **beat rate** between them, plus cross-roughness. |
| **Harmonic ladder** | One note's partials as bars, and a table: interval above f₀, ratio, the harmonic's *natural* offset from ET (h5 = −13.7¢, h7 = −31.2¢, h11 = −48.7¢…), measured vs exact n·f₀ (inharmonicity), note, cents and svara. |
| **Overtone overlap** | Each note's harmonic series in its own lane on a shared log-frequency axis. **Green links** mean coinciding partials (fusion, consonance). **Red bands** mean partials close enough to beat (roughness, dissonance), labelled with the beat rate. |
| **Dissonance curve** | Plomp–Levelt/Sethares roughness of a timbre (live, or presets) against itself at every interval over 1–2 octaves. The valleys fall on 6/5, 5/4, 4/3, 3/2, 5/3, 2/1. The live intervals and the chosen tuning's degrees are marked on it. |
| **Spectrogram** | Scrolling time × log-frequency picture, with traces of the detected fundamentals. |
| **Tuning explorer** | 12-TET, 5-limit Just, Pythagorean, ¼-comma Meantone, Werckmeister III, 7-limit, the 22 shrutis, and where harmonics 1–32 fall inside an octave. A table gives cents, ratios and offsets from ET; click a cell to hear Sa plus that degree in that tuning. |

**Tone Lab** (keyboard button) plays notes and chords with chosen timbre, harmonic count and string stiffness (inharmonicity), tuned in the selected **tuning system** and **Sa**. Change the tuning while a chord sounds and watch the beating partials appear or vanish.

### Controls

- **Sa / Key**, **Tuning**, **A4** (top bar). Sa fine-tune (±50¢), note spelling and Devanagari sargam are under ⚙ Settings.
- Spectrum: scroll to zoom, drag to pan, double-click to reset. **Click a peak** to pin its harmonic series (white), which helps when auto-detection can't separate a note.
- Keys: <kbd>Space</kbd> freeze · <kbd>M</kbd> mic · <kbd>T</kbd> Tone Lab · with the Tone Lab open, <kbd>A</kbd>…<kbd>K</kbd> play Sa to taar Sa chromatically.

## How the analysis works (and how accurate it is)

1. **Capture.** An AudioWorklet (ScriptProcessor fallback) copies raw samples into a ring buffer. The mic is opened with echo cancellation, noise suppression and auto-gain **off**, and the app tells you if the browser refused.
2. **Spectrum.** Two overlapping frames (offset by ¼ window) are windowed (Hann or Blackman-Harris) and packed into **one complex FFT**.
3. **Peak frequency.** This comes from the **phase-vocoder method**: the phase advance of each peak between the two frames gives its true frequency. On synthetic tones the worst-case error is **≈0.02 cents** (parabolic interpolation would give ~1–2¢). Peak level is corrected for scalloping with the window's analytic kernel (error < 0.01 dB).
4. **Peaks** are kept when they exceed a local, median-like noise floor by the threshold (default 15 dB, chosen from the noise statistics), and window side-lobes are rejected.
5. **Notes.** Notes are found by harmonic summation with iterative explanation, after Klapuri. Candidates are peaks and their sub-multiples. Each candidate's series is tracked upward by **extrapolating the measured partial spacing**, so stretched piano partials are followed with a tight tolerance. Missing low harmonics are penalised, and sub-octave "ghost" notes and vibrato sidebands are rejected.
6. **Roughness** is the Sethares (1993) parameterisation of Plomp & Levelt, summed over all partial pairs and normalised to the loudest partial.

### Validation (`tests/tests.html`, 53 checks, all passing in Chrome and Firefox)

- Pure tones at 300 random frequencies: worst error 0.016¢, 0.003 dB (Hann) and 0.017¢, 0.007 dB (Blackman-Harris).
- Single notes E2–C6 with sawtooth, odd-only, sine, weak-fundamental and bright spectra: all within 0.02¢.
- Chords: fifths (ET and just), 3rds, 4th, tritone, minor/major 2nd, major/minor triads (ET and just 4:5:6), wide spacings. Each is detected exactly, and no note may claim a partial off its own series.
- Stiff strings (B = 0.0004 and 0.001, partials stretched up to 290¢) are fully tracked. Singer vibrato (±17¢) gives one note and no ghosts.
- Music theory: note naming, cents, sargam with saptak, just/Werckmeister degrees (A stays at 440), sargam-aware spelling, compound intervals, harmonic offsets.
- Roughness: maximum at ~¼ critical band; dissonance-curve minima at 6/5, 5/4, 4/3, 3/2, 5/3, 2/1; m2 > M2 > ET M3 > just M3 > ET P5 > just P5 > octave.

A randomized stress test (random spectra, 44.1 kHz, noise, vibrato) gives 100% correct notes for single notes and two-note chords. Three-note chords are 86–87% correct; every miss was an **octave doubling**, which cannot be separated in principle.

### Limits worth knowing

- **Octave doublings** (and near-exact 12ths) cannot be detected as separate notes: every partial of the upper note coincides with the lower note's. That perfect overlap is *why* the octave is the most consonant interval. Click the peak to pin it if you want its series drawn.
- When two partials are closer than ~2 FFT bins (≈3 Hz at 16384, ≈1.5 Hz at 32768) they merge into one peak. The interval card then computes the beat from the precisely measured fundamentals (e.g. the 0.89 Hz beat of an ET fifth at C4).
- Larger FFT sizes give finer frequency detail but respond more slowly (the readings integrate 0.2–0.85 s of audio).

## Files

```
index.html          app shell
css/style.css       styling
js/dsp.js           FFT, windows, peak detection, phase-vocoder refinement
js/pitch.js         multi-note fundamental detection
js/music.js         tunings, note names, sargam, shrutis, intervals
js/dissonance.js    Plomp–Levelt / Sethares roughness & dissonance curves
js/audio.js         mic / file / Tone Lab synth, capture worklet
js/ui.js            drawing & formatting helpers
js/views/*.js       spectrum, ladder, overlap, curve, spectrogram, tuning
js/app.js           state, analysis loop, side panels, controls
tests/              validation suite (tests.html in browser, tests.js in Node)
```
