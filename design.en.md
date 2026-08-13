# Design — BioinformaticsHUB

> [中文版](./design.md) · [English](design.en.md)

BioinformaticsHUB's locked design system. The app pages and run states share one set of paper, typography, glass hierarchy and motion rules.

## Genre

Editorial workbench: archival technical layout, not a marketing landing page.

## Macrostructure family

- App page: Workbench; tool selection uses the F3 spec sheet, execution uses the F4 step sequence.
- Results page: the Workbench data-summary variant; prioritizes tables, definition lists and status rows.
- Navigation: the N9 edge-navigation app variant; brand on the left, essential workspace entry points on the right.
- Closing: an Ft4 short colophon stating run boundaries and data destinations.

## Theme

- Paper: warm-gray archival paper `oklch(94% 0.016 78)`.
- Ink: carbon black with a brown cast `oklch(20% 0.014 55)`.
- Accent: oxidized amber `oklch(52% 0.13 50)`, used only for selection, focus and primary actions.
- Glass is used only for the floating navigation, run confirmation and modal layers; content lists sit directly on the paper — no glass-on-glass.
- Paper fiber, scan lines and slight mottling all use CSS gradients and blend modes, never generated images.

## Typography

- Display: the system-available classical serif stack, 700, upright; Chinese prioritizes the Songti voice.
- Body: the Apple / Windows system sans stack, 400.
- Mono: the system monospace stack, used only for sequences, paths and values.
- Tight letter-spacing on headings; body line-height 1.55–1.65; body max line width 65ch.

## Spacing

A four-point base, using the named spacing variables in `apps/bioinformatics-hub/tokens.css`.

## Motion

- Page entry: short-distance fade-in, 420 ms, exponential ease-out.
- Control press: immediate 120 ms scale/translate feedback.
- Glass modal: materialized fade-in, 300–420 ms, no bounce.
- With reduced motion: only opacity changes of at most 150 ms remain.

## Microinteractions stance

- Success stays quiet; errors state what happened and what to do next.
- Focus rings appear immediately and never animate.
- All reachable controls are at least 44 × 44 CSS px.
- Selecting an analysis tool updates the run summary immediately, without a toast.

## CTA voice

- Primary action: dark ink solid button with warm paper text; labels must use a concrete verb.
- Secondary action: transparent paper with a hairline border; no gradients or glow.

## Per-page allowances

- App pages must not add non-semantic illustrations or atmospheric light orbs.
- Result figures come only from real analysis data.
- Structural analysis and browser steps must note elapsed time and external dependencies.

## What pages MUST share

- The BioinformaticsHUB wordmark, warm-gray paper and oxidized-amber accent.
- The same button shapes, input heights, focus feedback and status semantics.
- "Actual source" and "functionally equivalent implementation" must be clearly distinguished.

## Exports

- CSS source: `apps/bioinformatics-hub/tokens.css`.
- The current project does not use Tailwind or shadcn; it never generates unconsumed duplicate token files.
