# Prāta Piedzīvojumu Sala

Static kid-facing web game, part of [KidMindPath](https://www.kidmindpath.com/).

**Live:** <https://www.kidmindpath.com/PrataSala/>

## How it boots

Unusual, and worth understanding before changing anything:

1. `index.html` fetches `Prata Sala.dc.html` — a design-board export — and
   pulls out the one playable phone screen, dropping the board's annotations
   and mock device bezel.
2. It injects that `<x-dc>` subtree plus the board's logic script into the
   document.
3. `support.js` (the design-board runtime) compiles the logic with Babel and
   evaluates it, rendering the result with React.

So the game is transpiled in the browser on every load. There is no build step
and no `npm install`.

## Vendored libraries

`vendor/` holds React 18.3.1, ReactDOM 18.3.1 and `@babel/standalone` 7.26.4.
They used to be fetched from unpkg.com on every load; they are local now, so
the game starts offline, starts faster, and cannot be broken by a CDN outage.

**`support.js` is a generated file** (`// GENERATED from dc-runtime/src/*.ts`)
and the `dc-runtime` source is not in this repository. The four URL/hash
constants that point at `./vendor` were edited by hand, so **a rebuild will
silently restore the unpkg URLs**. The header comment in `support.js` names
them; re-apply them after any rebuild.

Each vendored file carries an SRI hash in `support.js`. React and ReactDOM
match the hashes that were already recorded there, which is how they were
verified as byte-identical to what the app used to fetch.

## Design

`shared/` is **a copy of the KidMindPath design system**, not this repo's own
code. Source of truth: `Hifistereo/Hifistereo.github.io` under `shared/`, whose
`shared/README.md` explains how to sync. Edit it there — a local edit is
overwritten on the next sync.

Loading it is what makes the `font-family` declarations in this app true. The
game named Nunito from the start but nothing ever loaded it, so it shipped in
whatever generic sans-serif the device picked; the display font was named as
`'Baloo 2'` and only loaded on the design board, which `index.html` throws
away. Both now resolve to the self-hosted Baloo 2 and Nunito in
`shared/fonts`.

(The display font briefly self-hosted as Fredoka instead of Baloo 2. Fredoka
is missing glyphs for most Latvian diacritics — `ā č ē ģ ī ķ ļ ņ ū` — even in
Google's own copy, so words containing them rendered with that one letter
jumping to a fallback font mid-word. Baloo 2 has full Latvian coverage and
matches the name the design board used originally.)

Every inline `font-weight:800` and `:900` in the board export moved to 700,
because Baloo 2 (like Fredoka before it) ships nothing heavier here and the
browser would otherwise synthesise a face that looks subtly wrong.

## Per-child progress

`SAVE_KEY` is namespaced to the child chosen on kidmindpath.com
(`prata-sala-v1:<childId>`), so two siblings on one tablet no longer overwrite
each other's island. `KMP.migrateKey()` moves pre-existing progress onto the
active child exactly once; without it everyone who has already played would
appear to have lost the lot, the data still sitting at the old key.

With no hub — `hifistereo.github.io/PrataSala/`, or a plain file server — the
key stays `prata-sala-v1` and nothing changes.

## The bar, and why this app needs a save hook

`.kmp-bar` is on every screen and leaves on a plain tap. This is the only one
of the five games that writes progress at round boundaries rather than
continuously, so leaving mid-round would otherwise lose it.

`componentDidMount` in the board export publishes `window.__prataSaveProgress`,
and `index.html` passes it to `KMP.homeBar({ onLeave })`. The bar calls it on
the click, before the page goes away — `pagehide` is not reliable enough for a
link navigation in Safari.

## Deploying on GitHub Pages

1. Repository settings → **Pages**.
2. Source: **Deploy from a branch**, `main`, `/ (root)`.

Everything in the repository root ships as-is: `index.html`, `support.js`,
`favicon.svg`, `Dragon.dc.html`, `Prata Sala.dc.html`, `vendor/` and `shared/`.
`.nojekyll` stops Jekyll from touching them.

## Security

The page sets a `Content-Security-Policy`, and it is worth being clear about
what it does and does not buy.

`script-src` has to allow both `'unsafe-eval'` and `'unsafe-inline'`, because
`support.js` compiles the game with Babel and runs it through `new Function`.
With both keywords present `script-src` stops approximately nothing — it is
there for the origin restriction, not as an XSS defence. Making it meaningful
means replacing the in-browser design-board runtime with a real build, which is
a separate job.

The rest of the policy does real work: `connect-src`, `img-src`, `font-src` and
`media-src` pinned to `'self'` mean injected code has nowhere to send data, and
`object-src` / `base-uri` / `form-action` close the usual side doors.

`frame-ancestors` is deliberately absent: browsers ignore it in a `<meta>`
policy and log an error for it, and GitHub Pages cannot set response headers.
