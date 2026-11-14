# TerraField Atlas — hackathon demo narration script

Voice: `jam` (English) · speed 1.2 · one WAV per scene, 24000 Hz.
Pipeline: z-ai TTS → Pillow frames → ffmpeg Ken Burns + mix → 1280×720 H.264 MP4.

## Scene 1 — `00-title` (title)
**Overlay label:** TERRAFIELD ATLAS

> TerraField Atlas — NASA Earth intelligence for agricultural resilience, built for the NASA Space Apps Challenge. This is the end-to-end tour.

## Scene 2 — `01-landing` (shot)
**Overlay label:** MISSION OVERVIEW · GUIDED TOUR

> The mission overview briefs the operator, and a guided seventeen-step tour walks new users through every module — automatically on first run.

## Scene 3 — `02-dashboard` (shot)
**Overlay label:** EARTH INTELLIGENCE · HONEST TRENDS

> Earth Intelligence ingests the real NASA POWER record and tests it with seasonal Mann-Kendall statistics and multiple-testing control. Missing days are reported as missing — never imputed.

## Scene 4 — `03-fire-signs` (shot)
**Overlay label:** FIRE INTELLIGENCE · LIVE SOURCE SIGNS

> Fire Intelligence decodes the VIIRS thermal anomaly stream — the same detections NASA FIRMS distributes. Live probes show which upstreams answer right now: the detection stream is live; the FIRMS API host is blocked here — flagged, never faked. NASA EONET adds live wildfire events.

## Scene 5 — `04-fire-calendar` (shot)
**Overlay label:** FIRE CALENDAR · DETECTION LEDGER

> Detections land in a queryable ledger with a fire calendar, confidence classes, and radiative power. Archive gaps are reported as no-data — never zero-filled.

## Scene 6 — `05-watchlists` (shot)
**Overlay label:** FIRE WATCHLISTS · SCHEDULED RUN

> Regional watchlists define a geography and a threshold rule. This Zambia list runs on a six-hour cadence: the scheduler claimed it atomically, evaluated the real GIBS stream, and recorded a scheduled run — while backtest mode replays the same rule on any historical date.

## Scene 7 — `06-digest-push` (shot)
**Overlay label:** PUSH DIGEST · SSE CHANNEL

> Every run pushes a cadence-aware digest over Server-Sent Events — the push chip counts it live. The digest window derives from the cadence itself, and the same payload exits through a signed webhook.

## Scene 8 — `07-system-health` (shot)
**Overlay label:** SYSTEM HEALTH · CRITICAL INFRASTRUCTURE

> System Health is the operational truth: liveness and readiness probes, a scheduler watchdog, circuit breakers, and per-provider latency — one hundred twenty requests logged, success and failure, nothing hidden.

## Scene 9 — `08-provenance` (shot)
**Overlay label:** EVIDENCE & PROVENANCE

> Every number is traceable: the evidence ledger records each request — status, latency, and correlation I D — so any claim audits back to its exact retrieval.

## Scene 10 — `09-closing` (closing)
**Overlay label:** REAL DATA · HONEST GAPS · PUSH-DELIVERED INTELLIGENCE

> Webhooks are signed with timestamped H MAC signatures under O W A S P guidance — replay protection and SSRF guards included. TerraField Atlas: real data, honest gaps, push-delivered intelligence.
