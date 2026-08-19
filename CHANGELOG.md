## [0.1.17](https://github.com/art-ws/muxeon/compare/v0.1.16...v0.1.17) (2026-08-19)


### Changes

* **T285:** the liveness probe says what it found — an out-of-band death is news

  A session that dies outside the system — a park script, a crashed CLI agent, a hand in a terminal — has exactly one witness: the liveness sweep (FR-93). It changed the status and said nothing, so "half the park is down" was a mystery with an empty log. ([6aee61c](https://github.com/art-ws/muxeon/commit/6aee61c648ba22fd2c99400581ce59ba6c3f5091))
* **T287:** trimming a capped log is not free — amortize it, or every message pays

  The transport journal and the panel history are append-only JSONL with a double age/count cap. The count cap was enforced the moment the log went one record ([cb9f345](https://github.com/art-ws/muxeon/commit/cb9f345c6e54347d08e16f606ffb8070b22004e8)), closes [#rewrite](https://github.com/art-ws/muxeon/issues/rewrite)
* **T289:** the sweep needed the slack more than append did — it runs on a clock

  T287 amortized the count cap on the append path and left prune() exact. Watching the deployed stand showed why that is not enough: the retention sweep runs every 60 s and calls prune(), which rewrote the whole journal whenever it found even one record over the cap. ([1b1db13](https://github.com/art-ws/muxeon/commit/1b1db132419ab41ab593dbc436061db18f215414))

## [0.1.16](https://github.com/art-ws/muxeon/compare/v0.1.15...v0.1.16) (2026-08-18)


### Changes

* **T279:** a header toolbar the user assembles — pinned shortcuts to the two menus

  The topbar was half empty while the actions people reach for most sat two clicks deep in the chat kebab and the account menu. Now any of those items can be pinned into the header, and Settings has a Toolbar section that lists the whole catalogue — icon, name, what it does — with a switch per row. ([8428cd2](https://github.com/art-ws/muxeon/commit/8428cd2e84679d0b0756b8f525fbda8e894b9c28))
* **T280:** the console stops blinking — a re-render must not detach the pane

  The translator comes from context and was rebuilt on every App render, so its identity changed constantly. The console's attach effect listed it among its dependencies, so an unrelated re-render disposed the terminal, closed the tmux client and built both again — the pane blinked. ([63f8f97](https://github.com/art-ws/muxeon/commit/63f8f97c6956cac022eef1b0def100afeac1514b))
* **T281:** the console stops flashing Reconnect — and says which build it is

  Still blinking after T280, in a way that names its own mechanism: "Reconnect" appeared and vanished at speed. That is one re-attach cycle drawn out — connecting → (the previous socket's close arrives) ended → live — so two things were wrong. ([ac9bf46](https://github.com/art-ws/muxeon/commit/ac9bf463175a8bc8192cdd9c1522d6345cad9fd3))
* **T282:** panel statics answer "is this still current?" — ETag and no-cache

  The entry bundle keeps a stable name, so a browser holding it had no way to learn that dist/ had been rebuilt: statics went out with no ETag, no Last-Modified and no Cache-Control. A soft reload could keep yesterday's panel alive, which is how two console fixes looked like no fix at all. ([c514f04](https://github.com/art-ws/muxeon/commit/c514f04dae3a3ec477c491abf8c6400215aea287))
* **T284:** a shim that outlives its agent stops being harmless — it now exits

  dev1 was producing a continuous stream of "identity taken over by a new session" on the stand: four processes claimed the name, three of them orphaned by earlier agent sessions (PPID 1, started Aug 14, Aug 16, Aug 17) and one belonging to the live agent. ([93eef4e](https://github.com/art-ws/muxeon/commit/93eef4eedcde8e97a5eb6ec5c45247205318093c))

## [0.1.15](https://github.com/art-ws/muxeon/compare/v0.1.14...v0.1.15) (2026-08-17)


### Changes

* **T276:** a sent message puts the composer back in its resting shape

  Full screen (FR-70, T222/T223) is the mode for writing a LONG message. Once that message is sent, the reason for the mode is gone — but the card stayed grown: an empty canvas over the whole feed, hiding the answer the operator was waiting for, with the collapse left as a chore for the human. ([ff8be67](https://github.com/art-ws/muxeon/commit/ff8be6762f7175591d62873b919b1a4d0d4cfc71))

## [0.1.14](https://github.com/art-ws/muxeon/compare/v0.1.13...v0.1.14) (2026-08-17)


### Changes

* **T274:** reactions — a mark on a message, and an instruction for an agent

  Implements §19 (FR-161…FR-168) and the console-input record §12.9.6 (FR-170). ([03600b4](https://github.com/art-ws/muxeon/commit/03600b4dff7d31013ec70f76eb29c729fed92b5b))

## [0.1.13](https://github.com/art-ws/muxeon/compare/v0.1.12...v0.1.13) (2026-08-17)


### Changes

* **T270:** the panel's console stops being a picture of a terminal

  Screen Live polled a text snapshot every 3s: you could watch, not work. The operator asked for the real thing — a terminal in the panel, typed into with the same effect as sitting at the machine (exchange 239c3390). ([9c5eabb](https://github.com/art-ws/muxeon/commit/9c5eabba1dc3f068e500c5c0b591c4a47ccefae1))
* **T271:** raw mode leaves the panel — one way to type into a pane, not two

  Raw was an approximation of a terminal from the time there was none: text in verbatim, a console snapshot back as the reply. T270 gave the panel the real pane, so a second and weaker way to type into the same place is UI with no purpose — and it carried its own rules (a global toggle, media switched off, its own placeh… ([4e46599](https://github.com/art-ws/muxeon/commit/4e4659939929be1bb5aba5406dbaa9bac8cd5f80))

## [0.1.12](https://github.com/art-ws/muxeon/compare/v0.1.11...v0.1.12) (2026-08-14)


### Changes

* **T267:** the compact contract stops naming the path it forbids

  Operator asked whether the trailing "do NOT write reply.md, do NOT delete message.json, do NOT repeat the answer elsewhere" is necessary. It is not, and it was actively working against itself. ([2860d53](https://github.com/art-ws/muxeon/commit/2860d538e5c20e5a168db9cbb82bd815b19fd21f))
* **T268:** document how to make the token gauge appear, not just how to enable counting

  The guide said which two shapes are recognised but not how to get one on screen — which is the half an operator actually acts on when an agent shows nothing. ([f750854](https://github.com/art-ws/muxeon/commit/f7508547f79f2fd3301c997c9bcec8584ea54284))
* **T269:** send carries files, so the compact contract stops being the poorer one

  Operator request, from a gap they spotted: agents on the compact reply contract had no way to attach artifacts. The file contract returns anything left beside message.json, but the compact form has no folder to use — its own clause says leave it untouched, and an MCP-closed turn is not collected at all. ([6782c6b](https://github.com/art-ws/muxeon/commit/6782c6b6c4f9163b88f3dc612ea8cf7475806cb1))

## [0.1.11](https://github.com/art-ws/muxeon/compare/v0.1.10...v0.1.11) (2026-08-14)


### Changes

* **T266:** the token orb shows the percentage; the count moves into its tooltip

  Operator request. The header caption was "226 813 tok (23%)" — the longest, fastest-changing part of the chat header, competing with the histogram for width, while the number a reader acts on is how close to the ceiling the agent is. The caption is now the percentage alone. ([32ad877](https://github.com/art-ws/muxeon/commit/32ad877b63adf89be507c5b33fada0c61a8aff04))

## [0.1.10](https://github.com/art-ws/muxeon/compare/v0.1.9...v0.1.10) (2026-08-14)


### Changes

* **T256:** README — where the name comes from

  Operator's request: the front page should say what "Muxeon" means, because the name is coined and reads as arbitrary until someone explains it. ([bdd901a](https://github.com/art-ws/muxeon/commit/bdd901a342ea3a3b7e968260938ae80b43a83d1f))
* **T258:** drop the temporary token — the trusted publisher is configured

  The token existed for exactly the window npm forces open: a trusted publisher ([d92bf66](https://github.com/art-ws/muxeon/commit/d92bf66e24e67f2192922b8ba2ddc5c1b1c343b0)), closes [npm/cli#8544](https://github.com/npm/cli/issues/8544)
* **T261:** the reply contract follows the live MCP session, and send ends the turn

  The file contract (§13.2) is self-sufficient but costs the agent two extra model round-trips at the end of every turn — write reply.md, then a second call to delete message.json — and the answer only leaves after the turn ends. MCP send delivers at the moment of the call and costs one. ([ed05514](https://github.com/art-ws/muxeon/commit/ed05514147280b4ca1f6aebd2e27235d3b2ad4e7))
* **T265:** the shim supervises its session instead of repairing it on demand

  Reconnecting on the next tool call stopped being enough the moment session liveness became a signal: since T261 the coordinator hands the compact reply contract only to agents holding a live agent-plane session. ([ff8b40a](https://github.com/art-ws/muxeon/commit/ff8b40aa5d3b7e5d09c6d764fa75458aafc75327))

## [0.1.9](https://github.com/art-ws/muxeon/compare/v0.1.8...v0.1.9) (2026-08-12)


### Changes

* **T252:** provenance lives in publishConfig, not in the plugin options

  0.1.8 published cleanly and without an attestation. The cause is a line that has been wrong since it was written: `.releaserc.cjs` passed `provenance: true` as an option to @semantic-release/npm, and that plugin has no such option — it wraps `npm publish`, so provenance must be configured where npm itself reads it, in… ([c5b4ee9](https://github.com/art-ws/muxeon/commit/c5b4ee96a7643d1f90c9fa81e528148e8ac7a9af))

## [0.1.8](https://github.com/art-ws/muxeon/compare/v0.1.7...v0.1.8) (2026-08-12)


### Changes

* **T239:** the turn dir is the coordinator's, and an undelivered answer is never silent

  Live complaint (operator, exchange 2026-08-09): "the file exchange has not picked up the reply twice in a row — message.json deleted, the folder with reply.md just sits there". ([d42eebe](https://github.com/art-ws/muxeon/commit/d42eebe9b95a79f71429bde7626e36f35af0b117))
* **T245:** rename the project to muxeon (B6/B7, prepared off the live checkout)

  Stage B6 of docs/spec-muxeon-migration.md, done ahead of the cutover window on a branch in a separate worktree so the live stand keeps running from the old checkout untouched. Nothing here renames data or moves directories — that is B5 and B8-B14, and they still need a stopped stand. ([c17666a](https://github.com/art-ws/muxeon/commit/c17666a05a1f46f515a8a63edcbad021764379b2)), closes [#3](https://github.com/art-ws/muxeon/issues/3)
* **T246:** release.yml — a temporary NPM_TOKEN for the first publish (C1)

  npm cannot configure a trusted publisher for a package that does not exist yet: the setting lives on the package's own settings page, and publishing an initial ([5de245d](https://github.com/art-ws/muxeon/commit/5de245da8e5c2af6ac3446399db468c2df53a630)), closes [npm/cli#8544](https://github.com/npm/cli/issues/8544)
* **T248:** C3 — the package is unscoped, so the docs must say so

  The layered rename left one thing wrong in prose. `@art-ws/teamai` became `@art-ws/muxeon` everywhere it appeared as text, which is right for repository ([f37c9bc](https://github.com/art-ws/muxeon/commit/f37c9bcb7a2efd7f48ae5df41aa1f97be1a0b21b)), closes [#3](https://github.com/art-ws/muxeon/issues/3)
* **T249:** write the name as Muxeon in prose, not MUXEON

  The all-caps spelling was inherited, not chosen: TEAMAI is an acronym-ish compound where caps read as a wordmark, and the rename carried the shape over to a coined word, where it reads as shouting. Operator's call to change it. ([c5b8481](https://github.com/art-ws/muxeon/commit/c5b84812f34de638d044b79414a8b4063dd932ad))
* **T250:** release — npm reads NODE_AUTH_TOKEN here, not NPM_TOKEN

  Both dry runs failed with `EINVALIDNPMTOKEN Invalid npm token`, which reads like a bad secret and is not one. The runner log shows what actually happens: setup-node's `registry-url` writes an .npmrc holding `_authToken=${NODE_AUTH_TOKEN}` and points NPM_CONFIG_USERCONFIG at it, then exports NODE_AUTH_TOKEN with its own… ([525b6f2](https://github.com/art-ws/muxeon/commit/525b6f22376f1f7971027e208e107e1e04bdad05))
* **T251:** publish under the @art-ws scope — npm refuses the bare name

  The real release reached the registry and was rejected ([9c2832a](https://github.com/art-ws/muxeon/commit/9c2832abe1fc2d38dbfa59762cf7e80d6b4294aa))

## [0.1.7](https://github.com/art-ws/muxeon/compare/v0.1.6...v0.1.7) (2026-08-02)


### Changes

* **T237:** an optional `title` labels an agent or a user in the panel

  The panel printed the topology name everywhere, so a stand's sidebar read `dev` / `ceo` / `operator-web` — precise, but not what a person wants on the screen. `agents[].title` and `users[].title` add ONE optional label: where the panel prints a name it now prints the title, and the name stays one hover away. ([31994d5](https://github.com/art-ws/muxeon/commit/31994d51f891680a04fd1f7983721301c162a4b5))
* **T238:** biome format for the T237 tests (CI lint was red)

  The two test files gained their FR-156 cases after the last local lint run, so `biome check .` on CI printed two format diffs and failed the check job. Pure formatting — biome's own output applied verbatim, no assertion touched (43 pass in the two files, typecheck clean). ([376ce60](https://github.com/art-ws/muxeon/commit/376ce6039328f609f0baa9134abcc28fd4310c0a))

## [0.1.6](https://github.com/art-ws/muxeon/compare/v0.1.5...v0.1.6) (2026-08-01)


### Changes

* **T234:** the account circle moves to the topbar's right corner

  The operator asked for the sidebar's bottom-left account menu to go away and for a bare user circle to sit in the header's right corner instead — no name, no "Account" label — opening the SAME menu on click. ([e79ba8a](https://github.com/art-ws/muxeon/commit/e79ba8aa31905bbe2d7f666e0e13a9079322f319))
* **T235:** the account menu sank under the chat header

  The menu opened but its first item was painted over by the chat pane's header: .chat-header is a layer of its own (z-index 6, T116) and the popover — hanging off the topbar, which was unpositioned — competed with it directly from the root stacking context at z-index 5. ([ce575b9](https://github.com/art-ws/muxeon/commit/ce575b94aaa4f72380ddd5d8457ad24caae2dc02))
* **T236:** the self-chat becomes the full mirror of a user's traffic

  FR-128 promised an aggregate inbox and the code never built one. What the operator did see there — their own outgoing messages — was a side effect of a bug: the panel calls "us" whoever is not a listed peer, but in users mode the viewer's own row IS in peers, so peerOf filed every outgoing record under the sender (the… ([b438912](https://github.com/art-ws/muxeon/commit/b4389128d01330127e151f91432dd5555dcb271a))

## [0.1.5](https://github.com/art-ws/muxeon/compare/v0.1.4...v0.1.5) (2026-08-01)


### Changes

* **T232:** relay mode joins two NAT-bound servers through a hub

  Two servers that cannot reach each other directly now talk through a shared hub they both import: the satellite adds publish: true to its import and the hub consents with relay: true on that accept entry — a two-sided opt-in (invariant §10.28) with both flags defaulting to false, so every existing link behaves exactly… ([719134c](https://github.com/art-ws/muxeon/commit/719134c83126d8da1fb73409444eab85a9c16845))
* **T232:** the docs catch up with federation and relay (LLM.md, SECURITY, CONTRIBUTING, README)

  The agent runbook (docs/LLM.md) gains a relay subsection in step 11 — the satellite/hub configs, the two-sided opt-in rules, the mailbox behaviour, the consent warning to state to the human — plus a security-posture bullet and two troubleshooting rows (the no-grant warning and the reachability formula). ([b2862db](https://github.com/art-ws/muxeon/commit/b2862dbea8c094418c57f7e780561d175827f08f))

## [0.1.4](https://github.com/art-ws/muxeon/compare/v0.1.3...v0.1.4) (2026-07-31)


### Changes

* **T228:** Screen Live moves to the chat's actions menu

  Watching an agent's console observes the AGENT — it is not a way to compose a message, which is what everything else in the composer's "+" menu is for. The entry moves to the chat header's kebab, next to Reload, Shutdown and Pause, where the other agent actions already live (operator's call). ([2cba811](https://github.com/art-ws/muxeon/commit/2cba8116c320b14c9d4202cf8d0adeac688a9c0a))

## [0.1.3](https://github.com/art-ws/muxeon/compare/v0.1.2...v0.1.3) (2026-07-31)


### Changes

* **T217:** federation of servers

  A Muxeon server can now export its actors and import a neighbour's — agents and users on different instances interact as if they shared one machine, addressed by email-style FQNs (`dev@hq`, chains grow right, resolve by the LAST `@` — decision §18.10-8). ([ff81829](https://github.com/art-ws/muxeon/commit/ff81829327447ef2fd736e79f83e63e9c4386f71))
* **T219:** LLM.md learns federation (§18) — the runbook can now join stands

  The agent runbook stops at a single server; the product no longer does. New step 11 "Federation — joining stands (only if asked)": both sides of a link (exporter's federation{} + exported actors, importer's imports[] + the edge on the import node), the FQN naming rule, the debugging-cycle notes ($env-only tokens in bot… ([97b46ec](https://github.com/art-ws/muxeon/commit/97b46ec5562273cecb6ae33797d5647e85b6708e))
* **T220:** the agent accent becomes a Gemini-style halo

  The open chat's wash turns RADIAL — brightest around the composer, melting into the background toward the edges (the reference the operator sent), still color-mix'ed with the themed --bg so both themes work. ([d2e6a8a](https://github.com/art-ws/muxeon/commit/d2e6a8acd949ac526c7d70023bd0c7cf051b876c))
* **T221:** message times grow a "how long ago" tooltip

  Everywhere a message shows its clock time — chat bubbles and the transport journal — hovering now answers the question the clock alone does not: the tooltip carries the full local date-time plus a relative phrase ("5 minutes ago" / "5 минут назад", Intl.RelativeTimeFormat in the panel's language). ([c04a5fe](https://github.com/art-ws/muxeon/commit/c04a5feb0622e9c2940c41ed8f6b08711ad7d11e))
* **T222:** the composer floats on frosted glass and grows in place

  Three moves from the operator's Gemini reference ([ad28275](https://github.com/art-ws/muxeon/commit/ad282757a0c9c9d2ebbf1e66cbcf811158ba6493))
* **T223:** the grown composer owns the pane — Enter, one toggle, glass, edge wash

  Six panel fixes on top of T220/T222, from the operator's review ([de549af](https://github.com/art-ws/muxeon/commit/de549af71fec56874fe9f51a00306056134580e9))
* **T224:** the composer's glass was trapping every full-screen overlay

  Screen Live opened as a dark plate over the composer with its dialog spilling off the card's edge. The popup was fine; its containing block was not. ([1433b69](https://github.com/art-ws/muxeon/commit/1433b696b619c76c9177dda5f8988f3cb910aba9))
* **T225:** the transport journal reads like the chat — meta under the message

  The row was two columns: time and route on the left, the text hanging in the rest of the width. Long payloads — most of them, since agents talk in paragraphs — read as a narrow ribbon beside an empty gutter. ([ca5b236](https://github.com/art-ws/muxeon/commit/ca5b236bff1a2eaedf6796bb27843db2c9d79a11))
* **T226:** the rail circles get a dome

  The collapsed sidebar was a column of flat discs. They now read as slightly domed: a light catches the upper left, the lower right falls off into shade, and a whisper of a drop shadow lifts them off the rail. ([67c2df8](https://github.com/art-ws/muxeon/commit/67c2df86d2e3c1ba6ddff4396aec358639e0f5a7))
* **T227:** the changelog says what changed (release notes from commit bodies)

  Two releases' worth of entries read "ci: exempt package.json from the formatter" and nothing else, while eight tasks — federation among them — went out invisibly. ([9e21e74](https://github.com/art-ws/muxeon/commit/9e21e746b07d479feeb1e868aa2abe5eef80fd4b))

## [0.1.2](https://github.com/art-ws/muxeon/compare/v0.1.1...v0.1.2) (2026-07-31)


### Bug Fixes

* **ci:** exempt package.json from the formatter — the release job owns its style ([3848eb1](https://github.com/art-ws/muxeon/commit/3848eb1ba5aac8e14e522a7cde0a21d8cdf9a966))

## [0.1.1](https://github.com/art-ws/muxeon/compare/v0.1.0...v0.1.1) (2026-07-30)


### Bug Fixes

* **ci:** drop an input setup-node@v4 does not accept ([e0f60ca](https://github.com/art-ws/muxeon/commit/e0f60cabe853d6fb6e8b16526396b37fd2a6a351))
